// The sealed box every channel document travels in (docs/remote-channel.md), in WebCrypto so the web app and tests speak the
// same bytes as the daemon. The wire layout lives here once: `src/remote/remote-crypto.ts` (the daemon's synchronous
// node:crypto path) takes its constants from this file, and `shared.test.ts` proves the two paths open each other's boxes.
//
// - Content: AES-256-GCM, CryptoKit's `SealedBox.combined`: 12-byte nonce, ciphertext, 16-byte tag, base64. WebCrypto's
//   encrypt returns ciphertext then tag, so nonce + its output IS the combined form.
// - A box's plaintext is JSON, or a zero byte then raw DEFLATE of the JSON.

import { fromBase64, fromUtf8, toBase64, utf8 } from "./encoding.js";

export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
/** A compressed box's plaintext starts with this byte; JSON never starts with a zero byte. */
export const COMPRESSED = 0x00;
export const KEY_BYTES = 32;

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
// WebCrypto's types want an ArrayBuffer-backed view; these arrays always are.
const buf = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => bytes as Uint8Array<ArrayBuffer>;

/** The channel secret (32 bytes, base64) as a key that can seal and open and cannot be read back out. */
export async function importChannelKey(keyBase64: string): Promise<CryptoKey> {
  const raw = fromBase64(keyBase64);
  if (raw.length !== KEY_BYTES) throw new Error("bad channel key");
  const key = await subtle().importKey("raw", buf(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  raw.fill(0);
  return key;
}

/** Encrypts a JSON value into a combined box (never compressed: the daemon reads both). */
export async function seal(key: CryptoKey, value: unknown): Promise<string> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const plain = buf(utf8(JSON.stringify(value)));
  const body = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: nonce }, key, plain));
  const combined = new Uint8Array(NONCE_BYTES + body.length);
  combined.set(nonce, 0);
  combined.set(body, NONCE_BYTES);
  return toBase64(combined);
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([buf(bytes)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decrypts a combined box. Throws if it was tampered with or sealed under another key. */
export async function open<T = unknown>(key: CryptoKey, box: string): Promise<T> {
  const raw = fromBase64(box);
  if (raw.length < NONCE_BYTES + TAG_BYTES) throw new Error("box too short");
  const iv = buf(raw.subarray(0, NONCE_BYTES));
  const plain = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv }, key, buf(raw.subarray(NONCE_BYTES))));
  const json = plain[0] === COMPRESSED ? await inflateRaw(plain.subarray(1)) : plain;
  return JSON.parse(fromUtf8(json)) as T;
}
