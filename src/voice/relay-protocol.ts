import crypto from "node:crypto";

import { open, seal } from "../remote/remote-crypto.js";
import type { ChannelDoc } from "../remote/firestore-rest.js";
import type { CallScript } from "./dialog.js";
import { EXTENSION } from "./settings.js";

/**
 * What the Mac and the Home Assistant gateway say to each other through the Realtime Database.
 * The database is an untrusted pipe, as it is for the phone channel and Cliq: every body is sealed
 * (AES-256-GCM, `remote-crypto.ts`) under a key only the two ends hold, and each document also carries
 * an HMAC that binds its direction and id to its box, so a request cannot be replayed as a result, nor
 * one id's box filed under another. The ends then check age and the id they are waiting for.
 */

/** A call request, as the Mac seals it. */
export interface CallRequest {
  v: 1;
  id: string;
  at: number;
  expiresAt: number;
  /** Whether a reply could go back right now; the gateway only takes keys when it also holds a PIN. */
  answerable: boolean;
  script: CallScript;
  /** The extension to ring, from the Mac's settings; absent: the gateway's own default. Internal extensions only. */
  callee?: string;
}

export type CallResultBody =
  | { status: "answered"; letter: string | null }
  | { status: "unanswered" }
  | { status: "failed"; reason: string }
  /** The answer to a pin change: it took, or why not. */
  | { status: "pin"; ok: true }
  | { status: "pin"; ok: false; reason: string };

/**
 * Change the pin the gateway asks for. It needs the current pin: whoever only holds the channel key cannot set
 * their own. The gateway keeps the new one on Home Assistant; the Mac never stores it.
 */
export interface PinChangeRequest {
  v: 1;
  id: string;
  at: number;
  expiresAt: number;
  kind: "pin";
  current: string;
  next: string;
}

/** 4 to 12 digits: what a keypad can enter before `#`. */
export const PIN_FORMAT = /^\d{4,12}$/;

/** A call result, as the gateway seals it. `id` is the request's. */
export type CallResultDoc = CallResultBody & { v: 1; id: string; at: number };

/** A request stays valid this long: a call that has not started by then is not one to place. */
export const REQUEST_TTL_MS = 2 * 60_000;
/** A little clock skew between the Mac and Home Assistant is not a forgery. */
export const CLOCK_SKEW_MS = 2 * 60_000;

/** Where the documents live in the channel (database.rules.json allows exactly these kinds). */
export const REQUEST_KIND = "voice";
export const RESULT_KIND = "voiceresult";

export function requestPath(channel: string, id: string): string {
  return `channels/${channel}/${REQUEST_KIND}/${id}`;
}
export function resultPath(channel: string, id: string): string {
  return `channels/${channel}/${RESULT_KIND}/${id}`;
}

export function newCallId(): string {
  return crypto.randomBytes(16).toString("base64url");
}

/** Which way a document travels: bound into its signature so none can be replayed as another. */
export type Direction = "req" | "res" | "dir" | "up" | "down";

function signature(keyBase64: string, direction: Direction, id: string, box: string): string {
  const key = crypto.hkdfSync("sha256", Buffer.from(keyBase64, "base64"), Buffer.alloc(0), "squeak-voice-v1-sign", 32);
  return crypto.createHmac("sha256", Buffer.from(key)).update(`${direction}|${id}|${box}`, "utf8").digest("hex");
}

export function sealBody(keyBase64: string, direction: Direction, id: string, body: unknown, at: number): ChannelDoc {
  const box = seal(keyBase64, body);
  return { box, sig: signature(keyBase64, direction, id, box), at };
}

