/**
 * What the Mac app's Settings > Cloud tab asks the daemon (docs/cloud-layer.md, "Daemon control routes"):
 * the hosted cloud's state (cloud/hosted.ts), what an older install is still on, a test round trip, and the move
 * onto the hosted relay. Self-hosting (Catalyst deploy, Firebase setup, choosing a provider) is gone: those routes
 * answer 410. The routes
 * themselves (token gate, no CORS, JSON) are in `fleet/hook-ingress.ts`; every answer here is a fixed
 * sentence, never a CLI's output, a token or a key.
 */

import crypto from "node:crypto";

import {
  catalystLocation,
  createCloudStore,
  firebaseLocation,
  hostedLocation,
  readCloudConfig,
  writeCloudConfig,
} from "./config.js";
import type { HostedCloud } from "./hosted.js";
import type { CloudLocation, CloudProvider } from "./location.js";
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

export interface CloudControlDeps {
  supportDir: string;
  hosted: Pick<HostedCloud, "view" | "connect">;
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
  /** A hosted store's key was refused (revoked). */
  onUnauthorized?: () => void;
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

const REMOVED = new Set([
  "GET /catalyst/projects",
  "POST /catalyst/project",
  "POST /catalyst/deploy",
  "POST /catalyst/check",
  "POST /select",
  "POST /firebase/rename",
  "POST /firebase/setup",
  "POST /firebase/project",
  "POST /firebase/projects",
]);

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

  /** The hosted relay when this Mac holds a key, else an older own-relay Catalyst config. */
  private catalystLocation(): CloudLocation | null {
    const file = readCloudConfig(this.deps.supportDir);
    return hostedLocation(file?.hosted) ?? catalystLocation(file?.catalyst);
  }

  async view(): Promise<unknown> {
    const fb = this.deps.firebase();
    const file = readCloudConfig(this.deps.supportDir);
    const databaseUrl = file?.firebase?.databaseUrl ?? fb.databaseUrl;
    const catalyst = file?.catalyst;
    return {
      active: this.active(),
      hosted: this.deps.hosted.view(),
      firebase: {
        configured: Boolean(databaseUrl),
        projectId: file?.firebase?.projectId ?? fb.projectId,
        databaseUrl: databaseUrl ?? null,
        lastTest: this.lastTests.firebase,
      },
      catalyst: {
        configured: this.catalystLocation() !== null,
        projectId: catalyst?.projectId ?? null,
        projectName: catalyst?.projectName ?? null,
        dc: catalyst?.dc ?? "in",
        appUrl: catalyst?.appUrl ?? null,
        lastTest: this.lastTests.catalyst,
      },
    };
  }

  /** A throwaway channel on `location`: written, watched, read and deleted. Never real channel data. */
  async test(provider: CloudProvider): Promise<CloudTestResult> {
    return this.testLocation(provider, provider === "firebase" ? this.firebaseLocation() : this.catalystLocation());
  }

  private async testLocation(provider: CloudProvider, location: CloudLocation | null): Promise<CloudTestResult> {
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
      // A stream sends its own snapshot when it opens (Firebase's first "put"), sometimes after `onOpen`: that wake
      // must not count as the notice (it read as 0 ms). Wait for the open, then up to 1.5 s for that first wake.
      let opened: (() => void) | null = null;
      const ready = new Promise<void>((resolve) => (opened = resolve));
      let firstWake: (() => void) | null = null;
      const settled = new Promise<void>((resolve) => (firstWake = resolve));
      unwatch = store.watch(
        collection,
        () => {
          if (sinceWrite !== null) noticed?.(this.now() - sinceWrite);
          else firstWake?.();
        },
        { onOpen: () => opened?.() },
      );
      await Promise.race([ready, delay(5_000)]);
      await Promise.race([settled, delay(1_500)]);
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

  /**
   * The move onto `target` (the hosted relay): a round trip on it first, then the paired devices are told on the store
   * they are on now, then the daemon switches and records it. Nothing changes unless every step held.
   */
  async moveTo(target: CloudLocation): Promise<{ ok: boolean; error?: string }> {
    if (this.moving) return { ok: false, error: "A move is already running." };
    this.moving = true;
    try {
      const tested = await this.testLocation("catalyst", target);
      if (!tested.ok) return { ok: false, error: "The test round trip failed, so nothing moved." };
      try {
        // On the store the devices are on now, so they can follow.
        await this.deps.announceMove(target);
      } catch {
        return { ok: false, error: "Could not tell the paired devices. Nothing moved." };
      }
      const store = this.deps.makeStore
        ? this.deps.makeStore(target)
        : createCloudStore(target, {
            ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
            ...(this.deps.onUnauthorized ? { onUnauthorized: this.deps.onUnauthorized } : {}),
          });
      this.deps.store.switchTo(store, target);
      const file = readCloudConfig(this.deps.supportDir) ?? { active: "firebase" as const };
      writeCloudConfig(this.deps.supportDir, { ...file, active: "hosted" });
      this.deps.onMoved?.(target);
      return { ok: true };
    } finally {
      this.moving = false;
    }
  }

  /** The routes below `/control/cloud`: `method` and `route` (the path after it, "" for the root). */
  async handle(method: string, route: string, body: unknown): Promise<RouteAnswer> {
    switch (`${method} ${route}`) {
      case "GET ":
        return ok(await this.view());
      case "POST /hosted/connect": {
        if (!exactKeys(body, [])) return bad("Nothing to send: the body is {}.");
        if (!this.deps.hosted.connect()) return bad("not-signed-in", 409);
        return { status: 202, body: { ok: true } };
      }
      case "POST /test": {
        const provider = this.providerOf(body);
        return provider ? ok(await this.test(provider)) : bad("Say which provider: firebase or catalyst.");
      }
      default:
        // Self-hosting is gone: nobody deploys a relay, makes a Firebase project or picks a provider any more.
        return REMOVED.has(`${method} ${route}`) ? bad("self-hosting-removed", 410) : bad("not found", 404);
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
