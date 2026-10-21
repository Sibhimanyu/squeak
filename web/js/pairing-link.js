// What the Mac's pairing QR code carries: `squeak://pair?d=<base64url JSON>`
// (ios/SqueakCore/Sources/SqueakCore/Pairing.swift, PairingPayload.parse).

import { fromBase64, fromBase64Url, fromUtf8 } from "./encoding.js";

/** A channel id (and a device id) is a path segment the database rules accept. */
export const CHANNEL_ID = /^[A-Za-z0-9_-]{22,64}$/;

export class PairingError extends Error {}

/**
 * A Realtime Database instance root and nothing else. The browser will send
 * signed commands wherever this points, so a pairing code must not be able to
 * aim it at another server: https, a host under firebasedatabase.app or
 * firebaseio.com, no credentials, port, path or query. Returns the clean
 * origin, or null.
 */
export function databaseOrigin(text) {
  if (typeof text !== "string") return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const underFirebase = host.endsWith(".firebasedatabase.app") || host.endsWith(".firebaseio.com");
  if (url.protocol !== "https:" || !underFirebase) return null;
  if (url.username || url.password || url.port || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return `https://${host}`;
}

/**
 * Parses a pasted pairing code. Throws PairingError with a sentence fit for
 * the screen. `databaseUrl` is the checked origin; null for a code made
 * before the channel moved to the Realtime Database (the web app cannot
 * follow Firestore, so the caller says so).
 */
export function parsePairingLink(text) {
  let url;
  try {
    url = new URL(String(text).trim());
  } catch {
    throw new PairingError("That is not a Squeak pairing code.");
  }
  const encoded = url.protocol === "squeak:" && url.hostname === "pair" ? url.searchParams.get("d") : null;
  if (!encoded) throw new PairingError("That is not a Squeak pairing code.");
  let payload;
  try {
    payload = JSON.parse(fromUtf8(fromBase64Url(encoded)));
  } catch {
    throw new PairingError("That is not a Squeak pairing code.");
  }
  if (!payload || typeof payload !== "object" || payload.v !== 1) {
    throw new PairingError("This pairing code is from a version Squeak for Web does not understand.");
  }
  let keyBytes;
  try {
    keyBytes = fromBase64(payload.k);
  } catch {
    keyBytes = null;
  }
  if (
    !keyBytes ||
    keyBytes.length !== 32 ||
    typeof payload.c !== "string" ||
    !CHANNEL_ID.test(payload.c) ||
    typeof payload.p !== "string" ||
    typeof payload.n !== "string"
  ) {
    throw new PairingError("That is not a Squeak pairing code.");
  }
  let databaseUrl = null;
  if (payload.r !== undefined) {
    databaseUrl = databaseOrigin(payload.r);
    if (!databaseUrl) throw new PairingError("That pairing code points at a server Squeak will not talk to.");
  }
  return { project: payload.p, channelId: payload.c, key: payload.k, macName: payload.n.slice(0, 60), databaseUrl };
}
