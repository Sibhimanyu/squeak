import crypto from "node:crypto";

import { logger } from "../utils/logger.js";
import type { Clip } from "./clips.js";
import { readDigits, type IncomingCall, type PhoneCall } from "./phone.js";
import {
  MAX_MEMO_MS,
  MENU_CHOICES,
  newMessageId,
  type DirectoryDoc,
  type DirectoryItem,
  type DownMessage,
  type DirectoryWorkspace,
} from "./memo-protocol.js";
import type { Uplink } from "./uplink.js";

export interface InboundDependencies {
  /**
   * Checked here, on this side only: neither the Mac nor the database ever holds it. Null skips it: you called
   * in, from the one extension allowed to, which the PBX has already proved is you.
   */
  pin: () => string | null;
  /**
   * Whether a call in may be taken at all right now; absent: yes. False when no pin has ever been set (and calling in
   * is not set to skip it): a caller could not be checked, so the call is refused. A pin turned off on purpose is
   * allowed: `pin()` is then null and nothing is asked.
   */
  allowed?: () => boolean;
  /** Who can take a message now, and the one extension allowed to call in (read from the Mac's sealed list). */
  directory: () => Promise<DirectoryDoc | null>;
  uplink: Uplink;
  /** Turns a recorded WAV into the small Opus memo that travels. */
  encode: (wavFile: string) => Promise<Buffer>;
  /**
   * One line per notable thing, for the apps' call log: `step: …`, `said: …` (what Squeak spoke) and `key: …` (a menu
   * or confirmation key). Never a PIN digit.
   */
  trace?: (line: string) => void;
  /** Gives the phone the Mac's recording of the read-back, so the add-on does not have to make it mid-call. */
  seed?: (clips: Clip[]) => void;
}

/** The read-back of what was heard: said by the add-on, and made ahead by the Mac in its own voice. */
export function readBackSentence(text: string, label: string): string {
  const { head, tail } = readBackParts(text, label);
  return `${head} ${tail}`;
}

/** The read-back in two parts: what was heard (per call), and the fixed suffix (per chat, made ahead). */
export function readBackParts(text: string, label: string): { head: string; tail: string } {
  return {
    head: `I heard: ${text.replace(/[.!?\s]+$/, "")}.`,
    tail: `Press 1 to send it to ${label}, 2 to record again, star to hear it again, or hash to cancel.`,
  };
}

const GREETING = "Hello, this is Squeak.";
const AGAIN = "Press star to hear this again";

/** Every fixed sentence the flow says: also what is made ahead of time, so it is ready the moment a call connects. */
const SAYS = {
  pin: "Please enter your PIN, then press hash. Press star to start over.",
  pinAgain: "That PIN is not right. Try again, then press hash.",
  pinFail: "That PIN is not right. Goodbye.",
  noChat: "No chat can take a message right now. Goodbye.",
  wait: "One moment.",
  still: "Still working on it.",
  nothing: "I did not hear anything. Let's try again.",
  cancelled: "Cancelled. Goodbye.",
  bye: "Goodbye.",
  noMac: "I could not reach your Mac. Goodbye.",
  notSure: "I could not reach your Mac, so I am not sure it was sent. Check the app. Goodbye.",
  wrong: "Something went wrong.",
};

/** Said once a chat is chosen, before the beep. */
const recordPrompt = (label: string): string =>
  `${label}. Speak your message after the beep, and press hash when you are done.`;
const sentLine = (label: string): string => `Done. Your message was sent to ${label}. Goodbye.`;

const MENU_END = `${AGAIN}, or hash to hang up.`;

/** The menu of chats outside the favourites (or all of them, with no workspaces). */
function menuPrompt(directory: DirectoryDoc, greet: boolean): string {
  const menu = directory.items
    .slice(0, MENU_CHOICES)
    .map((item) => `Press ${item.n} for ${item.label}.`)
    .join(" ");
  return `${greet ? `${GREETING} ` : ""}Which chat? ${menu} ${MENU_END}`;
}

