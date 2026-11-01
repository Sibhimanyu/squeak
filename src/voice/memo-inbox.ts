import crypto from "node:crypto";

import type { ChannelDoc } from "../remote/firestore-rest.js";
import type { RtdbRest } from "../remote/rtdb-rest.js";
import type { ReplyFailureHandler, ReplyOutcome } from "../fleet/session-reply.js";
import { logger } from "../utils/logger.js";
import { chunkClips, type Clip } from "./clips.js";
import {
  NEW_CHAT_SAYS,
  PARTS_SAYS,
  REFUSED_SAYS,
  TALK_REPLY_SAYS,
  callBackLine,
  chatBusy,
  couldNotFind,
  macFixedSays,
  macLabelSays,
} from "./mac-says.js";
import { spokenAnswer } from "./chat-brief.js";
import { ASK_FAILED, newChatReadBack, uploadPrompts } from "./inbound-flow.js";
import type { StartChatOutcome } from "../fleet/new-chat.js";
import { clipOption } from "./script.js";
import { numberRepeats } from "./spoken-labels.js";
import { speechParts } from "./natural-cache.js";
import { loadCallState, saveCallState } from "./call-state.js";
import {
  fixedMemoReadBackSpeech,
  fixedNewChatReadBackSpeech,
  memoReadBackSpeech,
  newChatReadBackSpeech,
} from "./read-back-parts.js";
import { judgeTranscript } from "./transcript-quality.js";
import type { ChoiceOption } from "../fleet/choices.js";
import {
  audioDocId,
  audioPath,
  MAX_ANSWER_PARTS,
  REPLY_AUDIO_PREFIX,
  replyAudioId,
  type AudioFollows,
  DIR_KIND,
  MAX_AUDIO_DOCS,
  sealAudio,
  dirPath,
  downPath,
  MAX_ANSWER_CHARS,
  MAX_CHOICES,
  MAX_WORKSPACES,
  MENU_CHOICES,
  readUp,
  readUpPart,
  UP_AUDIO_PREFIX,
  upAudioId,
  upPartHash,
  sealDirectory,
  sealDown,
  UP_KIND,
  upPath,
  type DirectoryDoc,
  type DirectoryItem,
  type DirectoryWorkspace,
  type DownMessage,
  type UpMessage,
  UP_TTL_MS,
} from "./memo-protocol.js";
import type { Transcriber } from "./transcribe.js";

export type MemoStore = Pick<RtdbRest, "get" | "list" | "set" | "delete" | "watch">;

/** A chat that can take a message right now. */
export interface MemoTarget {
  target: string;
  label: string;
  /** The workspace it belongs to (`workspaceKeyOf`), for favourites. */
  workspace: string | null;
  /** The workspace as spoken ("squeak, fix parser", `spokenWorkspace`); absent: the label stands in. */
  workspaceLabel?: string;
  /** It waits on the person (an approval or a question): the fallback "last chat" when none was used by phone. */
  waiting?: boolean;
}

export type TraceKind = "step" | "said" | "heard" | "key" | "warn";

export interface MemoInboxDependencies {
  store: MemoStore;
  channel: string;
  key: string;
  transcriber: Transcriber;
  /** Chats that can take a message now, most pressing first. Read each time the list is published. */
  targets: () => MemoTarget[];
  /** Whether this chat can still take one at the moment of sending (it may have started working). */
  canSend: (target: string) => boolean;
  send: (target: string, text: string, onFailed: ReplyFailureHandler) => Promise<ReplyOutcome>;
  /** The extension allowed to call in: the Mac's "who to ring" setting. */
  caller: () => string | null;
  /** A one-off note to Telegram and Cliq: what was sent by phone. */
  note: (text: string) => void;
  /**
   * The chat last used by phone (a message sent, a question or status asked), saved across restarts. With it the
   * directory names that chat first (`last`); without it, or when it cannot take a message now, the newest chat waiting
   * on the person stands in.
   */
  lastChat?: { get: () => string | null; recent?: (maxAgeMs: number) => string | null; set: (target: string) => void };
  /** Favourite workspaces for calling in, in any order. None: a flat list of chats, as before. */
  favorites?: () => Array<{ n: number; workspace: string; label: string }>;
  /** The Mac's own recordings of these call-in prompts (voice/natural-voice.ts); absent or empty: the add-on speaks. */
  audioClips?: (texts: string[]) => Promise<Clip[]>;
  /** The Mac's recording of the read-back sentence; undefined (or a failure) leaves it to the add-on. */
  readBack?: (text: string, label: string, ask?: boolean) => Promise<Clip | undefined>;
  /** Makes the fixed part of the read-back for these chats ahead of any call (after the prompts are published). */
  prepareReadBack?: (labels: string[], ask?: boolean) => Promise<void>;
  /**
   * Read-only answers for a call: where a chat stands (`describe`, from what Squeak knows, null when the chat is gone)
   * and an answer to a spoken question (`answer`, a headless model with no tools; throws a sentence fit to say when it
   * cannot). Both must write nothing, send nothing and touch no chat. With both, the directory says it can ask.
   */
  describe?: (target: string, label: string) => string | null;
  answer?: (target: string, label: string, question: string) => Promise<string>;
  /** The Mac's recording of an answer's words; undefined (or a failure) leaves it to the add-on. */
  speech?: (text: string) => Promise<Clip | undefined>;
  /**
   * The same words one sentence at a time (`NaturalVoice.sentenceClips`: each clip handed over in order as it is made,
   * its text exactly the sentence of `splitSentences`). With `streamsAnswers()` true (an add-on that plays them as they
   * arrive) an answer goes out after its first sentence and the rest follow as `replyaudio-` documents.
   */
  speechStream?: (text: string, onPart: (part: { index: number; total: number; clip: Clip }) => void) => Promise<void>;
  streamsAnswers?: () => boolean;
  /**
   * The read-back as separate clips (`NaturalVoice.partClips`: a fixed head, the words, a fixed tail, each handed over in
   * order as it is made, its text exactly the part). With `streamsReadBack()` true (add-on 0.19.0) the transcript goes
   * out after the head's clip and the rest follow as `replyaudio-` documents, like an answer's sentences.
   */
  speechParts?: (
    parts: string[],
    onPart: (part: { index: number; total: number; clip: Clip }) => void,
  ) => Promise<void>;
  streamsReadBack?: () => boolean;
  /**
   * With an add-on that plays the Mac's clip on a refusal (0.20.0): a refusal then carries its own clip, made within a
   * short budget. Absent or false: a refusal is text only, as before.
   */
  refusalAudio?: () => boolean;
  /**
   * Makes the lines the Mac itself says (refusals, talk replies, a new chat's outcomes, the ones naming a chat) ahead of
   * any call, local only and at background priority, so attaching a clip to a message at call time is a cache hit.
   */
  prepareMacSays?: (texts: string[]) => Promise<void>;
  /** Makes these fixed read-back words ahead of any call, so the head and tail are in the cache when a call needs them. */
  prepareSpeech?: (texts: string[]) => Promise<void>;
  /**
   * Voice-first calls out: works out what a spoken reply was (a question to answer, an instruction to propose, the
   * end of the call). Read-only like `answer`; its output only ever chooses the words of a proposal the person must
   * confirm by voice, never sends anything. Throws when it cannot. Absent: the Mac takes no `talk`.
   */
  converse?: (
    target: string,
    label: string,
    input: { utterance: string; question: string; options: ChoiceOption[]; callId: string },
  ) => Promise<{
    intent: "answer" | "send" | "end" | "callback" | "unclear";
    spoken: string;
    message?: string;
    callback?: boolean;
  }>;
  /**
   * "Call me back when you're done": remembers the request and has Squeak ring once the chat's work has ended. It
   * checks the chat itself and says no in a sentence fit to be heard. `afterSend` is a request made together with a
   * message just sent, so the work has not started yet. Absent: a call cannot ask for one.
   */
  requestCallback?: (
    target: string,
    label: string,
    note: string,
    afterSend: boolean,
  ) => { ok: true } | { ok: false; reason: string };
  /**
   * Staying on the line while a chat works. After a message the person approved, the call offers to hold; on hold it
   * checks in and a key asks what the agent is thinking. Read-only. Absent (or `supported()` false, an add-on that does
   * not run the hold loop): no hold is offered.
   */
  hold?: {
    supported: () => boolean;
    /** "working", "stopped" (finished, asking, blocked, error, idle), or null when the chat is gone. */
    state: (target: string, label: string) => "working" | "stopped" | null;
    /** Said when it has stopped: how it ended, and an invitation to talk about it. */
    ended: (target: string, label: string) => string;
    /** The agent's thinking so far, spoken; null when it cannot be read. */
    peek: (target: string, label: string) => string | null;
  };
  /**
   * Starting a NEW chat from a call in (add-on 0.18.0 and newer). `supported` is that gate (an older add-on never sees
   * `newChat` in the directory). `workspaceId` says whether Squeak may start a chat in a directory workspace (its key
   * is `workspaceKeyOf`) and which Conductor workspace that is; `model` is the owner's "New chats from calls use" pick
   * as it stands now (null: the workspace's usual model); `start` is the SAME `newChatControl().startChat` the phone
   * uses, so its validation and size caps hold. Absent: the Mac takes no `newchat` or `start`.
   */
  newChat?: {
    supported: () => boolean;
    workspaceId: (workspaceKey: string) => string | null;
    model: () => { id: string; level?: string; agent: "claude" | "codex"; label: string } | null;
    start: (args: {
      workspaceId: string;
      text: string;
      model?: { id: string; level?: string; agent: "claude" | "codex" };
    }) => Promise<StartChatOutcome>;
  };
  /** The owner's persona is terse (voice/settings.ts): calls in drop the pleasantries. Read at each publish. */
  terse?: () => boolean;
  /**
   * Which voice the Mac records the prompts in (engine, voice, emotion). Part of the list's version, so a change of
   * voice publishes the list again and the add-on gets recordings in the new voice instead of keeping the old ones.
   */
  voiceKey?: () => string;
  /**
   * The prompts' audio is out: the directory naming it is written (or there was none to name). `voiceKey` is the one
   * the list was made for, so a caller can ignore a pass for a voice it has since changed.
   */
  audioPublished?: (version: string, voiceKey: string | null) => void;
  /** A voice-first call is over (said goodbye, sent, gave up, or aged out): whatever it kept for the model can go. */
  endCall?: (callId: string) => void;
  /** A line for the call trace. */
  trace?: (kind: TraceKind, text: string, extra?: { ms?: number; label?: string }) => void;
  now?: () => number;
  /** Tests: how long to wait for a piece that has not arrived, and how often to look. */
  partsWaitMs?: number;
  partsPollMs?: number;
  /** Where a call in progress is kept across a restart (`voice-call-state.json`); absent = in memory only. */
  stateFile?: string;
}

