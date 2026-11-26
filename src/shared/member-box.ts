// A device's keys and what they do, in WebCrypto so a browser is a device like any other (docs/ponds.md, "Members are
// accounts"). The wire formats are the daemon's (`src/flotilla/crypto.ts`, node:crypto); `shared.test.ts` proves each side
// opens the other's boxes and verifies the other's signatures.
//
// - A device has two P-256 keys: one signs (ECDSA, the `publicKey`, whose hash is the device id) and one opens boxes sealed
//   to it (ECDH, the `boxKey`; WebCrypto binds a key to one algorithm, and the member document allows boxKey != publicKey).
//   Both public keys travel as x963 (0x04 || X || Y, 65 bytes, base64). The private halves are never extractable.
// - A box sealed to a device: ephemeral ECDH, HKDF-SHA256 (salt = the ephemeral public key, info "squeak-pond-key-v1"),
//   AES-256-GCM; layout ephemeral public key (65) || nonce (12) || ciphertext || tag (16).
// - A signature is `r || s` (IEEE P1363) over SHA-256 of the text; a document signs `<path>\n<box>`.

import { fromBase64, fromUtf8, toBase64, utf8 } from "./encoding.js";

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;
const buf = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => bytes as Uint8Array<ArrayBuffer>;
const POINT_BYTES = 65;
const NONCE = 12;
const TAG = 16;
const WRAP_INFO = "squeak-pond-key-v1";

export interface DeviceKeys {
  sign: CryptoKeyPair;
  box: CryptoKeyPair;
}

export async function generateDeviceKeys(): Promise<DeviceKeys> {
  const sign = await subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const box = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { sign, box };
}

/** A public key as x963 base64 (what the relay and the Owner's Mac exchange). */
export async function exportPublic(key: CryptoKey): Promise<string> {
  return toBase64(new Uint8Array(await subtle().exportKey("raw", key)));
}

/** A device or member id: the first 12 bytes of SHA-256 of the signing key, base64url (`memberIdOf` in the daemon). */
export async function deviceIdOf(publicKey: string): Promise<string> {
  const hash = new Uint8Array(await subtle().digest("SHA-256", buf(fromBase64(publicKey))));
  return toBase64(hash.subarray(0, 12)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const importPublic = (publicKey: string, algorithm: "ECDSA" | "ECDH", usages: KeyUsage[]): Promise<CryptoKey> =>
  subtle().importKey("raw", buf(fromBase64(publicKey)), { name: algorithm, namedCurve: "P-256" }, false, usages);

async function wrapKey(shared: ArrayBuffer, ephemeral: Uint8Array, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  const material = await subtle().importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: buf(ephemeral), info: buf(utf8(WRAP_INFO)) },
    material,
    256,
  );
  return subtle().importKey("raw", bits, { name: "AES-GCM" }, false, [usage]);
}

/** Opens a box sealed to this device's box key. Throws when it was sealed to another key or altered. */
export async function openFromMember<T = unknown>(boxPrivate: CryptoKey, box: string): Promise<T> {
  const raw = fromBase64(box);
  if (raw.length < POINT_BYTES + NONCE + TAG) throw new Error("box too short");
  const ephemeral = raw.subarray(0, POINT_BYTES);
  const shared = await subtle().deriveBits(
    { name: "ECDH", public: await importPublic(toBase64(ephemeral), "ECDH", []) },
    boxPrivate,
    256,
  );
  const key = await wrapKey(shared, ephemeral, "decrypt");
  const iv = buf(raw.subarray(POINT_BYTES, POINT_BYTES + NONCE));
  const plain = await subtle().decrypt({ name: "AES-GCM", iv }, key, buf(raw.subarray(POINT_BYTES + NONCE)));
  return JSON.parse(fromUtf8(new Uint8Array(plain))) as T;
}

/** Seals a value to a device's box key (the Owner's Mac does this in Node; this twin is for tests and tools). */
export async function sealToMember(publicKey: string, value: unknown): Promise<string> {
  const eph = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const ephemeral = new Uint8Array(await subtle().exportKey("raw", eph.publicKey));
  const shared = await subtle().deriveBits(
    { name: "ECDH", public: await importPublic(publicKey, "ECDH", []) },
    eph.privateKey,
    256,
  );
  const key = await wrapKey(shared, ephemeral, "encrypt");
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE));
  const plain = buf(utf8(JSON.stringify(value)));
  const body = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: nonce }, key, plain));
  const out = new Uint8Array(POINT_BYTES + NONCE + body.length);
  out.set(ephemeral, 0);
  out.set(nonce, POINT_BYTES);
  out.set(body, POINT_BYTES + NONCE);
  return toBase64(out);
}

/** What a signature covers: the document's path and its box, so neither can be swapped. */
export const signedText = (docPath: string, box: string): string => `${docPath}\n${box}`;

export async function signText(signPrivate: CryptoKey, text: string): Promise<string> {
  const sig = await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, signPrivate, buf(utf8(text)));
  return toBase64(new Uint8Array(sig));
}

export async function verifyText(publicKey: string, text: string, signature: string): Promise<boolean> {
  try {
    const key = await importPublic(publicKey, "ECDSA", ["verify"]);
    return await subtle().verify({ name: "ECDSA", hash: "SHA-256" }, key, buf(fromBase64(signature)), buf(utf8(text)));
  } catch {
    return false;
  }
}
