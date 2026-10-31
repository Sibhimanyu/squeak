import crypto from "node:crypto";

import type { ChannelDoc } from "../remote/firestore-rest.js";
import { readAudioClips, readClip, type Clip } from "./clips.js";
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
/** Longest recording (60 s; it was 120 s), and the most characters of base64 audio a memo may carry (kept for older peers). */
export const MAX_MEMO_MS = 60_000;
export const MAX_AUDIO_CHARS = 450_000;
/** Most chats a directory can name (a memo's `choice` indexes them); a keypad shows at most nine at a time. */
export const MAX_CHOICES = 40;
/** The chats read out in one menu without workspaces: a keypad's digits, and a menu a person can hold in mind. */
export const MENU_CHOICES = 6;
export const MAX_WORKSPACES = 9;
/** The most a call reads out for one answer: a phone line is a poor place for a document. */
export const MAX_ANSWER_CHARS = 600;
/** Answers (questions and status read-outs together) one call may ask for. */
export const MAX_ANSWERS_PER_CALL = 3;

export const newMessageId = (): string => crypto.randomBytes(16).toString("base64url");

export interface DirectoryItem {
  /** The digit that picks it in its menu. */
  n: number;
  label: string;
  /** Which chat it is (what a memo names); absent: `n`, as before workspaces existed. */
  choice?: number;
}

/** A favourite workspace: its own digit, and the chats in it that can take a message now. */
export interface DirectoryWorkspace {
  n: number;
  label: string;
  chats: DirectoryItem[];
}

export interface DirectoryDoc {
  v: 1;
  at: number;
  /** Changes whenever the list does; a memo names the version it was chosen from. */
  version: string;
  /** The one extension allowed to call in (the Mac's "who to ring" setting); null: nobody. */
  caller: string | null;
  /** Chats outside the favourites (or all of them, with none); the menu behind "0" when workspaces exist. */
  items: DirectoryItem[];
  /** The favourite workspaces, in the order they are read; absent from an older Mac. */
  workspaces?: DirectoryWorkspace[];
  /**
   * The Mac can answer a question about a chat and read out a chat's status (`ask` and `status` messages): the
   * keypad then offers them. Absent from an older Mac, and the call goes as it always has.
   */
  ask?: true;
  /**
   * The Mac can talk a call in through (`talk` messages naming a chat of this list, with a `callId`): once a chat is
   * chosen the call is a conversation and the keypad only a fallback. Absent from an older Mac, and the keys go on.
   */
  talk?: true;
  /**
   * The chat the person used last (a message sent or a question asked by phone), else the newest one waiting on them:
   * offered first, before any menu. `choice` indexes the version's chats as a memo's does, whether or not a menu lists
   * it. Absent from an older Mac, and the call goes straight to the menus as it always has.
   */
  last?: { choice: number; label: string };
  /** Ids of the audio documents (`voicedir/audio-<version>-<i>`) holding the Mac's recordings of this list's prompts. */
  audio?: string[];
}

export const MAX_AUDIO_DOCS = 8;
const AUDIO_ID = /^[A-Za-z0-9_-]{1,80}$/;

export const audioDocId = (version: string, index: number): string => `audio-${version}-${index}`;
/** The Mac's clips for one outbound call, one document each, written while the phone rings (`audioFollows`). */
export const callAudioId = (callId: string, index: number): string => `callaudio-${callId}-${index}`;
export const audioPath = (channel: string, id: string): string => `channels/${channel}/${DIR_KIND}/${id}`;

/** One audio document: the Mac's clips for call-in prompts, sealed apart from the list so the list stays small. */
export function sealAudio(key: string, id: string, version: string, clips: Clip[], at: number): ChannelDoc {
  return sealBody(key, "dir", id, { v: 1, version, clips }, at);
}

export function readAudio(key: string, id: string, doc: ChannelDoc): { version: string; clips: Clip[] } | null {
  if (!AUDIO_ID.test(id)) return null;
  const body = openBody(key, "dir", id, doc);
  if (!isRecord(body) || body.v !== 1 || typeof body.version !== "string") return null;
  const clips = readAudioClips(body.clips);
  return clips ? { version: body.version, clips } : null;
}

