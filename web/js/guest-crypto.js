// A pond member's cryptography in browser WebCrypto, byte-for-byte what the Mac speaks
// (src/flotilla/crypto.ts; vectors in src/flotilla/fixtures/web-vectors.json, docs/ponds.md "Web guests").
//
// - A document box is `<keyVersion>.` + base64(nonce12 || ciphertext || tag16): AES-256-GCM under the pond key, with the
//   document's path as additional data, so the cloud cannot move a sealed document to another path.
// - A signature is ECDSA P-256 / SHA-256 over the UTF-8 of `<path>\n<box>`, raw r || s.
// - A member id is base64url(sha256(publicKey x963)[0..12]): derived from the key, never claimed.
// - The pond key reaches a member sealed to their public key: ephemeral ECDH, HKDF-SHA256 (salt = the 65 ephemeral bytes,
//   info "squeak-pond-key-v1"), AES-256-GCM, no additional data.
// - The join proof is hex HMAC-SHA256 keyed by the invite's secret over `<requestId>\n<publicKey>`.
//
// The same point has to serve ECDSA and ECDH, and WebCrypto binds a key to one algorithm, so the pair is made once as
// extractable, its private half is imported twice as non-extractable keys, and the extractable copy is dropped. Nothing
// here ever stores or returns private bytes.

import { fromBase64, fromBase64Url, fromUtf8, toBase64, toHex, utf8 } from "./encoding.js";

const NONCE = 12;
const TAG = 16;
const subtle = () => globalThis.crypto.subtle;

export function randomId(bytes = 16) {
  return toBase64(globalThis.crypto.getRandomValues(new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const base64Url = (bytes) => toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function memberIdOf(publicKey) {
  const digest = new Uint8Array(await subtle().digest("SHA-256", fromBase64(publicKey)));
  return base64Url(digest.subarray(0, 12));
}

/** A new member key: `{ signingKey, ecdhKey, publicKey }`, both CryptoKeys non-extractable. */
export async function newMemberKey() {
  const pair = await subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await subtle().exportKey("pkcs8", pair.privateKey));
  const publicKey = toBase64(new Uint8Array(await subtle().exportKey("raw", pair.publicKey)));
  try {
    const signingKey = await subtle().importKey("pkcs8", pkcs8, { name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
    ]);
    const ecdhKey = await subtle().importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, false, [
      "deriveBits",
    ]);
    return { signingKey, ecdhKey, publicKey };
  } finally {
    pkcs8.fill(0);
  }
}

/** A pond key (32 bytes, base64) as a key that seals and opens and cannot be read back out. */
export async function importPondKey(keyBase64) {
  const raw = fromBase64(keyBase64);
  if (raw.length !== 32) throw new Error("bad pond key");
  try {
    return await subtle().importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  } finally {
    raw.fill(0);
  }
}

/** The box (without a version prefix) for `value` at `aad`, the document's path. */
export async function sealAt(key, aad, value) {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE));
  const body = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv: nonce, additionalData: utf8(aad) }, key, utf8(JSON.stringify(value))),
  );
  const out = new Uint8Array(NONCE + body.length);
  out.set(nonce, 0);
  out.set(body, NONCE);
  return toBase64(out);
}

/** Throws if the box was altered, moved to another path or sealed with another key. */
export async function openAt(key, aad, box) {
  const raw = fromBase64(box);
  if (raw.length < NONCE + TAG) throw new Error("box too short");
  const plain = await subtle().decrypt(
    { name: "AES-GCM", iv: raw.subarray(0, NONCE), additionalData: utf8(aad) },
    key,
    raw.subarray(NONCE),
  );
  return JSON.parse(fromUtf8(new Uint8Array(plain)));
}

export const signedText = (docPath, box) => `${docPath}\n${box}`;

export async function signText(signingKey, message) {
  return toBase64(new Uint8Array(await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, utf8(message))));
}

const verifyKeys = new Map();

/** True when `signature` is `publicKey`'s over `message`. Never throws on a malformed input: false. */
export async function verifyText(publicKey, message, signature) {
  try {
    let key = verifyKeys.get(publicKey);
    if (!key) {
      key = await subtle().importKey("raw", fromBase64(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, [
        "verify",
      ]);
      verifyKeys.set(publicKey, key);
    }
    return await subtle().verify({ name: "ECDSA", hash: "SHA-256" }, key, fromBase64(signature), utf8(message));
  } catch {
    return false;
  }
}

/** Opens what the owner's Mac sealed to this member's public key. */
export async function openFromMember(ecdhKey, box) {
  const raw = fromBase64(box);
  if (raw.length < 65 + NONCE + TAG) throw new Error("box too short");
  const eph = raw.subarray(0, 65);
  const ephKey = await subtle().importKey("raw", eph, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle().deriveBits({ name: "ECDH", public: ephKey }, ecdhKey, 256);
  const hkdf = await subtle().importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const aes = await subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: eph, info: utf8("squeak-pond-key-v1") },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const plain = await subtle().decrypt(
    { name: "AES-GCM", iv: raw.subarray(65, 65 + NONCE) },
    aes,
    raw.subarray(65 + NONCE),
  );
  return JSON.parse(fromUtf8(new Uint8Array(plain)));
}

/** The invite's one-time secret, proved without sending it. */
export async function joinProof(secret, requestId, publicKey) {
  const key = await subtle().importKey("raw", fromBase64Url(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return toHex(new Uint8Array(await subtle().sign("HMAC", key, utf8(`${requestId}\n${publicKey}`))));
}
