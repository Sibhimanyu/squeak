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
  return `I heard: ${text.replace(/[.!?\s]+$/, "")}. Press 1 to send it to ${label}, 2 to record again, or hash to cancel.`;
}

/** Every fixed sentence the flow says: also what is made ahead of time, so it is ready the moment a call connects. */
const SAYS = {
  pin: "Squeak. Enter your pin, then hash.",
  pinAgain: "That pin is not right. Try again, then hash.",
  pinFail: "That pin is not right. Goodbye.",
  noChat: "No chat can take a message right now. Goodbye.",
  wait: "One moment.",
  nothing: "I did not hear anything.",
  cancelled: "Cancelled. Goodbye.",
  sent: "Sent. Goodbye.",
  bye: "Goodbye.",
  noMac: "I could not reach your Mac. Goodbye.",
  record: "Speak after the beep, then press hash.",
};

const MENU_END = "Or press hash to hang up.";

/** The menu of chats outside the favourites (or all of them, with no workspaces). */
function menuPrompt(directory: DirectoryDoc, greet: boolean): string {
  const menu = directory.items
    .slice(0, MENU_CHOICES)
    .map((item) => `Press ${item.n} for ${item.label}.`)
    .join(" ");
  return `${greet ? "Squeak. " : ""}Which chat? ${menu} ${MENU_END}`;
}

/** The first thing said after the PIN when favourites are set: one key picks the workspace. */
function workspaceMenuPrompt(directory: DirectoryDoc, greet: boolean): string {
  const menu = (directory.workspaces ?? []).map((w) => `Press ${w.n} for ${w.label}.`).join(" ");
  const other = directory.items.length > 0 ? " Press 0 for other chats." : "";
  return `${greet ? "Squeak. " : ""}Which workspace? ${menu}${other} ${MENU_END}`;
}

function chatMenuPrompt(workspace: DirectoryWorkspace): string {
  const menu = workspace.chats.map((chat) => `Press ${chat.n} for ${chat.label}.`).join(" ");
  return `${workspace.label}. Which chat? ${menu} Or press hash to go back.`;
}

const noneIn = (workspace: DirectoryWorkspace): string => `Nothing in ${workspace.label} can take a message right now.`;

/** The words the menus will say for this list; the first menu carries "Squeak." only when no PIN prompt came first. */
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

/**
 * What to have ready for this chat list (the read-back of a message is the one thing made on the spot). Also what
 * the Mac records in its own voice and sends along (voice/natural-voice.ts), so the whole call sounds the same.
 */
export function inboundPrompts(directory: DirectoryDoc | null, askPin: boolean): string[] {
  const fixed = [SAYS.record, SAYS.wait, SAYS.nothing, SAYS.cancelled, SAYS.sent, SAYS.bye, SAYS.noMac, SAYS.noChat];
  const pin = askPin ? [SAYS.pin, SAYS.pinAgain, SAYS.pinFail] : [];
  return [...new Set([...pin, ...(directory ? menuPrompts(directory, !askPin) : []), ...fixed])];
}

/** The shortest recording that is a message, not a hiss. */
const MIN_MEMO_MS = 800;
const PIN_TRIES = 2;
const PIN_WAIT_MS = 20_000;
const MENU_WAIT_MS = 15_000;
const CONFIRM_WAIT_MS = 30_000;
const MAX_TAKES = 3;

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
    await speak(call, deps, attempt === 0 ? SAYS.pin : SAYS.pinAgain);
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
  const choice = await pickTarget(call, deps, directory, pin === null);
  if (choice === null) return bye(call, deps, SAYS.bye);

  // 3. Record, hear it back, send.
  for (let take = 0; take < MAX_TAKES && call.open; take++) {
    await speak(call, deps, SAYS.record);
    const recording = await call.record({ maxMs: MAX_MEMO_MS, beep: true });
    if (!recording) return;
    deps.trace?.(`step: Recorded ${(recording.durationMs / 1000).toFixed(1)} s`);
    if (recording.durationMs < MIN_MEMO_MS) {
      await speak(call, deps, SAYS.nothing);
      continue;
    }
    await speak(call, deps, SAYS.wait);
    const memoId = newMessageId();
    const heard = await deps.uplink.memo(memoId, choice, directory.version, await deps.encode(recording.file));
    if (!heard) return bye(call, deps, SAYS.noMac);
    if (heard.status !== "transcript") {
      await speak(call, deps, heard.status === "refused" ? heard.reason : "Something went wrong.");
      continue;
    }
    if (heard.audio) deps.seed?.([heard.audio]);
    await speak(call, deps, readBackSentence(heard.text, heard.label));
    const answer = await call.key(CONFIRM_WAIT_MS);
    deps.trace?.(`key: ${answer === "1" ? "1 (send)" : answer === "2" ? "2 (record again)" : "cancel"}`);
    if (answer === "2") continue;
    if (answer !== "1") return bye(call, deps, SAYS.cancelled);
    const outcome = await deps.uplink.send(memoId);
    if (!outcome) {
      return bye(call, deps, "I could not reach your Mac, so I am not sure it was sent. Check the app. Goodbye.");
    }
    deps.trace?.(outcome.status === "sent" ? "step: Message sent" : "step: Message not sent");
    return bye(
      call,
      deps,
      outcome.status === "sent"
        ? "Sent. Goodbye."
        : outcome.status === "refused"
          ? `${outcome.reason} Goodbye.`
          : "Goodbye.",
    );
  }
  return bye(call, deps, SAYS.bye);
}

const digitOf = (key: string | null): number | null => (key !== null && /^\d$/.test(key) ? Number(key) : null);
const chosen = (item: DirectoryItem): number => item.choice ?? item.n;

/**
 * The chat to send to (its number in the directory), or null. With favourite workspaces the first question is the
 * workspace; pressing a number before it has been read out is enough (a key interrupts speech).
 */
async function pickTarget(
  call: PhoneCall,
  deps: InboundDependencies,
  directory: DirectoryDoc,
  greet: boolean,
): Promise<number | null> {
  const workspaces = directory.workspaces ?? [];
  if (workspaces.length === 0) return pickChat(call, deps, directory.items, menuPrompt(directory, greet));
  for (let attempt = 0; attempt < 3 && call.open; attempt++) {
    await speak(call, deps, workspaceMenuPrompt(directory, greet && attempt === 0));
    const key = await call.key(MENU_WAIT_MS);
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
    // One chat in it: nothing to choose, and the read-back names it.
    if (workspace.chats.length === 1) return chosen(workspace.chats[0]!);
    const picked = await pickChat(call, deps, workspace.chats, chatMenuPrompt(workspace));
    if (picked !== null) return picked;
  }
  return null;
}

/** A chat from a menu: its number, or null when none was chosen (or `#` was pressed). */
async function pickChat(
  call: PhoneCall,
  deps: InboundDependencies,
  items: DirectoryItem[],
  prompt: string,
): Promise<number | null> {
  for (let attempt = 0; attempt < 2 && call.open; attempt++) {
    await speak(call, deps, prompt);
    const key = await call.key(MENU_WAIT_MS);
    if (key === null || key === "#") return null;
    const digit = digitOf(key);
    const item = items.find((candidate) => candidate.n === digit);
    if (item) {
      deps.trace?.(`key: ${digit} (${item.label})`);
      return chosen(item);
    }
  }
  return null;
}
