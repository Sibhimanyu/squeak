// A phone copy of a film or a soundtrack, brought over from the Mac. The Mac writes it into the channel as sealed
// chunks of at most 384 KB (`media/<id>-<i>`, each `{ i, n, data }` with `data` base64) and names them in its
// answer to a `media` command: `{ id, chunks, bytes, sha256, mime }`. The page opens each chunk, puts them in
// order, checks the length and the SHA-256 against the answer, and only then makes a Blob to play
// (Channel.media in the iPhone's Channel.swift does the same). Pure but for the injected `open`, `fromBase64`
// and `digest`, so tests run it with fakes.

import { fromBase64, toHex } from "./encoding.js";

export const MAX_CHUNKS = 400;
const MEDIA_ID = /^[A-Za-z0-9]{8,64}$/;
const MIME = /^(video|audio)\/[a-z0-9.+-]{1,40}$/;

/** What a failed fetch says. */
export class MediaError extends Error {}

/** The Mac's answer's `media`, checked; null when it is not a usable reference. */
export function readMediaRef(media) {
  if (!media || typeof media !== "object") return null;
  const { id, chunks, bytes, sha256, mime } = media;
  if (typeof id !== "string" || !MEDIA_ID.test(id)) return null;
  if (!Number.isInteger(chunks) || chunks < 1 || chunks > MAX_CHUNKS) return null;
  if (!Number.isInteger(bytes) || bytes < 1) return null;
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (typeof mime !== "string" || !MIME.test(mime)) return null;
  return { id, chunks, bytes, sha256, mime };
}

/** The SHA-256 of bytes as lowercase hex, through WebCrypto. */
export async function sha256Hex(bytes) {
  return toHex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)));
}

/**
 * Fetches, opens, orders and verifies every chunk, two at a time (the stream and a result read still need a
 * connection). `channel` is `{ path(kind, id), db: { get(path) }, key }`. Throws MediaError.
 */
export async function fetchMediaBytes(
  channel,
  ref,
  { open, decode = fromBase64, digest = sha256Hex, onProgress, cancelled } = {},
) {
  const parts = new Array(ref.chunks).fill(null);
  const chunk = async (index) => {
    const doc = await channel.db.get(channel.path("media", `${ref.id}-${index}`));
    if (!doc || typeof doc.box !== "string")
      throw new MediaError("The film has gone from the channel. Ask for it again.");
    const opened = await open(channel.key, doc.box);
    if (!opened || opened.i !== index || opened.n !== ref.chunks || typeof opened.data !== "string") {
      throw new MediaError("A piece of the film didn't check out.");
    }
    return decode(opened.data);
  };
  let done = 0;
  for (let next = 0; next < ref.chunks; next += 2) {
    if (cancelled?.()) throw new MediaError("Cancelled.");
    const batch = [next, ...(next + 1 < ref.chunks ? [next + 1] : [])];
    const got = await Promise.all(batch.map(chunk));
    batch.forEach((index, i) => (parts[index] = got[i]));
    done += batch.length;
    onProgress?.(done / ref.chunks);
  }
  const joined = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  if (joined.length !== ref.bytes) throw new MediaError("The film arrived incomplete.");
  if ((await digest(joined)) !== ref.sha256) throw new MediaError("The film didn't match what your Mac sent.");
  return joined;
}
