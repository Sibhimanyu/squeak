// The channel's cryptography in WebCrypto, byte-for-byte what the Mac
// (src/remote/remote-crypto.ts) and the iPhone (ChannelCrypto.swift) speak.
// See docs/remote-channel.md.
//
// - Content: AES-256-GCM, CryptoKit's `SealedBox.combined`: 12-byte nonce,
//   ciphertext, 16-byte tag, base64. WebCrypto's encrypt returns ciphertext
//   then tag, so nonce + its output IS the combined form.
// - A box's plaintext is JSON, or a zero byte then raw DEFLATE of the JSON
//   (a Mac writing for a phone that said it reads "z").
// - Commands: ECDSA P-256 / SHA-256 over the exact box string. WebCrypto
//   returns the signature as raw r || s (IEEE P1363), which is what the
//   Mac verifies and CryptoKit's `rawRepresentation` writes. No DER.
// - A device's public key travels as ANSI X9.63, 0x04 || X || Y, base64:
//   exactly WebCrypto's "raw" export of a P-256 public key.
//
// Keys are non-extractable CryptoKeys. Nothing here ever holds private
// bytes: the channel secret is imported once and the page keeps only the key.

import { fromBase64, fromUtf8, toBase64, utf8 } from "./encoding.js";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const COMPRESSED = 0x00;

const subtle = () => globalThis.crypto.subtle;

/** The channel secret (32 bytes, base64) as a key that can seal and open and cannot be read back out. */
export async function importChannelKey(keyBase64) {
  const raw = fromBase64(keyBase64);
  if (raw.length !== 32) throw new Error("bad channel key");
  const key = await subtle().importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  raw.fill(0);
  return key;
}

/** Encrypts a JSON value into a combined box (never compressed: the Mac reads both). */
export async function seal(key, value) {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const body = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: nonce }, key, utf8(JSON.stringify(value))));
  const combined = new Uint8Array(NONCE_BYTES + body.length);
  combined.set(nonce, 0);
  combined.set(body, NONCE_BYTES);
  return toBase64(combined);
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decrypts a combined box. Throws if it was tampered with or sealed under another key. */
export async function open(key, box) {
  const raw = fromBase64(box);
  if (raw.length < NONCE_BYTES + TAG_BYTES) throw new Error("box too short");
  const plain = new Uint8Array(
    await subtle().decrypt({ name: "AES-GCM", iv: raw.subarray(0, NONCE_BYTES) }, key, raw.subarray(NONCE_BYTES)),
  );
  const json = plain[0] === COMPRESSED ? await inflateRaw(plain.subarray(1)) : plain;
  return JSON.parse(fromUtf8(json));
}

/** A fresh device key pair. The private half can sign and never be exported. */
export async function generateDeviceKey() {
  const pair = await subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { privateKey: pair.privateKey, publicKeyX963: await publicKeyX963(pair.publicKey) };
}

/** The public key as the Mac stores it: 0x04 || X || Y, base64. */
export async function publicKeyX963(publicKey) {
  return toBase64(new Uint8Array(await subtle().exportKey("raw", publicKey)));
}

/** Signs the exact box string; raw r || s, base64. */
export async function sign(privateKey, message) {
  const signature = await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, utf8(message));
  return toBase64(new Uint8Array(signature));
}

/** Six digits both screens show during pairing (mirrors `pairingCode` on the Mac). */
export async function pairingCode(publicKeyX963Base64) {
  const digest = new Uint8Array(await subtle().digest("SHA-256", fromBase64(publicKeyX963Base64)));
  const value = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  return String(value % 1_000_000).padStart(6, "0");
}

/** For tests and the Mac's own check: verify a signature against a public key in x963 form. */
export async function verify(publicKeyX963Base64, message, signatureBase64) {
  const key = await subtle().importKey(
    "raw",
    fromBase64(publicKeyX963Base64),
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
  return subtle().verify({ name: "ECDSA", hash: "SHA-256" }, key, fromBase64(signatureBase64), utf8(message));
}

/** What this client tells the Mac it reads (its presence `caps`): same as the iPhone, so a phone and a browser never fight over the format. "films" asks the Mac to list RasanAI films (`films` in the view; it sends none to a client that does not say so). */
export const CAPABILITIES = ["z", "split", "films"];

/** Added to the caps only while the Phone calls log is open: the Mac then writes the recent calls (`voice.calls`, up to ~200 KB). */
export const CALLS_CAPABILITY = "calls";
