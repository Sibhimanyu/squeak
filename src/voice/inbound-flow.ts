import { recordForUpload, type RecordedUpload } from "./recording-upload.js";
import crypto from "node:crypto";

import { logger } from "../utils/logger.js";
import type { Clip } from "./clips.js";
import { readDigits, type IncomingCall, type PhoneCall } from "./phone.js";
import {
  MAX_ANSWERS_PER_CALL,
  MAX_MEMO_MS,
  MENU_CHOICES,
  newMessageId,
  type DirectoryDoc,
  type DirectoryItem,
  type DownMessage,
  type DirectoryWorkspace,
} from "./memo-protocol.js";
import { judgeTranscript } from "./transcript-quality.js";
import { speakReply } from "./answer-audio.js";
import type { TalkPhase } from "./memo-protocol.js";
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
  uplink: Omit<Uplink, "talk">;
  /** Turns a recorded WAV into the small Opus memo that travels. */
  encode: (wavFile: string) => Promise<Buffer>;
  /**
   * One line per notable thing, for the apps' call log: `step: …`, `said: …` (what Squeak spoke) and `key: …` (a menu
   * or confirmation key). Never a PIN digit.
   */
  trace?: (line: string) => void;
  /** Gives the phone the Mac's recording of the read-back, so the add-on does not have to make it mid-call. */
  seed?: (clips: Clip[]) => void;
  /**
   * Talks the call through once a chat is chosen (`talkFlow`), with a Mac that offers it (`DirectoryDoc.talk`).
   * "ended": it finished; "keys": the Mac could not be reached or refused, and the keypad goes on. Absent: the keypad.
   */
  talk?: (
    call: PhoneCall,
    info: {
      callId: string;
      label: string;
      from: { dirVersion: string; choice: number };
      /** The first turn's phase; absent: "say". "confirm" continues a hold offer the Mac has already made. */
      phase?: TalkPhase;
    },
  ) => Promise<"ended" | "keys">;
}

/**
 * The read-back of what was heard: said by the add-on, and made ahead by the Mac in its own voice. With `ask` (a Mac
 * that can answer questions) the keys are 1 send and hang up, 2 ask it as a question, 3 record again.
 */
export function readBackSentence(text: string, label: string, ask = false): string {
  const { head, tail } = readBackParts(text, label, ask);
  return `${head} ${tail}`;
}

/** The read-back in two parts: what was heard (per call), and the fixed suffix (per chat, made ahead). */
export function readBackParts(text: string, label: string, ask = false): { head: string; tail: string } {
  return {
    head: `I heard: ${text.replace(/[.!?\s]+$/, "")}.`,
    tail: ask
      ? `Press 1 to send it to ${label} and hang up, 2 to ask it as a question, 3 to record again, star to hear it again, or hash to cancel.`
      : `Press 1 to send it to ${label}, 2 to record again, star to hear it again, or hash to cancel.`,
  };
}

/** What the Mac says when it cannot answer a question (also what the add-on says when the Mac is silent). */
export const ASK_FAILED = "I could not get an answer. You can try again.";
const GREETING = "Hello, this is Squeak.";
/** The opening words of a call in: none for a terse persona (the owner knows who is calling). */
const hello = (terse: boolean): string => (terse ? "" : `${GREETING} `);
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
  // Only with a Mac that answers questions (`DirectoryDoc.ask`).
  recordAsk: "Speak your message or question after the beep, and press hash when you are done.",
  askFail: ASK_FAILED,
  followUp: `${AGAIN}, 1 for something else about this chat, or hash to hang up.`,
  limit: "That is as many answers as I can give on one call. Goodbye.",
  noSpeech: "I didn't hear anything. Press 1 to try again, or hash to hang up.",
  cap: "I have to stop there.",
  // A new chat from a call: what the add-on says when the Mac cannot be reached, or fails without a sentence of its own.
  newChatNoMac: "I could not reach your Mac, so no chat was started. Goodbye.",
  newChatNotSure: "I could not reach your Mac, so I am not sure the chat was started. Check the app. Goodbye.",
  newChatFailed: "Your Mac could not start the chat. Goodbye.",
};

/** Said once a chat is chosen, before the beep. */
const recordPrompt = (label: string): string =>
  `${label}. Speak your message after the beep, and press hash when you are done.`;
