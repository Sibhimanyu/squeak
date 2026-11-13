/**
 * Squeak's hosted cloud (docs/cloud-layer.md, "Squeak's hosted relay: per-Mac keys"). Nobody hosts their own cloud:
 * Squeak runs one relay for everyone, and signing in on the Mac is the setup. This file is the Mac's side:
 *
 *   needs-sign-in  no account token and no key: the Mac app's sign-in hands the daemon a token (`signIn`)
 *   connecting     provisioning (`POST /account/macs/provision`), or telling paired phones to follow a `move`
 *   ready          this Mac holds its own key and the daemon runs on the hosted relay
 *   error          something only the person can fix (too many Macs, a Mac id taken by another account)
 *
 * The account token (30 days) is kept in `hosted-account.json` (0600) only until the Mac holds its key; the key goes
 * to `cloud.json` (0600) and is never logged, echoed or sent anywhere but the relay. Answers are fixed sentences.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { logger } from "../utils/logger.js";
import { hostedLocation, readCloudConfig, writeCloudConfig, type CloudConfig, type HostedConfig } from "./config.js";
import {
  ACCOUNT_RELAY_URL,
  WEB_APP_URL,
  pinnedRelayBase,
  relayBaseUrl,
  validRelayKey,
  type CloudLocation,
} from "./location.js";

/** Squeak's own relay: the Catalyst app the owner deployed (the iPhone app's sign-in default is the same project). */
export const HOSTED_RELAY_URL = ACCOUNT_RELAY_URL;

/** `SQUEAK_CLOUD_URL` when it is a Catalyst relay address, else Squeak's relay. */
export function hostedRelayUrl(env: Record<string, string | undefined> = process.env): string {
  return relayBaseUrl(env.SQUEAK_CLOUD_URL?.trim()) ?? relayBaseUrl(HOSTED_RELAY_URL)!;
}

export type HostedState = "needs-sign-in" | "connecting" | "ready" | "error";
export type LegacyCloud = "firebase" | "shared" | "catalyst-own";

/** The contract the Mac app reads: `GET /control/cloud` `.hosted` and `/state` `.cloud.hosted`. */
export interface HostedView {
  state: HostedState;
  email?: string;
  error?: string;
  legacy: LegacyCloud | null;
  moving?: boolean;
  /** Additive: this Mac holds its key but the move onto the hosted relay is held (`deferMove`); `POST /control/cloud/move-now` runs it. */
  moveDeferred?: boolean;
  /** Additive: the page the browser opens to sign in (the relay's own `/app/index.html`). */
  signInUrl?: string;
  /** Additive: the web app's home (a browser's pairing link and "Copy web link" use it; `signInUrl` stays the account origin's). */
  webUrl?: string;
  /** Additive: where sign-in, linking and provisioning go (the function). */
  accountUrl?: string;
  /** Additive: where this Mac's device traffic goes (the function until a relay origin is named). */
  relayUrl?: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface AccountFile {
  token: string;
  email: string;
  name?: string;
}

export interface HostedDeps {
  supportDir: string;
  url: string;
  /** What the daemon runs on right now: null (nothing set up), or the location of its store. */
  current: () => CloudLocation | null;
  /** Which old cloud the Mac is on, for `legacy`; null when it is on none. */
  legacy: () => LegacyCloud | null;
  /** This Mac's existing phone-channel id (remote.json), or null. */
  channelId: () => string | null;
  /** Tells paired phones, switches the daemon to the hosted store and records it as active. */
  moveTo: (target: CloudLocation) => Promise<{ ok: boolean; error?: string }>;
  /** Nothing was set up before: the daemon restarts once to build everything on the new store. */
  restart: () => void;
  /**
   * Hold the move of an install that already runs on an older cloud: the key is provisioned, nothing moves until
   * `moveNow()`. `SQUEAK_CLOUD_DEFER_MOVE=on` or a `cloud-defer-move` file in the support dir (see `deferMoveRequested`).
   */
  deferMove?: () => boolean;
  fetch?: FetchLike;
  /** Waits between tries after a network error; the last repeats. Tests pass short ones. */
  retryMs?: number[];
  name?: () => string;
  /** Called after provisioning and the move settled without an error (the daemon links a held ticket then). */
  onSettled?: () => void;
}

const SIGN_IN = "Sign in to Squeak to use your phone, the web and Cliq.";
const RETRY_MS = [5_000, 15_000, 60_000, 300_000];
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{8,2048}$/;
const MAC_ID = /^[A-Za-z0-9_-]{22,64}$/;

class Refused extends Error {
  constructor(
    readonly kind: "signed-out" | "fatal" | "retry",
    message: string,
  ) {
    super(message);
  }
}

export class HostedCloud {
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private error: string | null = null;
  private moving = false;
  private deferred = false;
  private forceMove = false;
  private stopped = false;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly deps: HostedDeps) {
    this.fetchImpl = deps.fetch ?? fetch;
  }