interface Pending {
  target: string;
  label: string;
  text: string;
  at: number;
}

/** A new chat read back and awaiting the person's yes. */
interface PendingNewChat {
  workspaceId: string;
  label: string;
  text: string;
  model: { id: string; level?: string; agent: "claude" | "codex"; label: string } | null;
  at: number;
  tries: number;
  /** A spoken answer is being transcribed: a second `start` for the same memo must not run beside it. */
  busy: boolean;
}

const PENDING_TTL_MS = 10 * 60_000;
/** A chat started by phone is a deliberate act: a few an hour is a person, more is a stuck loop. */
const MAX_NEW_CHATS_PER_HOUR = 6;
const MAX_PENDING_NEW_CHATS = 10;
export { NEW_CHAT_SAYS };
const MAX_PENDING = 20;
/** How long the chat used by phone stays "the last one you used". */
export const LAST_CHAT_FRESH_MS = 2 * 60 * 60_000;
/** Most recording passes for one list's prompts (each up to a minute of speech). */
const MAX_AUDIO_PASSES = 8;

/** A digest of what an audio document holds: the clips' words and audio, in order. */
const clipsDigest = (clips: readonly Clip[]): string => {
  const hash = crypto.createHash("sha256");
  for (const clip of clips) hash.update(clip.text).update("\0").update(clip.mulaw).update("\0");
  return hash.digest("hex");
};
const KEEP_VERSIONS = 8;
const REPUBLISH_MS = 30 * 60_000;
const REMEMBER = 200;
/** A call out names its chat for this long: longer than any call lasts. */
const CALL_TARGET_TTL_MS = 30 * 60_000;
/** A list version is kept this long after a message last named it. */
const VERSION_TTL_MS = 30 * 60_000;
/** A call counts as up while the gateway sent something in the last 3 minutes (10 while on hold). */
const CALL_BUSY_MS = 3 * 60_000;
const READ_BACK_BUDGET_MS = 8_000;
/** The longest transcript a `transcript` carries (`readDown`'s cap); a longer one is never streamed. */
const MAX_TRANSCRIPT_CHARS = 1500;
type AudioFollowsFields = { audio?: Clip; audioFollows?: AudioFollows };
/**
 * An answer or status read out in the Mac's voice: several sentences, about a second each and more when the voice is
 * busy. A budget shorter than that leaves the add-on to say it in its plain voice, the "different voice" heard on a
 * status. The add-on waits for it (uplink.ts), and says "Still working on it" meanwhile.
 */
const ANSWER_AUDIO_BUDGET_MS = 20_000;
/** A refusal is short and made ahead; if its clip is not ready this fast it goes without. */
const REFUSAL_AUDIO_BUDGET_MS = 1_500;
/** How long the later sentences of an answer stay in the database: the add-on deletes them, this is the backstop. */
const REPLY_AUDIO_TTL_MS = 10 * 60_000;
const REPLY_AUDIO_WRITE_MS = 90_000;
/** Pieces of a recording (`upaudio-` documents): how long the Mac keeps what it decoded, and how long a document may sit. */
const PART_CACHE_TTL_MS = 3 * 60_000;
const PART_DOC_TTL_MS = 10 * 60_000;
const MAX_CACHED_STREAMS = 8;
/** How long a message naming pieces waits for one that has not arrived yet. */
const PARTS_WAIT_MS = 10_000;
const PARTS_POLL_MS = 250;

/** A recording as it reaches the transcriber: the whole Opus file, or the decoded pieces joined (with a note for the trace). */
type UpSpeech =
  | { kind: "opus"; audio: Buffer; note: string }
  | { kind: "pcm"; pcm: Buffer; note: string }
  | { kind: "refused"; reason: string };

interface PartEntry {
  hash: string;
  bytes: number;
  at: number;
  pcm: Promise<Buffer>;
}

/** A phone is not a keyboard: this many sends an hour is a stuck loop, not a person. */
const MAX_SENDS_PER_HOUR = 20;
const MAX_SPOKEN_LABEL = 60;
/** A model answer is worth a minute of a person's time, not more; the add-on waits a little longer than this. */
const ANSWER_BUDGET_MS = 45_000;
/** Questions and status read-outs an hour: a model call each, so a stuck loop is stopped here too. */
const MAX_ANSWERS_PER_HOUR = 40;
/** Turns a person gets on one voice-first call (each is a model call), and how long a read-back waits for a yes. */
const MAX_TALK_TURNS = 30;
const PROPOSAL_TTL_MS = 5 * 60_000;
/** On hold: how long a chat that never starts is waited for, how long in all, and how often a silence is broken. */
const HOLD_START_MS = 60_000;
const HOLD_MAX_MS = 10 * 60_000;
const HOLD_REASSURE_MS = 45_000;
/** A message by phone is a sentence or two, not a document. */
const MAX_TALK_MESSAGE_CHARS = 600;
/** A yes or no is a few words; anything longer than this is never taken as one. */
const MAX_CONFIRM_WORDS = 8;
const YES = /\b(?:yes|yeah|yep|yup|sure|send(?: it)?|do it|go ahead|correct|confirm|okay|ok|please do)\b/i;
const NO = /\b(?:no|nope|cancel|don'?t|do not|wait|stop|never ?mind|not yet)\b/i;
const GOODBYE = /^\W*(?:good ?bye|bye(?: bye)?|that'?s all|that is all|hang up)\W*$/i;

/** A model's proposed message: control characters out, whitespace collapsed, at most 600 characters. */
export function cleanMessage(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TALK_MESSAGE_CHARS)
  );
}

/** What was said for a new chat: control characters out, whitespace collapsed. The sender caps its length again. */
export function cleanNewChatText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** A model's name as said on a phone line: "Opus 5.5 · 1M" is "Opus 5.5, 1M". */
export function spokenModelLabel(label: string): string {
  return label.replace(/\s*·\s*/g, ", ").trim();
}

/** A workspace name read aloud: no longer than 60 characters, cut at a word. */
function spokenLabel(label: string): string {
  if (label.length <= MAX_SPOKEN_LABEL) return label;
  const cut = label.slice(0, MAX_SPOKEN_LABEL);
  const space = cut.lastIndexOf(" ");
  return (space > 20 ? cut.slice(0, space) : cut).trimEnd();
}

/**
 * The Mac's half of calling in. The gateway on Home Assistant answers the call and checks the PIN; this
 * publishes who can take a message (as numbers), transcribes a recorded memo with Whisper, reads it back, and,
 * only when the gateway says "send it" for that memo, sends the words it transcribed itself through the same
 * replier as every other surface. The gateway never supplies text or names a target.
 */
export class MemoInbox {
  private readonly now: () => number;
  private unwatch: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = false;
  private dirty = false;
  private readonly handled: string[] = [];
  /** When each handled id was taken, so a restart keeps it only as long as the message could still be replayed. */
  private readonly handledAt = new Map<string, number>();
  /** When a message last named each directory version. */
  private readonly versionUsed = new Map<string, number>();
  private activity: { since: number; last: number } | null = null;
  private readonly pending = new Map<string, Pending>();
  /** New chats read back and awaiting a yes, by the `newchat` message's id. */
  private readonly pendingNew = new Map<string, PendingNewChat>();
  /** Per directory version: the workspaces a chat may be started in, by a workspace's `newChat` index. */
  private readonly newChatSpaces = new Map<string, Array<{ workspaceId: string; label: string }>>();
  private readonly newChatStarts: number[] = [];
  /** Directory versions the gateway may still be reading from, each as the targets by number. */
  private readonly versions = new Map<string, string[]>();
  /** Calls out that may take a message for, or read the status of, the chat that asked: the call's id is their "version". */
  private readonly calls = new Map<
    string,
    {
      target: string;
      label: string;
      at: number;
      /** What the call asked, for the model's context (voice first only). */
      script?: { question: string; options: ChoiceOption[] };
      /** The one message read back and awaiting the person's yes; never set by anything but their own `say` turn. */
      proposal?: { message: string; at: number; tries: number; callback?: boolean } | undefined;
      /** A sent message was followed by "stay on the line?": waiting for the person's yes or no. */
      offer?: { at: number; tries: number } | undefined;
      /** The person is on hold while the chat works. */
      hold?: { since: number; seenWorking: boolean; lastSaid: number } | undefined;
      /** A chat started on this call: it may not be on the radar yet, so a missing one is not "lost" for a minute. */
      fresh?: true;
      turns: number;
    }
  >();
  private published: { version: string; at: number } | null = null;
  /** Audio document ids written for each directory version, so they go when the version does. */
  private readonly audioDocs = new Map<string, string[]>();
  /** What each audio document written holds (a digest of its clips), so an unchanged one is reused, not rewritten. */
  private readonly audioDigests = new Map<string, string>();
  private swept = false;
  /** Pieces of recordings still going up, by the stream (the up message's id) and the piece's number, decoded as they arrive. */
  private readonly partCache = new Map<string, Map<number, PartEntry>>();
  private partsSwept = false;
  private readonly sends: number[] = [];
  private readonly answers: number[] = [];