/** The first question once a chat is chosen, with a Mac that answers: say or ask something, or hear its status. */
const actionPrompt = (label: string): string =>
  `${label}. Press 9 to say a message or ask a question, or 0 to hear where it stands. ${AGAIN}, or hash to hang up.`;
/** Said once a chat is chosen, with a Mac that talks: the conversation starts at the beep. */
const talkPrompt = (label: string, terse = false): string =>
  terse ? `${label}.` : `${label}. Go ahead: ask me about it, or tell me what to do.`;
/** Offered first when the Mac names the chat used last: 1 takes it, 2 goes to the menus. */
export const lastChatPrompt = (
  label: string,
  greet: boolean,
  terse = false,
  why: "used" | "waiting" = "used",
): string =>
  `${greet ? hello(terse) : ""}Press 1 for ${label}, ${why === "waiting" ? "it's waiting on you" : "the last one you used"}. Press 2 for another chat. ${AGAIN}, or hash to hang up.`;
/** Said when the recording came back as silence or a stock hallucination; the key is "record again" for the flow. */
export const heardNothingPrompt = (recordAgain: string): string =>
  `I didn't hear anything. Press ${recordAgain} to record again, or hash to cancel.`;
/** Said when the words are too few or too brief to trust; nothing is sent without a key. */
export const unclearPrompt = (text: string, recordAgain: string): string =>
  `I only heard: ${text.replace(/[.!?\s]+$/, "")}. Press ${recordAgain} to record again, 1 to send it anyway, star to hear it again, or hash to cancel.`;
const sentLine = (label: string): string => `Done. Your message was sent to ${label}. Goodbye.`;

const MENU_END = `${AGAIN}, or hash to hang up.`;

/** The menu of chats outside the favourites (or all of them, with no workspaces). */
function menuPrompt(directory: DirectoryDoc, greet: boolean): string {
  const menu = directory.items
    .slice(0, MENU_CHOICES)
    .map((item) => `Press ${item.n} for ${item.label}.`)
    .join(" ");
  return `${greet ? hello(directory.terse === true) : ""}Which chat? ${menu} ${MENU_END}`;
}

/** The first thing said after the PIN when favourites are set: one key picks the workspace. */
function workspaceMenuPrompt(directory: DirectoryDoc, greet: boolean): string {
  const menu = (directory.workspaces ?? []).map((w) => `Press ${w.n} for ${w.label}.`).join(" ");
  const other = directory.items.length > 0 ? " Press 0 for other chats." : "";
  return `${greet ? hello(directory.terse === true) : ""}Which workspace? ${menu}${other} ${MENU_END}`;
}

/** The key for "a new chat" in a workspace's chat menu: chats take 1 to 9, so 0 is the one that never clashes. */
export const NEW_CHAT_KEY = "0";

function chatMenuPrompt(workspace: DirectoryWorkspace): string {
  const menu = workspace.chats.map((chat) => `Press ${chat.n} for ${chat.label}.`).join(" ");
  const fresh = workspace.newChat ? ` Press ${NEW_CHAT_KEY} for a new chat.` : "";
  return `${workspace.label}. Which chat? ${menu}${fresh} ${AGAIN}, or hash to go back.`;
}

const noneIn = (workspace: DirectoryWorkspace): string =>
  workspace.newChat
    ? `Nothing in ${workspace.label} can take a message right now. Press ${NEW_CHAT_KEY} for a new chat. ${AGAIN}, or hash to go back.`
    : `Nothing in ${workspace.label} can take a message right now.`;

/** Said once a new chat is chosen, before the beep. */
export const newChatPrompt = (label: string): string => `New chat in ${label}. Go ahead: say what you want it to do.`;

/**
 * The read-back of a new chat: said by the add-on, and made ahead of the call by the Mac (it sends the clip with the
 * transcript). `model` is the model's name, or absent for "its usual model".
 */
export const newChatReadBack = (text: string, label: string, model: string | undefined): string =>
  `I'll start a new chat in ${label} with ${model ?? "its usual model"}: ${text.replace(/[.!?\s]+$/, "")}. Say yes to start it, or no.`;
