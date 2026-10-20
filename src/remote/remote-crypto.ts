import crypto from "node:crypto";
import zlib from "node:zlib";

/**
 * The remote channel's cryptography. See docs/remote-channel.md.
 *
 * Two layers, each chosen to match what an iPhone can do natively with
 * CryptoKit, so the phone needs no third-party crypto:
 *
 * - Confidentiality: AES-256-GCM under a channel key that exists only on the
 *   Mac and on phones that scanned its pairing QR code. The wire format is
 *   CryptoKit's `AES.GCM.SealedBox.combined` — 12-byte nonce, ciphertext,
 *   16-byte tag — base64 encoded.
 * - Authority: every command is signed with ECDSA P-256 by a key generated in
 *   the phone's Secure Enclave (P-256 is the only curve it supports). The Mac
 *   acts only on signatures from devices it has approved. The channel key
 *   alone — a photographed QR code, say — can read, but never command.
 */

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface ChannelSecret {
  /** 128 random bits, base64url: the Firestore path, and nothing more. */
  channelId: string;
  /** 256 random bits, base64: the AES-GCM key. */
  key: string;
}

export function generateChannel(): ChannelSecret {
  return {
    channelId: crypto.randomBytes(16).toString("base64url"),
    key: crypto.randomBytes(32).toString("base64"),
  };
}

/**
 * A compressed box's plaintext starts with this byte, then raw DEFLATE of the
 * JSON. JSON never starts with a zero byte, so the two cannot be confused.
 * Only for a phone that said it reads them (its presence `caps` has "z").
 */
const COMPRESSED = 0x00;

/** Encrypt a JSON value into a CryptoKit-compatible combined box, compressed first when asked. */
export function seal(keyBase64: string, value: unknown, options: { compress?: boolean } = {}): string {
  const key = Buffer.from(keyBase64, "base64");
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const json = Buffer.from(JSON.stringify(value), "utf8");
  const plain = options.compress ? Buffer.concat([Buffer.from([COMPRESSED]), zlib.deflateRawSync(json)]) : json;
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64");
}

/** Decrypt a combined box; throws if it was tampered with or uses another key. */
export function open<T = unknown>(keyBase64: string, box: string): T {
  const key = Buffer.from(keyBase64, "base64");
  const raw = Buffer.from(box, "base64");
  if (raw.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error("box too short");
  }
  const nonce = raw.subarray(0, NONCE_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const body = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]);
  const json = plain[0] === COMPRESSED ? zlib.inflateRawSync(plain.subarray(1)) : plain;
  return JSON.parse(json.toString("utf8")) as T;
}

/**
 * A P-256 public key as CryptoKit's `x963Representation` (0x04 ‖ X ‖ Y),
 * base64, turned into something Node can verify with.
 */
function publicKeyFromX963(x963Base64: string): crypto.KeyObject {
  const raw = Buffer.from(x963Base64, "base64");
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error("not an uncompressed P-256 public key");
  }
  return crypto.createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: raw.subarray(1, 33).toString("base64url"),
      y: raw.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
}

/**
 * Verify a device's signature over `message` (the exact box string it sent).
 * The signature is CryptoKit's `rawRepresentation`: r ‖ s, 64 bytes.
 */
export function verifyDeviceSignature(publicKeyX963: string, message: string, signatureBase64: string): boolean {
  try {
    return crypto.verify(
      "sha256",
      Buffer.from(message, "utf8"),
      { key: publicKeyFromX963(publicKeyX963), dsaEncoding: "ieee-p1363" },
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}

/**
 * Six digits both screens show during pairing, derived from the phone's
 * public key: matching codes mean the key the Mac is about to trust is the
 * one this phone made, not one somebody else slipped into the channel.
 */
export function pairingCode(publicKeyX963: string): string {
  const digest = crypto.createHash("sha256").update(Buffer.from(publicKeyX963, "base64")).digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}