  constructor(private readonly deps: MemoInboxDependencies) {
    this.now = deps.now ?? Date.now;
    this.restore();
  }

  /** Whether a phone call looks to be up: the gateway sent something lately (a hold keeps it up longer). */
  busy(): { busy: boolean; since?: number } {
    const now = this.now();
    const a = this.activity;
    if (!a) return { busy: false };
    const onHold = [...this.calls.values()].some((c) => c.hold && now - c.hold.since < HOLD_MAX_MS);
    return now - a.last <= (onHold ? HOLD_MAX_MS : CALL_BUSY_MS) ? { busy: true, since: a.since } : { busy: false };
  }

  private touchActivity(): void {
    const now = this.now();
    const a = this.activity;
    this.activity = a && now - a.last <= HOLD_MAX_MS ? { since: a.since, last: now } : { since: now, last: now };
  }

  /** Loads a call in progress saved by an earlier run, dropping what has expired. */
  private restore(): void {
    const { stateFile } = this.deps;
    if (!stateFile) return;
    const saved = loadCallState(stateFile);
    if (!saved) return;
    const now = this.now();
    for (const v of saved.versions) {
      if (now - v.usedAt > VERSION_TTL_MS) continue;
      this.versions.set(v.version, v.targets);
      this.newChatSpaces.set(v.version, v.spaces);
      this.versionUsed.set(v.version, v.usedAt);
    }
    while (this.versions.size > KEEP_VERSIONS) this.dropVersion(this.versions.keys().next().value as string);
    for (const { key, ...call } of saved.calls) {
      if (now - (call.at as number) > CALL_TARGET_TTL_MS) continue;
      this.calls.set(key, call as unknown as typeof this.calls extends Map<string, infer C> ? C : never);
    }
    for (const { id, ...p } of saved.pending) {
      if (now - (p.at as number) > PENDING_TTL_MS) continue;
      this.pending.set(id, p as unknown as Pending);
    }
    for (const { id, ...p } of saved.pendingNew) {
      if (now - (p.at as number) > PENDING_TTL_MS) continue;
      this.pendingNew.set(id, { ...(p as unknown as PendingNewChat), busy: false });
    }
    for (const h of saved.handled) {
      if (now - h.at > UP_TTL_MS * 2) continue;
      this.handled.push(h.id);
      this.handledAt.set(h.id, h.at);
    }
  }

  private dropVersion(version: string): void {
    this.versions.delete(version);
    this.newChatSpaces.delete(version);
    this.versionUsed.delete(version);
  }

  private persist(): void {
    const { stateFile } = this.deps;
    if (!stateFile) return;
    const now = this.now();
    saveCallState(stateFile, {
      v: 1,
      savedAt: now,
      versions: [...this.versions].map(([version, targets]) => ({
        version,
        targets,
        spaces: this.newChatSpaces.get(version) ?? [],
        usedAt: this.versionUsed.get(version) ?? now,
      })),
      calls: [...this.calls].map(([key, call]) => ({ key, ...call })),
      pending: [...this.pending].map(([id, p]) => ({ id, ...p })),
      pendingNew: [...this.pendingNew].map(([id, p]) => ({ id, ...p, busy: false })),
      handled: this.handled.map((id) => ({ id, at: this.handledAt.get(id) ?? now })),
    });
  }

