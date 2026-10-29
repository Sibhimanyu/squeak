import crypto from "node:crypto";

import type { ChannelDoc } from "../remote/firestore-rest.js";
import { openBody, sealBody } from "./relay-protocol.js";

/**
 * Pairing the Home Assistant gateway with the Mac without anyone copying a channel, a key or a database address
 * (docs: .context/gateway-pairing-contract.md). The Mac makes one short code that carries the database address and a
 * one-time secret; the add-on takes it as its `pairing_code` option and asks to pair on a rendezvous channel only the
 * code's holder can derive; the human approves on the Mac; the Mac then seals the real channel and key under a key
 * derived from the same secret. The database stays an untrusted pipe: every body is sealed and signed.
 */

export const PAIR_KIND = "voicepair";
/** A code works this long, once. */
export const PAIR_TTL_MS = 10 * 60_000;
const PREFIX = "SQ1-";

export interface PairingCode {
  /** What the human copies. */
  code: string;
  secret: string;
  /** The channel id the two meet on, derived from the secret. */
  rendezvous: string;
  expiresAt: number;
}

export interface ReadPairingCode {
  databaseUrl: string;
  secret: string;
  rendezvous: string;
}

/** An https Firebase Realtime Database, as everywhere else in Squeak; its origin, or null. */
export function realtimeDatabaseOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      (url.hostname.endsWith(".firebasedatabase.app") || url.hostname.endsWith(".firebaseio.com"))
    ) {
      return `https://${url.hostname}`;
    }
  } catch {
    // Not a URL.
  }
  return null;
}

function derive(secret: string, info: string, length: number): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret, "base64url"), Buffer.alloc(0), info, length));
}

function rendezvousOf(secret: string): string {
  return derive(secret, "squeak-voice-pair-id", 16).toString("base64url");
}

function keyOf(secret: string): string {
  return derive(secret, "squeak-voice-pair-key", 32).toString("base64");
}

export function makePairingCode(databaseUrl: string, now: number): PairingCode {
  const origin = realtimeDatabaseOrigin(databaseUrl);
  if (!origin) throw new Error("The phone channel's database is not set up.");
  const secret = crypto.randomBytes(16).toString("base64url");
  const code = PREFIX + Buffer.from(JSON.stringify({ u: origin, s: secret }), "utf8").toString("base64url");
  return { code, secret, rendezvous: rendezvousOf(secret), expiresAt: now + PAIR_TTL_MS };
}

export function readPairingCode(code: unknown): ReadPairingCode | null {
  if (typeof code !== "string") return null;
  const trimmed = code.trim();
  if (!trimmed.startsWith(PREFIX) || trimmed.length > 400) return null;
  try {
    const body = JSON.parse(Buffer.from(trimmed.slice(PREFIX.length), "base64url").toString("utf8")) as {
      u?: unknown;
      s?: unknown;
    };
    const databaseUrl = realtimeDatabaseOrigin(body.u);
    if (!databaseUrl || typeof body.s !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(body.s)) return null;
    return { databaseUrl, secret: body.s, rendezvous: rendezvousOf(body.s) };
  } catch {
    return null;
  }
}

export const PAIR_REQUEST_ID = "req";
export const PAIR_GRANT_ID = "grant";

export function pairPath(rendezvous: string, id: string): string {
  return `channels/${rendezvous}/${PAIR_KIND}/${id}`;
}

export interface PairRequest {
  v: 1;
  name: string;
  version: string;
  /** Four digits the add-on prints in its log, shown to the human on the Mac to compare. */
  verify: string;
  at: number;
}

export interface PairGrant {
  v: 1;
  channel: string;
  key: string;
  at: number;
}

export function newVerifyCode(): string {
  return String(crypto.randomInt(0, 10_000)).padStart(4, "0");
}

export function sealPairRequest(secret: string, request: PairRequest): ChannelDoc {
  return sealBody(keyOf(secret), "pairreq", PAIR_REQUEST_ID, request, request.at);
}

export function readPairRequest(secret: string, doc: ChannelDoc, now: number): PairRequest | null {
  const body = openBody(keyOf(secret), "pairreq", PAIR_REQUEST_ID, doc);
  if (typeof body !== "object" || body === null) return null;
  const r = body as Record<string, unknown>;
  if (r.v !== 1 || typeof r.name !== "string" || typeof r.version !== "string") return null;
  if (typeof r.verify !== "string" || !/^\d{4}$/.test(r.verify) || typeof r.at !== "number") return null;
  if (Math.abs(now - r.at) > PAIR_TTL_MS) return null;
  return { v: 1, name: r.name.slice(0, 40), version: r.version.slice(0, 20), verify: r.verify, at: r.at };
}

export function sealPairGrant(secret: string, grant: PairGrant): ChannelDoc {
  return sealBody(keyOf(secret), "pairgrant", PAIR_GRANT_ID, grant, grant.at);
}

export function readPairGrant(secret: string, doc: ChannelDoc, now: number): PairGrant | null {
  const body = openBody(keyOf(secret), "pairgrant", PAIR_GRANT_ID, doc);
  if (typeof body !== "object" || body === null) return null;
  const r = body as Record<string, unknown>;
  if (r.v !== 1 || typeof r.channel !== "string" || typeof r.key !== "string" || typeof r.at !== "number") return null;
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(r.channel) || Buffer.from(r.key, "base64").length !== 32) return null;
  if (Math.abs(now - r.at) > PAIR_TTL_MS) return null;
  return { v: 1, channel: r.channel, key: r.key, at: r.at };
}
