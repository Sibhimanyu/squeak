import crypto from "node:crypto";

import type { ChannelDoc } from "../remote/firestore-rest.js";
import { CLOCK_SKEW_MS, isRecord, openBody, sealBody } from "./relay-protocol.js";

/**
 * Calling in: you phone Squeak, pick a chat, speak a message and confirm it. The Home Assistant gateway
 * answers the call and checks your PIN; the Mac does the rest (it transcribes with Whisper and sends). They
 * speak through the same sealed, signed pipe as outbound calls (relay-protocol.ts), in three more kinds:
 *
 * - `voicedir` (Mac to gateway): who can take a message now, as numbers and labels. Only the Mac knows which
 *   chat a number means, so the gateway can only say "number 2", never name a target.
 * - `voiceup` (gateway to Mac): the recorded memo (Opus, ~2 KB a second), then "send it".
 * - `voicedown` (Mac to gateway): what it heard, then whether it was sent.
 *
 * "Send it" names the memo, not the text: the Mac sends the words it transcribed itself, so nothing the
 * gateway says can change what an agent is told.
 */

export const DIR_KIND = "voicedir";
export const UP_KIND = "voiceup";
export const DOWN_KIND = "voicedown";

export const dirPath = (channel: string): string => `channels/${channel}/${DIR_KIND}/current`;
export const upPath = (channel: string, id: string): string => `channels/${channel}/${UP_KIND}/${id}`;
export const downPath = (channel: string, id: string): string => `channels/${channel}/${DOWN_KIND}/${id}`;

/** A memo or a send stays valid this long: recording, uploading and transcribing take a while. */
export const UP_TTL_MS = 5 * 60_000;
/** Longest recording, and the most characters of base64 audio a memo may carry (~120 s of Opus at 16 kbit/s). */
export const MAX_MEMO_MS = 120_000;
export const MAX_AUDIO_CHARS = 450_000;
export const MAX_CHOICES = 6;

export const newMessageId = (): string => crypto.randomBytes(16).toString("base64url");

export interface DirectoryItem {
  n: number;
  label: string;
}

export interface DirectoryDoc {
  v: 1;
  at: number;
  /** Changes whenever the list does; a memo names the version it was chosen from. */
  version: string;
  /** The one extension allowed to call in (the Mac's "who to ring" setting); null: nobody. */
  caller: string | null;
  items: DirectoryItem[];
}

export type UpMessage =
  | { v: 1; id: string; at: number; expiresAt: number; kind: "memo"; dirVersion: string; choice: number; audio: string }
  | { v: 1; id: string; at: number; expiresAt: number; kind: "send"; memoId: string };

export type DownMessage =
  | { v: 1; id: string; at: number; status: "transcript"; text: string; label: string }
  | { v: 1; id: string; at: number; status: "sent" }
  | { v: 1; id: string; at: number; status: "refused"; reason: string };

export function sealDirectory(key: string, doc: DirectoryDoc): ChannelDoc {
  return sealBody(key, "dir", "current", doc, doc.at);
}

export function readDirectory(key: string, doc: ChannelDoc, now: number): DirectoryDoc | null {
  const body = openBody(key, "dir", "current", doc);
  if (!isRecord(body) || body.v !== 1 || typeof body.at !== "number" || typeof body.version !== "string") return null;
  // A list from last week is not a list of who can take a message now.
  if (Math.abs(now - body.at) > 24 * 60 * 60_000) return null;
  if (body.caller !== null && typeof body.caller !== "string") return null;
  if (!Array.isArray(body.items) || body.items.length > MAX_CHOICES) return null;
  const items: DirectoryItem[] = [];
  for (const item of body.items) {
    if (!isRecord(item) || typeof item.n !== "number" || typeof item.label !== "string") return null;
    items.push({ n: item.n, label: item.label.slice(0, 80) });
  }
  return { v: 1, at: body.at, version: body.version, caller: body.caller, items };
}

export function sealUp(key: string, message: UpMessage): ChannelDoc {
  return sealBody(key, "up", message.id, message, message.at);
}

export function readUp(
  key: string,
  id: string,
  doc: ChannelDoc,
  now: number,
): { ok: true; message: UpMessage } | { ok: false; reason: string } {
  const body = openBody(key, "up", id, doc);
  if (!isRecord(body)) return { ok: false, reason: "not sealed with this key" };
  if (body.v !== 1 || body.id !== id || typeof body.at !== "number" || typeof body.expiresAt !== "number") {
    return { ok: false, reason: "not a voice message" };
  }
  if (body.expiresAt < now || body.at > now + CLOCK_SKEW_MS || body.expiresAt - body.at > UP_TTL_MS + CLOCK_SKEW_MS) {
    return { ok: false, reason: "expired" };
  }
  const base = { v: 1 as const, id, at: body.at, expiresAt: body.expiresAt };
  if (body.kind === "memo") {
    const { dirVersion, choice, audio } = body;
    if (typeof dirVersion !== "string" || dirVersion.length > 64) return { ok: false, reason: "not a voice message" };
    if (typeof choice !== "number" || !Number.isInteger(choice) || choice < 1 || choice > MAX_CHOICES) {
      return { ok: false, reason: "not a voice message" };
    }
    if (typeof audio !== "string" || audio.length === 0 || audio.length > MAX_AUDIO_CHARS) {
      return { ok: false, reason: "no audio" };
    }
    return { ok: true, message: { ...base, kind: "memo", dirVersion, choice, audio } };
  }
  if (body.kind === "send" && typeof body.memoId === "string" && body.memoId.length <= 64) {
    return { ok: true, message: { ...base, kind: "send", memoId: body.memoId } };
  }
  return { ok: false, reason: "not a voice message" };
}

export function sealDown(key: string, message: DownMessage): ChannelDoc {
  return sealBody(key, "down", message.id, message, message.at);
}

export function readDown(key: string, id: string, doc: ChannelDoc): DownMessage | null {
  const body = openBody(key, "down", id, doc);
  if (!isRecord(body) || body.v !== 1 || body.id !== id || typeof body.at !== "number") return null;
  const base = { v: 1 as const, id, at: body.at };
  switch (body.status) {
    case "transcript":
      return typeof body.text === "string" && typeof body.label === "string"
        ? { ...base, status: "transcript", text: body.text.slice(0, 1500), label: body.label.slice(0, 80) }
        : null;
    case "sent":
      return { ...base, status: "sent" };
    case "refused":
      return typeof body.reason === "string" ? { ...base, status: "refused", reason: body.reason.slice(0, 200) } : null;
    default:
      return null;
  }
}
