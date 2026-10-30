import crypto from "node:crypto";

import { open, seal } from "../remote/remote-crypto.js";
import type { ChannelDoc } from "../remote/firestore-rest.js";
import type { CallScript } from "./dialog.js";
import { readClips, type Clip } from "./clips.js";
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
  /**
   * The words of this call as the Mac's own voice says them, played in place of the add-on's when the dialog asks
   * for exactly these words. Absent: the add-on speaks everything itself (an older add-on ignores the field).
   */
  audio?: Clip[];
  /**
   * The Mac's clips are not in this request: they follow as `voicedir` documents (`callaudio-<id>-<n>`, memo-protocol.ts)
   * while the phone rings, so the call starts at once. The add-on seeds each as it arrives and speaks its own voice for
   * anything not there yet. Absent: an older Mac, whose request carries its clips (or none).
   */
  audioFollows?: boolean;
  /** The extension to ring, from the Mac's settings; absent: the gateway's own default. Internal extensions only. */
  callee?: string;
}

export type CallResultBody =
  | { status: "answered"; letter: string | null }
  | { status: "unanswered" }
  | { status: "failed"; reason: string }
  /** The answer to a pin change: it took, or why not. */
  | { status: "pin"; ok: true }
  | { status: "pin"; ok: false; reason: string }
  /** The answer to a pin control (status, turn off, turn on, reset): the state the pin is in now, or why not. */
  | {
      status: "pinctl";
      ok: true;
      state: "set" | "off" | "none";
      /** When the pin is asked; an older add-on omits it. */
      policy?: { outgoing: "ask" | "skip"; incoming: "ask" | "skip" };
    }
  | { status: "pinctl"; ok: false; reason: string }
  /** The answer to a gateway command (update the add-on): it was started (the add-on restarts), or why not. */
  | { status: "gwcmd"; ok: true }
  | { status: "gwcmd"; ok: false; reason: string };

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

/** What an app may ask of the pin. Exactly these keys per action; never carries more than digits. */
export type PinAction =
  | { action: "change"; current: string; next: string }
  | { action: "disable"; current: string }
  | { action: "enable"; next: string }
  | { action: "reset"; next: string | null }
  | { action: "policy"; outgoing: "ask" | "skip"; incoming: "ask" | "skip" };

/** The actions that travel as a `pinctl` request (a change keeps its older `pin` request). */
export type PinControlAction = Exclude<PinAction, { action: "change" }> | { action: "status" };

/**
 * A pin action from untrusted input (the Mac app's route, a phone's signed command), or null: an object with exactly
 * the keys its action takes, every pin 4 to 12 digits. Never echoes a value.
 */
export function parsePinAction(value: unknown): PinAction | null {
  if (!isRecord(value) || typeof value.action !== "string") return null;
  const keys = Object.keys(value).sort().join(",");
  const digits = (v: unknown): v is string => typeof v === "string" && PIN_FORMAT.test(v);
  switch (value.action) {
    case "change":
      return keys === "action,current,next" && digits(value.current) && digits(value.next)
        ? { action: "change", current: value.current, next: value.next }
        : null;
    case "disable":
      return keys === "action,current" && digits(value.current) ? { action: "disable", current: value.current } : null;
    case "enable":
      return keys === "action,next" && digits(value.next) ? { action: "enable", next: value.next } : null;
    case "reset":
      return keys === "action,next" && (value.next === null || digits(value.next))
        ? { action: "reset", next: value.next }
        : null;
    case "policy": {
      const choice = (v: unknown): v is "ask" | "skip" => v === "ask" || v === "skip";
      return keys === "action,incoming,outgoing" && choice(value.outgoing) && choice(value.incoming)
        ? { action: "policy", outgoing: value.outgoing, incoming: value.incoming }
        : null;
    }
    default:
      return null;
  }
}

/** Turn the pin off or on, reset it, or ask where it stands: the gateway answers through its `PinKeeper`. */
export type PinControlRequest = {
  v: 1;
  id: string;
  at: number;
  expiresAt: number;
  kind: "pinctl";
} & PinControlAction;

/** What the Mac may tell the add-on to do about itself. Exactly this one action; never carries more. */
export type GatewayCommandAction = "update";

/** A command to the add-on itself (`kind: "gwcmd"`): exactly these keys. */
export interface GatewayCommandRequest {
  v: 1;
  id: string;
  at: number;
  expiresAt: number;
  kind: "gwcmd";
  action: GatewayCommandAction;
}

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
export type Direction = "req" | "res" | "dir" | "up" | "down" | "pairreq" | "pairgrant" | "claimreq" | "claimgrant";

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

