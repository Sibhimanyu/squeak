import crypto from "node:crypto";

/**
 * The same-Wi-Fi path's request authentication (docs/remote-channel.md,
 * "The direct path"). Plain HTTP on the LAN is acceptable only because of
 * this and the sealing underneath it:
 *
 * - every document is still an AES-GCM box, and every command is still signed
 *   by the phone's device key, so nothing here can forge or alter content;
 * - every request carries an HMAC under a key derived from the channel key
 *   with its own label, so a host that does not hold the channel key can
 *   neither read from nor write to the Mac, and a captured request cannot be
 *   replayed (a timestamp window plus a nonce the Mac remembers);
 * - every response carries an HMAC that binds the request's nonce, so a LAN
 *   impostor cannot hand the phone a stale (replayed) document as if the Mac
 *   had just said it.
 *
 * Swift (SqueakCore/LocalAuth.swift) must agree byte for byte; the fixture
 * `fixtures/local-auth.json` pins both.
 */

export const LOCAL_LABEL = "squeak-local-v1";
const RESPONSE_LABEL = "squeak-local-v1-resp";
/** A request's stamp may be this far from the Mac's clock, either way. */
export const LOCAL_SKEW_MS = 60_000;

export const HEADER_TS = "x-squeak-ts";
export const HEADER_NONCE = "x-squeak-nonce";
export const HEADER_MAC = "x-squeak-mac";
export const HEADER_RESPONSE_MAC = "x-squeak-rmac";

/** HKDF-SHA256 of the channel key, no salt, info "squeak-local-v1": the key for requests and responses. */
export function deriveLocalKey(channelKeyBase64: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(channelKeyBase64, "base64"), Buffer.alloc(0), Buffer.from(LOCAL_LABEL), 32),
  );
}

/**
 * A short public tag a phone uses to tell its own Mac among Bonjour results:
 * the first 8 bytes of HMAC-SHA256(channel key, "local-id"), hex. It names
 * nothing and cannot be turned into the key, but it is stable, so anyone on
 * the same network can tell this Mac's advertisement from another's.
 */
export function localTag(channelKeyBase64: string): string {
  return crypto
    .createHmac("sha256", Buffer.from(channelKeyBase64, "base64"))
    .update("local-id")
    .digest()
    .subarray(0, 8)
    .toString("hex");
}

export function bodyHash(body: Buffer | string): string {
  return crypto.createHash("sha256").update(body).digest("hex");
}

/** What a request's MAC covers: the verb, the target exactly as sent, the stamp, the nonce, the body's hash. */
export function requestCanonical(args: {
  method: string;
  target: string;
  ts: string;
  nonce: string;
  body: Buffer | string;
}): string {
  return [LOCAL_LABEL, args.method.toUpperCase(), args.target, args.ts, args.nonce, bodyHash(args.body)].join("\n");
}

export function signRequest(
  localKey: Buffer,
  args: { method: string; target: string; ts: string; nonce: string; body: Buffer | string },
): string {
  return crypto.createHmac("sha256", localKey).update(requestCanonical(args)).digest("base64");
}

/** What a response's MAC covers: the request's nonce, the status and the body's hash. */
export function responseCanonical(args: { nonce: string; status: number; body: Buffer | string }): string {
  return [RESPONSE_LABEL, args.nonce, String(args.status), bodyHash(args.body)].join("\n");
}

export function signResponse(localKey: Buffer, args: { nonce: string; status: number; body: Buffer | string }): string {
  return crypto.createHmac("sha256", localKey).update(responseCanonical(args)).digest("base64");
}

/** Constant-time comparison of two base64 MACs. */
export function macEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "base64");
  const right = Buffer.from(b, "base64");
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

export type AuthVerdict = "ok" | "malformed" | "stale" | "bad-mac" | "replayed";

/**
 * Remembers the nonces of verified requests for as long as their stamp could
 * still pass, so a captured request is refused when it is sent again.
 */
export class NonceCache {
  private readonly seen = new Map<string, number>();

  constructor(private readonly maxEntries = 20_000) {}

  /** True when the nonce is new (and now remembered); false when seen before or the cache is full. */
  remember(nonce: string, expiresAt: number, now: number): boolean {
    this.sweep(now);
    if (this.seen.has(nonce) || this.seen.size >= this.maxEntries) {
      return false;
    }
    this.seen.set(nonce, expiresAt);
    return true;
  }

  private sweep(now: number): void {
    for (const [nonce, expiresAt] of this.seen) {
      if (expiresAt < now) {
        this.seen.delete(nonce);
      }
    }
  }

  get size(): number {
    return this.seen.size;
  }
}

const NONCE_PATTERN = /^[0-9a-f]{32}$/;

/** Checks one request's headers. The nonce is remembered only when everything else held. */
export function verifyRequest(args: {
  localKey: Buffer;
  nonces: NonceCache;
  now: number;
  method: string;
  target: string;
  body: Buffer;
  headers: { ts?: string | undefined; nonce?: string | undefined; mac?: string | undefined };
}): { verdict: AuthVerdict; nonce?: string } {
  const { ts, nonce, mac } = args.headers;
  if (!ts || !nonce || !mac || !/^\d{10,16}$/.test(ts) || !NONCE_PATTERN.test(nonce) || mac.length > 64) {
    return { verdict: "malformed" };
  }
  const stamped = Number(ts);
  if (Math.abs(args.now - stamped) > LOCAL_SKEW_MS) {
    return { verdict: "stale" };
  }
  const expected = signRequest(args.localKey, { method: args.method, target: args.target, ts, nonce, body: args.body });
  if (!macEquals(expected, mac)) {
    return { verdict: "bad-mac" };
  }
  if (!args.nonces.remember(nonce, stamped + LOCAL_SKEW_MS, args.now)) {
    return { verdict: "replayed" };
  }
  return { verdict: "ok", nonce };
}