const newChatKeys = "Press 1 to start it, star to hear it again, or hash to cancel.";
const newChatUnclear = (text: string): string =>
  `I only heard: ${text.replace(/[.!?\s]+$/, "")}. Press 2 to record again, or hash to cancel.`;

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
    SAYS.noSpeech,
    SAYS.cap,
  ];
  const terse = directory?.terse === true;
  const pin = askPin ? [`${hello(terse)}${SAYS.pin}`, SAYS.pin, SAYS.pinAgain, SAYS.pinFail] : [];
  const ask = directory?.ask === true;
  const talks = directory?.talk === true && directory.ask === true;
  const perChat = directory
    ? allLabels(directory).flatMap((label) =>
        talks
          ? [talkPrompt(label, terse), actionPrompt(label), sentLine(label)]
          : ask
            ? [actionPrompt(label), sentLine(label)]
            : [recordPrompt(label), sentLine(label)],
      )
    : [];
  if (ask) fixed.push(SAYS.recordAsk, SAYS.askFail, SAYS.followUp, SAYS.limit);
  const fresh = (directory?.workspaces ?? []).filter((w) => w.newChat);
  if (fresh.length > 0) {
    fixed.push(newChatKeys, SAYS.newChatNoMac, SAYS.newChatNotSure, SAYS.newChatFailed);
    for (const workspace of fresh) fixed.push(newChatPrompt(workspace.label));
  }
  fixed.push(heardNothingPrompt(ask ? "3" : "2"));
  const last = directory?.last ? [lastChatPrompt(directory.last.label, !askPin, terse, directory.last.why)] : [];
  // With a last chat the offer carries the greeting, so the menus behind "another chat" do not.
  const greetMenus = !askPin && last.length === 0;
  return [
    ...new Set([...pin, ...last, ...(directory ? menuPrompts(directory, greetMenus) : []), ...perChat, ...fixed]),
  ];
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
/** "Still working on it" is never said twice within this: a long wait is not a stream of reassurance. */
const STILL_WORKING_GAP_MS = 10_000;

/**
 * While the Mac works on an answer: says "Still working on it." after the first wait, and again only after the gap, as
 * long as the work goes on and the last one has been said. Returns what stops it.
 */
export function reassure(call: PhoneCall, deps: Pick<InboundDependencies, "trace">): () => void {
  let stopped = false;
  let saying = false;
  let lastAt = 0;
  const tick = (): void => {
    if (stopped || saying || !call.open || Date.now() - lastAt < STILL_WORKING_GAP_MS) return;
    saying = true;
    lastAt = Date.now();
    void speak(call, deps, SAYS.still)
      .catch(() => undefined)
      .finally(() => {
        saying = false;
      });
  };
  const begun = Date.now();
  const first = setTimeout(tick, STILL_WORKING_MS);
  const again = setInterval(() => {
    if (Date.now() - begun >= STILL_WORKING_MS) tick();
  }, 1_000);
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(again);
  };
}

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
  call.trace = deps.trace ?? null;
  deps.trace?.(`step: Call in answered from extension ${incoming.peer || "unknown"}`);
  try {
    await conversation(call, deps, directory.terse === true);
  } catch (error) {
    logger.warn("voice call-in failed", { error: error instanceof Error ? error.message : String(error) });
    deps.trace?.("step: The call-in failed");
  } finally {
    await call.hangup().catch(() => undefined);
    deps.trace?.(`step: Call in ended after ${((Date.now() - began) / 1000).toFixed(1)} s`);
  }
}

/** Says it, and writes down that it was said. */
async function speak(call: PhoneCall, deps: Pick<InboundDependencies, "trace">, text: string): Promise<void> {
  deps.trace?.(`said: ${text}`);
  await call.say(text);
}

async function bye(call: PhoneCall, deps: InboundDependencies, text: string): Promise<void> {
  await speak(call, deps, text);
}

