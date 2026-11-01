import crypto from "node:crypto";

import type { ChannelDoc } from "../remote/firestore-rest.js";
import { readAudioClips, readClip, type Clip } from "./clips.js";
import { CLOCK_SKEW_MS, isRecord, openBody, sealBody } from "./relay-protocol.js";
import { readFillers, type Fillers } from "./fillers.js";

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
  /**
   * Squeak may start a NEW chat here (add-on 0.18.0 and newer; the key is 0 in the workspace's chat menu): a 1-based
   * index into this version's list of workspaces a chat can be started in, which a `newchat` message names. The
   * Conductor workspace id behind it stays on the Mac, as a chat target does.
   */
  newChat?: number;
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
   * The Mac takes a recording in pieces while it is still being made (`audioParts` on a memo, newchat, talk or start,
   * the pieces as `upaudio-` documents): an add-on 0.19.0 or newer sends them only when the list it has says so.
   * Absent from an older Mac, and a recording goes up whole as `audio`, as it always has.
   */
  upParts?: true;
  /**
   * The owner's persona is terse: a call in drops "Hello, this is Squeak." from its prompts. Absent: as before.
   */
  terse?: true;
  /**
   * The chat offered first, before any menu: the one used by phone in the last two hours, else the newest waiting on
   * the person. `why` says which, so the prompt says it truly ("the last one you used" or "it's waiting on you");
   * absent from an older Mac, which reads as used. `choice` indexes the version's
   * chats as a memo's does, whether or not a menu lists it. No `last` at all: the call goes straight to the menus.
   */
  last?: { choice: number; label: string; why?: "used" | "waiting" };
  /**
   * The waiting lines in the owner's character (add-on 0.20.0 and newer): the add-on says a random one of `wait` when it
   * hands something to the Mac and one of `still` when that is slow, never the same twice in a row. Absent: "One moment."
   * and "Still working on it." as before. Each line is also one of the recorded prompts.
   */
  fillers?: Fillers;
  /** Ids of the audio documents (`voicedir/audio-<version>-<i>`) holding the Mac's recordings of this list's prompts. */
  audio?: string[];
}

export const MAX_AUDIO_DOCS = 8;
const AUDIO_ID = /^[A-Za-z0-9_-]{1,80}$/;

export const audioDocId = (version: string, index: number): string => `audio-${version}-${index}`;
/** The Mac's clips for one outbound call, one document each, written while the phone rings (`audioFollows`). */
export const callAudioId = (callId: string, index: number): string => `callaudio-${callId}-${index}`;
/**
 * One later sentence of a spoken answer (`audioFollows` on an `answer` or `talk`), keyed by the answer's own message id;
 * `n` counts from 1, since sentence 0 travels in the answer. Same sealing and document shape as `callaudio-`.
 */
export const replyAudioId = (messageId: string, index: number): string => `replyaudio-${messageId}-${index}`;
export const REPLY_AUDIO_PREFIX = "replyaudio-";
/** Most sentences an answer may be sent in (an answer is at most MAX_ANSWER_CHARS); more is spoken as one clip. */
export const MAX_ANSWER_PARTS = 30;
export const audioPath = (channel: string, id: string): string => `channels/${channel}/${DIR_KIND}/${id}`;

/**
 * One piece of a recording going up while the person still speaks: a document in `voiceup` named by the up message's own
 * id (the stream) and the piece's number from 0. The ids stay under the database rule's 80 characters.
 */
export const UP_AUDIO_PREFIX = "upaudio-";
export const upAudioId = (streamId: string, index: number): string => `${UP_AUDIO_PREFIX}${streamId}-${index}`;
/** Most pieces one recording may be sent in (three seconds each, so more than a recording can be). */
export const MAX_UP_PARTS = 40;
/** The most bytes of Opus one piece may hold: a few seconds of speech is a few KB; far under the 900000-character box. */
export const MAX_UP_PART_BYTES = 150_000;
const STREAM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PART_HASH = /^[0-9a-f]{64}$/;
/** The hash a message names a piece by: SHA-256 of the piece's Opus bytes, lowercase hex. */
export const upPartHash = (opus: Buffer): string => crypto.createHash("sha256").update(opus).digest("hex");

/** One piece, sealed and signed like the other documents; `stream` and `n` are inside, so a copy under another id fails. */
export function sealUpPart(key: string, streamId: string, index: number, opus: Buffer, at: number): ChannelDoc {
  return sealBody(
    key,
    "up",
    upAudioId(streamId, index),
    { v: 1, stream: streamId, n: index, opus: opus.toString("base64") },
    at,
  );
}

