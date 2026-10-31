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
};

/** Said once a chat is chosen, before the beep. */
const recordPrompt = (label: string): string =>
  `${label}. Speak your message after the beep, and press hash when you are done.`;
/** The first question once a chat is chosen, with a Mac that answers: say or ask something, or hear its status. */
const actionPrompt = (label: string): string =>
  `${label}. Press 9 to say a message or ask a question, or 0 to hear where it stands. ${AGAIN}, or hash to hang up.`;
/** Offered first when the Mac names the chat used last: 1 takes it, 2 goes to the menus. */
export const lastChatPrompt = (label: string, greet: boolean): string =>
  `${greet ? `${GREETING} ` : ""}Press 1 for ${label}, the last one you used. Press 2 for another chat. ${AGAIN}, or hash to hang up.`;
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
    SAYS.noSpeech,
    SAYS.cap,
  ];
  const pin = askPin ? [`${GREETING} ${SAYS.pin}`, SAYS.pin, SAYS.pinAgain, SAYS.pinFail] : [];
  const ask = directory?.ask === true;
  const perChat = directory
    ? allLabels(directory).flatMap((label) =>
        ask ? [actionPrompt(label), sentLine(label)] : [recordPrompt(label), sentLine(label)],
      )
    : [];
  if (ask) fixed.push(SAYS.recordAsk, SAYS.askFail, SAYS.followUp, SAYS.limit);
  fixed.push(heardNothingPrompt(ask ? "3" : "2"));
  const last = directory?.last ? [lastChatPrompt(directory.last.label, !askPin)] : [];
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
async function speak(call: PhoneCall, deps: Pick<InboundDependencies, "trace">, text: string): Promise<void> {
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
      const key = await menuKey(call, deps, lastChatPrompt(offered.label, greet && attempt === 0));
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
  target ??= await pickTarget(call, deps, directory, greet);
  if (target === null) return bye(call, deps, SAYS.bye);

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
  if (heard.audio) deps.seed?.([heard.audio]);
  await speak(call, deps, heard.text);
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
    const recording = await call.record({ maxMs: MAX_MEMO_MS, beep: true, endOnSilence: true });
    if (!recording) return "done";
    deps.trace?.(`step: Recorded ${(recording.durationMs / 1000).toFixed(1)} s`);
    if (recording.ended === "no-speech") {
      // Nothing was said: do not process two minutes of silence. One key tries again; anything else hangs up.
      await speak(call, deps, SAYS.noSpeech);
      const again = await call.key(MENU_WAIT_MS);
      deps.trace?.(`key: ${again === "1" ? "1 (try again)" : "hang up"}`);
      if (again === "1") continue;
      return done(SAYS.bye);
    }
    if (recording.ended === "limit") await speak(call, deps, SAYS.cap);
    if (recording.durationMs < MIN_MEMO_MS) {
      await speak(call, deps, SAYS.nothing);
      continue;
    }
    await speak(call, deps, SAYS.wait);
    const memoId = newMessageId();
    const stopReassuring = reassure(call, deps);
    let heard: DownMessage | null;
    try {
      heard = await deps.uplink.memo(memoId, choice, directory.version, await deps.encode(recording.file));
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
        if (reply.audio) deps.seed?.([reply.audio]);
        await speak(call, deps, reply.text);
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