  private accountPath(): string {
    return path.join(this.deps.supportDir, "hosted-account.json");
  }

  private readAccount(): AccountFile | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.accountPath(), "utf8")) as Record<string, unknown>;
      return typeof raw.token === "string" && TOKEN_SHAPE.test(raw.token) && typeof raw.email === "string"
        ? {
            token: raw.token,
            email: raw.email,
            ...(typeof raw.name === "string" && raw.name ? { name: raw.name } : {}),
          }
        : null;
    } catch {
      return null;
    }
  }

  private writeAccount(account: AccountFile): void {
    fs.mkdirSync(this.deps.supportDir, { recursive: true });
    const temp = `${this.accountPath()}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(account), { mode: 0o600 });
    fs.renameSync(temp, this.accountPath());
  }

  /** The account's display name, kept with the Mac's key so ponds can call this person by it. */
  private rememberName(name: string): void {
    const file = readCloudConfig(this.deps.supportDir);
    if (!file?.hosted || file.hosted.name === name) return;
    writeCloudConfig(this.deps.supportDir, { ...file, hosted: { ...file.hosted, name } });
  }

  private clearAccount(): void {
    fs.rmSync(this.accountPath(), { force: true });
  }

  /** The hosted key this Mac holds (valid shape), whether or not the daemon runs on it yet. */
  private held(): HostedConfig | null {
    const hosted = readCloudConfig(this.deps.supportDir)?.hosted;
    return hosted && hostedLocation(hosted) ? hosted : null;
  }

  private onHosted(): boolean {
    const file = readCloudConfig(this.deps.supportDir);
    return file?.active === "hosted" && Boolean(hostedLocation(file.hosted));
  }

  view(): HostedView {
    const held = this.held();
    const account = this.readAccount();
    const email = held?.email ?? account?.email;
    const base = {
      ...(email ? { email } : {}),
      signInUrl: `${new URL(this.deps.url).origin}/app/index.html`,
      webUrl: WEB_APP_URL,
      accountUrl: this.deps.url,
      relayUrl: pinnedRelayBase(held?.relay) ?? this.deps.url,
    };
    if (this.onHosted()) return { state: "ready", ...base, legacy: null };
    const legacy = this.deps.legacy();
    if (this.error) return { state: "error", ...base, error: this.error, legacy };
    if (this.running || this.timer || held || account) {
      return {
        state: "connecting",
        ...base,
        legacy,
        ...(this.moving ? { moving: true } : {}),
        ...(this.deferred && !this.moving ? { moveDeferred: true } : {}),
      };
    }
    return { state: "needs-sign-in", ...base, legacy };
  }

  /** At daemon start: pick up what an earlier run left (a token to provision with, a key whose move did not finish). */
  start(): void {
    this.stopped = false;
    if (this.onHosted()) return;
    if (this.held() || this.readAccount()) this.kick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * The Mac app's sign-in: a Squeak account token (`x-squeak-account`). Checked against the relay's `/me`, kept
   * until the Mac holds its key, and provisioning starts.
   */
  async signIn(token: unknown): Promise<{ ok: true; email: string } | { ok: false; reason: string }> {
    if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) {
      return { ok: false, reason: "That sign-in could not be read. Sign in again." };
    }
    let email: string;
    let name = "";
    try {
      const response = await this.fetchImpl(`${this.deps.url}/me`, {
        headers: { "x-squeak-account": token },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401) return { ok: false, reason: "That sign-in expired. Sign in again." };
      if (!response.ok) throw new Error("me");
      const body = (await response.json().catch(() => null)) as { email?: unknown; name?: unknown } | null;
      if (!body || typeof body.email !== "string" || !body.email) throw new Error("me");
      email = body.email.slice(0, 320);
      if (typeof body.name === "string") name = body.name.replace(/\p{C}/gu, "").trim().slice(0, 100);
    } catch {
      return { ok: false, reason: "Squeak's cloud did not answer. Try again in a moment." };
    }
    this.writeAccount({ token, email, ...(name ? { name } : {}) });
    // Already holding a key (signing in again): the name follows the account at once.
    if (name) this.rememberName(name);
    this.error = null;
    this.kick();
    return { ok: true, email };
  }

  private ticketPath(): string {
    return path.join(this.deps.supportDir, "hosted-ticket.json");
  }

  /**
   * One-step sign-in: the page's link ticket waits (0600, never logged, at most 10 minutes, the relay's own ticket
   * lifetime) for the Mac's channel on the hosted relay, which a brand-new Mac only gets after provisioning.
   */
  holdTicket(ticket: string, now = Date.now()): void {
    fs.mkdirSync(this.deps.supportDir, { recursive: true });
    fs.writeFileSync(this.ticketPath(), JSON.stringify({ ticket, at: now }), { mode: 0o600 });
  }

  /** The held ticket if it is still young, else null (a stale one is deleted). */
  heldTicket(now = Date.now()): string | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.ticketPath(), "utf8")) as { ticket?: unknown; at?: unknown };
      if (
        typeof raw.ticket === "string" &&
        typeof raw.at === "number" &&
        now - raw.at >= 0 &&
        now - raw.at < 9 * 60_000
      )
        return raw.ticket;
    } catch {
      // none held
    }
    this.dropTicket();
    return null;
  }

  dropTicket(): void {
    fs.rmSync(this.ticketPath(), { force: true });
  }

  /** `POST /control/cloud/hosted/connect`: (re)start with what is linked; false when there is no account at all. */
  connect(): boolean {
    if (!this.readAccount() && !this.held()) return false;
    this.error = null;
    this.attempt = 0;
    this.kick();
    return true;
  }

  /** `POST /control/cloud/move-now`: runs a held move. False when this Mac has no account and no key. */
  moveNow(): boolean {
    if (!this.readAccount() && !this.held()) return false;
    this.forceMove = true;
    this.deferred = false;
    this.error = null;
    this.attempt = 0;
    if (this.running) void this.running.then(() => this.kick());
    else this.kick();
    return true;
  }

  /**
   * Names where device traffic goes (a pinned origin) or, with null, puts it back on the account origin, then runs the
   * same move as everything else (round trip on the target first, paired devices told, daemon switched). Nothing is
   * saved unless the move held. Sign-in and provisioning never leave `deps.url`.
   */
  async setRelay(relay: string | null): Promise<{ ok: boolean; error?: string }> {
    const target = relay === null ? null : pinnedRelayBase(relay);
    if (relay !== null && !target) return { ok: false, error: "That relay is not one Squeak uses." };
    const file = readCloudConfig(this.deps.supportDir);
    const held = file?.hosted && hostedLocation(file.hosted) ? file.hosted : null;
    if (!file || !held) return { ok: false, error: "This Mac holds no hosted key yet." };
    const next: HostedConfig = { ...held };
    delete next.relay;
    if (target && target !== pinnedRelayBase(this.deps.url)) next.relay = target;
    const location = hostedLocation(next);
    if (!location) return { ok: false, error: "That relay is not one Squeak uses." };
    const moved = await this.deps.moveTo(location);
    if (!moved.ok) return moved;
    const after = readCloudConfig(this.deps.supportDir) ?? file;
    writeCloudConfig(this.deps.supportDir, { ...after, hosted: next });
    return { ok: true };
  }

  /** The relay refused this Mac's key (revoked): forget it and go back to needing a sign-in. */
  onUnauthorized(): void {
    const file = readCloudConfig(this.deps.supportDir);
    if (!file?.hosted) return;
    const wasActive = file.active === "hosted";
    const rest: CloudConfig = { ...file, active: wasActive ? "firebase" : file.active };
    delete rest.hosted;
    writeCloudConfig(this.deps.supportDir, rest);
    this.clearAccount();
    this.error = null;
    this.stop();
    logger.warn("hosted cloud key was refused; sign in again");
    // A daemon that ran on the hosted store restarts onto whatever is left (an older cloud, or none).
    if (wasActive) this.deps.restart();
  }

  private kick(): void {
    if (this.running || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.running = this.run()
      .catch(() => undefined)
      .finally(() => {
        this.running = null;
      });
  }

  private schedule(): void {
    if (this.stopped) return;
    const waits = this.deps.retryMs ?? RETRY_MS;
    const wait = waits[Math.min(this.attempt, waits.length - 1)] ?? 5_000;
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, wait);
    this.timer.unref?.();
  }

  private async run(): Promise<void> {
    try {
      let held = this.held();
      if (!held) {
        const account = this.readAccount();
        if (!account) return;
        held = await this.provision(account);
      }
      if (!this.onHosted() && this.deps.current() !== null && !this.forceMove && (this.deps.deferMove?.() ?? false)) {
        this.deferred = true;
        this.attempt = 0;
        this.error = null;
        logger.info("hosted cloud: key held, move deferred until move-now");
        return;
      }
      this.deferred = false;
      await this.migrate(held);
      this.forceMove = false;
      this.attempt = 0;
      this.error = null;
      this.deps.onSettled?.();
    } catch (error) {
      if (error instanceof Refused && error.kind === "signed-out") {
        this.clearAccount();
        this.error = null;
        return;
      }
      if (error instanceof Refused && error.kind === "fatal") {
        this.error = error.message;
        return;
      }
      logger.warn("hosted cloud: will retry");
      this.schedule();
    }
  }

  private macId(): string {
    const existing = this.deps.channelId();
    if (existing && MAC_ID.test(existing)) return existing;
    const held = readCloudConfig(this.deps.supportDir)?.hosted?.macId;
    return held && MAC_ID.test(held) ? held : crypto.randomBytes(16).toString("base64url");
  }

  private async provision(account: AccountFile): Promise<HostedConfig> {
    const macId = this.macId();
    const name = (this.deps.name?.() ?? os.hostname().replace(/\.local$/, "")).replace(/[^\P{C}]/gu, "").slice(0, 64);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.deps.url}/account/macs/provision`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-squeak-account": account.token },
        body: JSON.stringify({ macId, name }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Refused("retry", "network");
    }
    if (response.status === 401) throw new Refused("signed-out", SIGN_IN);
    if (response.status === 409) throw new Refused("fatal", "This account already has the most Macs it can use.");
    if (response.status === 403) throw new Refused("fatal", "This Mac belongs to another Squeak account.");
    if (response.status === 400) throw new Refused("fatal", "Squeak's cloud did not accept this Mac.");
    if (!response.ok) throw new Refused("retry", "server");
    const body = (await response.json().catch(() => null)) as {
      macId?: unknown;
      key?: unknown;
      relay?: unknown;
    } | null;
    if (!body || body.macId !== macId || !validRelayKey(body.key)) {
      throw new Refused("retry", "answer");
    }
    // The key exists only in this answer: write it before anything else can fail.
    const hosted: HostedConfig = {
      provider: "catalyst",
      url: this.deps.url,
      macKey: body.key,
      macId,
      hosted: true,
      email: account.email,
      ...(account.name ? { name: account.name } : {}),
      // A relay origin the answer names counts only if it is one of the pinned ones; otherwise device traffic stays on `url`.
      ...(pinnedRelayBase(body.relay) ? { relay: pinnedRelayBase(body.relay)! } : {}),
    };
    const file = readCloudConfig(this.deps.supportDir) ?? { active: "firebase" as const };
    const fresh = this.deps.current() === null;
    writeCloudConfig(this.deps.supportDir, { ...file, hosted, ...(fresh ? { active: "hosted" as const } : {}) });
    this.clearAccount();
    return hosted;
  }

  /** From the old cloud (or from nothing) onto the hosted one. */
  private async migrate(hosted: HostedConfig): Promise<void> {
    if (this.onHosted()) {
      if (this.deps.current()?.provider === "catalyst" && (this.deps.current() as { hosted?: true }).hosted) return;
      // Nothing was running before (a fresh install): build everything on the new store.
      this.deps.restart();
      return;
    }
    const target = hostedLocation(hosted);
    if (!target) throw new Refused("fatal", "Squeak's cloud did not accept this Mac.");
    this.moving = true;
    try {
      const moved = await this.deps.moveTo(target);
      if (!moved.ok) throw new Refused("retry", "move");
    } finally {
      this.moving = false;
    }
  }
}

/** The hold on moving an existing install: `SQUEAK_CLOUD_DEFER_MOVE=on`, or a `cloud-defer-move` file in the support dir. */
export function deferMoveRequested(supportDir: string, env: Record<string, string | undefined> = process.env): boolean {
  if (/^(1|on|true|yes)$/i.test(env.SQUEAK_CLOUD_DEFER_MOVE?.trim() ?? "")) return true;
  return fs.existsSync(path.join(supportDir, "cloud-defer-move"));
}
