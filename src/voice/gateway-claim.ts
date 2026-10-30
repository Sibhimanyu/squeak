import crypto from "node:crypto";

import type { RtdbRest } from "../remote/rtdb-rest.js";
import {
  CLAIM_GRANT_ID,
  CLAIM_REQUEST_ID,
  CLAIM_TTL_MS,
  claimIdOf,
  claimPath,
  normalizeClaimCode,
  readClaimRequest,
  sealClaimGrant,
  type ClaimRequest,
} from "./claim-protocol.js";
import type { PairingState, PairingView } from "./pairing-window.js";

export type ClaimStore = Pick<RtdbRest, "get" | "set" | "delete">;

export interface GatewayClaimOptions {
  /** The rendezvous database (`RENDEZVOUS_DATABASE`), where the add-on posts its request. */
  store: ClaimStore;
  /** The Mac's own phone-channel database (`SQUEAK_REMOTE_DATABASE_URL`) the grant points the add-on at. */
  databaseUrl: string;
  /** The channel and key the Mac already has for the gateway, or null before the first pairing. */
  current(): { channel: string; key: string } | null;
  /** Saves a newly made channel and key (to `.env`). */
  save(channel: string, key: string): void;
  /** Called once a grant that made a new saved channel or key is written: the daemon restarts to use it. */
  restart(): void;
  now?: () => number;
  /** How often the request is looked at again, to notice the add-on made a new code. */
  pollMs?: number;
  cleanupMs?: number;
  restartMs?: number;
  doneViewMs?: number;
}

export type ClaimStartResult =
  | { ok: true; name: string; version: string; expiresAt: number }
  | { ok: false; status: 400 | 503; reason: string };

interface Claim {
  code: string;
  claimId: string;
  request: ClaimRequest;
  state: PairingState;
  expiresAt: number;
  doneAt: number | null;
  timer: NodeJS.Timeout | null;
}

/** Why a typed code cannot be one: the add-on never shows 0, 1, O, I or L, so a typo of those is named, not "not found". */
export function badCodeReason(input: unknown): string {
  const flat = typeof input === "string" ? input.toUpperCase().replace(/[\s-]/g, "") : "";
  if (/[01OIL]/.test(flat)) {
    return "A code never has the characters 0, 1, O, I or L. Look again at the add-on's panel: it is letters and the digits 2 to 9.";
  }
  if (flat.length !== 8) return "A code is 8 characters, like K7M2-QX9P.";
  return UNKNOWN_CODE;
}

const UNKNOWN_CODE = "That code isn't showing on an add-on. Check it, or open the add-on's panel for a new one.";

/**
 * Pairing by a short code the add-on shows (src/voice/claim-protocol.ts): the person types it, the Mac reads the
 * add-on's sealed request, and after approval seals the Mac's own channel and key to it. One claim at a time; a new
 * `start()` replaces the old one. The typed code, channel and key are never logged or put in a view.
 */
export class GatewayClaim {
  private claim: Claim | null = null;
  private readonly now: () => number;

  constructor(private readonly options: GatewayClaimOptions) {
    this.now = options.now ?? Date.now;
  }

  async start(input: unknown): Promise<ClaimStartResult> {
    const code = normalizeClaimCode(input);
    if (!code) return { ok: false, status: 400, reason: badCodeReason(input) };
    const claimId = claimIdOf(code);
    let request: ClaimRequest | null;
    try {
      const doc = await this.options.store.get(claimPath(claimId, CLAIM_REQUEST_ID));
      request = doc ? readClaimRequest(code, doc, this.now()) : null;
    } catch {
      return { ok: false, status: 503, reason: "Could not reach the pairing service. Try again." };
    }
    if (!request) return { ok: false, status: 400, reason: UNKNOWN_CODE };
    this.close();
    const claim: Claim = {
      code,
      claimId,
      request,
      state: "request",
      expiresAt: request.at + CLAIM_TTL_MS,
      doneAt: null,
      timer: null,
    };
    this.claim = claim;
    claim.timer = setInterval(() => void this.poll(claim), this.options.pollMs ?? 3000);
    claim.timer.unref?.();
    return { ok: true, name: request.name, version: request.version, expiresAt: claim.expiresAt };
  }