export type UpMessage =
  | { v: 1; id: string; at: number; expiresAt: number; kind: "memo"; dirVersion: string; choice: number; audio: string }
  | { v: 1; id: string; at: number; expiresAt: number; kind: "send"; memoId: string }
  /** The recording is a question about its chat: answer it aloud; send nothing to the chat. */
  | { v: 1; id: string; at: number; expiresAt: number; kind: "ask"; memoId: string }
  /** Read out where a chat stands: no recording. Names the chat as a memo does. */
  | { v: 1; id: string; at: number; expiresAt: number; kind: "status"; dirVersion: string; choice: number }
  /**
   * One turn of a voice-first call out: a recording of what the person said. `dirVersion` is the call's id (never a
   * published list), `choice` is always 1. `phase` "confirm" is the person's yes or no to a message read back.
   */
  | {
      v: 1;
      id: string;
      at: number;
      expiresAt: number;
      kind: "talk";
      dirVersion: string;
      choice: number;
      phase: TalkPhase;
      audio: string;
      /** A call in: names the call (its conversation), and `dirVersion` and `choice` name the chat in the list. */
      callId?: string;
    };

/** What a voice-first call's turn is: what the person said, or whether to send what was read back to them. */
export type TalkPhase = "say" | "confirm" | "hold" | "peek";
/**
 * "hold": the call stays on the line while the chat works (`text` may be empty: nothing to say yet). The add-on then
 * checks in with `hold` turns, and a key asks for `peek` (what the agent is thinking). Both carry no recording.
 */
export type TalkNext = "listen" | "confirm" | "end" | "hold";

export type DownMessage =
  | { v: 1; id: string; at: number; status: "transcript"; text: string; label: string; audio?: Clip }
  | { v: 1; id: string; at: number; status: "sent" }
  /** What to read aloud for an `ask` or `status`: plain sentences, at most `MAX_ANSWER_CHARS`. */
  | { v: 1; id: string; at: number; status: "answer"; text: string; audio?: Clip }
  | { v: 1; id: string; at: number; status: "refused"; reason: string }
  /** What to say for a `talk` turn, and what the call does next: listen again, listen for yes or no, or end. */
  | { v: 1; id: string; at: number; status: "talk"; text: string; audio?: Clip; next: TalkNext };

export function sealDirectory(key: string, doc: DirectoryDoc): ChannelDoc {
  return sealBody(key, "dir", "current", doc, doc.at);
}

