import crypto from "node:crypto";

import type { RtdbRest } from "../remote/rtdb-rest.js";
import type { ReplyFailureHandler, ReplyOutcome } from "../fleet/session-reply.js";
import { logger } from "../utils/logger.js";
import { chunkClips, type Clip } from "./clips.js";
import { ASK_FAILED, inboundPrompts } from "./inbound-flow.js";
import {
  audioDocId,
  audioPath,
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
  sealDirectory,
  sealDown,
  UP_KIND,
  upPath,
  type DirectoryDoc,
  type DirectoryItem,
  type DirectoryWorkspace,
  type DownMessage,
  type UpMessage,
} from "./memo-protocol.js";
import type { Transcriber } from "./transcribe.js";

export type MemoStore = Pick<RtdbRest, "list" | "set" | "delete" | "watch">;

/** A chat that can take a message right now. */
export interface MemoTarget {
  target: string;
  label: string;
  /** The workspace it belongs to (`workspaceKeyOf`), for favourites. */
  workspace: string | null;
  /** The workspace as spoken ("squeak, ushuaia", `spokenWorkspace`); absent: the label stands in. */
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
  lastChat?: { get: () => string | null; set: (target: string) => void };
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
  /** A line for the call trace. */
  trace?: (kind: TraceKind, text: string, extra?: { ms?: number; label?: string }) => void;
  now?: () => number;
}

interface Pending {
  target: string;
  label: string;
  text: string;
  at: number;
}

const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 20;
const KEEP_VERSIONS = 8;
const REPUBLISH_MS = 30 * 60_000;
const REMEMBER = 200;
/** A call out names its chat for this long: longer than any call lasts. */
const CALL_TARGET_TTL_MS = 30 * 60_000;
const READ_BACK_BUDGET_MS = 8_000;
/**
 * An answer or status read out in the Mac's voice: several sentences, about a second each and more when the voice is
 * busy. A budget shorter than that leaves the add-on to say it in its plain voice, the "different voice" heard on a
 * status. The add-on waits for it (uplink.ts), and says "Still working on it" meanwhile.
 */
