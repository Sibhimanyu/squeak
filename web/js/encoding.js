// Base64 and friends, the way the phone's CryptoKit code and the Mac's Node code write them.

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8(text) {
  return encoder.encode(text);
}

export function fromUtf8(bytes) {
  return decoder.decode(bytes);
}

export function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Standard base64 (what a box, a key and a signature are). Throws on anything else. */
export function fromBase64(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) {
    throw new Error("not base64");
  }
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** base64url, padded or not (the pairing code's `d`). */
export function fromBase64Url(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(text)) {
    throw new Error("not base64url");
  }
  let base64 = text.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  while (base64.length % 4 !== 0) base64 += "=";
  return fromBase64(base64);
}

export function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