/** The first thing said after the PIN when favourites are set: one key picks the workspace. */
function workspaceMenuPrompt(directory: DirectoryDoc, greet: boolean): string {
  const menu = (directory.workspaces ?? []).map((w) => `Press ${w.n} for ${w.label}.`).join(" ");
  const other = directory.items.length > 0 ? " Press 0 for other chats." : "";
  return `${greet ? `${GREETING} ` : ""}Which workspace? ${menu}${other} ${MENU_END}`;
}

function chatMenuPrompt(workspace: DirectoryWorkspace): string {
  const menu = workspace.chats.map((chat) => `Press ${chat.n} for ${chat.label}.`).join(" ");
  return `${workspace.label}. Which chat? ${menu} ${AGAIN}, or hash to go back.`;
}

const noneIn = (workspace: DirectoryWorkspace): string => `Nothing in ${workspace.label} can take a message right now.`;

/** The words the menus will say for this list; the first menu carries the greeting only when no PIN prompt came first. */
function menuPrompts(directory: DirectoryDoc, greet: boolean): string[] {
  const out: string[] = [];
  if (directory.workspaces?.length) {
    out.push(workspaceMenuPrompt(directory, greet));
    for (const workspace of directory.workspaces) {
      out.push(workspace.chats.length === 0 ? noneIn(workspace) : chatMenuPrompt(workspace));
    }
    if (directory.items.length > 0) out.push(menuPrompt(directory, false));
  } else if (directory.items.length > 0) {
    out.push(menuPrompt(directory, greet));
  }
  return out;
}

/** Every chat a message can go to, whichever menu names it. */
function allLabels(directory: DirectoryDoc): string[] {
  const labels = [...directory.items.map((item) => item.label)];
  for (const workspace of directory.workspaces ?? []) for (const chat of workspace.chats) labels.push(chat.label);
  return [...new Set(labels)];
}

/**
 * What to have ready for this chat list (the read-back of a message is the one thing made on the spot). Also what
 * the Mac records in its own voice and sends along (voice/natural-voice.ts), so the whole call sounds the same.
 */
export function inboundPrompts(directory: DirectoryDoc | null, askPin: boolean): string[] {
  const fixed = [
    SAYS.wait,
    SAYS.still,
    SAYS.nothing,
    SAYS.cancelled,
    SAYS.bye,
    SAYS.noMac,
    SAYS.notSure,
    SAYS.wrong,
    SAYS.noChat,
  ];
  const pin = askPin ? [`${GREETING} ${SAYS.pin}`, SAYS.pin, SAYS.pinAgain, SAYS.pinFail] : [];
  const perChat = directory ? allLabels(directory).flatMap((label) => [recordPrompt(label), sentLine(label)]) : [];
  return [...new Set([...pin, ...(directory ? menuPrompts(directory, !askPin) : []), ...perChat, ...fixed])];
}

/** The shortest recording that is a message, not a hiss. */
const MIN_MEMO_MS = 800;
const PIN_TRIES = 2;
const PIN_WAIT_MS = 20_000;
const MENU_WAIT_MS = 15_000;
const CONFIRM_WAIT_MS = 30_000;
const MAX_TAKES = 3;
const MAX_REPEATS = 5;
const STILL_WORKING_MS = 6_000;

