// Photos for a chat and pictures from one. The attach protocol is the iPhone's
// (PhotoAttachment.swift) and the Mac's (fleet/phone-attachments.ts): a photo
// is shrunk to a JPEG of at most four 300,000-byte pieces, sent as signed
// `attach` commands under one upload id, and the Mac saves it under the chat's
// `.context/attachments/` and answers the last piece with its path (`ref`).
// The message then names it as Conductor's image token for `<ref>`, which the page shows
// as a photo, never as text. Everything here is pure except `prepareImage`
// (canvas) and the two functions that take a `commands`.

import { fromBase64, toBase64, toHex } from "./encoding.js";

export const CHUNK_BYTES = 300_000;
export const MAX_CHUNKS = 4;
export const MAX_PHOTOS = 4;
/** The most a prepared photo may weigh. */
export const MAX_BYTES = CHUNK_BYTES * MAX_CHUNKS;
/** The longest edge a photo is sent at: enough for an agent to read a screenshot. */
export const LONGEST_EDGE = 1600;
export const QUALITIES = Object.freeze([0.75, 0.6, 0.45, 0.3]);
/** The Mac refuses more than this many pieces a minute per device. */
export const CHUNKS_PER_MINUTE = 40;

/** A photo's bytes in pieces of at most CHUNK_BYTES. */
export function chunksOf(bytes) {
  const out = [];
  for (let at = 0; at < bytes.length; at += CHUNK_BYTES)
    out.push(bytes.subarray(at, Math.min(at + CHUNK_BYTES, bytes.length)));
  return out;
}

/** A fresh upload id: 24 hex characters (the Mac takes 8 to 40 of letters, digits, `_` and `-`). */
export function newUploadId() {
  return toHex(globalThis.crypto.getRandomValues(new Uint8Array(12)));
}

/** The bytes are a JPEG or a PNG (the only two the Mac saves). */
export function imageKind(bytes) {
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length > 8 && png.every((byte, i) => bytes[i] === byte)) return "png";
  return null;
}

/** Whether prepared bytes can be sent at all, and if not, why. */
export function checkPhoto(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return "That isn't a photo.";
  if (!imageKind(bytes)) return "That isn't a JPEG or PNG photo.";
  if (bytes.length > MAX_BYTES) return "That photo is too big to send.";
  return null;
}

/** Conductor's own image token: `@⟦image-1.jpg⟧(.context%2Fattachments%2Fab12cd34%2Fimage-1.jpg)` */
export const imageLine = (ref) => `@⟦${ref.split("/").pop()}⟧(${encodeURIComponent(ref)})`;

/** What is sent: the person's words, then one line per saved photo. With no words, a plain request to look. */
export function composeMessage(words, refs) {
  const body = typeof words === "string" ? words.trim() : "";
  if (!refs?.length) return body;
  const lead = body || (refs.length === 1 ? "See the attached image." : "See the attached images.");
  return [lead, "", ...refs.map(imageLine)].join("\n");
}

const SAVED_REF = /^\.context\/attachments\/[0-9a-f]{8}\/image-\d+\.(?:jpg|png)$/;
const MARKER = /^\[Image: (\.context\/attachments\/[0-9a-f]{8}\/image-\d+\.(?:jpg|png))\]$/;
const TOKEN = /@⟦[^⟦⟧\n]*⟧\(([^)\s]+)\)[ \t]*/g;
const ATTACHMENT = /^\.context\/attachments\/[A-Za-z0-9_-]+\/[^/\\]+\.(?:jpe?g|png|gif|webp|heic)$/i;

/** A message's words and the photos it names, for showing: the marker lines and Conductor's tokens are taken out. */
export function splitMessage(message) {
  const kept = [];
  const refs = [];
  for (const line of String(message ?? "").split("\n")) {
    const match = MARKER.exec(line);
    if (match) {
      refs.push(match[1]);
      continue;
    }
    kept.push(
      line.replace(TOKEN, (whole, encoded) => {
        let decoded;
        try {
          decoded = decodeURIComponent(encoded);
        } catch {
          return whole;
        }
        if (!ATTACHMENT.test(decoded)) return whole;
        refs.push(decoded);
        return "";
      }),
    );
  }
  if (refs.length === 0) return { body: String(message ?? ""), refs: [] };
  return { body: kept.join("\n").trim(), refs };
}

