/**
 * What the Mac app's Settings > Cloud tab asks the daemon (docs/cloud-layer.md, "Daemon control routes"):
 * the state of both providers, Catalyst's setup steps, a test round trip, and the move. The routes
 * themselves (token gate, no CORS, JSON) are in `fleet/hook-ingress.ts`; every answer here is a fixed
 * sentence, never a CLI's output, a token or a key.
 */

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { catalystLocation, createCloudStore, firebaseLocation, readCloudConfig, writeCloudConfig } from "./config.js";
import type { CloudLocation, CloudProvider } from "./location.js";
import type { CatalystSetup, Step } from "./catalyst-setup.js";
import type { SwitchableStore } from "./switchable-store.js";
import type { CloudStore } from "./store.js";

export interface CloudTestResult {
  ok: boolean;
  writeMs: number | null;
  readMs: number | null;
  noticeMs: number | null;
  error?: string;
}

export interface LastTest {
  at: number;
  ok: boolean;
  writeMs: number | null;
  readMs: number | null;
  noticeMs: number | null;
}

export type CatalystSetupApi = Pick<
  CatalystSetup,
  "cliStatus" | "listProjects" | "selectProject" | "deploy" | "ping" | "steps" | "config" | "setConfig"
>;

export interface CloudControlDeps {
  supportDir: string;
  setup: CatalystSetupApi;
  /** The store the daemon runs on; `select` switches it. */
  store: SwitchableStore;
  /** `SQUEAK_REMOTE_DATABASE_URL` and the Firebase project it belongs to. */
  firebase: () => { databaseUrl: string | null; projectId: string | null };
  /** Builds a store for a location (a test passes fakes). */
  makeStore?: (location: CloudLocation) => CloudStore & { close?: () => void };
  /** Writes the `move` document for every channel on the store they are on now, before the switch. */
  announceMove: (target: CloudLocation) => Promise<void>;
  /** Called once the daemon is on the new store (the Mac's own channel docs, the pairing QR and so on follow). */
  onMoved?: (target: CloudLocation) => void;
  /** A Firebase access token for the rename; null when the Firebase CLI is not signed in. */
  firebaseToken?: () => Promise<string | null>;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  noticeTimeoutMs?: number;
}

export interface RouteAnswer {
  status: number;
  body: unknown;
}

const ok = (body: unknown): RouteAnswer => ({ status: 200, body });
const bad = (error: string, status = 400): RouteAnswer => ({ status, body: { error } });

function randomChannelId(): string {
  return crypto.randomBytes(16).toString("base64url");
}

function exactKeys(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const actual = Object.keys(value).sort().join(",");
  return actual === [...keys].sort().join(",") ? (value as Record<string, unknown>) : null;
}

export class CloudControl {
  private readonly lastTests: Record<CloudProvider, LastTest | null> = { firebase: null, catalyst: null };
  private deploying = false;
  private moving = false;
  private readonly now: () => number;