/** A piece from an untrusted (but sealed and signed) document: its stream, number and Opus bytes, or null. */
export function readUpPart(
  key: string,
  id: string,
  doc: ChannelDoc,
): { stream: string; index: number; opus: Buffer } | null {
  if (!AUDIO_ID.test(id) || !id.startsWith(UP_AUDIO_PREFIX)) return null;
  const body = openBody(key, "up", id, doc);
  if (!isRecord(body) || body.v !== 1 || typeof body.stream !== "string" || !STREAM_ID.test(body.stream)) return null;
  if (typeof body.n !== "number" || !Number.isInteger(body.n) || body.n < 0 || body.n >= MAX_UP_PARTS) return null;
  if (id !== upAudioId(body.stream, body.n)) return null;
  if (typeof body.opus !== "string" || body.opus.length === 0 || body.opus.length > MAX_UP_PART_BYTES * 2) return null;
  const opus = Buffer.from(body.opus, "base64");
  if (opus.length === 0 || opus.length > MAX_UP_PART_BYTES) return null;
  return { stream: body.stream, index: body.n, opus };
}

/** The audio an up message carries: the whole recording (`audio`, base64 Opus) or the hashes of its pieces, never both. */
export function readUpAudio(
  body: Record<string, unknown>,
  { required }: { required: boolean },
): { ok: true; audio?: string; audioParts?: string[] } | { ok: false } {
  const { audio, audioParts } = body;
  if (audio !== undefined && audioParts !== undefined) return { ok: false };
  if (audioParts !== undefined) {
    if (!Array.isArray(audioParts) || audioParts.length < 1 || audioParts.length > MAX_UP_PARTS) return { ok: false };
    if (!audioParts.every((hash) => typeof hash === "string" && PART_HASH.test(hash))) return { ok: false };
    return { ok: true, audioParts: audioParts as string[] };
  }
  if (audio === undefined) return required ? { ok: false } : { ok: true };
  if (typeof audio !== "string" || audio.length === 0 || audio.length > MAX_AUDIO_CHARS) return { ok: false };
  return { ok: true, audio };
}

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
  | {
      v: 1;
      id: string;
      at: number;
      expiresAt: number;
      kind: "memo";
      dirVersion: string;
      choice: number;
      audio?: string;
      audioParts?: string[];
    }
  | { v: 1; id: string; at: number; expiresAt: number; kind: "send"; memoId: string }
  /**
   * What the person wants a NEW chat to do, recorded: `workspace` indexes the version's `newChat` list (a directory
   * workspace's `newChat`). The Mac answers with a `transcript` naming the workspace and the model, and starts nothing.
   */
  | {
      v: 1;
      id: string;
      at: number;
      expiresAt: number;
      kind: "newchat";
      dirVersion: string;
      workspace: number;
      audio?: string;
      audioParts?: string[];
    }
  /**
   * Start the new chat the Mac read back (`memoId` is the `newchat` message's id). Without `audio` it is the keypad's
   * explicit 1; with `audio` it is the person's spoken answer, which the Mac transcribes and only a plain yes accepts.
   * `callId` names the call, so the Mac can offer to hold the line for the chat it started.
   */
  | {
      v: 1;
      id: string;
      at: number;
      expiresAt: number;
      kind: "start";
      memoId: string;
      callId?: string;
      audio?: string;
      audioParts?: string[];
    }
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
      /** Exactly one of `audio` (the whole recording) and `audioParts` (hashes of its `upaudio-` pieces, in order). */
      audio?: string;
      audioParts?: string[];
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

/**
 * The rest of a spoken answer is still being made (add-on 0.17.0 and newer): `audio` is the clip of `parts[0]` only
 * and `parts` lists every sentence in order, each exactly the words its clip says. Sentence n (n >= 1) follows as the
 * document `replyAudioId(<this message's id>, n)`; one that never arrives is spoken by the add-on's quick plain voice.
 */
export interface AudioFollows {
  parts: string[];
}