  /** The same shape as the legacy pairing window's view, without `verify`. */
  view(): PairingView | null {
    const claim = this.claim;
    if (!claim) return null;
    const now = this.now();
    if (claim.state === "done" && claim.doneAt !== null && now - claim.doneAt > (this.options.doneViewMs ?? 60_000)) {
      this.claim = null;
      return null;
    }
    this.expireIfDue(claim);
    const view: PairingView = { state: claim.state, expiresAt: claim.expiresAt };
    if (claim.state === "request") {
      view.name = claim.request.name;
      view.version = claim.request.version;
    }
    return view;
  }

  async approve(yes: boolean): Promise<{ ok: true } | { ok: false; reason: string }> {
    const claim = this.claim;
    if (!claim) return { ok: false, reason: "No gateway is waiting to pair. Start again from Add gateway." };
    this.expireIfDue(claim);
    if (claim.state === "expired") return { ok: false, reason: "That code ran out. Start again from Add gateway." };
    if (claim.state !== "request") return { ok: false, reason: "No gateway has asked to pair yet." };
    const { store } = this.options;
    const requestPath = claimPath(claim.claimId, CLAIM_REQUEST_ID);
    const grantPath = claimPath(claim.claimId, CLAIM_GRANT_ID);
    if (!yes) {
      this.close();
      await store.delete(requestPath).catch(() => undefined);
      return { ok: true };
    }
    const existing = this.options.current();
    const channel = existing?.channel ?? crypto.randomBytes(16).toString("base64url");
    const key = existing?.key ?? crypto.randomBytes(32).toString("base64");
    try {
      await store.set(
        grantPath,
        sealClaimGrant(claim.code, claim.request, { databaseUrl: this.options.databaseUrl, channel, key }, this.now()),
      );
    } catch {
      return { ok: false, reason: "Could not reach the pairing service. Try again." };
    }
    claim.state = "done";
    claim.doneAt = this.now();
    this.stopTimer(claim);
    if (!existing) {
      this.options.save(channel, key);
      const timer = setTimeout(() => this.options.restart(), this.options.restartMs ?? 1500);
      timer.unref?.();
    }
    // The add-on deletes both once it has read the grant; this is the safety net.
    const cleanup = setTimeout(() => {
      void store.delete(requestPath).catch(() => undefined);
      void store.delete(grantPath).catch(() => undefined);
    }, this.options.cleanupMs ?? 10_000);
    cleanup.unref?.();
    return { ok: true };
  }

  stop(): void {
    this.close();
  }

  private close(): void {
    const claim = this.claim;
    this.claim = null;
    if (claim) this.stopTimer(claim);
  }

  private stopTimer(claim: Claim): void {
    if (claim.timer) clearInterval(claim.timer);
    claim.timer = null;
  }

  private expireIfDue(claim: Claim): void {
    if (claim.state === "done" || claim.state === "expired" || this.now() < claim.expiresAt) return;
    claim.state = "expired";
    this.stopTimer(claim);
  }

  private async poll(claim: Claim): Promise<void> {
    if (this.claim !== claim || claim.state !== "request") return;
    this.expireIfDue(claim);
    if (claim.state !== "request") return;
    try {
      const doc = await this.options.store.get(claimPath(claim.claimId, CLAIM_REQUEST_ID));
      if (this.claim !== claim || claim.state !== "request") return;
      const request = doc ? readClaimRequest(claim.code, doc, this.now()) : null;
      // The add-on took it down or made a new code: this one is over.
      if (!request || request.publicKey !== claim.request.publicKey) {
        claim.state = "expired";
        this.stopTimer(claim);
      }
    } catch {
      // Offline for a moment: the next poll tries again.
    }
  }
}