export function sealPinControl(keyBase64: string, request: PinControlRequest): ChannelDoc {
  return sealBody(keyBase64, "req", request.id, request, request.at);
}

export function sealGatewayCommand(keyBase64: string, request: GatewayCommandRequest): ChannelDoc {
  return sealBody(keyBase64, "req", request.id, request, request.at);
}

/** A `gwcmd` request in a document, or why not. Checks the seal, id, exact keys, the action enum and age. */
export function readGatewayCommand(
  keyBase64: string,
  id: string,
  doc: ChannelDoc,
  now: number,
): { ok: true; request: GatewayCommandRequest } | { ok: false; reason: string } {
  const body = openBody(keyBase64, "req", id, doc);
  if (!isRecord(body)) return { ok: false, reason: "not sealed with this key" };
  if (body.v !== 1 || body.kind !== "gwcmd" || body.id !== id) return { ok: false, reason: "not a gateway command" };
  if (Object.keys(body).sort().join(",") !== "action,at,expiresAt,id,kind,v")
    return { ok: false, reason: "not a gateway command" };
  if (typeof body.at !== "number" || typeof body.expiresAt !== "number")
    return { ok: false, reason: "not a gateway command" };
  if (body.action !== "update") return { ok: false, reason: "not a gateway command" };
  if (
    body.expiresAt < now ||
    body.at > now + CLOCK_SKEW_MS ||
    body.expiresAt - body.at > REQUEST_TTL_MS + CLOCK_SKEW_MS
  ) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, request: { v: 1, id, at: body.at, expiresAt: body.expiresAt, kind: "gwcmd", action: "update" } };
}

/** A `pinctl` request in a document, or why not. Checks the seal, id, exact keys, digits and age. */
export function readPinControl(
  keyBase64: string,
  id: string,
  doc: ChannelDoc,
  now: number,
): { ok: true; request: PinControlRequest } | { ok: false; reason: string } {
  const body = openBody(keyBase64, "req", id, doc);
  if (!isRecord(body)) return { ok: false, reason: "not sealed with this key" };
  if (body.v !== 1 || body.kind !== "pinctl" || body.id !== id) return { ok: false, reason: "not a pin control" };
  if (typeof body.at !== "number" || typeof body.expiresAt !== "number")
    return { ok: false, reason: "not a pin control" };
  if (
    body.expiresAt < now ||
    body.at > now + CLOCK_SKEW_MS ||
    body.expiresAt - body.at > REQUEST_TTL_MS + CLOCK_SKEW_MS
  ) {
    return { ok: false, reason: "expired" };
  }
  const { v, id: _id, at, expiresAt, kind, ...rest } = body;
  void v;
  void _id;
  void at;
  void expiresAt;
  void kind;
  const action =
    rest.action === "status"
      ? Object.keys(rest).length === 1
        ? { action: "status" as const }
        : null
      : parsePinAction(rest);
  if (!action || action.action === "change") return { ok: false, reason: "not a pin control" };
  return {
    ok: true,
    request: { v: 1, id, at: body.at, expiresAt: body.expiresAt, kind: "pinctl", ...action } as PinControlRequest,
  };
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
      ...(readClips(body.audio) ? { audio: readClips(body.audio)! } : {}),
      ...(body.audioFollows === true ? { audioFollows: true } : {}),
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
    case "pinctl":
      if (body.ok === true) {
        if (body.state !== "set" && body.state !== "off" && body.state !== "none") return null;
        const p = body.policy;
        const choice = (v: unknown): v is "ask" | "skip" => v === "ask" || v === "skip";
        return isRecord(p) && choice(p.outgoing) && choice(p.incoming)
          ? { status: "pinctl", ok: true, state: body.state, policy: { outgoing: p.outgoing, incoming: p.incoming } }
          : { status: "pinctl", ok: true, state: body.state };
      }
      return body.ok === false && typeof body.reason === "string"
        ? { status: "pinctl", ok: false, reason: body.reason.slice(0, 200) }
        : null;
    case "gwcmd":
      if (body.ok === true) return { status: "gwcmd", ok: true };
      return body.ok === false && typeof body.reason === "string"
        ? { status: "gwcmd", ok: false, reason: body.reason.slice(0, 200) }
        : null;
    default:
      return null;
  }
}