/** The size a photo is drawn at: no side longer than `longest`, never enlarged. */
export function fitSize(width, height, longest = LONGEST_EDGE) {
  if (!(width > 0) || !(height > 0)) return null;
  const scale = Math.min(1, longest / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Shrinks and re-encodes until it fits: `encode(width, height, quality)` returns JPEG bytes (or null), tried at
 * each quality in turn. Null when nothing gets under MAX_BYTES.
 */
export async function fitToLimit({ width, height, encode, qualities = QUALITIES, maxBytes = MAX_BYTES }) {
  const size = fitSize(width, height);
  if (!size) return null;
  for (const quality of qualities) {
    const bytes = await encode(size.width, size.height, quality);
    if (bytes && bytes.length > 0 && bytes.length <= maxBytes) return { bytes, ...size, quality };
  }
  return null;
}

/** The browser's canvas, as `fitToLimit` wants it. */
function canvasEnv(doc = globalThis.document) {
  return {
    async decode(blob) {
      const bitmap = await globalThis.createImageBitmap(blob);
      return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close?.() };
    },
    async encode(source, width, height, quality) {
      const canvas = doc.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      // A JPEG has no transparency: paint white first, as the phone draws it opaque.
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      context.drawImage(source, 0, 0, width, height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    },
  };
}

/** A picked file or blob as a photo ready to send (`{ bytes, width, height }`), or `{ error }`. Needs a browser. */
export async function prepareImage(blob, env = canvasEnv()) {
  let decoded;
  try {
    decoded = await env.decode(blob);
  } catch {
    return { error: "That isn't an image this browser can read." };
  }
  try {
    const fit = await fitToLimit({
      width: decoded.width,
      height: decoded.height,
      encode: (width, height, quality) => env.encode(decoded.source, width, height, quality),
    });
    return fit
      ? { bytes: fit.bytes, width: fit.width, height: fit.height }
      : { error: "That photo will not get small enough to send." };
  } finally {
    decoded.close?.();
  }
}

/**
 * Sends one prepared photo for a chat (`{ sessionId }`) or a new chat's workspace (`{ workspaceId }`), piece by
 * piece, spaced inside the Mac's 40 pieces a minute. Stops at the first piece that is not delivered and never
 * sends a piece again: an unconfirmed piece may have landed. `{ ok: true, ref }` when the Mac saved it.
 */
export async function uploadPhoto(commands, target, bytes) {
  const problem = checkPhoto(bytes);
  if (problem) return { ok: false, reason: problem, unconfirmed: false, retrySafe: true };
  const pieces = chunksOf(bytes);
  const uploadId = newUploadId();
  let last = null;
  for (let index = 0; index < pieces.length; index++) {
    await commands.throttle("attach");
    last = await commands.attach({ ...target, uploadId, index, total: pieces.length, data: toBase64(pieces[index]) });
    if (!last.ok)
      return {
        ok: false,
        reason: last.reason,
        unconfirmed: last.unconfirmed,
        retrySafe: last.retrySafe && index === 0,
      };
  }
  const ref = last?.result?.ref;
  if (typeof ref !== "string" || !SAVED_REF.test(ref)) {
    return { ok: false, reason: "Your Mac didn't say where it saved the photo.", unconfirmed: true, retrySafe: false };
  }
  return { ok: true, ref };
}

/** Several prepared photos (at most MAX_PHOTOS), one after another; the refs of those saved, and the first failure. */
export async function uploadPhotos(commands, target, photos) {
  const refs = [];
  for (const bytes of photos.slice(0, MAX_PHOTOS)) {
    const sent = await uploadPhoto(commands, target, bytes);
    if (!sent.ok) return { ok: false, refs, reason: sent.reason, unconfirmed: sent.unconfirmed };
    refs.push(sent.ref);
  }
  return { ok: true, refs };
}

/** A fetched image as something `<img src>` takes (a `data:` URI the page's policy allows), or null if it is not one. */
export function imageUri(image) {
  if (!image || typeof image !== "object") return null;
  const { mime, data } = image;
  if ((mime !== "image/jpeg" && mime !== "image/png") || typeof data !== "string" || data === "") return null;
  try {
    fromBase64(data);
  } catch {
    return null;
  }
  return `data:${mime};base64,${data}`;
}

/**
 * Asks the Mac for an image the chat's agent showed, a workflow card's or a film's picture: pass one of
 * `{ sessionId, source }`, `{ sessionKey, source }` or `{ filmId, source }`. `{ ok, uri }` or `{ ok: false, reason }`.
 */
export async function fetchImage(commands, request) {
  const answer = await commands.image(request);
  if (!answer.ok) return { ok: false, reason: answer.reason };
  const uri = imageUri(answer.result?.image);
  return uri ? { ok: true, uri } : { ok: false, reason: "Your Mac sent something that isn't an image." };
}