  constructor(private readonly deps: CloudControlDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The provider in use: the file's, as the daemon resolved it at start and after every move. */
  active(): CloudProvider {
    return this.deps.store.location?.provider ?? "firebase";
  }

  private firebaseLocation(): CloudLocation | null {
    const file = readCloudConfig(this.deps.supportDir);
    return firebaseLocation(file?.firebase?.databaseUrl ?? this.deps.firebase().databaseUrl);
  }

  private catalystLocation(): CloudLocation | null {
    return catalystLocation(this.deps.setup.config());
  }

  async view(): Promise<unknown> {
    const fb = this.deps.firebase();
    const file = readCloudConfig(this.deps.supportDir);
    const databaseUrl = file?.firebase?.databaseUrl ?? fb.databaseUrl;
    const catalyst = this.deps.setup.config();
    const [cli, steps] = await Promise.all([
      this.deps.setup.cliStatus().catch(() => ({ installed: false, loggedIn: false })),
      this.deps.setup.steps().catch((): Step[] => []),
    ]);
    return {
      active: this.active(),
      firebase: {
        configured: Boolean(databaseUrl),
        projectId: file?.firebase?.projectId ?? fb.projectId,
        databaseUrl: databaseUrl ?? null,
        lastTest: this.lastTests.firebase,
      },
      catalyst: {
        configured: this.catalystLocation() !== null,
        cli,
        projectId: catalyst.projectId,
        projectName: catalyst.projectName,
        dc: catalyst.dc,
        appUrl: catalyst.appUrl,
        steps: this.deploying
          ? steps.map((step) => (step.id === "deploy" ? { ...step, state: "working" as const } : step))
          : steps,
        lastTest: this.lastTests.catalyst,
      },
    };
  }

  /** A throwaway channel on `location`: written, watched, read and deleted. Never real channel data. */
  async test(provider: CloudProvider): Promise<CloudTestResult> {
    const location = provider === "firebase" ? this.firebaseLocation() : this.catalystLocation();
    if (!location) {
      return this.record(provider, {
        ok: false,
        writeMs: null,
        readMs: null,
        noticeMs: null,
        error: provider === "firebase" ? "Firebase is not set up." : "Catalyst is not set up.",
      });
    }
    const store = this.deps.makeStore
      ? this.deps.makeStore(location)
      : createCloudStore(location, { fetch: this.deps.fetch });
    const channel = randomChannelId();
    const collection = `channels/${channel}/state`;
    const docPath = `${collection}/test`;
    const doc = { box: crypto.randomBytes(24).toString("base64"), at: this.now() };
    const result: CloudTestResult = { ok: false, writeMs: null, readMs: null, noticeMs: null };
    let wrote = false;
    let unwatch: (() => void) | null = null;
    try {
      let sinceWrite: number | null = null;
      let noticed: ((ms: number) => void) | null = null;
      const noticeSeen = new Promise<number>((resolve) => (noticed = resolve));
      let opened: (() => void) | null = null;
      const ready = new Promise<void>((resolve) => (opened = resolve));
      unwatch = store.watch(
        collection,
        () => {
          // The first wake is the watch's own (once on connect); only one after the write is its notice.
          if (sinceWrite !== null) noticed?.(this.now() - sinceWrite);
          else opened?.();
        },
        { onOpen: () => opened?.() },
      );
      await Promise.race([ready, delay(5_000)]);
      const t0 = this.now();
      sinceWrite = t0;
      wrote = true;
      await store.set(docPath, doc);
      result.writeMs = this.now() - t0;
      const t1 = this.now();
      const read = await store.get(docPath);
      result.readMs = this.now() - t1;
      if (!read || read.box !== doc.box) throw new Error("read-back");
      const notice = await Promise.race([noticeSeen, delay(this.deps.noticeTimeoutMs ?? 8_000).then(() => null)]);
      result.noticeMs = notice;
      result.ok = notice !== null;
      if (!result.ok) result.error = "The change notice did not arrive.";
    } catch {
      result.error = "The test round trip failed.";
    } finally {
      unwatch?.();
      if (wrote) await store.delete(docPath).catch(() => undefined);
      (store as { close?: () => void }).close?.();
    }
    return this.record(provider, result);
  }

  private record(provider: CloudProvider, result: CloudTestResult): CloudTestResult {
    this.lastTests[provider] = {
      at: this.now(),
      ok: result.ok,
      writeMs: result.writeMs,
      readMs: result.readMs,
      noticeMs: result.noticeMs,
    };
    return result;
  }

  async select(provider: CloudProvider): Promise<{ ok: boolean; moved: boolean; error?: string }> {
    if (this.moving) return { ok: false, moved: false, error: "A move is already running." };
    if (provider === this.active()) return { ok: true, moved: false };
    this.moving = true;
    try {
      const target = provider === "firebase" ? this.firebaseLocation() : this.catalystLocation();
      if (!target) {
        return {
          ok: false,
          moved: false,
          error: provider === "firebase" ? "Firebase is not set up." : "Catalyst is not set up.",
        };
      }
      if (provider === "catalyst") {
        const ping = await this.deps.setup.ping().catch(() => null);
        if (!ping || !ping.ok || ping.store !== "ready" || ping.channel !== "ready") {
          return { ok: false, moved: false, error: "Catalyst is not ready: finish its setup steps first." };
        }
      }
      const tested = await this.test(provider);
      if (!tested.ok) return { ok: false, moved: false, error: "The test round trip failed, so nothing moved." };
      try {
        // On the store the devices are on now, so they can follow.
        await this.deps.announceMove(target);
      } catch {
        return { ok: false, moved: false, error: "Could not tell the paired devices. Nothing moved." };
      }
      const store = this.deps.makeStore
        ? this.deps.makeStore(target)
        : createCloudStore(target, { fetch: this.deps.fetch });
      this.deps.store.switchTo(store, target);
      const file = readCloudConfig(this.deps.supportDir) ?? { active: "firebase" as const };
      writeCloudConfig(this.deps.supportDir, { ...file, active: provider });
      this.deps.onMoved?.(target);
      return { ok: true, moved: true };
    } finally {
      this.moving = false;
    }
  }

  /** `projects.patch` on the Firebase Management API with the Firebase CLI's own token. */
  async renameFirebase(displayName: string): Promise<{ ok: boolean; error?: string }> {
    const file = readCloudConfig(this.deps.supportDir);
    const projectId = file?.firebase?.projectId ?? this.deps.firebase().projectId;
    if (!projectId) return { ok: false, error: "Firebase is not set up." };
    const token = await (this.deps.firebaseToken ?? defaultFirebaseToken)().catch(() => null);
    if (!token) return { ok: false, error: "Sign in with the Firebase CLI first (firebase login), then try again." };
    try {
      const response = await (this.deps.fetch ?? fetch)(
        `https://firebase.googleapis.com/v1beta1/projects/${encodeURIComponent(projectId)}?updateMask=displayName`,
        {
          method: "PATCH",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ displayName }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      return response.ok ? { ok: true } : { ok: false, error: "Google refused the new name." };
    } catch {
      return { ok: false, error: "Could not reach Google. Try again." };
    }
  }

  /** The routes below `/control/cloud`: `method` and `route` (the path after it, "" for the root). */
  async handle(method: string, route: string, body: unknown): Promise<RouteAnswer> {
    const { setup } = this.deps;
    switch (`${method} ${route}`) {
      case "GET ":
        return ok(await this.view());
      case "GET /catalyst/projects": {
        try {
          return ok({ projects: await setup.listProjects() });
        } catch {
          return bad(
            "Could not list the Catalyst projects. Check that the Catalyst CLI is installed and signed in.",
            502,
          );
        }
      }
      case "POST /catalyst/project": {
        const parsed = exactKeys(body, ["projectId"]);
        if (!parsed || typeof parsed.projectId !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(parsed.projectId)) {
          return bad("Pick a project from the list.");
        }
        try {
          await setup.selectProject(parsed.projectId);
          return ok({ ok: true });
        } catch {
          return bad("Could not select that project. Check the Catalyst CLI is signed in.", 502);
        }
      }
      case "POST /catalyst/deploy": {
        if (!exactKeys(body, [])) return bad("Nothing to send: the body is {}.");
        if (this.deploying) return bad("A deploy is already running.", 409);
        this.deploying = true;
        try {
          await setup.deploy();
          return ok({ ok: true });
        } catch {
          return bad("The deploy did not finish. Check the steps for what is missing.", 502);
        } finally {
          this.deploying = false;
        }
      }
      case "POST /catalyst/check": {
        if (!exactKeys(body, [])) return bad("Nothing to send: the body is {}.");
        return ok(await this.view());
      }
      case "POST /test": {
        const provider = this.providerOf(body);
        return provider ? ok(await this.test(provider)) : bad("Say which provider: firebase or catalyst.");
      }
      case "POST /select": {
        const provider = this.providerOf(body);
        if (!provider) return bad("Say which provider: firebase or catalyst.");
        const outcome = await this.select(provider);
        return ok(outcome);
      }
      case "POST /firebase/rename": {
        const parsed = exactKeys(body, ["displayName"]);
        const name = typeof parsed?.displayName === "string" ? parsed.displayName.trim() : "";
        // eslint-disable-next-line no-control-regex
        if (name.length < 4 || name.length > 30 || /[\u0000-\u001f]/.test(name)) {
          return bad("A project name is 4 to 30 characters.");
        }
        return ok(await this.renameFirebase(name));
      }
      default:
        return bad("not found", 404);
    }
  }

  private providerOf(body: unknown): CloudProvider | null {
    const parsed = exactKeys(body, ["provider"]);
    return parsed?.provider === "firebase" || parsed?.provider === "catalyst" ? parsed.provider : null;
  }
}

function delay(ms: number): Promise<null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
}

/** The Firebase CLI's own access token: refreshed by a cheap CLI call, then read from its config store. */
export async function defaultFirebaseToken(): Promise<string | null> {
  await new Promise<void>((resolve) => {
    execFile("firebase", ["projects:list", "--json"], { timeout: 60_000 }, () => resolve());
  });
  const file = path.join(os.homedir(), ".config", "configstore", "firebase-tools.json");
  try {
    const root = JSON.parse(fs.readFileSync(file, "utf8")) as { tokens?: { access_token?: unknown } };
    const token = root.tokens?.access_token;
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
}