function equalHex(a: string, b: string): boolean {
  return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function openBody(keyBase64: string, direction: Direction, id: string, doc: ChannelDoc): unknown | null {
  if (typeof doc.box !== "string" || typeof doc.sig !== "string") return null;
  if (!equalHex(doc.sig, signature(keyBase64, direction, id, doc.box))) return null;
  try {
    return open(keyBase64, doc.box);
  } catch {
    return null;
  }
}

export function sealRequest(keyBase64: string, request: CallRequest): ChannelDoc {
  return sealBody(keyBase64, "req", request.id, request, request.at);
}

export function sealPinChange(keyBase64: string, request: PinChangeRequest): ChannelDoc {
  return sealBody(keyBase64, "req", request.id, request, request.at);
}

export function readPinChange(
  keyBase64: string,
  id: string,
  doc: ChannelDoc,
  now: number,
): { ok: true; request: PinChangeRequest } | { ok: false; reason: string } {
  const body = openBody(keyBase64, "req", id, doc);
  if (!isRecord(body)) return { ok: false, reason: "not sealed with this key" };
  if (body.v !== 1 || body.kind !== "pin" || body.id !== id) return { ok: false, reason: "not a pin change" };
  if (typeof body.at !== "number" || typeof body.expiresAt !== "number")
    return { ok: false, reason: "not a pin change" };
  if (typeof body.current !== "string" || typeof body.next !== "string")
    return { ok: false, reason: "not a pin change" };
  if (
    body.expiresAt < now ||
    body.at > now + CLOCK_SKEW_MS ||
    body.expiresAt - body.at > REQUEST_TTL_MS + CLOCK_SKEW_MS
  ) {
    return { ok: false, reason: "expired" };
  }
  return {
    ok: true,
    request: { v: 1, id, at: body.at, expiresAt: body.expiresAt, kind: "pin", current: body.current, next: body.next },
  };
}

export function sealResult(keyBase64: string, result: CallResultDoc): ChannelDoc {
  return sealBody(keyBase64, "res", result.id, result, result.at);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScript(value: unknown): value is CallScript {
  if (!isRecord(value) || typeof value.greeting !== "string" || typeof value.question !== "string") return false;
  if (!Array.isArray(value.options) || value.options.length > 8) return false;
  return value.options.every(
    (option) =>
      isRecord(option) &&
      typeof option.letter === "string" &&
      /^[A-H]$/.test(option.letter) &&
      typeof option.title === "string",
  );
}

/** The request in a document, or why not. Checks the seal, the id, the shape and the age. */
export function readRequest(
  keyBase64: string,
  id: string,
  doc: ChannelDoc,
  now: number,
): { ok: true; request: CallRequest } | { ok: false; reason: string } {
  const body = openBody(keyBase64, "req", id, doc);
  if (!isRecord(body)) return { ok: false, reason: "not sealed with this key" };
  if (body.v !== 1 || body.id !== id || typeof body.at !== "number" || typeof body.expiresAt !== "number") {
    return { ok: false, reason: "not a call request" };
  }
  if (typeof body.answerable !== "boolean" || !isScript(body.script))
    return { ok: false, reason: "not a call request" };
  // Only an internal extension: a stolen key must not be able to point the PBX at an outside number.
  if (body.callee !== undefined && !(typeof body.callee === "string" && EXTENSION.test(body.callee))) {
    return { ok: false, reason: "not an extension" };
  }
  if (
    body.expiresAt < now ||
    body.at > now + CLOCK_SKEW_MS ||
    body.expiresAt - body.at > REQUEST_TTL_MS + CLOCK_SKEW_MS
  ) {
    return { ok: false, reason: "expired" };
  }
  return {
    ok: true,
    request: {
      v: 1,
      id,
      at: body.at,
      expiresAt: body.expiresAt,
      answerable: body.answerable,
      script: body.script,
      ...(typeof body.callee === "string" ? { callee: body.callee } : {}),
    },
  };
}

/** The result in a document for the request `id`, or null. A letter is kept only if the script offered it. */
export function readResult(
  keyBase64: string,
  id: string,
  doc: ChannelDoc,
  offered: readonly string[],
): CallResultBody | null {
  const body = openBody(keyBase64, "res", id, doc);
  if (!isRecord(body) || body.v !== 1 || body.id !== id) return null;
  switch (body.status) {
    case "answered":
      if (body.letter === null || body.letter === undefined) return { status: "answered", letter: null };
      return typeof body.letter === "string" && offered.includes(body.letter)
        ? { status: "answered", letter: body.letter }
        : null;
    case "unanswered":
      return { status: "unanswered" };
    case "failed":
      return typeof body.reason === "string" ? { status: "failed", reason: body.reason.slice(0, 300) } : null;
    case "pin":
      if (body.ok === true) return { status: "pin", ok: true };
      return body.ok === false && typeof body.reason === "string"
        ? { status: "pin", ok: false, reason: body.reason.slice(0, 200) }
        : null;
    default:
      return null;
  }
}