export function readDirectory(key: string, doc: ChannelDoc, now: number): DirectoryDoc | null {
  const body = openBody(key, "dir", "current", doc);
  if (!isRecord(body) || body.v !== 1 || typeof body.at !== "number" || typeof body.version !== "string") return null;
  // A list from last week is not a list of who can take a message now.
  if (Math.abs(now - body.at) > 24 * 60 * 60_000) return null;
  if (body.caller !== null && typeof body.caller !== "string") return null;
  const readItems = (raw: unknown, max: number): DirectoryItem[] | null => {
    if (!Array.isArray(raw) || raw.length > max) return null;
    const out: DirectoryItem[] = [];
    for (const item of raw) {
      if (!isRecord(item) || typeof item.n !== "number" || typeof item.label !== "string") return null;
      if (item.choice !== undefined && !(typeof item.choice === "number" && Number.isInteger(item.choice))) return null;
      out.push({
        n: item.n,
        label: item.label.slice(0, 80),
        ...(typeof item.choice === "number" ? { choice: item.choice } : {}),
      });
    }
    return out;
  };
  const items = readItems(body.items, MAX_CHOICES);
  if (!items) return null;
  let workspaces: DirectoryWorkspace[] | undefined;
  if (body.workspaces !== undefined) {
    if (!Array.isArray(body.workspaces) || body.workspaces.length > MAX_WORKSPACES) return null;
    workspaces = [];
    for (const raw of body.workspaces) {
      if (!isRecord(raw) || typeof raw.n !== "number" || typeof raw.label !== "string") return null;
      const chats = readItems(raw.chats, MAX_WORKSPACES);
      if (!chats) return null;
      workspaces.push({ n: raw.n, label: raw.label.slice(0, 80), chats });
    }
  }
  let last: DirectoryDoc["last"];
  if (body.last !== undefined) {
    const raw = body.last;
    if (!isRecord(raw) || typeof raw.label !== "string" || typeof raw.choice !== "number") return null;
    if (!Number.isInteger(raw.choice) || raw.choice < 1 || raw.choice > MAX_CHOICES) return null;
    last = { choice: raw.choice, label: raw.label.slice(0, 80) };
  }
  let audio: string[] | undefined;
  if (body.audio !== undefined) {
    if (!Array.isArray(body.audio) || body.audio.length > MAX_AUDIO_DOCS) return null;
    if (!body.audio.every((id) => typeof id === "string" && AUDIO_ID.test(id))) return null;
    audio = body.audio as string[];
  }
  return {
    ...(body.ask === true ? { ask: true as const } : {}),
    ...(body.talk === true ? { talk: true as const } : {}),
    v: 1,
    at: body.at,
    version: body.version,
    caller: body.caller,
    items,
    ...(workspaces ? { workspaces } : {}),
    ...(last ? { last } : {}),
    ...(audio ? { audio } : {}),
  };
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
  if (body.kind === "ask" && typeof body.memoId === "string" && body.memoId.length <= 64) {
    return { ok: true, message: { ...base, kind: "ask", memoId: body.memoId } };
  }
  if (body.kind === "status") {
    const { dirVersion, choice } = body;
    if (typeof dirVersion !== "string" || dirVersion.length > 64) return { ok: false, reason: "not a voice message" };
    if (typeof choice !== "number" || !Number.isInteger(choice) || choice < 1 || choice > MAX_CHOICES) {
      return { ok: false, reason: "not a voice message" };
    }
    return { ok: true, message: { ...base, kind: "status", dirVersion, choice } };
  }
  if (body.kind === "talk") {
    const { dirVersion, choice, phase, audio, callId } = body;
    if (typeof dirVersion !== "string" || dirVersion.length === 0 || dirVersion.length > 64) {
      return { ok: false, reason: "not a voice message" };
    }
    if (callId !== undefined && (typeof callId !== "string" || !/^[A-Za-z0-9_-]{4,64}$/.test(callId))) {
      return { ok: false, reason: "not a voice message" };
    }
    // A call out is always chat 1 of its own one-chat list; a call in names a chat of the published list.
    const choiceOk =
      callId === undefined
        ? choice === 1
        : typeof choice === "number" && Number.isInteger(choice) && choice >= 1 && choice <= MAX_CHOICES;
    if (!choiceOk || !["say", "confirm", "hold", "peek"].includes(phase as string))
      return { ok: false, reason: "not a voice message" };
    // A hold check-in or a peek is a key press, not speech: no recording goes with it.
    const spoken = phase === "say" || phase === "confirm";
    if (typeof audio !== "string" || (spoken && audio.length === 0) || audio.length > MAX_AUDIO_CHARS) {
      return { ok: false, reason: "no audio" };
    }
    return {
      ok: true,
      message: {
        ...base,
        kind: "talk",
        dirVersion,
        choice: choice as number,
        phase: phase as TalkPhase,
        audio,
        ...(callId !== undefined ? { callId: callId as string } : {}),
      },
    };
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
    case "transcript": {
      if (typeof body.text !== "string" || typeof body.label !== "string") return null;
      const spoken = readClip(body.audio);
      return {
        ...base,
        status: "transcript",
        text: body.text.slice(0, 1500),
        label: body.label.slice(0, 80),
        // Speech that does not check out is dropped, never a reason to lose the transcript.
        ...(spoken ? { audio: spoken } : {}),
      };
    }
    case "sent":
      return { ...base, status: "sent" };
    case "answer": {
      if (typeof body.text !== "string" || body.text.trim() === "") return null;
      const spoken = readClip(body.audio);
      return {
        ...base,
        status: "answer",
        text: body.text.slice(0, MAX_ANSWER_CHARS),
        ...(spoken ? { audio: spoken } : {}),
      };
    }
    case "talk": {
      if (typeof body.text !== "string") return null;
      if (body.next !== "listen" && body.next !== "confirm" && body.next !== "end" && body.next !== "hold") return null;
      if (body.text.trim() === "" && body.next !== "hold") return null;
      const spoken = readClip(body.audio);
      return {
        ...base,
        status: "talk",
        text: body.text.slice(0, MAX_ANSWER_CHARS),
        next: body.next,
        ...(spoken ? { audio: spoken } : {}),
      };
    }
    case "refused":
      return typeof body.reason === "string" ? { ...base, status: "refused", reason: body.reason.slice(0, 200) } : null;
    default:
      return null;
  }
}