export type DownMessage =
  /**
   * What was heard. `audio` is the Mac's clip of the read-back; with `audioFollows` (add-on 0.19.0 and newer) it is the
   * clip of `parts[0]` only, and `parts` joined with spaces are exactly the words of the add-on's own read-back.
   */
  | {
      v: 1;
      id: string;
      at: number;
      status: "transcript";
      text: string;
      label: string;
      audio?: Clip;
      audioFollows?: AudioFollows;
      model?: string;
    }
  /**
   * The outcome of a `start`: "started" (`hold`: the Mac offered to stay on the line, so the call goes on as a talk
   * turn in `confirm`), "declined" (a spoken no, or two answers that were no yes or no) or "again" (say yes or no).
   */
  | {
      v: 1;
      id: string;
      at: number;
      status: "newchat";
      outcome: "started" | "declined" | "again";
      text: string;
      audio?: Clip;
      audioFollows?: AudioFollows;
      hold?: true;
    }
  | { v: 1; id: string; at: number; status: "sent" }
  /** What to read aloud for an `ask` or `status`: plain sentences, at most `MAX_ANSWER_CHARS`. */
  | { v: 1; id: string; at: number; status: "answer"; text: string; audio?: Clip; audioFollows?: AudioFollows }
  /**
   * A refusal. `audio` (add-on 0.20.0 and newer) is the Mac's clip of exactly `reason`, so a line the Mac chose at call
   * time is in the Mac's voice without the add-on holding a recording of it ahead of the call.
   */
  | { v: 1; id: string; at: number; status: "refused"; reason: string; audio?: Clip }
  /** What to say for a `talk` turn, and what the call does next: listen again, listen for yes or no, or end. */
  | {
      v: 1;
      id: string;
      at: number;
      status: "talk";
      text: string;
      audio?: Clip;
      audioFollows?: AudioFollows;
      next: TalkNext;
    };

