import crypto from "node:crypto";

import type { ChannelDoc } from "../remote/firestore-rest.js";
import { realtimeDatabaseOrigin } from "./pair-protocol.js";
import { openBody, sealBody } from "./relay-protocol.js";
import { open, seal } from "../remote/remote-crypto.js";

/**
 * Pairing the Home Assistant add-on by a short code the add-on SHOWS and the person types on the Mac, like signing
 * in on a TV (docs: .context/claim-flow-contract.md). The add-on makes a code and an X25519 key and posts a sealed
 * request on a small signalling database both sides know (`RENDEZVOUS_DATABASE`, Squeak's shared server, which holds
 * nothing but these short-lived sealed notes); the Mac reads it with the typed code, the person approves, and the Mac
 * seals the real database address, channel and key to the add-on's key. The rendezvous is an untrusted pipe: its path
 * and the first seal come from the code, the grant is also sealed to the add-on's key.
 */

export const CLAIM_KIND = "claims";
export const CLAIM_REQUEST_ID = "req";
export const CLAIM_GRANT_ID = "grant";
/** A code works this long; the add-on shows a fresh one after it. */
export const CLAIM_TTL_MS = 15 * 60_000;
/** Where both ends meet. Never holds a channel, key or address in the clear. */
export const RENDEZVOUS_DATABASE = "https://squeak-shared-default-rtdb.firebaseio.com";

/** No 0/O/1/I/L: a code is read off a screen and typed. 31 symbols, 8 of them: about 40 bits. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;
const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

/** A new code, shown as `K7M2-QX9P`. */
export function makeClaimCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** What was typed, as the 8 symbols it stands for, or null: case, spaces and dashes do not matter. */
export function normalizeClaimCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const flat = input.toUpperCase().replace(/[\s-]/g, "");
  if (flat.length !== CODE_LENGTH || [...flat].some((c) => !ALPHABET.includes(c))) return null;
  return flat;
}

function derive(code: string, info: string, length: number): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(code, "utf8"), Buffer.alloc(0), info, length));
}

/** The folder the two meet in: derived from the code, so the code itself is never stored. */
export function claimIdOf(code: string): string {
  return derive(code, "squeak-claim-id", 16).toString("base64url");
}

function claimKey(code: string): string {
  return derive(code, "squeak-claim-key", 32).toString("base64");
}

export function claimPath(claimId: string, doc: string): string {
  return `${CLAIM_KIND}/${claimId}/${doc}`;
}

export interface ClaimKeyPair {
  /** 32 raw bytes, base64url: goes in the request. */
  publicKey: string;
  privateKey: crypto.KeyObject;
}

export function newClaimKeyPair(): ClaimKeyPair {
  const pair = crypto.generateKeyPairSync("x25519");
  const der = pair.publicKey.export({ type: "spki", format: "der" });
  return { publicKey: Buffer.from(der).subarray(-32).toString("base64url"), privateKey: pair.privateKey };
}

function publicKeyFrom(raw: string): crypto.KeyObject | null {
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.length !== 32) return null;
  try {
    return crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519_PREFIX, bytes]), format: "der", type: "spki" });
  } catch {
    return null;
  }
}

function sharedKey(privateKey: crypto.KeyObject, theirPublic: crypto.KeyObject, code: string): string {
  const secret = crypto.diffieHellman({ privateKey, publicKey: theirPublic });
  return Buffer.from(crypto.hkdfSync("sha256", secret, Buffer.from(code, "utf8"), "squeak-claim-grant", 32)).toString(
    "base64",
  );
}

export interface ClaimRequest {
  name: string;
  version: string;
  publicKey: string;
  at: number;
}

export function sealClaimRequest(code: string, request: ClaimRequest): ChannelDoc {
  return sealBody(claimKey(code), "claimreq", CLAIM_REQUEST_ID, { v: 1, ...request }, request.at);
}

export function readClaimRequest(code: string, doc: ChannelDoc, now: number): ClaimRequest | null {
  const body = openBody(claimKey(code), "claimreq", CLAIM_REQUEST_ID, doc);
  if (typeof body !== "object" || body === null) return null;
  const r = body as Record<string, unknown>;
  if (r.v !== 1 || typeof r.name !== "string" || typeof r.version !== "string") return null;
  if (typeof r.publicKey !== "string" || publicKeyFrom(r.publicKey) === null) return null;
  if (typeof r.at !== "number" || !Number.isFinite(r.at) || Math.abs(now - r.at) > CLAIM_TTL_MS) return null;
  return { name: r.name.slice(0, 40), version: r.version.slice(0, 20), publicKey: r.publicKey, at: r.at };
}

export interface ClaimGrant {
  databaseUrl: string;
  channel: string;
  key: string;
}

/** The Mac's answer: its own database, channel and key, sealed to the key the request carried. */
export function sealClaimGrant(code: string, request: ClaimRequest, grant: ClaimGrant, now: number): ChannelDoc {
  const theirs = publicKeyFrom(request.publicKey);
  if (!theirs) throw new Error("The add-on's key is not valid.");
  const mine = crypto.generateKeyPairSync("x25519");
  const macPublic = Buffer.from(mine.publicKey.export({ type: "spki", format: "der" }))
    .subarray(-32)
    .toString("base64url");
  const inner = seal(sharedKey(mine.privateKey, theirs, code), { v: 1, ...grant, at: now });
  return sealBody(claimKey(code), "claimgrant", CLAIM_GRANT_ID, { v: 1, macPublic, inner }, now);
}

export function readClaimGrant(
  code: string,
  privateKey: crypto.KeyObject,
  doc: ChannelDoc,
  now: number,
): ClaimGrant | null {
  const outer = openBody(claimKey(code), "claimgrant", CLAIM_GRANT_ID, doc);
  if (typeof outer !== "object" || outer === null) return null;
  const o = outer as Record<string, unknown>;
  if (o.v !== 1 || typeof o.macPublic !== "string" || typeof o.inner !== "string") return null;
  const theirs = publicKeyFrom(o.macPublic);
  if (!theirs) return null;
  let body: unknown;
  try {
    body = open(sharedKey(privateKey, theirs, code), o.inner);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const g = body as Record<string, unknown>;
  const databaseUrl = realtimeDatabaseOrigin(g.databaseUrl);
  if (g.v !== 1 || !databaseUrl || typeof g.channel !== "string" || typeof g.key !== "string") return null;
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(g.channel) || Buffer.from(g.key, "base64").length !== 32) return null;
  if (typeof g.at !== "number" || Math.abs(now - g.at) > CLAIM_TTL_MS) return null;
  return { databaseUrl, channel: g.channel, key: g.key };
}
