import crypto from "node:crypto";

import { logger } from "../utils/logger.js";
import { readDigits, type IncomingCall, type PhoneCall } from "./phone.js";
import { MAX_MEMO_MS, newMessageId, type DirectoryDoc } from "./memo-protocol.js";
import type { Uplink } from "./uplink.js";

export interface InboundDependencies {
  /** Checked here, on this side only: neither the Mac nor the database ever holds it. */
  pin: string;
  /** Who can take a message now, and the one extension allowed to call in (read from the Mac's sealed list). */
  directory: () => Promise<DirectoryDoc | null>;
  uplink: Uplink;
  /** Turns a recorded WAV into the small Opus memo that travels. */
  encode: (wavFile: string) => Promise<Buffer>;
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
  try {
    await conversation(call, deps);
  } catch (error) {
    logger.warn("voice call-in failed", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    await call.hangup().catch(() => undefined);
  }
}

async function bye(call: PhoneCall, text: string): Promise<void> {
  await call.say(text);
}

async function conversation(call: PhoneCall, deps: InboundDependencies): Promise<void> {
  // 1. The PIN.
  let known = false;
  for (let attempt = 0; attempt < PIN_TRIES && call.open && !known; attempt++) {
    await call.say(
      attempt === 0 ? "Squeak. Enter your PIN, then hash." : "That PIN is not right. Try again, then hash.",
    );
    const typed = await readDigits(call, { maxLength: 12, timeoutMs: PIN_WAIT_MS });
    if (typed === null) return;
    known = samePin(typed, deps.pin);
  }
  if (!known) return bye(call, "That PIN is not right. Goodbye.");

  // 2. Which chat. Re-read now: the list moves while the phone rings.
  const directory = await deps.directory().catch(() => null);
  if (!directory || directory.items.length === 0) {
    return bye(call, "No chat can take a message right now. Goodbye.");
  }
  const choice = await pickChat(call, directory);
  if (choice === null) return bye(call, "Goodbye.");
  const label = directory.items.find((item) => item.n === choice)?.label ?? `chat ${choice}`;

  // 3. Record, hear it back, send.
  for (let take = 0; take < MAX_TAKES && call.open; take++) {
    await call.say(`Say your message for ${label} after the beep, then press hash.`);
    await call.beep();
    const recording = await call.record({ maxMs: MAX_MEMO_MS });
    if (!recording) return;
    if (recording.durationMs < MIN_MEMO_MS) {
      await call.say("I did not hear anything.");
      continue;
    }
    await call.say("One moment.");
    const memoId = newMessageId();
    const heard = await deps.uplink.memo(memoId, choice, directory.version, await deps.encode(recording.file));
    if (!heard) return bye(call, "I could not reach your Mac. Goodbye.");
    if (heard.status !== "transcript") {
      await call.say(heard.status === "refused" ? heard.reason : "Something went wrong.");
      continue;
    }
    await call.say(
      `I heard: ${heard.text.replace(/[.!?\s]+$/, "")}. Press 1 to send it to ${heard.label}, 2 to record again, or hash to cancel.`,
    );
    const answer = await call.key(CONFIRM_WAIT_MS);
    if (answer === "2") continue;
    if (answer !== "1") return bye(call, "Cancelled. Goodbye.");
    const outcome = await deps.uplink.send(memoId);
    if (!outcome) return bye(call, "I could not reach your Mac, so I am not sure it was sent. Check the app. Goodbye.");
    return bye(
      call,
      outcome.status === "sent"
        ? "Sent. Goodbye."
        : outcome.status === "refused"
          ? `${outcome.reason} Goodbye.`
          : "Goodbye.",
    );
  }
  return bye(call, "Goodbye.");
}

/** The chat's number, or null if none was chosen. */
async function pickChat(call: PhoneCall, directory: DirectoryDoc): Promise<number | null> {
  const menu = directory.items.map((item) => `Press ${item.n} for ${item.label}.`).join(" ");
  for (let attempt = 0; attempt < 2 && call.open; attempt++) {
    await call.say(`Which chat? ${menu} Or press hash to hang up.`);
    const key = await call.key(MENU_WAIT_MS);
    if (key === null || key === "#") return null;
    const n = Number(key);
    if (directory.items.some((item) => item.n === n)) return n;
  }
  return null;
}