const ANSWER_AUDIO_BUDGET_MS = 20_000;
/** A phone is not a keyboard: this many sends an hour is a stuck loop, not a person. */
const MAX_SENDS_PER_HOUR = 20;
const MAX_SPOKEN_LABEL = 60;
/** A model answer is worth a minute of a person's time, not more; the add-on waits a little longer than this. */
const ANSWER_BUDGET_MS = 45_000;
/** Questions and status read-outs an hour: a model call each, so a stuck loop is stopped here too. */
const MAX_ANSWERS_PER_HOUR = 40;

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
  private readonly pending = new Map<string, Pending>();
  /** Directory versions the gateway may still be reading from, each as the targets by number. */
  private readonly versions = new Map<string, string[]>();
  /** Calls out that may take a message for, or read the status of, the chat that asked: the call's id is their "version". */
  private readonly calls = new Map<string, { target: string; label: string; at: number }>();
  private published: { version: string; at: number } | null = null;
  /** Audio document ids written for each directory version, so they go when the version does. */
  private readonly audioDocs = new Map<string, string[]>();
  private swept = false;
  private readonly sends: number[] = [];
  private readonly answers: number[] = [];

  constructor(private readonly deps: MemoInboxDependencies) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    this.unwatch = this.deps.store.watch(`channels/${this.deps.channel}/${UP_KIND}`, () => this.wake(), {
      onError: (error) => logger.warn("voice memo stream", { error: error.message }),
    });
    this.timer = setInterval(() => {
      this.wake();
      void this.publish().catch(() => undefined);
    }, 60_000);
    this.timer.unref?.();
    void this.publish().catch(() => undefined);
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
      workspaces = favorites.map((fav) => ({
        n: fav.n,
        label: spokenLabel(fav.label),
        chats: chatsOf(fav.workspace, all),
      }));
      const used = new Set(favorites.map((f) => f.n));
      const grouped = new Set<string>();
      for (const key of autoKeys) {
        let n = 1;
        while (used.has(n)) n++;
        if (n > MAX_WORKSPACES || workspaces.length >= MAX_WORKSPACES) break;
        used.add(n);
        grouped.add(key);
        const first = rest.find((x) => x.workspace === key)!;
        workspaces.push({ n, label: spokenLabel(first.workspaceLabel ?? first.label), chats: chatsOf(key, rest) });
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
    const lastTarget = this.deps.lastChat?.get();
    const lastPick = all.find((t) => t.target === lastTarget) ?? all.find((t) => t.waiting);
    let last: DirectoryDoc["last"];
    if (lastPick) {
      let index = targets.findIndex((t) => t.target === lastPick.target);
      if (index < 0 && targets.length < MAX_CHOICES) {
        targets.push(lastPick);
        index = targets.length - 1;
      }
      if (index >= 0) last = { choice: index + 1, label: lastPick.label };
    }
    const version = crypto
      .createHash("sha256")
      .update(JSON.stringify({ items, workspaces, caller, last, targets: targets.map((t) => t.target) }))
      .digest("hex")
      .slice(0, 12);
    const at = this.now();
    if (this.published?.version === version && at - this.published.at < REPUBLISH_MS) return;
    this.versions.set(
      version,
      targets.map((t) => t.target),
    );
    while (this.versions.size > KEEP_VERSIONS) this.versions.delete(this.versions.keys().next().value as string);
    const doc: DirectoryDoc = {
      v: 1,
      at,
      version,
      caller,
      items,
      ...(workspaces ? { workspaces } : {}),
      ...(last ? { last } : {}),
      ...(this.canAsk ? { ask: true as const } : {}),
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
    const texts = [...new Set([...inboundPrompts(doc, true), ...inboundPrompts(doc, false)])];
    const clips = await this.deps.audioClips!(texts);
    if (clips.length === 0 || this.stopped) return;
    const groups = chunkClips(clips).slice(0, MAX_AUDIO_DOCS);
    const ids: string[] = [];
    for (const [index, group] of groups.entries()) {
      const id = audioDocId(doc.version, index);
      await store.set(audioPath(channel, id), sealAudio(key, id, doc.version, group, this.now()));
      ids.push(id);
    }
    // A newer list came out while this rendered: its own audio follows; this one's documents are cleaned with it.
    this.audioDocs.set(doc.version, ids);
    if (this.published?.version === doc.version) {
      await store.set(dirPath(channel), sealDirectory(key, { ...doc, audio: ids }));
    }
    await this.dropStaleAudio();
    if (this.deps.prepareReadBack && !this.stopped) {
      const labels = [...doc.items, ...(doc.workspaces ?? []).flatMap((w) => w.chats)].map((i) => i.label);
      await this.deps.prepareReadBack(labels, this.canAsk).catch(() => undefined);
    }
  }

  /** Deletes audio documents of directory versions no longer kept (and, once, ones a restart left behind). */
  private async dropStaleAudio(): Promise<void> {
    const { store, channel } = this.deps;
    const keep = new Set<string>();
    for (const version of this.versions.keys()) for (const id of this.audioDocs.get(version) ?? []) keep.add(id);
    for (const [version, ids] of [...this.audioDocs]) {
      if (this.versions.has(version)) continue;
      this.audioDocs.delete(version);
      await Promise.all(ids.map((id) => store.delete(audioPath(channel, id)).catch(() => undefined)));
    }
    if (this.swept) return;
    this.swept = true;
    for (const { id } of await store.list(`channels/${channel}/${DIR_KIND}`)) {
      if (id.startsWith("audio-") && !keep.has(id)) await store.delete(audioPath(channel, id)).catch(() => undefined);
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
    for (const { id, doc } of await store.list(`channels/${channel}/${UP_KIND}`)) {
      if (this.stopped) return;
      if (this.handled.includes(id)) {
        await store.delete(upPath(channel, id)).catch(() => undefined);
        continue;
      }
      const read = readUp(key, id, doc, this.now());
      // Remember first, then claim: a second pass must see it as taken, and an undeletable one is not run twice.
      this.handled.push(id);
      if (this.handled.length > REMEMBER) this.handled.shift();
      try {
        await store.delete(upPath(channel, id));
      } catch {
        this.handled.splice(this.handled.indexOf(id), 1);
        continue;
      }
      if (!read.ok) {
        logger.info("voice memo dropped", { reason: read.reason });
        continue;
      }
      const answer = await this.handle(read.message).catch((error: unknown): DownMessage => {
        logger.warn("voice memo failed", { error: error instanceof Error ? error.message : String(error) });
        return { v: 1, id, at: this.now(), status: "refused", reason: "Something went wrong on the Mac." };
      });
      await store.set(downPath(channel, id), sealDown(key, answer));
    }
  }

  /** The read-back in the Mac's voice, within a short budget: a slow render must not hold up the phone line. */
  private get canAsk(): boolean {
    return Boolean(this.deps.describe && this.deps.answer);
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
  registerCall(callId: string, target: string, label: string): void {
    const now = this.now();
    for (const [id, call] of this.calls) if (now - call.at > CALL_TARGET_TTL_MS) this.calls.delete(id);
    this.calls.set(callId, { target, label, at: now });
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
  private async answerAudio(text: string): Promise<Clip | undefined> {
    if (!this.deps.speech) return undefined;
    try {
      return await Promise.race([
        this.deps.speech(text),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ANSWER_AUDIO_BUDGET_MS).unref()),
      ]);
    } catch {
      return undefined;
    }
  }

  /**
   * A question about a chat, or where it stands, answered aloud. Read-only by construction: nothing here reaches
   * `send`, `canSend` or any writer, so a question can never become a message to an agent or change a chat.
   */
  private async handleAnswer(message: Extract<UpMessage, { kind: "ask" | "status" }>): Promise<DownMessage> {
    const { describe, answer, trace } = this.deps;
    if (!describe || !answer) return this.refuse(message.id, "Your Mac cannot answer questions yet.");
    const now = this.now();
    while (this.answers.length > 0 && now - this.answers[0]! > 60 * 60_000) this.answers.shift();
    if (this.answers.length >= MAX_ANSWERS_PER_HOUR)
      return this.refuse(message.id, "Too many questions by phone this hour.");
    let target: string;
    let label: string;
    let question = "";
    if (message.kind === "status") {
      const found = this.targetsOf(message.dirVersion)?.[message.choice - 1];
      if (!found) return this.refuse(message.id, "That list is out of date. Call again.");
      target = found;
      label = this.labelOf(message.dirVersion, found, message.choice);
    } else {
      // Not deleted: the same recording may be sent after it was asked about, or asked again.
      const pending = this.pending.get(message.memoId);
      if (!pending) return this.refuse(message.id, "That recording is no longer waiting. Record it again.");
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
        if (!read) return this.refuse(message.id, `I could not find ${label} any more.`);
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
    const spoken = await this.answerAudio(text);
    return { v: 1, id: message.id, at: this.now(), status: "answer", text, ...(spoken ? { audio: spoken } : {}) };
  }

  private async handle(message: UpMessage): Promise<DownMessage> {
    const now = this.now();
    for (const [memoId, pending] of this.pending) if (now - pending.at > PENDING_TTL_MS) this.pending.delete(memoId);

    if (message.kind === "memo") {
      const targets = this.targetsOf(message.dirVersion);
      const target = targets?.[message.choice - 1];
      if (!target) return this.refuse(message.id, "That list is out of date. Call again.");
      const label = this.labelOf(message.dirVersion, target, message.choice);
      const { trace } = this.deps;
      const audio = Buffer.from(message.audio, "base64");
      trace?.("step", `Recording received (${Math.max(1, Math.round(audio.length / 1024))} KB)`, { label });
      let text: string;
      const began = Date.now();
      try {
        text = await this.deps.transcriber.transcribe(audio);
      } catch (error) {
        logger.warn("voice memo could not be transcribed", {
          error: error instanceof Error ? error.message : String(error),
        });
        trace?.("warn", "Could not transcribe the recording", { label });
        return this.refuse(message.id, "I could not make that out.");
      }
      if (!text) {
        trace?.("warn", "Nothing was heard in the recording", { label });
        return this.refuse(message.id, "I did not hear anything.");
      }
      const transcribedMs = Date.now() - began;
      // The Mac's voice starts on the words as soon as they are known; the trace lines are written meanwhile.
      const spokenPromise = this.readBackAudio(text, label);
      trace?.("heard", text, { ms: transcribedMs, label });
      trace?.("step", `Transcribed in ${(transcribedMs / 1000).toFixed(1)} s`, { ms: transcribedMs, label });
      trace?.("said", text, { label });
      this.pending.set(message.id, { target, label, text, at: this.now() });
      while (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value as string);
      const spoken = await spokenPromise;
      const renderMs = Date.now() - began - transcribedMs;
      if (this.deps.readBack)
        trace?.(
          spoken ? "step" : "warn",
          spoken
            ? `Read-back voice rendered in ${(renderMs / 1000).toFixed(1)} s`
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
      };
    }

    if (message.kind === "status" || message.kind === "ask") return this.handleAnswer(message);

    const pending = this.pending.get(message.memoId);
    if (!pending) return this.refuse(message.id, "That message is no longer waiting.");
    this.pending.delete(message.memoId);
    while (this.sends.length > 0 && now - this.sends[0]! > 60 * 60_000) this.sends.shift();
    if (this.sends.length >= MAX_SENDS_PER_HOUR)
      return this.refuse(message.id, "Too many messages by phone this hour.");
    if (!this.deps.canSend(pending.target)) {
      this.deps.trace?.("warn", `${pending.label} is busy, nothing sent`, { label: pending.label });
      return this.refuse(message.id, `${pending.label} is busy right now. Send it from the app.`);
    }
    this.sends.push(now);
    this.rememberLast(pending.target);
    const outcome = await this.deps.send(pending.target, pending.text, (reason) => {
      this.deps.note(`The message you phoned in for ${pending.label} did not go through: ${reason}`);
    });
    if (outcome.status === "refused" || outcome.status === "unconfirmed") {
      this.deps.trace?.("warn", outcome.reason.slice(0, 200), { label: pending.label });
      return this.refuse(message.id, outcome.reason.slice(0, 200));
    }
    this.deps.trace?.("step", `Sent to ${pending.label}`, { label: pending.label });
    const shown = pending.text.length > 200 ? `${pending.text.slice(0, 200)}…` : pending.text;
    this.deps.note(`Sent by phone to ${pending.label}: “${shown}”`);
    return { v: 1, id: message.id, at: this.now(), status: "sent" };
  }
}