/** `audioFollows` from a sealed message: only with a first clip that says `parts[0]`, and well-formed parts. */
function readFollows(value: unknown, first: Clip | undefined): AudioFollows | undefined {
  if (!first || !isRecord(value) || !Array.isArray(value.parts)) return undefined;
  const { parts } = value;
  if (parts.length < 2 || parts.length > MAX_ANSWER_PARTS) return undefined;
  if (!parts.every((part) => typeof part === "string" && part.length > 0 && part.length <= MAX_ANSWER_CHARS)) {
    return undefined;
  }
  if (parts[0] !== first.text) return undefined;
  return { parts: parts as string[] };
}

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
      let newChat: number | undefined;
      if (raw.newChat !== undefined) {
        if (!Number.isInteger(raw.newChat) || (raw.newChat as number) < 1 || (raw.newChat as number) > MAX_WORKSPACES) {
          return null;
        }
        newChat = raw.newChat as number;
      }
      workspaces.push({ n: raw.n, label: raw.label.slice(0, 80), chats, ...(newChat ? { newChat } : {}) });
    }
  }
  let last: DirectoryDoc["last"];
  if (body.last !== undefined) {
    const raw = body.last;
    if (!isRecord(raw) || typeof raw.label !== "string" || typeof raw.choice !== "number") return null;
    if (!Number.isInteger(raw.choice) || raw.choice < 1 || raw.choice > MAX_CHOICES) return null;
    const why = raw.why === "used" || raw.why === "waiting" ? raw.why : undefined;
    last = { choice: raw.choice, label: raw.label.slice(0, 80), ...(why ? { why } : {}) };
  }
  let audio: string[] | undefined;
  if (body.audio !== undefined) {
    if (!Array.isArray(body.audio) || body.audio.length > MAX_AUDIO_DOCS) return null;
    if (!body.audio.every((id) => typeof id === "string" && AUDIO_ID.test(id))) return null;
    audio = body.audio as string[];
  }
  const fillers = body.fillers === undefined ? undefined : (readFillers(body.fillers) ?? undefined);
  return {
    ...(fillers ? { fillers } : {}),
    ...(body.ask === true ? { ask: true as const } : {}),
    ...(body.talk === true ? { talk: true as const } : {}),
    ...(body.upParts === true ? { upParts: true as const } : {}),
    ...(body.terse === true ? { terse: true as const } : {}),
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
    const { dirVersion, choice } = body;
    if (typeof dirVersion !== "string" || dirVersion.length > 64) return { ok: false, reason: "not a voice message" };
    if (typeof choice !== "number" || !Number.isInteger(choice) || choice < 1 || choice > MAX_CHOICES) {
      return { ok: false, reason: "not a voice message" };
    }
    const heard = readUpAudio(body, { required: true });
    if (!heard.ok) return { ok: false, reason: "no audio" };
    const { ok: _ok, ...spoken } = heard;
    void _ok;
    return { ok: true, message: { ...base, kind: "memo", dirVersion, choice, ...spoken } };
  }
  if (body.kind === "send" && typeof body.memoId === "string" && body.memoId.length <= 64) {
    return { ok: true, message: { ...base, kind: "send", memoId: body.memoId } };
  }
  if (body.kind === "newchat") {
    const { dirVersion, workspace } = body;
    if (typeof dirVersion !== "string" || dirVersion.length === 0 || dirVersion.length > 64) {
      return { ok: false, reason: "not a voice message" };
    }
    if (typeof workspace !== "number" || !Number.isInteger(workspace) || workspace < 1 || workspace > MAX_WORKSPACES) {
      return { ok: false, reason: "not a voice message" };
    }
    const heard = readUpAudio(body, { required: true });
    if (!heard.ok) return { ok: false, reason: "no audio" };
    const { ok: _ok, ...spoken } = heard;
    void _ok;
    return { ok: true, message: { ...base, kind: "newchat", dirVersion, workspace, ...spoken } };
  }
  if (body.kind === "start") {
    const { memoId, callId } = body;
    if (typeof memoId !== "string" || memoId.length === 0 || memoId.length > 64) {
      return { ok: false, reason: "not a voice message" };
    }
    if (callId !== undefined && (typeof callId !== "string" || !/^[A-Za-z0-9_-]{4,64}$/.test(callId))) {
      return { ok: false, reason: "not a voice message" };
    }
    const heard = readUpAudio(body, { required: false });
    if (!heard.ok) return { ok: false, reason: "no audio" };
    const { ok: _ok, ...spoken } = heard;
    void _ok;
    return {
      ok: true,
      message: {
        ...base,
        kind: "start",
        memoId,
        ...(callId !== undefined ? { callId: callId as string } : {}),
        ...spoken,
      },
    };
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
    const { dirVersion, choice, phase, callId } = body;
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
    const isSpeech = phase === "say" || phase === "confirm";
    // A key press (hold, peek) carries an empty whole audio; speech is the whole recording or its pieces.
    const heard: ReturnType<typeof readUpAudio> = isSpeech
      ? readUpAudio(body, { required: true })
      : body.audioParts === undefined && typeof body.audio === "string" && body.audio.length <= MAX_AUDIO_CHARS
        ? { ok: true, audio: body.audio }
        : { ok: false };
    if (!heard.ok) return { ok: false, reason: "no audio" };
    const { ok: _ok, ...spoken } = heard;
    void _ok;
    return {
      ok: true,
      message: {
        ...base,
        kind: "talk",
        dirVersion,
        choice: choice as number,
        phase: phase as TalkPhase,
        ...spoken,
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
      const follows = readFollows(body.audioFollows, spoken);
      return {
        ...base,
        status: "transcript",
        text: body.text.slice(0, 1500),
        label: body.label.slice(0, 80),
        // Speech that does not check out is dropped, never a reason to lose the transcript.
        ...(spoken ? { audio: spoken } : {}),
        ...(follows ? { audioFollows: follows } : {}),
        ...(typeof body.model === "string" && body.model.trim() ? { model: body.model.slice(0, 80) } : {}),
      };
    }
    case "sent":
      return { ...base, status: "sent" };
    case "answer": {
      if (typeof body.text !== "string" || body.text.trim() === "") return null;
      const spoken = readClip(body.audio);
      const follows = readFollows(body.audioFollows, spoken);
      return {
        ...base,
        status: "answer",
        text: body.text.slice(0, MAX_ANSWER_CHARS),
        ...(spoken ? { audio: spoken } : {}),
        ...(follows ? { audioFollows: follows } : {}),
      };
    }
    case "talk": {
      if (typeof body.text !== "string") return null;
      if (body.next !== "listen" && body.next !== "confirm" && body.next !== "end" && body.next !== "hold") return null;
      if (body.text.trim() === "" && body.next !== "hold") return null;
      const spoken = readClip(body.audio);
      const follows = readFollows(body.audioFollows, spoken);
      return {
        ...base,
        status: "talk",
        text: body.text.slice(0, MAX_ANSWER_CHARS),
        next: body.next,
        ...(spoken ? { audio: spoken } : {}),
        ...(follows ? { audioFollows: follows } : {}),
      };
    }
    case "newchat": {
      if (typeof body.text !== "string" || body.text.trim() === "") return null;
      if (body.outcome !== "started" && body.outcome !== "declined" && body.outcome !== "again") return null;
      const spoken = readClip(body.audio);
      const follows = readFollows(body.audioFollows, spoken);
      return {
        ...base,
        status: "newchat",
        outcome: body.outcome,
        text: body.text.slice(0, MAX_ANSWER_CHARS),
        ...(spoken ? { audio: spoken } : {}),
        ...(follows ? { audioFollows: follows } : {}),
        ...(body.hold === true && body.outcome === "started" ? { hold: true as const } : {}),
      };
    }
    case "refused": {
      if (typeof body.reason !== "string") return null;
      const reason = body.reason.slice(0, 200);
      const spoken = readClip(body.audio);
      // A clip that says anything but the reason is dropped: the add-on seeds it under its own words.
      return { ...base, status: "refused", reason, ...(spoken && spoken.text === reason ? { audio: spoken } : {}) };
    }
    default:
      return null;
  }
}