  start(): void {
    this.stopped = false;
    this.unwatch = this.deps.store.watch(`channels/${this.deps.channel}/${UP_KIND}`, () => this.wake(), {
      onError: (error) => logger.warn("voice memo stream", { error: error.message }),
    });
    this.timer = setInterval(() => {
      this.wake();
      void this.publish().catch(() => undefined);
      void this.sweepParts(false).catch(() => undefined);
    }, 60_000);
    this.timer.unref?.();
    void this.publish().catch(() => undefined);
    void this.sweepParts(true).catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    this.unwatch?.();
    this.unwatch = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Writes the list of who can take a message, when it changed (or is getting old). */
  async publish(): Promise<void> {
    const all = this.deps.targets();
    const caller = this.deps.caller();
    const favorites = [...(this.deps.favorites?.() ?? [])].sort((a, b) => a.n - b.n).slice(0, MAX_WORKSPACES);
    let targets: MemoTarget[];
    let items: DirectoryItem[];
    let workspaces: DirectoryWorkspace[] | undefined;
    const newChatSpaces: Array<{ workspaceId: string; label: string }> = [];
    /** The workspace key behind each of `workspaces`, in order. */
    const workspaceKeys: string[] = [];
    // Automatic workspaces: the distinct workspaces of the chats no favourite holds, newest chat first.
    const favoriteKeys = new Set(favorites.map((f) => f.workspace));
    const rest = all.filter((x) => !x.workspace || !favoriteKeys.has(x.workspace));
    const autoKeys: string[] = [];
    for (const t of rest) if (t.workspace && !autoKeys.includes(t.workspace)) autoKeys.push(t.workspace);
    if (favorites.length === 0 && autoKeys.length < 2) {
      targets = all.slice(0, MENU_CHOICES);
      items = targets.map((t, index) => ({ n: index + 1, label: t.label }));
    } else {
      targets = [];
      const room = () => targets.length < MAX_CHOICES;
      const chatsOf = (key: string, from: MemoTarget[]): DirectoryItem[] => {
        const chats: DirectoryItem[] = [];
        for (const t of from.filter((x) => x.workspace === key).slice(0, MAX_WORKSPACES)) {
          if (!room()) break;
          targets.push(t);
          chats.push({ n: chats.length + 1, label: t.label, choice: targets.length });
        }
        return chats;
      };
      workspaces = favorites.map((fav) => {
        workspaceKeys.push(fav.workspace);
        return { n: fav.n, label: spokenLabel(fav.label), chats: chatsOf(fav.workspace, all) };
      });
      const used = new Set(favorites.map((f) => f.n));
      const grouped = new Set<string>();
      for (const key of autoKeys) {
        let n = 1;
        while (used.has(n)) n++;
        if (n > MAX_WORKSPACES || workspaces.length >= MAX_WORKSPACES) break;
        used.add(n);
        grouped.add(key);
        workspaceKeys.push(key);
        const first = rest.find((x) => x.workspace === key)!;
        workspaces.push({ n, label: spokenLabel(first.workspaceLabel ?? first.label), chats: chatsOf(key, rest) });
      }
      const numbered = numberRepeats(workspaces.map((w) => w.label));
      workspaces = workspaces.map((w, i) => ({ ...w, label: numbered[i]! }));
      // Where a new chat may be started (an add-on that offers it): only workspaces Conductor knows, at most nine.
      const newChat = this.deps.newChat;
      if (newChat?.supported()) {
        workspaces = workspaces.map((w, i) => {
          if (newChatSpaces.length >= MAX_WORKSPACES) return w;
          const workspaceId = newChat.workspaceId(workspaceKeys[i]!);
          if (!workspaceId) return w;
          newChatSpaces.push({ workspaceId, label: w.label });
          return { ...w, newChat: newChatSpaces.length };
        });
      }
      items = [];
      for (const t of rest.filter((x) => !x.workspace || !grouped.has(x.workspace)).slice(0, MENU_CHOICES)) {
        if (!room()) break;
        targets.push(t);
        items.push({ n: items.length + 1, label: t.label, choice: targets.length });
      }
    }
    // The chat offered first: the last one used by phone, else the newest waiting on the person. It is always one of
    // `targets` (put at the end, off every menu, when no menu lists it), so a memo or a status can name it.
    // Used by phone only counts for a while: a chat from this morning offered as "the last one you used" tonight
    // read as a stale list. Else the newest waiting on the person (`all` is newest first); else no offer, the menus.
    const lastChat = this.deps.lastChat;
    const lastTarget = lastChat ? (lastChat.recent ? lastChat.recent(LAST_CHAT_FRESH_MS) : lastChat.get()) : null;
    const used = all.find((t) => t.target === lastTarget);
    const waiting = all.find((t) => t.waiting);
    const lastPick = used ?? waiting;
    const why = used ? "used" : "waiting";
    let last: DirectoryDoc["last"];
    if (lastPick) {
      let index = targets.findIndex((t) => t.target === lastPick.target);
      if (index < 0 && targets.length < MAX_CHOICES) {
        targets.push(lastPick);
        index = targets.length - 1;
      }
      if (index >= 0) last = { choice: index + 1, label: lastPick.label, why };
    }
    const version = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          items,
          workspaces,
          caller,
          last,
          talk: Boolean(this.canAsk && this.deps.converse),
          terse: Boolean(this.deps.terse?.()),
          newChat: newChatSpaces.map((space) => space.workspaceId),
          voice: this.deps.voiceKey?.() ?? null,
          targets: targets.map((t) => t.target),
        }),
      )
      .digest("hex")
      .slice(0, 12);
    const at = this.now();
    if (this.published?.version === version && at - this.published.at < REPUBLISH_MS) return;
    this.versions.set(
      version,
      targets.map((t) => t.target),
    );
    this.newChatSpaces.set(version, newChatSpaces);
    this.versionUsed.set(version, this.versionUsed.get(version) ?? at);
    // A version no message has named for a while goes too (the newest is kept whatever its age).
    for (const known of [...this.versions.keys()]) {
      if (known !== version && at - (this.versionUsed.get(known) ?? at) > VERSION_TTL_MS) this.dropVersion(known);
    }
    while (this.versions.size > KEEP_VERSIONS) this.dropVersion(this.versions.keys().next().value as string);
    for (const known of [...this.newChatSpaces.keys()]) if (!this.versions.has(known)) this.newChatSpaces.delete(known);
    this.persist();
    const doc: DirectoryDoc = {
      v: 1,
      at,
      version,
      caller,
      items,
      ...(workspaces ? { workspaces } : {}),
      ...(last ? { last } : {}),
      ...(this.canAsk ? { ask: true as const } : {}),
      ...(this.canAsk && this.deps.converse ? { talk: true as const } : {}),
      ...(this.deps.terse?.() ? { terse: true as const } : {}),
      ...(this.canParts ? { upParts: true as const } : {}),
    };
    const audio = this.audioDocs.get(version);
    await this.deps.store.set(
      dirPath(this.deps.channel),
      sealDirectory(this.deps.key, audio ? { ...doc, audio } : doc),
    );
    this.published = { version, at };
    void this.dropStaleAudio().catch(() => undefined);
    // The recordings take a while to make: the list is already out, and the audio follows as separate documents.
    if (this.deps.audioClips) void this.publishAudio(doc).catch(() => undefined);
  }

  /** Renders the call-in prompts, writes them as audio documents, then names them in the list (same version). */
  private async publishAudio(doc: DirectoryDoc): Promise<void> {
    const { store, channel, key } = this.deps;
    // Only what the add-on says itself, menus first and cut to what the audio documents hold: the Mac's own lines ride
    // in the messages that carry them.
    const texts = uploadPrompts(doc);
    const voiceKey = this.deps.voiceKey?.() ?? null;
    // One pass records at most a minute of speech (PromptClipCache), so a slow voice leaves most prompts to the
    // add-on's own (Piper). Each pass is published as soon as it is made, then the next records what is still missing
    // (the made ones are cached), until all are there, a pass adds nothing, or the list or the voice changed.
    let previous = -1;
    for (let pass = 0; pass < MAX_AUDIO_PASSES; pass += 1) {
      const clips = await this.deps.audioClips!(texts);
      if (this.stopped) return;
      const stale = this.published?.version !== doc.version || (this.deps.voiceKey?.() ?? null) !== voiceKey;
      const more = !stale && clips.length < texts.length && clips.length > previous && pass + 1 < MAX_AUDIO_PASSES;
      previous = clips.length;
      if (clips.length > 0) {
        const groups = chunkClips(clips).slice(0, MAX_AUDIO_DOCS);
        const ids: string[] = [];
        for (const [index, group] of groups.entries()) {
          // A document whose clips are unchanged is not written again (the database's bandwidth is the owner's): one an
          // earlier pass or a still-kept version already holds is named as it is.
          const digest = clipsDigest(group);
          const held = [...this.audioDigests].find(([docId, held]) => held === digest && this.audioHeld(docId));
          if (held) {
            ids.push(held[0]);
            continue;
          }
          const id = audioDocId(doc.version, index);
          await store.set(audioPath(channel, id), sealAudio(key, id, doc.version, group, this.now()));
          this.audioDigests.set(id, digest);
          ids.push(id);
        }
        // A newer list came out while this rendered: its own audio follows; this one's documents are cleaned with it.
        this.audioDocs.set(doc.version, ids);
        if (this.published?.version === doc.version) {
          await store.set(dirPath(channel), sealDirectory(key, { ...doc, audio: ids }));
        }
      }
      if (!more) break;
    }
    this.deps.audioPublished?.(doc.version, voiceKey);
    await this.dropStaleAudio();
    if (this.deps.prepareMacSays && !this.stopped) {
      const labels = [...doc.items, ...(doc.workspaces ?? []).flatMap((w) => w.chats)].map((i) => i.label);
      await this.deps
        .prepareMacSays([...new Set([...macFixedSays(), ...[...new Set(labels)].flatMap((l) => macLabelSays(l))])])
        .catch(() => undefined);
    }
    if (this.deps.prepareReadBack && !this.stopped) {
      const labels = [...doc.items, ...(doc.workspaces ?? []).flatMap((w) => w.chats)].map((i) => i.label);
      await this.deps.prepareReadBack(labels, this.canAsk).catch(() => undefined);
    }
    if (this.deps.prepareSpeech && this.deps.streamsReadBack?.() && !this.stopped) {
      const labels = [...doc.items, ...(doc.workspaces ?? []).flatMap((w) => w.chats)].map((i) => i.label);
      const model = this.deps.newChat?.model();
      const names = (doc.workspaces ?? []).map((w) => w.label);
      const spoken = model ? spokenModelLabel(model.label) : undefined;
      const texts = [...fixedMemoReadBackSpeech(labels, this.canAsk), ...fixedNewChatReadBackSpeech(names, spoken)];
      await this.deps.prepareSpeech(texts).catch(() => undefined);
    }
  }

  /** Whether an audio document written earlier is still named by a kept version (or by the pass being made). */
  private audioHeld(id: string): boolean {
    for (const [version, ids] of this.audioDocs) if (this.versions.has(version) && ids.includes(id)) return true;
    return false;
  }

  /** Deletes audio documents of directory versions no longer kept (and, once, ones a restart left behind). */
  private async dropStaleAudio(): Promise<void> {
    const { store, channel } = this.deps;
    const keep = new Set<string>();
    for (const version of this.versions.keys()) for (const id of this.audioDocs.get(version) ?? []) keep.add(id);
    for (const [version, ids] of [...this.audioDocs]) {
      if (this.versions.has(version)) continue;
      this.audioDocs.delete(version);
      await Promise.all(
        ids
          .filter((id) => !keep.has(id))
          .map((id) => {
            this.audioDigests.delete(id);
            return store.delete(audioPath(channel, id)).catch(() => undefined);
          }),
      );
    }
    if (this.swept) return;
    this.swept = true;
    for (const { id } of await store.list(`channels/${channel}/${DIR_KIND}`)) {
      if (id.startsWith(REPLY_AUDIO_PREFIX)) await store.delete(audioPath(channel, id)).catch(() => undefined);
      else if (id.startsWith("audio-") && !keep.has(id))
        await store.delete(audioPath(channel, id)).catch(() => undefined);
    }
  }

  private wake(): void {
    if (this.stopped) return;
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.running = true;
    void this.pass()
      .catch((error: unknown) =>
        logger.warn("voice memo pass failed", { error: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => {
        this.running = false;
        if (this.dirty) {
          this.dirty = false;
          this.wake();
        }
      });
  }

  /** One pass over what the gateway sent; exposed for tests. */
  async pass(): Promise<void> {
    const { store, channel, key } = this.deps;
    const docs = await store.list(`channels/${channel}/${UP_KIND}`);
    // Pieces of a recording are never messages: take them in (decoding starts now) before any message is looked at.
    for (const { id, doc } of docs) if (id.startsWith(UP_AUDIO_PREFIX)) this.takePart(id, doc);
    for (const { id, doc } of docs) {
      if (this.stopped) return;
      if (id.startsWith(UP_AUDIO_PREFIX)) continue;
      if (this.handled.includes(id)) {
        await store.delete(upPath(channel, id)).catch(() => undefined);
        continue;
      }
      const read = readUp(key, id, doc, this.now());
      // Remember first, then claim: a second pass must see it as taken, and an undeletable one is not run twice.
      this.handled.push(id);
      this.handledAt.set(id, this.now());
      if (this.handled.length > REMEMBER) this.handledAt.delete(this.handled.shift() as string);
      try {
        await store.delete(upPath(channel, id));
      } catch {
        this.handled.splice(this.handled.indexOf(id), 1);
        this.handledAt.delete(id);
        continue;
      }
      this.persist();
      if (!read.ok) {
        logger.info("voice memo dropped", { reason: read.reason });
        continue;
      }
      this.touchActivity();
      if ("dirVersion" in read.message && this.versions.has(read.message.dirVersion)) {
        this.versionUsed.set(read.message.dirVersion, this.now());
      }
      const answer = await this.handle(read.message).catch((error: unknown): DownMessage => {
        logger.warn("voice memo failed", { error: error instanceof Error ? error.message : String(error) });
        return { v: 1, id, at: this.now(), status: "refused", reason: REFUSED_SAYS.wentWrong };
      });
      this.persist();
      await store.set(downPath(channel, id), sealDown(key, await this.withRefusalAudio(answer)));
    }
  }

  /** Whether this Mac can take a recording in pieces: it needs a transcriber that decodes them and reads the joined audio. */
  private get canParts(): boolean {
    const { transcriber } = this.deps;
    return Boolean(transcriber.decode && transcriber.transcribePcm);
  }

  /** Reads one `upaudio-` document and starts decoding it. A stale one is deleted; one that does not check out is ignored. */
  private takePart(id: string, doc: ChannelDoc): void {
    const { store, channel, key } = this.deps;
    const now = this.now();
    if (typeof doc.at === "number" && now - doc.at > PART_DOC_TTL_MS) {
      void Promise.resolve(store.delete(upPath(channel, id))).catch(() => undefined);
      return;
    }
    const read = readUpPart(key, id, doc);
    if (!read || !this.canParts) return;
    for (const [stream, entries] of [...this.partCache]) {
      const newest = Math.max(...[...entries.values()].map((entry) => entry.at));
      if (now - newest > PART_CACHE_TTL_MS) this.partCache.delete(stream);
    }
    const hash = upPartHash(read.opus);
    let entries = this.partCache.get(read.stream);
    if (!entries) {
      entries = new Map();
      this.partCache.set(read.stream, entries);
      while (this.partCache.size > MAX_CACHED_STREAMS)
        this.partCache.delete(this.partCache.keys().next().value as string);
    }
    if (entries.get(read.index)?.hash === hash) return;
    const pcm = this.deps.transcriber.decode!(read.opus);
    pcm.catch(() => undefined);
    entries.set(read.index, { hash, bytes: read.opus.length, at: now, pcm });
  }

  /** Deletes every `upaudio-` document older than ten minutes, or (at start) all of them: a call cannot outlive the daemon. */
  private async sweepParts(all: boolean): Promise<void> {
    if (all && this.partsSwept) return;
    if (all) this.partsSwept = true;
    const { store, channel } = this.deps;
    const now = this.now();
    for (const { id, doc } of await store.list(`channels/${channel}/${UP_KIND}`)) {
      if (!id.startsWith(UP_AUDIO_PREFIX)) continue;
      if (all || typeof doc.at !== "number" || now - doc.at > PART_DOC_TTL_MS) {
        await store.delete(upPath(channel, id)).catch(() => undefined);
      }
    }
  }

  /**
   * The audio an up message carries: its whole recording, or the pieces it names, gathered (from what was decoded ahead,
   * else fetched; one that has not arrived is waited for) and checked against their hashes. Anything short of exact is
   * refused, never a partial recording. The pieces' documents are deleted once used.
   */
  private async audioOf(message: { id: string; audio?: string; audioParts?: string[] }): Promise<UpSpeech> {
    const { parts } = { parts: message.audioParts };
    if (!parts) {
      const audio = Buffer.from(message.audio ?? "", "base64");
      return { kind: "opus", audio, note: `${Math.max(1, Math.round(audio.length / 1024))} KB` };
    }
    if (!this.canParts) return { kind: "refused", reason: PARTS_SAYS.unsupported };
    const { store, channel } = this.deps;
    try {
      const deadline = Date.now() + (this.deps.partsWaitMs ?? PARTS_WAIT_MS);
      for (;;) {
        const entries = this.partCache.get(message.id);
        const missing = parts.map((_, index) => index).filter((index) => !entries?.has(index));
        if (missing.length === 0) break;
        for (const index of missing) {
          const id = upAudioId(message.id, index);
          try {
            const doc = await store.get(upPath(channel, id));
            if (doc) this.takePart(id, doc);
          } catch {
            // The next look tries again; the deadline ends it.
          }
        }
        if (parts.every((_, index) => this.partCache.get(message.id)?.has(index))) break;
        if (Date.now() >= deadline) return { kind: "refused", reason: PARTS_SAYS.missing };
        await new Promise((resolve) => setTimeout(resolve, this.deps.partsPollMs ?? PARTS_POLL_MS));
      }
      const have = this.partCache.get(message.id)!;
      for (const [index, hash] of parts.entries()) {
        if (have.get(index)?.hash !== hash) return { kind: "refused", reason: PARTS_SAYS.missing };
      }
      let pcm: Buffer[];
      try {
        pcm = await Promise.all(parts.map((_, index) => have.get(index)!.pcm));
      } catch {
        return { kind: "refused", reason: PARTS_SAYS.missing };
      }
      const bytes = parts.reduce((sum, _, index) => sum + have.get(index)!.bytes, 0);
      return {
        kind: "pcm",
        pcm: Buffer.concat(pcm),
        note: `${Math.max(1, Math.round(bytes / 1024))} KB in ${parts.length} pieces`,
      };
    } finally {
      this.partCache.delete(message.id);
      await Promise.allSettled(parts.map((_, index) => store.delete(upPath(channel, upAudioId(message.id, index)))));
    }
  }

  private transcribeUp(speech: Exclude<UpSpeech, { kind: "refused" }>): Promise<string> {
    return speech.kind === "opus"
      ? this.deps.transcriber.transcribe(speech.audio)
      : this.deps.transcriber.transcribePcm!(speech.pcm);
  }

  /** The read-back in the Mac's voice, within a short budget: a slow render must not hold up the phone line. */
  private get canAsk(): boolean {
    return Boolean(this.deps.describe && this.deps.answer);
  }

  /** The memo read-back's clip: in parts as they are made for an add-on that follows, else the one clip. */
  private async memoReadBackFields(id: string, text: string, label: string): Promise<AudioFollowsFields> {
    const streamed = await this.readBackParts(id, text, memoReadBackSpeech(text, label, this.canAsk));
    if (streamed) return streamed;
    const audio = await this.readBackAudio(text, label);
    return audio ? { audio } : {};
  }

  private async readBackAudio(text: string, label: string): Promise<Clip | undefined> {
    if (!this.deps.readBack) return undefined;
    try {
      return await Promise.race([
        this.deps.readBack(text, label, this.canAsk),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), READ_BACK_BUDGET_MS).unref()),
      ]);
    } catch {
      return undefined;
    }
  }

  /** The call `callId` is about this chat: its id then names a one-chat list for memos and status (9 and 0 on the keypad). */
  registerCall(
    callId: string,
    target: string,
    label: string,
    script?: { question: string; options: ChoiceOption[] },
  ): void {
    const now = this.now();
    for (const [id, call] of this.calls) {
      if (now - call.at <= CALL_TARGET_TTL_MS) continue;
      this.calls.delete(id);
      this.deps.endCall?.(id);
    }
    this.calls.set(callId, { target, label, at: now, turns: 0, ...(script ? { script } : {}) });
    this.touchActivity();
    this.persist();
  }

  /** The chats a list version names by number: a published list, or the one chat a call out is about. */
  private targetsOf(version: string): string[] | undefined {
    const call = this.calls.get(version);
    return this.versions.get(version) ?? (call ? [call.target] : undefined);
  }

  /** What to call a chat: as listed now, else as the call out named it, else by number. */
  private labelOf(version: string, target: string, choice: number): string {
    return (
      this.deps.targets().find((t) => t.target === target)?.label ?? this.calls.get(version)?.label ?? `chat ${choice}`
    );
  }

  /** Notes the chat used by phone and republishes, so the next call offers it first. */
  private rememberLast(target: string): void {
    const { lastChat } = this.deps;
    if (!lastChat || lastChat.get() === target) return;
    lastChat.set(target);
    void this.publish().catch(() => undefined);
  }

  private refuse(id: string, reason: string): DownMessage {
    return { v: 1, id, at: this.now(), status: "refused", reason };
  }

  /** The recording's words in the Mac's voice, within a short budget; undefined leaves it to the add-on. */
  private async answerAudio(text: string, budgetMs = ANSWER_AUDIO_BUDGET_MS): Promise<Clip | undefined> {
    if (!this.deps.speech) return undefined;
    try {
      return await Promise.race([
        this.deps.speech(text),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), budgetMs).unref()),
      ]);
    } catch {
      return undefined;
    }
  }

  /**
   * A refusal in the Mac's voice: its clip rides in the message (add-on 0.20.0), so none of these lines has to be held
   * by the add-on. Made ahead (`prepareMacSays`), so this is normally a cache hit; not ready within the short budget,
   * it goes as text and the add-on speaks it.
   */
  private async withRefusalAudio(answer: DownMessage): Promise<DownMessage> {
    if (answer.status !== "refused" || answer.audio || !this.deps.refusalAudio?.()) return answer;
    const clip = await this.answerAudio(answer.reason, REFUSAL_AUDIO_BUDGET_MS);
    return clip && clip.text === answer.reason ? { ...answer, audio: clip } : answer;
  }

  /**
   * The spoken part of an answer or talk reply. With an add-on that follows (`streamsAnswers`) and a text of two or
   * more sentences: waits only for the first sentence's clip (within the same budget), returns it with `audioFollows`,
   * and writes each later sentence's clip, in order, as it is made. Otherwise the whole text as one clip, as before.
   */
  private async spokenFields(id: string, text: string): Promise<{ audio?: Clip; audioFollows?: AudioFollows }> {
    const { speechStream, streamsAnswers } = this.deps;
    const parts = speechParts(text);
    if (!speechStream || !streamsAnswers?.() || parts.length < 2 || parts.length > MAX_ANSWER_PARTS) {
      const audio = await this.answerAudio(text);
      return audio ? { audio } : {};
    }
    return this.streamedSpeech(id, parts, (onPart) => speechStream(text, onPart), ANSWER_AUDIO_BUDGET_MS);
  }

  /**
   * The read-back as parts when the add-on plays them as they are made: the head first (made ahead, so it is ready at
   * once), the words, the tail. `parts` is what `memoReadBackSpeech` / `newChatReadBackSpeech` cut. Anything else
   * (an older add-on, no streaming voice, a text too long for the transcript) is `undefined`: the caller sends the one
   * clip as before.
   */
  private async readBackParts(id: string, text: string, parts: string[]): Promise<AudioFollowsFields | undefined> {
    const { speechParts: render, streamsReadBack } = this.deps;
    if (!render || !streamsReadBack?.() || parts.length < 2 || parts.length > MAX_ANSWER_PARTS) return undefined;
    if (text.length > MAX_TRANSCRIPT_CHARS || parts.some((part) => part.length > MAX_ANSWER_CHARS)) return undefined;
    // Tried once: a head that is not ready in time leaves the whole read-back to the add-on, never a second wait.
    return this.streamedSpeech(id, parts, (onPart) => render(parts, onPart), READ_BACK_BUDGET_MS);
  }

  /**
   * Waits only for the first part's clip (within `budgetMs`), returns it with `audioFollows`, and writes each later
   * part's clip as the document `replyaudio-<id>-<n>`, in order, as it is made. No first clip in time: `{}` and the
   * rest is dropped.
   */
  private async streamedSpeech(
    id: string,
    parts: string[],
    render: (onPart: (part: { index: number; total: number; clip: Clip }) => void) => Promise<void>,
    budgetMs: number,
  ): Promise<{ audio?: Clip; audioFollows?: AudioFollows }> {
    const { store, channel, key } = this.deps;
    let release: (clip: Clip | undefined) => void = () => undefined;
    const first = new Promise<Clip | undefined>((resolve) => (release = resolve));
    let abandoned = false;
    let chain: Promise<void> = Promise.resolve();
    const written: string[] = [];
    void render(({ index, clip }) => {
      if (index === 0) return release(clip.text === parts[0] ? clip : undefined);
      if (clip.text !== parts[index]) return;
      chain = chain.then(async () => {
        if (abandoned) return;
        const docId = replyAudioId(id, index);
        try {
          await store.set(audioPath(channel, docId), sealAudio(key, docId, id, [clip], this.now()), {
            timeoutMs: REPLY_AUDIO_WRITE_MS,
          });
          written.push(docId);
        } catch {
          // The add-on speaks what does not arrive.
        }
      });
    })
      .catch(() => undefined)
      .finally(() => release(undefined));
    const audio = await Promise.race([
      first,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), budgetMs).unref()),
    ]);
    // The backstop: the add-on deletes these when the answer is spoken; a call that dropped leaves them to this.
    setTimeout(() => {
      abandoned = true;
      void chain.then(() => Promise.allSettled(written.map((docId) => store.delete(audioPath(channel, docId)))));
    }, REPLY_AUDIO_TTL_MS).unref();
    if (!audio) {
      abandoned = true;
      return {};
    }
    return { audio, audioFollows: { parts } };
  }

  /**
   * A question about a chat, or where it stands, answered aloud. Read-only by construction: nothing here reaches
   * `send`, `canSend` or any writer, so a question can never become a message to an agent or change a chat.
   */
  private async handleAnswer(message: Extract<UpMessage, { kind: "ask" | "status" }>): Promise<DownMessage> {
    const { describe, answer, trace } = this.deps;
    if (!describe || !answer) return this.refuse(message.id, REFUSED_SAYS.noAnswering);
    const now = this.now();
    while (this.answers.length > 0 && now - this.answers[0]! > 60 * 60_000) this.answers.shift();
    if (this.answers.length >= MAX_ANSWERS_PER_HOUR) return this.refuse(message.id, REFUSED_SAYS.tooManyQuestions);
    let target: string;
    let label: string;
    let question = "";
    if (message.kind === "status") {
      const found = this.targetsOf(message.dirVersion)?.[message.choice - 1];
      if (!found) return this.refuse(message.id, REFUSED_SAYS.staleList);
      target = found;
      label = this.labelOf(message.dirVersion, found, message.choice);
    } else {
      // Not deleted: the same recording may be sent after it was asked about, or asked again.
      const pending = this.pending.get(message.memoId);
      if (!pending) return this.refuse(message.id, REFUSED_SAYS.recordingGone);
      target = pending.target;
      label = pending.label;
      question = pending.text;
    }
    this.answers.push(now);
    this.rememberLast(target);
    let text: string;
    const began = Date.now();
    try {
      if (message.kind === "status") {
        const read = describe(target, label);
        if (!read) return this.refuse(message.id, couldNotFind(label));
        text = read;
      } else {
        text = await Promise.race([
          answer(target, label, question),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("took too long")), ANSWER_BUDGET_MS).unref(),
          ),
        ]);
      }
    } catch (error) {
      logger.warn("voice answer failed", { error: error instanceof Error ? error.message : String(error) });
      trace?.("warn", message.kind === "ask" ? "Could not answer the question" : "Could not read the status", {
        label,
      });
      return this.refuse(message.id, ASK_FAILED);
    }
    text = text.slice(0, MAX_ANSWER_CHARS);
    trace?.(
      "step",
      message.kind === "ask" ? `Question answered in ${((Date.now() - began) / 1000).toFixed(1)} s` : "Status read out",
      { label, ms: Date.now() - began },
    );
    trace?.("said", text, { label });
    const spoken = await this.spokenFields(message.id, text);
    return { v: 1, id: message.id, at: this.now(), status: "answer", text, ...spoken };
  }

  private async handle(message: UpMessage): Promise<DownMessage> {
    const now = this.now();
    for (const [memoId, pending] of this.pending) if (now - pending.at > PENDING_TTL_MS) this.pending.delete(memoId);

    if (message.kind === "memo") {
      const targets = this.targetsOf(message.dirVersion);
      const target = targets?.[message.choice - 1];
      if (!target) return this.refuse(message.id, REFUSED_SAYS.staleList);
      const label = this.labelOf(message.dirVersion, target, message.choice);
      const { trace } = this.deps;
      const speech = await this.audioOf(message);
      if (speech.kind === "refused") {
        trace?.("warn", "The recording did not arrive whole", { label });
        return this.refuse(message.id, speech.reason);
      }
      trace?.("step", `Recording received (${speech.note})`, { label });
      let text: string;
      const began = Date.now();
      try {
        text = await this.transcribeUp(speech);
      } catch (error) {
        logger.warn("voice memo could not be transcribed", {
          error: error instanceof Error ? error.message : String(error),
        });
        trace?.("warn", "Could not transcribe the recording", { label });
        return this.refuse(message.id, REFUSED_SAYS.notMadeOut);
      }
      if (!text) {
        trace?.("warn", "Nothing was heard in the recording", { label });
        return this.refuse(message.id, REFUSED_SAYS.heardNothing);
      }
      const transcribedMs = Date.now() - began;
      // The Mac's voice starts on the words as soon as they are known; the trace lines are written meanwhile.
      const spokenPromise = this.memoReadBackFields(message.id, text, label);
      trace?.("heard", text, { ms: transcribedMs, label });
      trace?.("step", `Transcribed in ${(transcribedMs / 1000).toFixed(1)} s`, { ms: transcribedMs, label });
      trace?.("said", text, { label });
      this.pending.set(message.id, { target, label, text, at: this.now() });
      while (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value as string);
      const { audio: spoken, audioFollows } = await spokenPromise;
      const renderMs = Date.now() - began - transcribedMs;
      if (this.deps.readBack || audioFollows)
        trace?.(
          spoken ? "step" : "warn",
          spoken
            ? `Read-back voice ${audioFollows ? "started" : "rendered"} in ${(renderMs / 1000).toFixed(1)} s`
            : `Read-back voice not ready after ${(renderMs / 1000).toFixed(1)} s; the add-on will speak it`,
          { ms: renderMs, label },
        );
      return {
        v: 1,
        id: message.id,
        at: this.now(),
        status: "transcript",
        text,
        label,
        ...(spoken ? { audio: spoken } : {}),
        ...(audioFollows ? { audioFollows } : {}),
      };
    }

    if (message.kind === "status" || message.kind === "ask") return this.handleAnswer(message);
    if (message.kind === "talk") return this.handleTalk(message);
    if (message.kind === "newchat") return this.handleNewChat(message);
    if (message.kind === "start") return this.handleStart(message);

    const pending = this.pending.get(message.memoId);
    if (!pending) return this.refuse(message.id, REFUSED_SAYS.messageGone);
    this.pending.delete(message.memoId);
    const delivered = await this.deliver(pending.target, pending.label, pending.text);
    if (!delivered.sent) return this.refuse(message.id, delivered.reason);
    return { v: 1, id: message.id, at: this.now(), status: "sent" };
  }

  /** One reply for a new chat's turn: the words, the Mac's voice for them, and what the call does with it. */
  private async newChatReply(
    id: string,
    outcome: "started" | "declined" | "again",
    text: string,
    label: string,
    hold = false,
  ): Promise<DownMessage> {
    this.deps.trace?.("said", text, { label });
    const spoken = await this.spokenFields(id, text);
    return {
      v: 1,
      id,
      at: this.now(),
      status: "newchat",
      outcome,
      text,
      ...spoken,
      ...(hold ? { hold: true as const } : {}),
    };
  }

  /**
   * What the person wants a new chat to do, recorded. Nothing starts here: the words are transcribed, kept, and read
   * back with the workspace and the model; only a later `start` (the keypad's 1, or a spoken yes) runs them.
   */
  private async handleNewChat(message: Extract<UpMessage, { kind: "newchat" }>): Promise<DownMessage> {
    const { newChat, trace } = this.deps;
    if (!newChat) return this.refuse(message.id, NEW_CHAT_SAYS.unavailable);
    const space = this.newChatSpaces.get(message.dirVersion)?.[message.workspace - 1];
    if (!space) return this.refuse(message.id, NEW_CHAT_SAYS.stale);
    const { label } = space;
    const speech = await this.audioOf(message);
    if (speech.kind === "refused") {
      trace?.("warn", "The recording did not arrive whole", { label });
      return this.refuse(message.id, speech.reason);
    }
    trace?.("step", `Recording received (${speech.note})`, { label });
    let text: string;
    const began = Date.now();
    try {
      text = cleanNewChatText(await this.transcribeUp(speech));
    } catch (error) {
      logger.warn("voice new chat could not be transcribed", {
        error: error instanceof Error ? error.message : String(error),
      });
      trace?.("warn", "Could not transcribe the recording", { label });
      return this.refuse(message.id, REFUSED_SAYS.notMadeOut);
    }
    if (!text) {
      trace?.("warn", "Nothing was heard in the recording", { label });
      return this.refuse(message.id, REFUSED_SAYS.heardNothing);
    }
    const transcribedMs = Date.now() - began;
    trace?.("heard", text, { ms: transcribedMs, label });
    const model = newChat.model();
    this.pendingNew.set(message.id, {
      workspaceId: space.workspaceId,
      label,
      text,
      model,
      at: this.now(),
      tries: 0,
      busy: false,
    });
    while (this.pendingNew.size > MAX_PENDING_NEW_CHATS) {
      this.pendingNew.delete(this.pendingNew.keys().next().value as string);
    }
    const modelLabel = model ? spokenModelLabel(model.label) : undefined;
    // The read-back in the Mac's voice (the add-on says exactly these words), within a short budget.
    const sentence = newChatReadBack(text, label, modelLabel);
    let spoken: Clip | undefined;
    const streamed = await this.readBackParts(message.id, text, newChatReadBackSpeech(text, label, modelLabel));
    if (!streamed && this.deps.speech) {
      spoken = await Promise.race([
        this.answerAudio(sentence),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), READ_BACK_BUDGET_MS).unref()),
      ]);
    }
    trace?.("said", sentence, { label });
    return {
      v: 1,
      id: message.id,
      at: this.now(),
      status: "transcript",
      text,
      label,
      ...(modelLabel ? { model: modelLabel } : {}),
      ...(streamed ? streamed : spoken ? { audio: spoken } : {}),
    };
  }

  /**
   * Starts the new chat read back as `memoId`, through the same `startChat` as the phone app. Only an explicit yes gets
   * here: the keypad's 1 (a `start` with no recording) or a spoken answer this Mac transcribed itself that is a plain
   * yes. The words are the ones kept at read-back; nothing the gateway sends can change them, or the workspace or model.
   */
  private async handleStart(message: Extract<UpMessage, { kind: "start" }>): Promise<DownMessage> {
    const { newChat, trace } = this.deps;
    if (!newChat) return this.refuse(message.id, NEW_CHAT_SAYS.unavailable);
    const now = this.now();
    for (const [id, waiting] of this.pendingNew) if (now - waiting.at > PENDING_TTL_MS) this.pendingNew.delete(id);
    const pending = this.pendingNew.get(message.memoId);
    if (!pending || pending.busy) return this.refuse(message.id, NEW_CHAT_SAYS.gone);
    const { label } = pending;
    if (message.audio !== undefined || message.audioParts !== undefined) {
      pending.busy = true;
      let heard = "";
      try {
        const speech = await this.audioOf(message);
        if (speech.kind === "refused") throw new Error(speech.reason);
        heard = await this.transcribeUp(speech);
      } catch (error) {
        logger.warn("voice new chat answer could not be transcribed", {
          error: error instanceof Error ? error.message : String(error),
        });
        trace?.("warn", "Could not transcribe the answer", { label });
      } finally {
        pending.busy = false;
      }
      trace?.("heard", heard || "(nothing)", { label });
      const words = heard.trim().split(/\s+/).filter(Boolean);
      const yes = YES.test(heard);
      const no = NO.test(heard);
      if (words.length > MAX_CONFIRM_WORDS || yes === no) {
        pending.tries += 1;
        if (pending.tries >= 2) {
          this.pendingNew.delete(message.memoId);
          return this.newChatReply(message.id, "declined", NEW_CHAT_SAYS.declined, label);
        }
        return this.newChatReply(message.id, "again", NEW_CHAT_SAYS.again, label);
      }
      if (no) {
        this.pendingNew.delete(message.memoId);
        return this.newChatReply(message.id, "declined", NEW_CHAT_SAYS.declined, label);
      }
    }
    // Taken first, so a repeated or replayed start can never start the same chat twice.
    this.pendingNew.delete(message.memoId);
    while (this.newChatStarts.length > 0 && now - this.newChatStarts[0]! > 60 * 60_000) this.newChatStarts.shift();
    if (this.newChatStarts.length >= MAX_NEW_CHATS_PER_HOUR) {
      trace?.("warn", "Too many new chats by phone this hour", { label });
      return this.refuse(message.id, NEW_CHAT_SAYS.limit);
    }
    this.newChatStarts.push(now);
    let outcome: StartChatOutcome;
    try {
      outcome = await newChat.start({
        workspaceId: pending.workspaceId,
        text: pending.text,
        ...(pending.model
          ? {
              model: {
                id: pending.model.id,
                agent: pending.model.agent,
                ...(pending.model.level ? { level: pending.model.level } : {}),
              },
            }
          : {}),
      });
    } catch (error) {
      logger.warn("voice new chat failed", { error: error instanceof Error ? error.message : String(error) });
      outcome = { ok: false, reason: "threw" };
    }
    if (!outcome.ok) {
      trace?.("warn", `Could not start a new chat: ${outcome.reason.slice(0, 160)}`, { label });
      return this.refuse(message.id, NEW_CHAT_SAYS.failed);
    }
    trace?.("step", `Started a new chat in ${label}`, { label });
    const shown = pending.text.length > 200 ? `${pending.text.slice(0, 200)}…` : pending.text;
    this.deps.note(`Started by phone in ${label}: \u201c${shown}\u201d`);
    this.rememberLast(outcome.sessionId);
    // Offered only when the call can carry it: an add-on that holds, a Mac that talks, and the call's own id.
    if (message.callId && this.deps.hold?.supported() && this.deps.converse) {
      for (const [id, old] of this.calls) {
        if (now - old.at <= CALL_TARGET_TTL_MS) continue;
        this.calls.delete(id);
        this.deps.endCall?.(id);
      }
      this.calls.set(`in:${message.callId}`, {
        target: outcome.sessionId,
        label,
        at: now,
        turns: 0,
        offer: { at: now, tries: 0 },
        fresh: true,
      });
      return this.newChatReply(
        message.id,
        "started",
        `${NEW_CHAT_SAYS.started} ${NEW_CHAT_SAYS.offerHold}`,
        label,
        true,
      );
    }
    return this.newChatReply(message.id, "started", `${NEW_CHAT_SAYS.started} ${NEW_CHAT_SAYS.bye}`, label);
  }

  /**
   * Sends words the person has confirmed to a chat, through the same replier as every other surface: the hourly limit,
   * whether the chat can still take one, the send, and the notes. The one place a phone message leaves the Mac.
   */
  private async deliver(
    target: string,
    label: string,
    text: string,
  ): Promise<{ sent: true } | { sent: false; reason: string }> {
    const now = this.now();
    while (this.sends.length > 0 && now - this.sends[0]! > 60 * 60_000) this.sends.shift();
    if (this.sends.length >= MAX_SENDS_PER_HOUR) return { sent: false, reason: REFUSED_SAYS.tooManyMessages };
    if (!this.deps.canSend(target)) {
      this.deps.trace?.("warn", `${label} is busy, nothing sent`, { label });
      return { sent: false, reason: chatBusy(label) };
    }
    this.sends.push(now);
    this.rememberLast(target);
    const outcome = await this.deps.send(target, text, (reason) => {
      this.deps.note(`The message you phoned in for ${label} did not go through: ${reason}`);
    });
    if (outcome.status === "refused" || outcome.status === "unconfirmed") {
      this.deps.trace?.("warn", outcome.reason.slice(0, 200), { label });
      return { sent: false, reason: outcome.reason.slice(0, 200) };
    }
    this.deps.trace?.("step", `Sent to ${label}`, { label });
    const shown = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    this.deps.note(`Sent by phone to ${label}: \u201c${shown}\u201d`);
    return { sent: true };
  }

  private async talkReply(
    id: string,
    text: string,
    next: "listen" | "confirm" | "end" | "hold",
    label: string,
  ): Promise<DownMessage> {
    // A hold check-in with nothing to say is a silent "keep waiting".
    if (!text) return { v: 1, id, at: this.now(), status: "talk", text: "", next };
    this.deps.trace?.("said", text, { label });
    const spoken = await this.spokenFields(id, text);
    return { v: 1, id, at: this.now(), status: "talk", text, next, ...spoken };
  }

  /** One check-in (`hold`) or key press (`peek`) of a call that is holding while a chat works. */
  private async handleHold(
    phase: "hold" | "peek",
    call: NonNullable<ReturnType<MemoInbox["calls"]["get"]>>,
    target: string,
    label: string,
    now: number,
    reply: (text: string, next: "listen" | "confirm" | "end" | "hold") => Promise<DownMessage>,
  ): Promise<DownMessage> {
    const hold = this.deps.hold;
    const state = call.hold;
    if (!hold || !state) return reply(TALK_REPLY_SAYS.closed, "end");
    if (phase === "peek") {
      state.lastSaid = now;
      return reply(hold.peek(target, label) || TALK_REPLY_SAYS.cannotSee, "hold");
    }
    const seen = hold.state(target, label);
    // A chat started on this call can take a moment to show up: wait for it as long as one that never starts.
    if (seen === null && call.fresh && now - state.since <= HOLD_START_MS) return reply("", "hold");
    if (seen === null) {
      call.hold = undefined;
      return reply(TALK_REPLY_SAYS.lostChat, "end");
    }
    if (seen === "working") state.seenWorking = true;
    if (seen === "stopped" && (state.seenWorking || now - state.since > HOLD_START_MS)) {
      call.hold = undefined;
      const ended = hold.ended(target, label);
      return reply(state.seenWorking ? ended : `${TALK_REPLY_SAYS.noStart} ${ended}`, "listen");
    }
    if (now - state.since > HOLD_MAX_MS) {
      call.hold = undefined;
      return reply(TALK_REPLY_SAYS.longHold, "end");
    }
    if (now - state.lastSaid > HOLD_REASSURE_MS) {
      state.lastSaid = now;
      return reply(TALK_REPLY_SAYS.stillWorking, "hold");
    }
    return reply("", "hold");
  }

  /**
   * One turn of a voice-first call out. Only a call the Mac itself registered can talk (never a published list), and a
   * message leaves only from a `confirm` turn whose own recorded words said yes to the one proposal the person's
   * `say` turn made. The model chooses the proposal's words and nothing else: it cannot send, and a `say` turn never
   * reaches `deliver`.
   */
  private async handleTalk(message: Extract<UpMessage, { kind: "talk" }>): Promise<DownMessage> {
    const { converse, trace } = this.deps;
    const now = this.now();
    // A call in names its own conversation (`callId`) and a chat of the published list; the Mac makes the call's record
    // the first time it hears it. A call out is the record `registerCall` made, always chat 1.
    const callKey = message.callId ? `in:${message.callId}` : message.dirVersion;
    let call = this.calls.get(callKey);
    if (!call && message.callId) {
      const found = this.versions.get(message.dirVersion)?.[message.choice - 1];
      if (found) {
        for (const [id, old] of this.calls) {
          if (now - old.at <= CALL_TARGET_TTL_MS) continue;
          this.calls.delete(id);
          this.deps.endCall?.(id);
        }
        call = { target: found, label: this.labelOf(message.dirVersion, found, message.choice), at: now, turns: 0 };
        this.calls.set(callKey, call);
      }
    }
    if ((!message.callId && message.choice !== 1) || !call || now - call.at > CALL_TARGET_TTL_MS) {
      return this.refuse(message.id, TALK_REPLY_SAYS.closed);
    }
    if (!converse) return this.refuse(message.id, REFUSED_SAYS.noTalking);
    const { label, target } = call;
    const reply = (text: string, next: "listen" | "confirm" | "end" | "hold"): Promise<DownMessage> => {
      if (next === "end") this.deps.endCall?.(callKey);
      return this.talkReply(message.id, text, next, label);
    };

    // A hold check-in or a peek is a key press: no recording, no model, nothing sent.
    if (message.phase === "hold" || message.phase === "peek") {
      return this.handleHold(message.phase, call, target, label, now, reply);
    }

    let heard: string;
    const began = Date.now();
    try {
      const speech = await this.audioOf(message);
      if (speech.kind === "refused") throw new Error(speech.reason);
      heard = await this.transcribeUp(speech);
    } catch (error) {
      logger.warn("voice talk could not be transcribed", {
        error: error instanceof Error ? error.message : String(error),
      });
      trace?.("warn", "Could not transcribe the recording", { label });
      heard = "";
    }
    trace?.("heard", heard || "(nothing)", { ms: Date.now() - began, label });
    const words = heard.trim().split(/\s+/).filter(Boolean);

    if (message.phase === "confirm" && call.offer) {
      const offer = call.offer;
      if (now - offer.at > PROPOSAL_TTL_MS) {
        call.offer = undefined;
        return reply(TALK_REPLY_SAYS.bye, "end");
      }
      const yes = YES.test(heard);
      const no = NO.test(heard);
      if (words.length > MAX_CONFIRM_WORDS || yes === no) {
        offer.tries += 1;
        if (offer.tries >= 2) {
          call.offer = undefined;
          return reply(TALK_REPLY_SAYS.noHold, "end");
        }
        return reply(TALK_REPLY_SAYS.offerHold, "confirm");
      }
      call.offer = undefined;
      if (no) return reply(TALK_REPLY_SAYS.noHold, "end");
      call.hold = { since: now, seenWorking: false, lastSaid: now };
      return reply(TALK_REPLY_SAYS.holding, "hold");
    }

    if (message.phase === "confirm") {
      const proposal = call.proposal;
      if (!proposal || now - proposal.at > PROPOSAL_TTL_MS) {
        call.proposal = undefined;
        return reply(TALK_REPLY_SAYS.gone, "listen");
      }
      const yes = YES.test(heard);
      const no = NO.test(heard);
      if (words.length > MAX_CONFIRM_WORDS || yes === no) {
        proposal.tries += 1;
        if (proposal.tries >= 2) {
          call.proposal = undefined;
          return reply(TALK_REPLY_SAYS.giveUp, "end");
        }
        return reply(TALK_REPLY_SAYS.again, "confirm");
      }
      // Taken first, so a repeated or replayed confirm can never send the same words twice.
      call.proposal = undefined;
      if (no) return reply(TALK_REPLY_SAYS.declined, "listen");
      const delivered = await this.deliver(target, label, proposal.message);
      if (!delivered.sent) return reply(delivered.reason, "end");
      // The call back is asked for only after the send went, and only for what the person said yes to.
      const calling = proposal.callback
        ? this.deps.requestCallback?.(target, label, proposal.message.length > 1 ? proposal.message : "", true)
        : undefined;
      if (calling?.ok) trace?.("step", `Call back requested for ${label}`, { label });
      if (calling?.ok) return reply(TALK_REPLY_SAYS.sentCallback, "end");
      // Asking the person, not assuming: a quick job may be worth waiting for, a long one is not.
      if (this.deps.hold?.supported()) {
        call.offer = { at: now, tries: 0 };
        return reply(TALK_REPLY_SAYS.offerHold, "confirm");
      }
      return reply(TALK_REPLY_SAYS.sent, "end");
    }

    // A new thing said: whatever was read back before is no longer on offer.
    call.proposal = undefined;
    if (GOODBYE.test(heard)) return reply(TALK_REPLY_SAYS.bye, "end");
    if (judgeTranscript(heard, 5_000) === "silence") return reply(TALK_REPLY_SAYS.sorry, "listen");
    if (call.turns >= MAX_TALK_TURNS) return reply(TALK_REPLY_SAYS.turns, "end");
    while (this.answers.length > 0 && now - this.answers[0]! > 60 * 60_000) this.answers.shift();
    if (this.answers.length >= MAX_ANSWERS_PER_HOUR) return this.refuse(message.id, REFUSED_SAYS.tooManyQuestions);
    call.turns += 1;
    this.answers.push(now);
    this.rememberLast(target);
    let decided: Awaited<ReturnType<NonNullable<MemoInboxDependencies["converse"]>>>;
    try {
      decided = await Promise.race([
        converse(target, label, {
          utterance: heard.slice(0, 600),
          question: call.script?.question ?? "",
          options: call.script?.options ?? [],
          callId: callKey,
        }),
        new Promise<never>((_, rejectTurn) =>
          setTimeout(() => rejectTurn(new Error("took too long")), ANSWER_BUDGET_MS).unref(),
        ),
      ]);
    } catch (error) {
      logger.warn("voice talk failed", { error: error instanceof Error ? error.message : String(error) });
      trace?.("warn", "Could not work out what was said", { label });
      return reply(TALK_REPLY_SAYS.failed, "listen");
    }
    switch (decided.intent) {
      case "answer": {
        const text = spokenAnswer(String(decided.spoken ?? ""), MAX_ANSWER_CHARS);
        return reply(text || TALK_REPLY_SAYS.unclear, "listen");
      }
      case "end":
        return reply(TALK_REPLY_SAYS.bye, "end");
      case "callback": {
        const request = this.deps.requestCallback;
        if (!request) return reply(TALK_REPLY_SAYS.noCallback, "listen");
        const calling = request(target, label, cleanMessage(decided.message), false);
        if (!calling.ok) return reply(calling.reason, "listen");
        trace?.("step", `Call back requested for ${label}`, { label });
        return reply(callBackLine(label), "end");
      }
      case "send": {
        const proposed = cleanMessage(decided.message);
        if (!proposed) return reply(TALK_REPLY_SAYS.unclear, "listen");
        let phrase: string;
        const letter = /^[A-Ha-h]$/.test(proposed) ? proposed.toUpperCase() : null;
        if (letter) {
          const option = call.script?.options.find((o) => o.letter === letter);
          if (!option) return reply(TALK_REPLY_SAYS.unclear, "listen");
          phrase = `option ${letter}: ${clipOption(option.title)}`;
        } else {
          phrase = spokenAnswer(proposed, 400) || spokenAnswer(String(decided.spoken ?? ""), 200);
        }
        if (!phrase) return reply(TALK_REPLY_SAYS.unclear, "listen");
        const callBack = decided.callback === true && Boolean(this.deps.requestCallback);
        call.proposal = { message: letter ?? proposed, at: now, tries: 0, ...(callBack ? { callback: true } : {}) };
        return reply(
          `I'll tell it${letter ? " " : ": "}${phrase.replace(/[.!?]+$/, "")}${callBack ? ", then call you back when it's done" : ""}. Say yes to send.`,
          "confirm",
        );
      }
      default:
        return reply(TALK_REPLY_SAYS.unclear, "listen");
    }
  }
}
