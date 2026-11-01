import { recordForUpload, type RecordedUpload } from "./recording-upload.js";
import { MAX_AUDIO_DOC_BYTES } from "./clips.js";
import { FillerPicker, fillerLines } from "./fillers.js";
import { PICK_HINT, pickMenuSpec, pickMiss, pickQuestion, type PickAction } from "./voice-pick.js";
import crypto from "node:crypto";

import { logger } from "../utils/logger.js";
import type { Clip } from "./clips.js";
import { readDigits, type IncomingCall, type PhoneCall } from "./phone.js";
import {
  MAX_ANSWERS_PER_CALL,
  MAX_AUDIO_DOCS,
  MAX_MEMO_MS,
  MENU_CHOICES,
  newMessageId,
  type DirectoryDoc,
  type DirectoryItem,
  type DownMessage,
  type DirectoryWorkspace,
} from "./memo-protocol.js";
import { judgeTranscript } from "./transcript-quality.js";
import { readBackSpeech, refusalWords, speakReply } from "./answer-audio.js";
import type { TalkPhase } from "./memo-protocol.js";
import { TALK_SAYS } from "./talk-flow.js";
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
export const SAYS = {
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
export const newChatReadBack = (text: string, label: string, model: string | undefined): string => {
  const { head, tail } = newChatReadBackParts(label, model);
  return `${head} ${text.replace(/[.!?\s]+$/, "")}. ${tail}`;
};

/** The fixed words either side of what was heard in a new chat's read-back (made ahead and cached by the Mac). */
export const newChatReadBackParts = (label: string, model: string | undefined): { head: string; tail: string } => ({
  head: `I'll start a new chat in ${label} with ${model ?? "its usual model"}:`,
  tail: "Say yes to start it, or no.",
});
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
 * What the add-on says on its own for this chat list, most used first, in tiers (the audio documents hold only so much,
 * so a list that is too long loses its tail, never its menus). Lines that come FROM the Mac (a refusal, a talk reply, a
 * new chat's outcome: `mac-says.ts`) are not here: the Mac attaches its own clip to the message that carries them.
 * Also what the Mac records in its own voice and sends along (voice/natural-voice.ts).
 */
export function inboundPromptTiers(directory: DirectoryDoc | null, askPin: boolean): string[][] {
  const terse = directory?.terse === true;
  const ask = directory?.ask === true;
  const talks = directory?.talk === true && directory.ask === true;
  const fresh = (directory?.workspaces ?? []).filter((w) => w.newChat);
  const last = directory?.last ? [lastChatPrompt(directory.last.label, !askPin, terse, directory.last.why)] : [];
  // With a last chat the offer carries the greeting, so the menus behind "another chat" do not.
  const greetMenus = !askPin && last.length === 0;
  const labels = directory ? allLabels(directory) : [];
  const pin = askPin ? [`${hello(terse)}${SAYS.pin}`, SAYS.pin, SAYS.pinAgain, SAYS.pinFail] : [];

  // The menus as the keypad says them. Answered by voice they are the rare path (two misses, or a Mac that cannot be
  // reached), so they move to the last tier and the questions take their place.
  const keypadMenus = directory ? menuPrompts(directory, greetMenus) : [];
  const voice = directory?.pickByVoice === true;
  const empty = (directory?.workspaces ?? []).filter((w) => w.chats.length === 0).map(noneIn);
  const names = directory && voice ? voiceMenuNames(directory) : [];
  const [first] = names;
  // Said on every call: the PIN, the menus, and the line that opens the chosen chat. The first menu of a call carries the
  // hint ("You can also press a number.") and, when no PIN prompt came first, the greeting.
  const opening = [
    ...pin,
    ...last,
    ...(voice
      ? [
          ...names.map((name) => voiceMenuPrompt(directory!, name, name === first && greetMenus, name === first)),
          ...empty,
        ]
      : keypadMenus),
    ...labels.flatMap((label) =>
      talks
        ? [talkPrompt(label, terse)]
        : ask
          ? [actionPrompt(label), sentLine(label)]
          : [recordPrompt(label), sentLine(label)],
    ),
  ];
  // What any call can hit, shortest and commonest first.
  const common = [
    // The waiting lines: the owner's character when the Mac sends one, else the two fixed lines.
    ...(directory?.fillers ? fillerLines(directory.fillers) : [SAYS.wait, SAYS.still]),
    SAYS.bye,
    SAYS.noMac,
    SAYS.noChat,
    SAYS.wrong,
    SAYS.nothing,
    SAYS.cancelled,
    SAYS.notSure,
    SAYS.noSpeech,
    SAYS.cap,
    ...(ask ? [SAYS.recordAsk, SAYS.askFail, SAYS.followUp, SAYS.limit] : []),
    ...(talks ? Object.values(TALK_SAYS) : []),
    ...fresh.flatMap((workspace) => [newChatPrompt(workspace.label)]),
    ...(fresh.length > 0 ? [SAYS.newChatNoMac, SAYS.newChatNotSure, SAYS.newChatFailed] : []),
  ];
  // The spoken menus again without the hint (a repeat, or a way back), and what is said after a miss.
  const retry = directory
    ? names.flatMap((name) => [
        ...(name === first ? [voiceMenuPrompt(directory, name, false, false)] : []),
        pickMiss(pickMenuSpec(directory, name)?.names ?? []),
      ])
    : [];
  // The keypad's wording when the conversation falls back to keys, and its rarer follow-ups.
  const keypad = [
    ...(voice ? keypadMenus.filter((text) => !empty.includes(text)) : []),
    ...(talks ? labels.flatMap((label) => [actionPrompt(label), sentLine(label)]) : []),
    ...(fresh.length > 0 ? [newChatKeys] : []),
    heardNothingPrompt(ask ? "3" : "2"),
  ];
  return [opening, [...common, ...retry], keypad];
}

/** Every line of the tiers, in order, for one PIN setting. */
export function inboundPrompts(directory: DirectoryDoc | null, askPin: boolean): string[] {
  return [...new Set(inboundPromptTiers(directory, askPin).flat())];
}

/** What a speaker says in a second, by the same rule the call-in notes use; a clip also carries ~0.55 s of padding. */
export const SPEECH_CHARS_PER_SECOND = 14;
const CLIP_PADDING_SECONDS = 0.55;
/** The speech the audio documents can hold: `MAX_AUDIO_DOCS` of `MAX_AUDIO_DOC_BYTES` of 8 kHz mu-law. */
export const PROMPT_AUDIO_SECONDS = (MAX_AUDIO_DOCS * MAX_AUDIO_DOC_BYTES) / 8000;

export const estimateSpeechSeconds = (texts: readonly string[], padded = false): number =>
  texts.reduce((sum, text) => sum + text.length / SPEECH_CHARS_PER_SECOND + (padded ? CLIP_PADDING_SECONDS : 0), 0);

/**
 * The prompts the Mac records and uploads for this list: both PIN settings, tier by tier (so a menu with the greeting and
 * one without come before any fixed line), cut where the estimated speech would pass `share` of what the audio documents
 * hold. Nothing past the cut is rendered or sent; the add-on makes it itself.
 */
export function uploadPrompts(directory: DirectoryDoc | null, share = 0.9): string[] {
  const withPin = inboundPromptTiers(directory, true);
  const withoutPin = inboundPromptTiers(directory, false);
  const out: string[] = [];
  const seen = new Set<string>();
  let seconds = 0;
  for (let tier = 0; tier < withPin.length; tier += 1) {
    for (const text of [...(withPin[tier] ?? []), ...(withoutPin[tier] ?? [])]) {
      if (seen.has(text) || text.trim().length === 0) continue;
      const cost = estimateSpeechSeconds([text], true);
      if (seconds + cost > PROMPT_AUDIO_SECONDS * share) return out;
      seen.add(text);
      seconds += cost;
      out.push(text);
    }
  }
  return out;
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
/**
 * The waiting lines of each call: with the Mac's `fillers` a random one, never the previous from the same set; without,
 * the two fixed lines. Kept per call so every flow (and the talk flow's `reassure`) draws from one place.
 */
const pickers = new WeakMap<PhoneCall, FillerPicker>();
const waitLine = (call: PhoneCall): string => pickers.get(call)?.wait() ?? SAYS.wait;
const stillLine = (call: PhoneCall): string => pickers.get(call)?.still() ?? SAYS.still;

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
    void speak(call, deps, stillLine(call))
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
  if (directory?.fillers) pickers.set(call, new FillerPicker(directory.fillers));
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
  await speak(call, deps, waitLine(call));
  const stopReassuring = reassure(call, deps);
  let heard: DownMessage | null;
  try {
    heard = await deps.uplink.status(chosen(target), directory.version);
  } finally {
    stopReassuring();
  }
  if (!heard) return bye(call, deps, SAYS.noMac).then(() => "done" as const);
  if (heard.status !== "answer") {
    await speak(call, deps, heard.status === "refused" ? refusalWords(heard, deps) : SAYS.wrong);
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
    await speak(call, deps, waitLine(call));
    const stopReassuring = reassure(call, deps);
    let heard: DownMessage | null;
    try {
      heard = await deps.uplink.memo(memoId, choice, directory.version, await upload.audio());
    } finally {
      stopReassuring();
    }
    if (!heard) return done(SAYS.noMac);
    if (heard.status !== "transcript") {
      await speak(call, deps, heard.status === "refused" ? refusalWords(heard, deps) : SAYS.wrong);
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
    // Said as the Mac makes it (its parts, add-on 0.19.0) the first time, then from the clips already held.
    const sayReadBack = unclear ? () => speak(call, deps, readBack) : readBackSpeech(call, heard, readBack, deps);
    // Said until a key that means something: star hears it again, 2 (with a Mac that answers) asks it as a question,
    // and a question that fails is offered again here, never by recording again.
    for (let repeats = 0; call.open; ) {
      await sayReadBack();
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
      await speak(call, deps, waitLine(call));
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
      await speak(call, deps, reply?.status === "refused" ? refusalWords(reply, deps) : SAYS.askFail);
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
    if (outcome.status === "refused") {
      await speak(call, deps, refusalWords(outcome, deps));
      return done(SAYS.bye);
    }
    return done(outcome.status === "sent" ? sentLine(target.label) : SAYS.bye);
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
    await speak(call, deps, waitLine(call));
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
      await speak(call, deps, heard.status === "refused" ? refusalWords(heard, deps) : SAYS.wrong);
      return bye(call, deps, SAYS.bye);
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
      readBackSpeech(call, heard, readBack, deps),
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
  sayReadBack: () => Promise<void>,
  info: { callId: string; label: string; dirVersion: string },
  start: (spoken: string | null, answer?: { id: string; upload: RecordedUpload }) => Promise<DownMessage | null>,
): Promise<void> {
  const finish = async (reply: DownMessage | null): Promise<void> => {
    if (!reply) return bye(call, deps, SAYS.newChatNotSure);
    if (reply.status === "refused") {
      await speak(call, deps, refusalWords(reply, deps));
      return bye(call, deps, SAYS.bye);
    }
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
    await sayReadBack();
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

/** What one asking of a menu came to: a key (null: silence or hang-up), a spoken pick of an option, or a spoken extra. */
type MenuAnswer =
  | { type: "key"; key: string | null }
  | { type: "pick"; n: number }
  | { type: "action"; action: PickAction };

/** A menu answer is a few words: recorded for at most this long, and ended by this much quiet after speech (a message waits 1.6 s). */
const PICK_MAX_MS = 6_000;
const PICK_END_SILENCE_MS = 1_000;
/** Nothing said at all for this long is a miss, not a wait. */
const PICK_NO_SPEECH_MS = 5_000;
/** Under this a recording is a click or a breath. */
const MIN_PICK_MS = 400;
/** Spoken tries at one menu before the keypad's wording is used. */
const PICK_TRIES = 2;
/** A Mac that has not answered a pick by this long is covered with a waiting line. */
const PICK_LATE_MS = 3_000;

/** Whether this call's first spoken menu has said its hint ("You can also press a number.") yet. */
const hinted = new WeakSet<PhoneCall>();

/** A menu of the published list as a question the person answers aloud (the keypad's version is `menuPrompt` and its kin). */
export function voiceMenuPrompt(directory: DirectoryDoc, menu: string, greet: boolean, hint: boolean): string {
  const spec = pickMenuSpec(directory, menu);
  if (!spec) return "";
  const question = pickQuestion(spec.question, spec.names);
  const opening = greet ? hello(directory.terse === true) : "";
  return `${opening}${question}${hint ? ` ${PICK_HINT}` : ""}`;
}

/** The menus the call can ask by voice, as `pickMenuSpec` names them, for the recorded prompts. */
function voiceMenuNames(directory: DirectoryDoc): string[] {
  const names: string[] = [];
  if (directory.workspaces?.length) {
    names.push("workspaces");
    for (const workspace of directory.workspaces)
      if (workspace.chats.length > 0) names.push(`workspace:${workspace.n}`);
    if (directory.items.length > 0) names.push("chats");
  } else if (directory.items.length > 0) {
    names.push("chats");
  }
  return names;
}

/** Whether menus are answered by voice on this call: the Mac says so, and the uplink can carry a recording up. */
const byVoice = (directory: DirectoryDoc, deps: InboundDependencies): boolean =>
  directory.pickByVoice === true && typeof deps.uplink.pick === "function";

/**
 * Asks one menu by voice: the question, then listens (no tone: the question is the cue) until a pause of a second, at most
 * six seconds. Any key pressed meanwhile ends the listening and is the answer at once. The recording goes to the Mac, which
 * matches it against exactly what the menu offered; a pick comes back as the digit the keypad would have pressed. Not
 * understood (or a tie) says "Sorry, which one?" with the options and listens again; after two misses, or when the Mac
 * cannot be reached, "keypad": the caller asks with the keys, as it always has. This only selects; nothing here sends.
 */
async function voiceMenu(
  call: PhoneCall,
  deps: InboundDependencies,
  directory: DirectoryDoc,
  menu: string,
  greet: boolean,
): Promise<MenuAnswer | "keypad"> {
  const spec = pickMenuSpec(directory, menu);
  if (!spec || !deps.uplink.pick) return "keypad";
  let prompt = voiceMenuPrompt(directory, menu, greet, !hinted.has(call));
  hinted.add(call);
  let misses = 0;
  let repeats = 0;
  while (call.open) {
    await speak(call, deps, prompt);
    // A key pressed while it was being said (it interrupts speech and stays queued) is the answer.
    let key = await call.key(50);
    if (key === null) {
      const id = newMessageId();
      const upload = await recordForUpload(
        call,
        deps,
        {
          maxMs: PICK_MAX_MS,
          beep: false,
          endOnSilence: true,
          endSilenceMs: PICK_END_SILENCE_MS,
          noSpeechMs: PICK_NO_SPEECH_MS,
          endOnAnyKey: true,
        },
        id,
      );
      if (!upload) return { type: "key", key: null };
      const { recording } = upload;
      if (recording.ended === "key") {
        upload.discard();
        key = await call.key(250);
      } else if (recording.ended === "no-speech" || recording.durationMs < MIN_PICK_MS) {
        upload.discard();
      } else {
        let late: Promise<void> | null = null;
        const timer = setTimeout(() => {
          late = speak(call, deps, waitLine(call)).catch(() => undefined);
        }, PICK_LATE_MS);
        let heard: DownMessage | null;
        try {
          heard = await deps.uplink.pick(id, directory.version, menu, await upload.audio());
        } finally {
          clearTimeout(timer);
        }
        if (late) await late;
        if (heard?.status !== "pick") {
          deps.trace?.("step: Menu answers by voice are not available, using the keypad");
          return "keypad";
        }
        if (heard.choice !== undefined) return { type: "pick", n: heard.choice };
        if (heard.action === "repeat") {
          deps.trace?.("step: Asked to hear the menu again");
          if (repeats++ >= MAX_REPEATS) return "keypad";
          prompt = voiceMenuPrompt(directory, menu, false, false);
          continue;
        }
        if (heard.action) return { type: "action", action: heard.action };
      }
    }
    if (key !== null) {
      if (key === "*") {
        deps.trace?.("key: * (hear it again)");
        if (repeats++ >= MAX_REPEATS) return "keypad";
        prompt = voiceMenuPrompt(directory, menu, false, false);
        continue;
      }
      return { type: "key", key };
    }
    deps.trace?.("step: Pick not understood");
    if (++misses >= PICK_TRIES) return "keypad";
    prompt = pickMiss(spec.names);
  }
  return { type: "key", key: null };
}

/** One menu asked by voice while that works, then by the keys (and by the keys from the start for a Mac that cannot). */
class MenuAsker {
  private voice: boolean;

  constructor(
    private readonly call: PhoneCall,
    private readonly deps: InboundDependencies,
    private readonly directory: DirectoryDoc,
    private readonly menu: string,
    private readonly keypad: (greet: boolean) => string,
  ) {
    this.voice = byVoice(directory, deps);
  }

  async ask(greet: boolean): Promise<MenuAnswer> {
    if (this.voice) {
      const answer = await voiceMenu(this.call, this.deps, this.directory, this.menu, greet);
      if (answer !== "keypad") return answer;
      // Back to the keys for good on this menu; the greeting (if any) has been said.
      this.voice = false;
      greet = false;
    }
    return { type: "key", key: await menuKey(this.call, this.deps, this.keypad(greet)) };
  }
}

/** Writes down a choice: the key pressed, or that it was picked by voice. */
function traceChoice(deps: InboundDependencies, answer: MenuAnswer, keyLine: string, label: string): void {
  deps.trace?.(answer.type === "key" ? `key: ${keyLine}` : `step: Picked ${label} by voice`);
}

/** The digit a menu answer stands for (a spoken extra "other chats" is the 0 key), or null when it is not one. */
function digitOfAnswer(answer: MenuAnswer): number | null {
  if (answer.type === "pick") return answer.n;
  if (answer.type === "key") return digitOf(answer.key);
  return answer.action === "other" ? 0 : null;
}

/** Silence, hash and a spoken "hang up" all end the call from a menu. */
const endsCall = (answer: MenuAnswer): boolean =>
  (answer.type === "key" && (answer.key === null || answer.key === "#")) ||
  (answer.type === "action" && answer.action === "hangup");

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
  if (workspaces.length === 0) {
    const picked = await pickChat(call, deps, directory.items, (g) => menuPrompt(directory, g), {
      directory,
      menu: "chats",
      greet,
    });
    return picked === "hangup" ? null : picked;
  }
  const asker = new MenuAsker(call, deps, directory, "workspaces", (g) => workspaceMenuPrompt(directory, g));
  for (let attempt = 0; attempt < 3 && call.open; attempt++) {
    const answer = await asker.ask(greet && attempt === 0);
    if (endsCall(answer)) return null;
    const digit = digitOfAnswer(answer);
    if (digit === 0 && directory.items.length > 0) {
      traceChoice(deps, answer, "0 (other chats)", "other chats");
      const other = await pickChat(call, deps, directory.items, (g) => menuPrompt(directory, g), {
        directory,
        menu: "chats",
        greet: false,
      });
      if (other === "hangup") return null;
      if (other !== null) return other;
      continue;
    }
    const workspace = workspaces.find((w) => w.n === digit);
    if (!workspace) continue;
    traceChoice(deps, answer, `${digit} (workspace ${workspace.label})`, workspace.label);
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
    const picked = await pickChat(call, deps, workspace.chats, () => chatMenuPrompt(workspace), {
      directory,
      menu: `workspace:${workspace.n}`,
      greet: false,
      fresh: workspace,
    });
    if (picked === "hangup") return null;
    if (picked !== null) return picked;
  }
  return null;
}

/** A chat from a menu; null when it was left (`#`, or a spoken "go back"); "hangup" when the person said to end the call. */
async function pickChat(
  call: PhoneCall,
  deps: InboundDependencies,
  items: DirectoryItem[],
  keypad: (greet: boolean) => string,
  menu: {
    directory: DirectoryDoc;
    /** Which menu it is, as `pickMenuSpec` names it. */
    menu: string;
    greet: boolean;
    /** The workspace whose menu this is, when it can start a new chat (key 0). */
    fresh?: DirectoryWorkspace;
  },
): Promise<DirectoryItem | NewChatPick | "hangup" | null> {
  const { fresh } = menu;
  const asker = new MenuAsker(call, deps, menu.directory, menu.menu, keypad);
  for (let attempt = 0; attempt < 2 && call.open; attempt++) {
    const answer = await asker.ask(menu.greet && attempt === 0);
    if (answer.type === "action" && answer.action === "hangup") return "hangup";
    if (answer.type === "action" && answer.action === "back") return null;
    if (answer.type === "key" && (answer.key === null || answer.key === "#")) return null;
    const isNew =
      (answer.type === "key" && answer.key === NEW_CHAT_KEY) || (answer.type === "action" && answer.action === "new");
    if (isNew && fresh?.newChat) {
      traceChoice(deps, answer, `${NEW_CHAT_KEY} (a new chat in ${fresh.label})`, `a new chat in ${fresh.label}`);
      return { newChatIn: fresh };
    }
    const digit = digitOfAnswer(answer);
    const item = items.find((candidate) => candidate.n === digit);
    if (item) {
      traceChoice(deps, answer, `${digit} (${item.label})`, item.label);
      return item;
    }
  }
  return null;
}