function samePin(typed: string, pin: string): boolean {
  const a = Buffer.from(typed);
  const b = Buffer.from(pin);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * A call in, start to finish: who may call, the PIN, which chat, the message, what was heard, and "send".
 * A phone is a poor way to type, so every step is spoken and every answer is a key; nothing reaches an
 * agent until the Mac has read back the words it heard and you pressed 1.
 */
export async function handleIncoming(incoming: IncomingCall, deps: InboundDependencies): Promise<void> {
  const directory = await deps.directory().catch(() => null);
  // Only the extension set in Squeak's Settings may call in, and with none set nobody may: the PIN is the second lock.
  if (!directory?.caller || incoming.peer !== directory.caller) {
    logger.info("voice call-in refused", { from: incoming.peer || incoming.uri, allowed: directory?.caller ?? null });
    deps.trace?.(`step: Call in from extension ${incoming.peer || "unknown"} refused: not the allowed extension`);
    await incoming.reject().catch(() => undefined);
    return;
  }
  if (deps.allowed && !deps.allowed()) {
    logger.info("voice call-in refused", { reason: "no pin is set" });
    deps.trace?.("step: Call in refused: no PIN is set");
    await incoming.reject().catch(() => undefined);
    return;
  }
  let call: PhoneCall;
  try {
    call = await incoming.answer();
  } catch (error) {
    logger.info("voice call-in not answered", { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  const began = Date.now();
  deps.trace?.(`step: Call in answered from extension ${incoming.peer || "unknown"}`);
  try {
    await conversation(call, deps);
  } catch (error) {
    logger.warn("voice call-in failed", { error: error instanceof Error ? error.message : String(error) });
    deps.trace?.("step: The call-in failed");
  } finally {
    await call.hangup().catch(() => undefined);
    deps.trace?.(`step: Call in ended after ${((Date.now() - began) / 1000).toFixed(1)} s`);
  }
}

/** Says it, and writes down that it was said. */
async function speak(call: PhoneCall, deps: InboundDependencies, text: string): Promise<void> {
  deps.trace?.(`said: ${text}`);
  await call.say(text);
}

async function bye(call: PhoneCall, deps: InboundDependencies, text: string): Promise<void> {
  await speak(call, deps, text);
}

async function conversation(call: PhoneCall, deps: InboundDependencies): Promise<void> {
  // 1. The PIN, unless this gateway is set to take the caller's extension as proof.
  // Read once per call: a pin changed from an app applies from the next one.
  const pin = deps.pin();
  let known = pin === null;
  for (let attempt = 0; attempt < PIN_TRIES && call.open && !known; attempt++) {
    // The PIN prompt is said but its digits are never written down.
    await speak(call, deps, attempt === 0 ? `${GREETING} ${SAYS.pin}` : SAYS.pinAgain);
    const typed = await readDigits(call, { maxLength: 12, timeoutMs: PIN_WAIT_MS });
    if (typed === null) return;
    known = samePin(typed, pin ?? "");
    deps.trace?.(known ? "step: PIN accepted" : "step: PIN wrong");
  }
  if (!known) return bye(call, deps, SAYS.pinFail);

  // 2. Which workspace, then which chat. Re-read now: the list moves while the phone rings.
  const directory = await deps.directory().catch(() => null);
  if (!directory || (directory.items.length === 0 && !directory.workspaces?.some((w) => w.chats.length > 0))) {
    return bye(call, deps, SAYS.noChat);
  }
  const target = await pickTarget(call, deps, directory, pin === null);
  if (target === null) return bye(call, deps, SAYS.bye);
  const choice = chosen(target);

  // 3. Record, hear it back, send.
  for (let take = 0; take < MAX_TAKES && call.open; take++) {
    await speak(call, deps, recordPrompt(target.label));
    const recording = await call.record({ maxMs: MAX_MEMO_MS, beep: true });
    if (!recording) return;
    deps.trace?.(`step: Recorded ${(recording.durationMs / 1000).toFixed(1)} s`);
    if (recording.durationMs < MIN_MEMO_MS) {
      await speak(call, deps, SAYS.nothing);
      continue;
    }
    await speak(call, deps, SAYS.wait);
    const memoId = newMessageId();
    const waiting = setTimeout(() => void speak(call, deps, SAYS.still).catch(() => undefined), STILL_WORKING_MS);
    let heard: DownMessage | null;
    try {
      heard = await deps.uplink.memo(memoId, choice, directory.version, await deps.encode(recording.file));
    } finally {
      clearTimeout(waiting);
    }
    if (!heard) return bye(call, deps, SAYS.noMac);
    if (heard.status !== "transcript") {
      await speak(call, deps, heard.status === "refused" ? heard.reason : SAYS.wrong);
      continue;
    }
    if (heard.audio) deps.seed?.([heard.audio]);
    const readBack = readBackSentence(heard.text, heard.label);
    let answer: string | null = null;
    for (let repeats = 0; call.open; repeats++) {
      await speak(call, deps, readBack);
      answer = await call.key(CONFIRM_WAIT_MS);
      if (answer !== "*") break;
      deps.trace?.("key: * (hear it again)");
      if (repeats >= MAX_REPEATS) {
        answer = null;
        break;
      }
    }
    deps.trace?.(`key: ${answer === "1" ? "1 (send)" : answer === "2" ? "2 (record again)" : "cancel"}`);
    if (answer === "2") continue;
    if (answer !== "1") return bye(call, deps, SAYS.cancelled);
    const outcome = await deps.uplink.send(memoId);
    if (!outcome) return bye(call, deps, SAYS.notSure);
    deps.trace?.(outcome.status === "sent" ? "step: Message sent" : "step: Message not sent");
    return bye(
      call,
      deps,
      outcome.status === "sent"
        ? sentLine(target.label)
        : outcome.status === "refused"
          ? `${outcome.reason} Goodbye.`
          : SAYS.bye,
    );
  }
  return bye(call, deps, SAYS.bye);
}

const digitOf = (key: string | null): number | null => (key !== null && /^\d$/.test(key) ? Number(key) : null);
const chosen = (item: DirectoryItem): number => item.choice ?? item.n;

/** Says a menu and reads one key; `*` says it again (not an attempt), up to MAX_REPEATS times, then counts as no answer. */
async function menuKey(call: PhoneCall, deps: InboundDependencies, prompt: string): Promise<string | null> {
  for (let repeats = 0; call.open; repeats++) {
    await speak(call, deps, prompt);
    const key = await call.key(MENU_WAIT_MS);
    if (key !== "*") return key;
    deps.trace?.("key: * (hear it again)");
    if (repeats >= MAX_REPEATS) return null;
  }
  return null;
}

/**
 * The chat to send to, or null. With favourite workspaces the first question is the
 * workspace; pressing a number before it has been read out is enough (a key interrupts speech).
 */
async function pickTarget(
  call: PhoneCall,
  deps: InboundDependencies,
  directory: DirectoryDoc,
  greet: boolean,
): Promise<DirectoryItem | null> {
  const workspaces = directory.workspaces ?? [];
  if (workspaces.length === 0) return pickChat(call, deps, directory.items, menuPrompt(directory, greet));
  for (let attempt = 0; attempt < 3 && call.open; attempt++) {
    const key = await menuKey(call, deps, workspaceMenuPrompt(directory, greet && attempt === 0));
    if (key === null || key === "#") return null;
    const digit = digitOf(key);
    if (digit === 0 && directory.items.length > 0) {
      deps.trace?.("key: 0 (other chats)");
      const other = await pickChat(call, deps, directory.items, menuPrompt(directory, false));
      if (other !== null) return other;
      continue;
    }
    const workspace = workspaces.find((w) => w.n === digit);
    if (!workspace) continue;
    deps.trace?.(`key: ${digit} (workspace ${workspace.label})`);
    if (workspace.chats.length === 0) {
      await speak(call, deps, noneIn(workspace));
      continue;
    }
    // One chat in it: nothing to choose, and the line before the beep names it.
    if (workspace.chats.length === 1) return workspace.chats[0]!;
    const picked = await pickChat(call, deps, workspace.chats, chatMenuPrompt(workspace));
    if (picked !== null) return picked;
  }
  return null;
}

/** A chat from a menu, or null when none was chosen (or `#` was pressed). */
async function pickChat(
  call: PhoneCall,
  deps: InboundDependencies,
  items: DirectoryItem[],
  prompt: string,
): Promise<DirectoryItem | null> {
  for (let attempt = 0; attempt < 2 && call.open; attempt++) {
    const key = await menuKey(call, deps, prompt);
    if (key === null || key === "#") return null;
    const digit = digitOf(key);
    const item = items.find((candidate) => candidate.n === digit);
    if (item) {
      deps.trace?.(`key: ${digit} (${item.label})`);
      return item;
    }
  }
  return null;
}
