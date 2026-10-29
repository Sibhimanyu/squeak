import crypto from "node:crypto";

import type { RtdbRest } from "../remote/rtdb-rest.js";
import {
  makePairingCode,
  pairPath,
  PAIR_GRANT_ID,
  PAIR_REQUEST_ID,
  readPairRequest,
  sealPairGrant,
  type PairingCode,
} from "./pair-protocol.js";

export type PairStore = Pick<RtdbRest, "get" | "set" | "delete" | "watch">;

export type PairingState = "waiting" | "request" | "done" | "expired";

/** What `GET /control/voice/gateway` carries for the window; never the code, the secret, the key or the channel. */
export interface PairingView {
  state: PairingState;
  expiresAt: number;
  name?: string;
  version?: string;
  verify?: string;
}

export interface GatewayPairingOptions {
  store: PairStore;
  /** The phone channel's database (`SQUEAK_REMOTE_DATABASE_URL`). */
  databaseUrl: string;
  /** The channel and key the Mac already has for the gateway, or null before the first pairing. */
  current(): { channel: string; key: string } | null;
  /** Saves a newly made channel and key (to `.env`). */
  save(channel: string, key: string): void;
  /** Called once a grant that changed the saved channel or key is written: the daemon must restart to use it. */
  restart(): void;
  now?: () => number;
  /** Watch is the fast path; this is the safety net and the way to notice a lost event. */
  pollMs?: number;
  /** How long after a grant the pairing documents are deleted. */
  cleanupMs?: number;
  /** How long after a grant the daemon restarts, so the answer to the app goes out first. */
  restartMs?: number;
  /** How long a finished window stays in the view. */
  doneViewMs?: number;
}

/** The state as it is now: `expireIfDue` and a late poll change it behind a narrowing check. */
function stateOf(window: Window): PairingState {
  return window.state;
}

interface Window {
  code: PairingCode;
  state: PairingState;
  request: { name: string; version: string; verify: string; at: number } | null;
  doneAt: number | null;
  stop: () => void;
}

/**
 * The pairing window for one Home Assistant gateway (src/voice/pair-protocol.ts): opens a one-time code, watches the
 * rendezvous for the add-on's request, and after the person approves seals the Mac's channel and key for it. One window
 * at a time; a new `start()` replaces the old one. The code and secret leave only in `start()`'s return value.
 */
export class GatewayPairing {
  private window: Window | null = null;
  private readonly now: () => number;

  constructor(private readonly options: GatewayPairingOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): { code: string; expiresAt: number } {
    this.close(true);
    const code = makePairingCode(this.options.databaseUrl, this.now());
    const window: Window = { code, state: "waiting", request: null, doneAt: null, stop: () => undefined };
    this.window = window;
    const poll = () => void this.poll(window);
    const unwatch = this.options.store.watch(pairPath(code.rendezvous, PAIR_REQUEST_ID), poll);
    const timer = setInterval(poll, this.options.pollMs ?? 2000);
    timer.unref?.();
    window.stop = () => {
      unwatch();
      clearInterval(timer);
    };
    poll();
    return { code: code.code, expiresAt: code.expiresAt };
  }

  view(): PairingView | null {
    const window = this.window;
    if (!window) return null;
    const now = this.now();
    if (
      window.state === "done" &&
      window.doneAt !== null &&
      now - window.doneAt > (this.options.doneViewMs ?? 60_000)
    ) {
      this.window = null;
      return null;
    }
    this.expireIfDue(window);
    const view: PairingView = { state: window.state, expiresAt: window.code.expiresAt };
    if (window.state === "request" && window.request) {
      view.name = window.request.name;
      view.version = window.request.version;
      view.verify = window.request.verify;
    }
    return view;
  }

  async approve(yes: boolean): Promise<{ ok: true } | { ok: false; reason: string }> {
    const window = this.window;
    if (!window) return { ok: false, reason: "No gateway is waiting to pair. Start again from Add gateway." };
    this.expireIfDue(window);
    if (window.state === "expired") return { ok: false, reason: "That code ran out. Start again from Add gateway." };
    if (window.state !== "request" || !window.request) {
      return { ok: false, reason: "No gateway has asked to pair yet." };
    }
    const { store } = this.options;
    const { rendezvous, secret } = window.code;
    if (!yes) {
      window.state = "waiting";
      window.request = null;
      try {
        await store.delete(pairPath(rendezvous, PAIR_REQUEST_ID));
      } catch {
        // The window no longer shows it; the add-on's own timeout ends its side.
      }
      return { ok: true };
    }
    const existing = this.options.current();
    const channel = existing?.channel ?? crypto.randomBytes(16).toString("base64url");
    const key = existing?.key ?? crypto.randomBytes(32).toString("base64");
    try {
      await store.set(
        pairPath(rendezvous, PAIR_GRANT_ID),
        sealPairGrant(secret, { v: 1, channel, key, at: this.now() }),
      );
    } catch {
      return { ok: false, reason: "Could not reach the database. Try again." };
    }
    window.state = "done";
    window.doneAt = this.now();
    window.stop();
    if (!existing) {
      this.options.save(channel, key);
      const timer = setTimeout(() => this.options.restart(), this.options.restartMs ?? 1500);
      timer.unref?.();
    }
    const cleanup = setTimeout(() => {
      void store.delete(pairPath(rendezvous, PAIR_REQUEST_ID)).catch(() => undefined);
      void store.delete(pairPath(rendezvous, PAIR_GRANT_ID)).catch(() => undefined);
    }, this.options.cleanupMs ?? 30_000);
    cleanup.unref?.();
    return { ok: true };
  }

  /** Stops watching; documents of an open window are left to expire. */
  stop(): void {
    this.close(false);
  }

  private close(deleteDocs: boolean): void {
    const window = this.window;
    this.window = null;
    if (!window) return;
    window.stop();
    if (deleteDocs && window.state !== "done") {
      void this.options.store.delete(pairPath(window.code.rendezvous, PAIR_REQUEST_ID)).catch(() => undefined);
    }
  }

  private expireIfDue(window: Window): void {
    if (window.state === "done" || window.state === "expired" || this.now() < window.code.expiresAt) return;
    window.state = "expired";
    window.request = null;
    window.stop();
    void this.options.store.delete(pairPath(window.code.rendezvous, PAIR_REQUEST_ID)).catch(() => undefined);
  }

  private async poll(window: Window): Promise<void> {
    if (this.window !== window || window.state === "done" || window.state === "expired") return;
    this.expireIfDue(window);
    if (stateOf(window) === "expired") return;
    try {
      const doc = await this.options.store.get(pairPath(window.code.rendezvous, PAIR_REQUEST_ID));
      if (this.window !== window || stateOf(window) === "done" || stateOf(window) === "expired") return;
      const request = doc ? readPairRequest(window.code.secret, doc, this.now()) : null;
      if (request) {
        window.request = request;
        window.state = "request";
      } else if (window.state === "request") {
        window.request = null;
        window.state = "waiting";
      }
    } catch {
      // Offline for a moment: the next poll tries again.
    }
  }
}