async function conversation(call: PhoneCall, deps: InboundDependencies, terse: boolean): Promise<void> {
  // 1. The PIN, unless this gateway is set to take the caller's extension as proof.
  // Read once per call: a pin changed from an app applies from the next one.
  const pin = deps.pin();
  let known = pin === null;
  for (let attempt = 0; attempt < PIN_TRIES && call.open && !known; attempt++) {
    // The PIN prompt is said but its digits are never written down.
    await speak(call, deps, attempt === 0 ? `${hello(terse)}${SAYS.pin}` : SAYS.pinAgain);
    call.redactKeys = true;
    const typed = await readDigits(call, { maxLength: 12, timeoutMs: PIN_WAIT_MS }).finally(() => {
      call.redactKeys = false;
    });
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
  // The chat used last is offered before any menu: 1 takes it, 2 goes on to the workspaces and chats.
  let target: DirectoryItem | null = null;
  let greet = pin === null;
  if (directory.last) {
    const offered = directory.last;
    let another = false;
    for (let attempt = 0; attempt < 2 && call.open && target === null && !another; attempt++) {
      const key = await menuKey(
        call,
        deps,
        lastChatPrompt(offered.label, greet && attempt === 0, directory.terse === true, offered.why),
      );
      if (key === null || key === "#") return bye(call, deps, SAYS.bye);
      if (key === "1") {
        deps.trace?.(`key: 1 (${offered.label}, the last one used)`);
        target = { n: 1, label: offered.label, choice: offered.choice };
      } else if (key === "2") {
        deps.trace?.("key: 2 (another chat)");
        another = true;
      }
    }
    // Two wrong keys end the call, as in every menu; 2 goes on, with the greeting already said.
    if (target === null && !another) return bye(call, deps, SAYS.bye);
    greet = false;
  }
  const picked = target ?? (await pickTarget(call, deps, directory, greet));
  if (picked === null) return bye(call, deps, SAYS.bye);
  // 0 in a workspace's chat menu: not a chat of the list but a new one in that workspace.
  if ("newChatIn" in picked) return newChatFlow(call, deps, directory, picked.newChatIn);
  target = picked;

  // 3a. With a Mac that talks: the rest of the call is a conversation about this chat. Only if the Mac cannot be
  // reached does it fall back to the keys below.
  if (directory.talk === true && directory.ask === true && deps.talk && call.open) {
    await speak(call, deps, talkPrompt(target.label, directory.terse === true));
    const outcome = await deps.talk(call, {
      callId: crypto.randomBytes(9).toString("base64url"),
      label: target.label,
      from: { dirVersion: directory.version, choice: chosen(target) },
    });
    if (outcome === "ended") return;
    deps.trace?.("step: Talking did not work, back to the keys");
  }

  // 3. With a Mac that answers questions: say or ask something, or hear the chat's status; each answer may be followed
  // by something else about the same chat (at most MAX_ANSWERS_PER_CALL in all). Without one: record, hear it, send.
  if (directory.ask !== true) {
    await messageFlow(call, deps, directory, target, false, { answers: 0 });
    return;
  }
  const counter = { answers: 0 };
  for (let round = 0; call.open; round++) {
    const mode = await actionKey(call, deps, target.label);
    if (mode === null) return bye(call, deps, SAYS.bye);
    const outcome =
      mode === "status"
        ? await statusFlow(call, deps, directory, target, counter)
        : await messageFlow(call, deps, directory, target, true, counter);
    if (outcome === "done") return;
    // An answer was read out: offer something else about this chat, or hang up.
    if (counter.answers >= MAX_ANSWERS_PER_CALL) return bye(call, deps, SAYS.limit);
    let next: string | null = null;
    for (let repeats = 0; call.open; repeats++) {
      await speak(call, deps, SAYS.followUp);
      next = await call.key(CONFIRM_WAIT_MS);
      if (next !== "*") break;
      deps.trace?.("key: * (hear the answer again)");
      if (repeats >= MAX_REPEATS || !outcome.text) {
        next = null;
        break;
      }
      await speak(call, deps, outcome.text);
    }
    deps.trace?.(`key: ${next === "1" ? "1 (something else about this chat)" : "hang up"}`);
    if (next !== "1") return bye(call, deps, SAYS.bye);
  }
}

type Done = "done" | { text: string };

/**
 * What an outbound call offers beside its options: a message for the chat that asked (9) or its status (0), run with
 * the same flows as a call in. The Mac knows the call's id as a one-chat list (`MemoInbox.registerCall`), so the chat
 * is item 1 of that "version". "ended": the flow said goodbye (a message sent, or cancelled); "back": ask the question again.
 */
export async function followUpFlow(
  call: PhoneCall,
  deps: InboundDependencies,
  info: { callId: string; label: string; ask: boolean },
  kind: "message" | "status",
): Promise<"back" | "ended"> {
  const item: DirectoryItem = { n: 1, label: info.label, choice: 1 };
  const directory: DirectoryDoc = {
    v: 1,
    at: Date.now(),
    version: info.callId,
    caller: null,
    items: [item],
    ...(info.ask ? { ask: true as const } : {}),
  };
  const counter = { answers: 0 };
  const outcome =
    kind === "status"
      ? await statusFlow(call, deps, directory, item, counter)
      : await messageFlow(call, deps, directory, item, info.ask, counter);
  return outcome === "done" || !call.open ? "ended" : "back";
}

/** One of the two things to do with a chat: 1 say or ask, 3 its status. Null: hash, silence or two wrong keys. */
async function actionKey(
  call: PhoneCall,
  deps: InboundDependencies,
  label: string,
): Promise<"message" | "status" | null> {
  for (let attempt = 0; attempt < 2 && call.open; attempt++) {
    const key = await menuKey(call, deps, actionPrompt(label));
    if (key === null || key === "#") return null;
    // The same keys as a call out (9 a message or question, 0 the status); 1 and 3, the older ones, still work.
    if (key === "9" || key === "1") return "message";
    if (key === "0" || key === "3") {
      deps.trace?.("key: 0 (status)");
      return "status";
    }
  }
  return null;
}

/** Reads out where the chat stands. Asks the Mac, which answers from what it knows and changes nothing. */
async function statusFlow(
  call: PhoneCall,
  deps: InboundDependencies,
  directory: DirectoryDoc,
  target: DirectoryItem,
  counter: { answers: number },
): Promise<Done> {
  counter.answers += 1;
  await speak(call, deps, SAYS.wait);
  const stopReassuring = reassure(call, deps);
  let heard: DownMessage | null;
  try {
    heard = await deps.uplink.status(chosen(target), directory.version);
  } finally {
    stopReassuring();
  }
  if (!heard) return bye(call, deps, SAYS.noMac).then(() => "done" as const);
  if (heard.status !== "answer") {
    await speak(call, deps, heard.status === "refused" ? heard.reason : SAYS.wrong);
    // Not a status: back to the question of what to do, unless the cap is spent.
    return counter.answers >= MAX_ANSWERS_PER_CALL
      ? bye(call, deps, SAYS.limit).then(() => "done" as const)
      : { text: "" };
  }
  deps.trace?.("step: Status read out");
  await speakReply(call, heard, deps);
  return { text: heard.text };
}

/**
 * Record a message, hear it back, and with 1 send it (the call then ends). With a Mac that answers questions, 2 treats
 * the recording as a question instead: the answer is read out and nothing is sent or typed anywhere.
 */
async function messageFlow(
  call: PhoneCall,
  deps: InboundDependencies,
  directory: DirectoryDoc,
  target: DirectoryItem,
  ask: boolean,
  counter: { answers: number },
): Promise<Done> {
  const choice = chosen(target);
  const done = (text: string): Promise<Done> => bye(call, deps, text).then(() => "done" as const);
  let askFails = 0;
  for (let take = 0; take < MAX_TAKES && call.open; take++) {
    await speak(call, deps, ask ? SAYS.recordAsk : recordPrompt(target.label));
    const memoId = newMessageId();
    const upload = await recordForUpload(call, deps, { maxMs: MAX_MEMO_MS, beep: true, endOnSilence: true }, memoId);
    if (!upload) return "done";
    const { recording } = upload;
    deps.trace?.(`step: Recorded ${(recording.durationMs / 1000).toFixed(1)} s`);
    if (recording.ended === "no-speech") {
      upload.discard();
      // Nothing was said: do not process two minutes of silence. One key tries again; anything else hangs up.
      await speak(call, deps, SAYS.noSpeech);
      const again = await call.key(MENU_WAIT_MS);
      deps.trace?.(`key: ${again === "1" ? "1 (try again)" : "hang up"}`);
      if (again === "1") continue;
      return done(SAYS.bye);
    }
    if (recording.ended === "limit") await speak(call, deps, SAYS.cap);
    if (recording.durationMs < MIN_MEMO_MS) {
      upload.discard();
      await speak(call, deps, SAYS.nothing);
      continue;
    }
    await speak(call, deps, SAYS.wait);
    const stopReassuring = reassure(call, deps);
    let heard: DownMessage | null;
    try {
      heard = await deps.uplink.memo(memoId, choice, directory.version, await upload.audio());
    } finally {
      stopReassuring();
    }
    if (!heard) return done(SAYS.noMac);
    if (heard.status !== "transcript") {
      await speak(call, deps, heard.status === "refused" ? heard.reason : SAYS.wrong);
      continue;
    }
    const recordAgain = ask ? "3" : "2";
    // Silence and stock hallucinations are nothing heard; a few brief words are offered back, never sent on their own.
    const quality = judgeTranscript(heard.text, recording.durationMs);
    deps.trace?.(`step: Transcript judged ${quality}`);
    if (quality === "silence") {
      await speak(call, deps, heardNothingPrompt(recordAgain));
      const retry = await call.key(MENU_WAIT_MS);
      deps.trace?.(`key: ${retry === recordAgain ? `${recordAgain} (record again)` : "cancel"}`);
      if (retry === recordAgain) continue;
      return done(SAYS.cancelled);
    }
    const unclear = quality === "unclear";
    if (!unclear && heard.audio) deps.seed?.([heard.audio]);
    const readBack = unclear ? unclearPrompt(heard.text, recordAgain) : readBackSentence(heard.text, heard.label, ask);
    let answer: string | null = null;
    // Said until a key that means something: star hears it again, 2 (with a Mac that answers) asks it as a question,
    // and a question that fails is offered again here, never by recording again.
    for (let repeats = 0; call.open; ) {
      await speak(call, deps, readBack);
      answer = await call.key(CONFIRM_WAIT_MS);
      if (answer === "*") {
        deps.trace?.("key: * (hear it again)");
        if (repeats++ >= MAX_REPEATS) {
          answer = null;
          break;
        }
        continue;
      }
      if (!(ask && !unclear && answer === "2")) break;
      deps.trace?.("key: 2 (ask it as a question)");
      if (counter.answers >= MAX_ANSWERS_PER_CALL) return done(SAYS.limit);
      counter.answers += 1;
      await speak(call, deps, SAYS.wait);
      const stopReassuring = reassure(call, deps);
      let reply: DownMessage | null;
      try {
        reply = await deps.uplink.ask(memoId);
      } finally {
        stopReassuring();
      }
      if (reply?.status === "answer") {
        deps.trace?.("step: Question answered");
        await speakReply(call, reply, deps);
        return { text: reply.text };
      }
      askFails += 1;
      await speak(call, deps, reply?.status === "refused" ? reply.reason : SAYS.askFail);
      if (askFails >= 2 || counter.answers >= MAX_ANSWERS_PER_CALL) return done(SAYS.bye);
    }
    deps.trace?.(
      `key: ${answer === "1" ? "1 (send)" : answer === recordAgain ? `${recordAgain} (record again)` : "cancel"}`,
    );
    if (answer === recordAgain) continue;
    if (answer !== "1") return done(SAYS.cancelled);
    const outcome = await deps.uplink.send(memoId);
    if (!outcome) return done(SAYS.notSure);
    deps.trace?.(outcome.status === "sent" ? "step: Message sent" : "step: Message not sent");
    return done(
      outcome.status === "sent"
        ? sentLine(target.label)
        : outcome.status === "refused"
          ? `${outcome.reason} Goodbye.`
          : SAYS.bye,
    );
  }
  return done(SAYS.bye);
}

/** A spoken yes or no to the read-back is a word or two. */
const NEW_CHAT_ANSWER_MS = 8_000;
/** Tries at the spoken answer before the keypad is offered, and read-backs heard again with star. */
const MAX_ANSWER_TRIES = 2;
/** Under this a spoken answer is a click or a breath: the keypad is offered instead. */
const MIN_ANSWER_MS = 500;

/**
 * Starts a NEW chat in a workspace (key 0 in its chat menu; a directory workspace's `newChat`): record what it should
 * do, have the Mac read it back with the workspace and the model, and only a yes starts it. The yes is spoken first
 * (the Mac transcribes it and accepts only a plain yes) with the keypad as the fallback: 1 starts it, star hears it
 * again, hash cancels. This side never decides: it sends the recording up, speaks what the Mac says, and a start is a
 * message the Mac checks against the read-back it kept. Always ends the call.
 */
async function newChatFlow(
  call: PhoneCall,
  deps: InboundDependencies,
  directory: DirectoryDoc,
  workspace: DirectoryWorkspace,
): Promise<void> {
  const { uplink } = deps;
  const index = workspace.newChat;
  if (!index || !uplink.newChat || !uplink.start) return bye(call, deps, SAYS.wrong);
  const callId = crypto.randomBytes(9).toString("base64url");
  for (let take = 0; take < MAX_TAKES && call.open; take++) {
    await speak(call, deps, newChatPrompt(workspace.label));
    const memoId = newMessageId();
    const upload = await recordForUpload(call, deps, { maxMs: MAX_MEMO_MS, beep: true, endOnSilence: true }, memoId);
    if (!upload) return;
    const { recording } = upload;
    deps.trace?.(`step: Recorded ${(recording.durationMs / 1000).toFixed(1)} s`);
    if (recording.ended === "no-speech") {
      upload.discard();
      await speak(call, deps, SAYS.noSpeech);
      const again = await call.key(MENU_WAIT_MS);
      deps.trace?.(`key: ${again === "1" ? "1 (try again)" : "hang up"}`);
      if (again === "1") continue;
      return bye(call, deps, SAYS.bye);
    }
    if (recording.ended === "limit") await speak(call, deps, SAYS.cap);
    if (recording.durationMs < MIN_MEMO_MS) {
      upload.discard();
      await speak(call, deps, SAYS.nothing);
      continue;
    }
    await speak(call, deps, SAYS.wait);
    const stopReassuring = reassure(call, deps);
    let heard: DownMessage | null;
    try {
      heard = await uplink.newChat(memoId, index, directory.version, await upload.audio());
    } finally {
      stopReassuring();
    }
    if (!heard) return bye(call, deps, SAYS.newChatNoMac);
    if (heard.status !== "transcript") {
      // A refusal (an out-of-date list, too many today) will not change by recording again.
      return bye(call, deps, `${heard.status === "refused" ? heard.reason : SAYS.wrong} Goodbye.`);
    }
    const quality = judgeTranscript(heard.text, recording.durationMs);
    deps.trace?.(`step: Transcript judged ${quality}`);
    if (quality === "silence") {
      await speak(call, deps, heardNothingPrompt("2"));
      const retry = await call.key(MENU_WAIT_MS);
      deps.trace?.(`key: ${retry === "2" ? "2 (record again)" : "cancel"}`);
      if (retry === "2") continue;
      return bye(call, deps, SAYS.cancelled);
    }
    // A few brief words are never offered for a start: they are read back, and the only ways on are to record again or stop.
    if (quality === "unclear") {
      await speak(call, deps, newChatUnclear(heard.text));
      const retry = await call.key(CONFIRM_WAIT_MS);
      deps.trace?.(`key: ${retry === "2" ? "2 (record again)" : "cancel"}`);
      if (retry === "2") continue;
      return bye(call, deps, SAYS.cancelled);
    }
    if (heard.audio) deps.seed?.([heard.audio]);
    const readBack = newChatReadBack(heard.text, heard.label, heard.model);
    return confirmNewChat(
      call,
      deps,
      readBack,
      { callId, label: heard.label, dirVersion: directory.version },
      async (spoken, answer) => {
        deps.trace?.(spoken ? "step: Spoken answer sent" : "key: 1 (start)");
        return uplink.start!(memoId, {
          callId,
          ...(spoken
            ? {
                audio: answer ? await answer.upload.audio() : await deps.encode(spoken),
                ...(answer ? { id: answer.id } : {}),
              }
            : {}),
        });
      },
    );
  }
  return bye(call, deps, SAYS.bye);
}

/**
 * The yes or no after a new chat's read-back. Said, then (a key pressed meanwhile counts first) a short spoken answer
 * the Mac judges; if nothing was said, the keypad: 1 starts it, star hears it again, hash cancels. "ended": the call
 * said its goodbye.
 */
async function confirmNewChat(
  call: PhoneCall,
  deps: InboundDependencies,
  readBack: string,
  info: { callId: string; label: string; dirVersion: string },
  start: (spoken: string | null, answer?: { id: string; upload: RecordedUpload }) => Promise<DownMessage | null>,
): Promise<void> {
  const finish = async (reply: DownMessage | null): Promise<void> => {
    if (!reply) return bye(call, deps, SAYS.newChatNotSure);
    if (reply.status === "refused") return bye(call, deps, `${reply.reason} Goodbye.`);
    if (reply.status !== "newchat") return bye(call, deps, SAYS.newChatFailed);
    deps.trace?.(`step: New chat ${reply.outcome}`);
    await speakReply(call, reply, deps);
    // The Mac offered to stay on the line: the call goes on as a talk turn answering that offer.
    if (reply.outcome === "started" && reply.hold && deps.talk && call.open) {
      const outcome = await deps.talk(call, {
        callId: info.callId,
        label: info.label,
        from: { dirVersion: info.dirVersion, choice: 1 },
        phase: "confirm",
      });
      if (outcome === "keys") await speak(call, deps, SAYS.bye);
    } else if (reply.outcome === "started" && reply.hold && call.open) {
      await speak(call, deps, SAYS.bye);
    }
  };
  let spokenTries = 0;
  let repeats = 0;
  while (call.open) {
    await speak(call, deps, readBack);
    // A key pressed while it was being read (it interrupts speech and stays queued) is the answer.
    let key = await call.key(250);
    if (key === null && spokenTries < MAX_ANSWER_TRIES) {
      const startId = newMessageId();
      const upload = await recordForUpload(
        call,
        deps,
        { maxMs: NEW_CHAT_ANSWER_MS, beep: true, endOnSilence: true },
        startId,
      );
      if (!upload) return;
      const answer = upload.recording;
      if (answer.ended === "key") {
        upload.discard();
        deps.trace?.("key: cancel");
        return bye(call, deps, SAYS.cancelled);
      }
      if (answer.ended !== "no-speech" && answer.durationMs >= MIN_ANSWER_MS) {
        spokenTries += 1;
        const stop = reassure(call, deps);
        let reply: DownMessage | null;
        try {
          reply = await start(answer.file, { id: startId, upload });
        } finally {
          stop();
        }
        if (reply?.status === "newchat" && reply.outcome === "again") {
          await speakReply(call, reply, deps);
          continue;
        }
        return finish(reply);
      }
      // Nothing said: the keypad.
      upload.discard();
      await speak(call, deps, newChatKeys);
      key = await call.key(CONFIRM_WAIT_MS);
    } else if (key === null) {
      await speak(call, deps, newChatKeys);
      key = await call.key(CONFIRM_WAIT_MS);
    }
    if (key === "*") {
      deps.trace?.("key: * (hear it again)");
      if (repeats++ >= MAX_REPEATS) break;
      continue;
    }
    if (key === "1") return finish(await start(null));
    if (key !== null && key !== "#") {
      // Any other digit is not an answer: the read-back is said again, a few times at most.
      if (repeats++ >= MAX_REPEATS) break;
      continue;
    }
    deps.trace?.("key: cancel");
    return bye(call, deps, SAYS.cancelled);
  }
  if (call.open) await bye(call, deps, SAYS.bye);
}

/** A menu's answer that is not a chat: a new one, in this workspace. */
type NewChatPick = { newChatIn: DirectoryWorkspace };

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
): Promise<DirectoryItem | NewChatPick | null> {
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
      // Nothing to message, but a new chat can still be started there (the prompt then offers it).
      if (!workspace.newChat) {
        await speak(call, deps, noneIn(workspace));
        continue;
      }
      const again = await menuKey(call, deps, noneIn(workspace));
      if (again === null || again === "#") return null;
      if (again === NEW_CHAT_KEY) {
        deps.trace?.(`key: ${NEW_CHAT_KEY} (a new chat in ${workspace.label})`);
        return { newChatIn: workspace };
      }
      continue;
    }
    // One chat in it: nothing to choose, and the line before the beep names it. With a new chat on offer the menu is
    // the way to it, so it is read.
    if (workspace.chats.length === 1 && !workspace.newChat) return workspace.chats[0]!;
    const picked = await pickChat(call, deps, workspace.chats, chatMenuPrompt(workspace), workspace);
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
  /** The workspace whose menu this is, when it can start a new chat (key 0). */
  fresh?: DirectoryWorkspace,
): Promise<DirectoryItem | NewChatPick | null> {
  for (let attempt = 0; attempt < 2 && call.open; attempt++) {
    const key = await menuKey(call, deps, prompt);
    if (key === null || key === "#") return null;
    if (key === NEW_CHAT_KEY && fresh?.newChat) {
      deps.trace?.(`key: ${NEW_CHAT_KEY} (a new chat in ${fresh.label})`);
      return { newChatIn: fresh };
    }
    const digit = digitOf(key);
    const item = items.find((candidate) => candidate.n === digit);
    if (item) {
      deps.trace?.(`key: ${digit} (${item.label})`);
      return item;
    }
  }
  return null;
}
