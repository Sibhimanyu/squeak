import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { flag } from "../squeak/flags.js";
import { logger } from "../utils/logger.js";
import { defaultTitleCall, TITLE_TIMEOUT_MS, type TitleModelCall } from "./auto-title.js";
import { Decider, haikuDecider, type DeciderDuck, type DeciderModelPort, type ScoredDuck } from "./decider.js";
import {
  duckMentionTokens,
  mentionedToken,
  mentions,
  projectOfSession,
  type HostEvents,
  type Room,
  type RoomThread,
} from "./room.js";
import { DEFAULT_MAX_WORKING_DUCKS } from "./project-settings.js";
import { AttachmentError, stripAttachmentLines } from "./room-attachments.js";
import { FINISH_ID_PREFIX, writeFinish, type FinishWriterPort } from "./room-finish.js";
import { firstSentence, oneLine, type TurnBase } from "./room-turns.js";
import type { HostEvent } from "./host.js";
import type { DuckRow, NativeStore, RoomPostRow } from "./store.js";
import type { SessionRow } from "./types.js";

/**
 * Room Tasks: a person's message that asks for work becomes a Task Squeak routes to a Duck. Squeak never chats (its
 * only words are action and status lines) and never takes or starts anything without the person's Go / Allow.
 * Matching is rules first (word overlap with the pond's recent threads); the only model call is the yes/no check.
 */

/** A Task's state: waiting (not taken up yet), working (a Duck has it), blocked (its turn did not finish), done, dropped. */
export type TaskState = "waiting" | "working" | "blocked" | "done" | "dropped";

/** The Room discussion a Task carries is never older than this before the message that made it. */
export const TASK_DISCUSSION_WINDOW_MS = 2 * 3_600_000;
const DISCUSSION_MAX_MESSAGES = 60;

/** One Room message a Task carries. */
export interface TaskDiscussionMessage {
  id: string;
  author: string;
  authorKind: "person" | "agent";
  text: string;
  at: number;
}

/** Where a job runs: an existing stream, or a new stream (a worktree off the default branch) on this branch. */
export type TaskPlace = { kind: "stream"; workspaceId: string; branch: string } | { kind: "new"; branch: string };

/**
 * The Task as the Room feed serves it: one live item per Task (its `id` never changes; it updates in place as the state
 * moves waiting, working, blocked or done). `owner` is the Duck that holds it; `open` is the Duck's chat and turn to open
 * (the turn's `RoomTurn.id` is `${sessionId}:${turnId}`), present once the Duck has started the turn.
 */
export interface RoomTaskItem extends RoomTask {
  owner?: { duckId?: string; name: string; sessionId: string };
  open?: { sessionId: string; turnId?: string };
}

export interface TaskThreadRef {
  /** The duck (a pond-level identity); `sessionId` is its current chat, empty when it has not worked yet. */
  duckId?: string;
  name?: string;
  sessionId: string;
  title: string;
  reason: string;
  /** The reason in the first person, for the duck to say "I <pitch>": "worked on the control bar an hour ago". */
  pitch: string;
  state: "working" | "idle";
}

/** What the decider chose when the Task was made (or the person chose after): shown as the Room's one routing line. */
export interface TaskRouting {
  kind: "duck" | "hatch" | "wait";
  duckId?: string;
  name?: string;
  /** "related to icon work": the words in the line. Never part of any Duck's prompt. */
  reason: string;
  by: "decider" | "person";
  at: number;
}

export interface RoomTask {
  id: string;
  /** The Room message that made this Task. */
  messageId: string;
  text: string;
  /** One line: the Task's first clause. */
  title: string;
  state: TaskState;
  /** Only suggested by the check so far: the person has not taken it up, and it does not cut the discussion. */
  proposed?: boolean;
  parentTaskId?: string;
  /** The Room messages since the previous Task (at most 2 h), as the person trimmed them. */
  discussion: TaskDiscussionMessage[];
  /** How it ended: the Duck's first sentence. */
  result?: string;
  /**
   * On done: the Duck's own Room message for the Task (what it did, found and needs), else the one Squeak wrote for it
   * from the turn's result. Fills in place, so the feed's Task item never changes id.
   */
  summary?: string;
  suggestion?: TaskThreadRef;
  candidates?: TaskThreadRef[];
  routing?: TaskRouting;
  /** Chosen by the host when the job is made; the person can override it on Go. Absent in a plain-folder pond. */
  place?: TaskPlace;
  /** Squeak starts this Task itself, in order, once a Duck is free: set when it is made with a destination. */
  inLine?: true;
  /**
   * A Member made it and may not start things (the `start` permission is off): it waits for the Owner's approval
   * (`approve`, Go, New or Allow from the Owner's Room) and is never started or offered to a Duck before that.
   */
  approval?: { by: string; name: string };
  claim?: {
    sessionId: string;
    duckId?: string;
    title: string;
    eta?: string;
    at: number;
    status: "asking" | "allowed" | "denied";
  };
  handedTo?: { sessionId: string; duckId?: string; title: string; turnId?: string; newThread: boolean };
  createdAt: number;
  updatedAt: number;
}

/** Who made a Task from a Member's words, and whether they may start things. */
export interface TaskOrigin {
  memberId: string;
  name: string;
  canStart: boolean;
}

export class TaskError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const JOB_CHECK_PER_HOUR = 30;
export const JOB_CLAIMS_PER_HOUR = 10;
export const JOB_MATCH_WINDOW_MS = 7 * 24 * 3_600_000;
export const JOB_LISTED_MS = 24 * 3_600_000;
/**
 * A working Task whose handed turn never shows up (the message was steered into another turn, the host restarted and
 * dropped the queued send, the turn was interrupted before it was recorded) is not working once its chat is idle this
 * long. Without it the Task, and the Room's working glyph, stayed on for good.
 */
export const TASK_UNBOUND_MS = 120_000;
const TASK_BUSY_STATUS = new Set(["working", "stopping", "awaiting_approval", "awaiting_plan", "awaiting_answer"]);
/** A thread must score at least this (a title word is 3, an intent word 2, a past-turn word 1.5) to be suggested. */
export const JOB_MIN_SCORE = 3;
const MIN_WORDS = 3;

export const JOB_CHECK_SYSTEM = [
  "You read one message from a team room where people and coding agents work on an app's code.",
  'Reply with strict JSON only: {"job": boolean, "text": string}.',
  "job is true only when the message asks for work to be done on the code or the app (a change, a fix, a feature, a check to run).",
  "Chat, greetings, thanks, opinions, status talk and questions answered by reading or explaining are not jobs.",
  "text is the job as one short paragraph in the person's own words, or an empty string when job is false.",
].join(" ");

const IMPERATIVE = new Set(
  "fix add make build change update remove rename refactor implement create write delete move set show hide use run test ship deploy merge revert bump check clean drop wire hook split extract replace tweak polish improve review document open close install upgrade move".split(
    " ",
  ),
);

const STOP = new Set(
  "the and for with that this from into have has not but are was were you your can could would should please just then them they there their what when where which will its our out all any new use using about also more some like need want make let get got one two".split(
    " ",
  ),
);

/** Lowercase words of 3+ letters, plural "s" dropped, no stop words. */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? []) {
    let w = raw.replace(/'s$/, "");
    if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    if (w.length >= 3 && !STOP.has(w)) out.add(w);
  }
  return out;
}

/** `text` without the `@Name` mention (and the run of spaces it leaves). */
export function stripMention(text: string, name: string): string {
  const escaped = name
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return text
    .replace(new RegExp(`(^|[^\\w@])@${escaped}(?![\\w])[,:]?`, "gi"), "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function looksImperative(text: string): boolean {
  const first = text
    .trim()
    .toLowerCase()
    .match(/[a-z]+/)?.[0];
  return !!first && IMPERATIVE.has(first);
}

/** The model's answer to the check, or null when it is not the strict shape. */
export function parseJobCheck(raw: string): { job: boolean; text: string } | null {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]) as unknown;
    if (typeof v !== "object" || v === null) return null;
    const o = v as { job?: unknown; text?: unknown };
    if (typeof o.job !== "boolean") return null;
    return { job: o.job, text: typeof o.text === "string" ? o.text : "" };
  } catch {
    return null;
  }
}

export function ago(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 12) return `${h} h ago`;
  if (h < 36) return "today";
  const d = Math.round(h / 24);
  return d <= 1 ? "yesterday" : `${d} days ago`;
}

interface Scored {
  duck: DuckRow;
  session: SessionRow | null;
  state: RoomThread["state"];
  score: number;
  reason: string;
  pitch: string;
}

export interface StartSpec {
  projectId: string;
  duck: DuckRow;
  place?: TaskPlace;
  text: string;
  title: string;
  /** The lines for the job's message's attachments, written under the session's folder once that is known. */
  attach?: (cwd: string) => string;
}

/** How a Pond starts routed Tasks (its settings). */
export interface StartRules {
  askBeforeStarting: boolean;
  maxWorkingDucks: number;
}

/** A stream's recent turns must match the job this strongly (a title word is 3, a turn word 1.5) to continue there. */
export const JOB_CONTINUE_SCORE = 4.5;

export interface RoomTasksOptions {
  store: NativeStore;
  room: Room;
  /** A new turn for an existing chat, from the person (queued if busy). */
  send: (sessionId: string, text: string) => Promise<unknown>;
  /** A new thread in the pond with `text`, run by the owner's defaults (used when `start` is absent). */
  newThread: (projectId: string, text: string, title: string, attach?: (cwd: string) => string) => Promise<SessionRow>;
  /** Starts a fresh session for `duck` in `place` (creating the stream when it is new) with its identity. */
  start?: (spec: StartSpec) => Promise<SessionRow>;
  /** A free, valid branch name for a new stream slugged from the job text; null when the pond has no streams. */
  newBranch?: (projectId: string, text: string) => string | null;
  /** The typed branch as git accepts it for a new stream, or a TaskError saying why not. */
  checkBranch?: (projectId: string, branch: string) => string;
  /** The Pond's start rules; absent means the defaults (start at once, 4 working Ducks). */
  settings?: (projectId: string) => StartRules;
  /**
   * The Pond's Notebook as text for a Duck's briefing (`PondNotebook.forBriefing`); absent or empty: the briefing
   * has no Notebook section.
   */
  notebook?: (projectId: string) => string | null | undefined;
  call?: TitleModelCall;
  /** A Task just finished in this chat (once per finish): the host looks at the chat's title again. */
  onTaskDone?: (sessionId: string) => void;
  /** The decider that routes a new Task; default: local similarity plus `deciderModel`. */
  decider?: Decider;
  /** Settles an unsure routing: a port, or "haiku" (the same small-model call as the job check); absent = never asked. */
  deciderModel?: DeciderModelPort | "haiku";
  /** How full a chat's context is, 0..100 (the host's context meter); null/absent = unknown. */
  contextPercent?: (session: SessionRow) => number | null;
  /** Defaults to the SQUEAK_ROOM_JOBS switch. */
  enabled?: () => boolean;
  now?: () => number;
  timeoutMs?: number;
  /** Runs `fn` after `ms` (default: an unref'd timer); tests inject a manual clock. */
  schedule?: (fn: () => void, ms: number) => void;
  /** Waits before each retry of a start that failed for a transient reason; its length is the attempt cap. */
  retryDelaysMs?: number[];
  /**
   * Writers of the Room message for a Task whose Duck finished without posting one (the on-device model, then Haiku).
   * Absent: no message is written (the Task still shows the Duck's first sentence).
   */
  finishWriters?: FinishWriterPort[];
  finishTimeoutMs?: number;
}

/** Why a start can work a moment later: the Task or its Duck was momentarily taken. */
const isTransientStart = (error: unknown): boolean =>
  error instanceof TaskError && /being handed over|busy in another stream/.test(error.message);

const DEFAULT_RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

/** Emits `job` `{ projectId, job }` for every create or change. */
export class RoomTasks extends EventEmitter {
  private readonly now: () => number;
  private readonly checks = new Map<string, number[]>();
  private readonly claims = new Map<string, number[]>();
  private readonly busy = new Set<string>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly lining = new Set<string>();
  private readonly lineAgain = new Set<string>();
  /** Start retries so far per Task, and the Tasks with a retry already scheduled. */
  private readonly retries = new Map<string, number>();
  private readonly retryPending = new Set<string>();
  /** Tasks whose routing is still being decided; an action on one waits for it. */
  private readonly routings = new Map<string, Promise<void>>();
  private readonly decider: Decider;
  private call: TitleModelCall | null;
  /** Members' posts being applied right now (post id to who): a Task made from one waits for approval unless they may start. */
  private readonly memberPosts = new Map<string, TaskOrigin>();

  constructor(private readonly o: RoomTasksOptions) {
    super();
    this.setMaxListeners(0);
    this.now = o.now ?? Date.now;
    this.call = o.call ?? null;
    const dm = o.deciderModel;
    this.decider =
      o.decider ??
      new Decider({
        model: dm === "haiku" ? haikuDecider(() => (this.call ??= defaultTitleCall())) : (dm ?? null),
        onModelError: (error) => logger.warn("decider model failed", { error: String(error) }),
      });
  }

  // ---- reading ----

  /** Open Tasks (waiting, working, blocked) plus those updated in the last 24 h, oldest first (newest last). */
  list(projectId: string): RoomTaskItem[] {
    const cutoff = this.now() - JOB_LISTED_MS;
    return this.o.store
      .roomJobRows(projectId)
      .map((r) => JSON.parse(r.data) as RoomTask)
      .filter((j) => j.state === "waiting" || j.state === "working" || j.state === "blocked" || j.updatedAt >= cutoff)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .slice(-50)
      .map((j) => this.item(j.state === "working" ? this.reconcileJob(projectId, j) : j));
  }

  /** The feed item of a Task: the Task, its owner Duck by its current name, where to open it, and on done its summary. */
  item(job: RoomTask): RoomTaskItem {
    const to = job.handedTo;
    if (!to) return job;
    const name = (
      to.duckId ? this.o.store.duckRow(to.duckId)?.name : this.o.store.duckBySession(to.sessionId)?.name
    )?.trim();
    const bare = to.turnId?.startsWith(`${to.sessionId}:`) ? to.turnId.slice(to.sessionId.length + 1) : to.turnId;
    return {
      ...job,
      ...(job.state === "done" && !job.summary && job.result ? { summary: job.result } : {}),
      owner: { ...(to.duckId ? { duckId: to.duckId } : {}), name: name || to.title, sessionId: to.sessionId },
      open: { sessionId: to.sessionId, ...(bare ? { turnId: bare } : {}) },
    };
  }

  /** Ducks holding an open Task (waiting on them or being worked): never put off duty for being quiet. */
  busyDuckIds(): Set<string> {
    const out = new Set<string>();
    for (const p of this.o.store.listProjects()) {
      for (const t of this.list(p.id)) {
        if ((t.state === "working" || t.state === "waiting") && t.handedTo?.duckId) out.add(t.handedTo.duckId);
        if (t.state === "waiting" && t.routing?.kind === "duck" && t.routing.duckId) out.add(t.routing.duckId);
      }
    }
    return out;
  }

  get(id: string): { job: RoomTask; projectId: string } | null {
    const r = this.o.store.roomJobRow(id);
    return r ? { job: JSON.parse(r.data) as RoomTask, projectId: r.projectId } : null;
  }

  private save(projectId: string, job: RoomTask): RoomTask {
    job.updatedAt = Math.max(this.now(), job.updatedAt);
    this.o.store.saveRoomTask({
      id: job.id,
      projectId,
      messageId: job.messageId,
      data: JSON.stringify(job),
      updatedAt: job.updatedAt,
    });
    this.emit("job", { projectId, job: this.item(job) });
    return job;
  }

  // ---- making jobs ----

  /** Watches the room: every person message gets the background check. Returns the detach. */
  attach(host: HostEvents): () => void {
    const onPost = (p: RoomPostRow): void => {
      if (p.authorKind !== "person" || p.kind !== "message" || p.level !== "room") return;
      // "make it a task" is rules, not a model: it works with the check switched off.
      if (this.fromMention(p)) return;
      if (asksForTask(p.text)) this.fromPhrase(p);
      else this.check(p);
    };
    const onEvent = (e: HostEvent): void => {
      try {
        if (e.type === "timeline" && ["turn.started", "reply.done", "turn.ended"].includes(e.event.type)) {
          this.reconcileSession(e.sessionId);
          if (e.event.type === "turn.ended") {
            this.settleRoomTurn(e.sessionId, e.event.turnId);
            this.startWaiting();
          }
        }
      } catch (error) {
        logger.warn("room job watcher failed", { error: String(error) });
      }
    };
    this.o.room.on("post", onPost);
    host.on("event", onEvent);
    return () => {
      this.o.room.off("post", onPost);
      host.off("event", onEvent);
    };
  }

  /** Resolves when the background checks so far are done (tests). */
  idle(): Promise<void> {
    return Promise.all([...this.inflight]).then(() => undefined);
  }

  /** The background check for a person's post; never throws, never blocks the post. */
  check(post: RoomPostRow): void {
    if (!(this.o.enabled ?? (() => flag("roomJobs")))()) return;
    const text = post.text.trim();
    if (wordCount(text) < MIN_WORDS && !looksImperative(text)) return;
    if (this.o.store.roomJobRowByMessage(post.id)) return;
    const hour = this.now() - 3_600_000;
    const recent = (this.checks.get(post.projectId) ?? []).filter((t) => t > hour);
    this.checks.set(post.projectId, recent);
    if (recent.length >= JOB_CHECK_PER_HOUR) return;
    recent.push(this.now());
    const run = this.runCheck(post)
      .catch((error) => logger.warn("room job check failed", { error: String(error) }))
      .finally(() => this.inflight.delete(run));
    this.inflight.add(run);
  }

  /** "(+2 images, 1 file)": the check hears that something was attached, never what it is. */
  private attachmentNote(postId: string): string {
    const { images, files } = this.o.room.attachments.counts(postId);
    const parts = [
      images ? `${images} image${images === 1 ? "" : "s"}` : "",
      files ? `${files} file${files === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    return parts.length ? `\n(+${parts.join(", ")})` : "";
  }

  private async runCheck(post: RoomPostRow): Promise<void> {
    const call = (this.call ??= defaultTitleCall());
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.o.timeoutMs ?? TITLE_TIMEOUT_MS);
    let answer: { job: boolean; text: string } | null;
    try {
      const timedOut = new Promise<never>((_, reject) =>
        abort.signal.addEventListener("abort", () => reject(new Error("job check timed out")), { once: true }),
      );
      const raw = await Promise.race([
        call({
          prompt: `Message:\n${post.text.slice(0, 1500)}${this.attachmentNote(post.id)}\n\nJSON:`,
          system: JOB_CHECK_SYSTEM,
          signal: abort.signal,
        }),
        timedOut,
      ]);
      answer = parseJobCheck(raw);
    } catch {
      answer = null;
    } finally {
      clearTimeout(timer);
    }
    if (!answer?.job) return;
    // The person may have made it a job by hand while the call ran.
    if (this.o.store.roomJobRowByMessage(post.id)) return;
    this.create(post.projectId, post.id, answer.text.trim() || post.text, { proposed: true });
  }

  /**
   * A person's message that @mentions a Duck and asks it for work ("@Pixel fix the login") is a Task for that Duck at
   * once, no decider. A bare ping ("@Pixel thanks") and a name that is no Duck's stay ordinary chat. True when handled.
   */
  private fromMention(post: RoomPostRow): boolean {
    try {
      const duck = this.mentionedDuck(post.projectId, post.text);
      if (!duck) return false;
      const token = mentionedToken(
        post.text,
        duckMentionTokens(duck, this.o.store.getSession(duck.currentSessionId ?? "")?.title),
      );
      const rest = stripMention(post.text, token ?? duck.name ?? "");
      if (wordCount(rest) < MIN_WORDS && !looksImperative(rest)) return false;
      // A question to a Duck ("are you done?") is a nudge it answers in the Room, not work to track.
      if (/\?\s*$/.test(rest.trim()) && !looksImperative(rest)) return false;
      if (this.o.store.roomJobRowByMessage(post.id)) return true;
      this.handOff(post.projectId, post.id, duck.id, { text: rest, reason: "you @mentioned it" });
      return true;
    } catch (error) {
      logger.warn("@mention hand-off failed", { error: String(error) });
      return false;
    }
  }

  /** The Duck of the pond @mentioned in `text`; the longest matching name wins ("@Pip Squeak" is not "Pip"). */
  mentionedDuck(projectId: string, text: string): DuckRow | null {
    let best: DuckRow | null = null;
    let bestLen = 0;
    for (const d of this.o.store.listDucks(projectId)) {
      const sid = d.currentSessionId;
      const token = mentionedToken(text, duckMentionTokens(d, sid ? this.o.store.getSession(sid)?.title : null));
      if (token && token.length > bestLen) {
        best = d;
        bestLen = token.length;
      }
    }
    return best;
  }

  /**
   * A Task given straight to `duckId` (an @mention by a person or a Duck): routed to it with no decider run, and, like
   * any routed Task, started in the line unless the Pond asks first. A Duck's hand-off passes its own Task as parent.
   */
  handOff(
    projectId: string,
    messageId: string,
    duckId: string,
    o: { text?: string; parentTaskId?: string; reason?: string } = {},
  ): RoomTask {
    const post = this.o.store.roomPostById(messageId);
    if (!post || post.projectId !== projectId || post.kind !== "message") {
      throw new TaskError("That isn't a message in this pond's room.", 404);
    }
    if (this.o.store.roomJobRowByMessage(messageId)) throw new TaskError("That message is already a task.", 409);
    const duck = this.o.store.duckRow(duckId);
    if (!duck || duck.projectId !== projectId) throw new TaskError("That duck isn't in this pond.", 409);
    if (o.parentTaskId) {
      const parent = this.get(o.parentTaskId);
      if (!parent || parent.projectId !== projectId) throw new TaskError("That parent Task isn't in this pond.", 404);
    }
    return this.create(projectId, messageId, o.text ?? post.text, {
      ...(o.parentTaskId ? { parentTaskId: o.parentTaskId } : {}),
      direct: { duckId, reason: o.reason ?? "it was @mentioned" },
    });
  }

  /** The Task `sessionId`'s chat is working on now (the parent of what that Duck hands on). */
  currentFor(sessionId: string): RoomTask | null {
    return this.activeFor(sessionId)[0]?.[1] ?? null;
  }

  /** The person said "make it a task": a Task from the discussion, never throwing into the post. */
  private fromPhrase(post: RoomPostRow): void {
    try {
      this.fromMessage(post.projectId, post.id);
    } catch (error) {
      logger.warn("make it a task failed", { error: String(error) });
    }
  }

  /**
   * A Task from a message: the person's phrase, the Make task action, or taking up a suggestion (skips the check).
   * A suggestion for the message becomes a plain Task; a dropped one is made again.
   */
  fromMessage(projectId: string, messageId: unknown, parentTaskId?: unknown, origin?: TaskOrigin): RoomTask {
    if (typeof messageId !== "string" || !messageId) throw new TaskError("messageId is required.", 400);
    const post = this.o.store.roomPostById(messageId);
    if (!post || post.projectId !== projectId || post.kind !== "message") {
      throw new TaskError("That isn't a message in this pond's room.", 404);
    }
    if (parentTaskId !== undefined && (typeof parentTaskId !== "string" || !parentTaskId)) {
      throw new TaskError("parentTaskId must be a Task id.", 400);
    }
    if (typeof parentTaskId === "string") {
      const parent = this.get(parentTaskId);
      if (!parent || parent.projectId !== projectId) throw new TaskError("That parent Task isn't in this pond.", 404);
    }
    const existing = this.o.store.roomJobRowByMessage(messageId);
    if (existing) {
      const task = JSON.parse(existing.data) as RoomTask;
      if (task.state === "dropped") {
        return this.create(projectId, messageId, task.text, {
          reopen: task,
          ...(origin ? { origin } : {}),
          ...(typeof parentTaskId === "string"
            ? { parentTaskId }
            : task.parentTaskId
              ? { parentTaskId: task.parentTaskId }
              : {}),
        });
      }
      if (task.proposed) {
        delete task.proposed;
        if (typeof parentTaskId === "string") task.parentTaskId = parentTaskId;
        this.gate(task, origin);
        this.save(projectId, task);
        this.route(projectId, task.id, true, !task.approval && !this.rules(projectId).askBeforeStarting);
        return task;
      }
      throw new TaskError("That message is already a task.", 409);
    }
    return this.create(projectId, messageId, post.text, {
      ...(typeof parentTaskId === "string" ? { parentTaskId } : {}),
      ...(origin ? { origin } : {}),
    });
  }

  /**
   * Runs `fn` (a Member's post being applied) so that a Task it makes by phrase knows who asked. Taking a Task up for the Owner
   * (the Owner's own Make task, Go or New) is approval by itself and never comes through here.
   */
  withMemberPost<T>(postId: string, origin: TaskOrigin, fn: () => T): T {
    this.memberPosts.set(postId, origin);
    try {
      return fn();
    } finally {
      this.memberPosts.delete(postId);
    }
  }

  /** A Task a Member made without the start permission waits for the Owner: no line, no Duck, until approved. */
  private gate(task: RoomTask, origin: TaskOrigin | undefined): void {
    if (origin && !origin.canStart) {
      task.approval = { by: origin.memberId.slice(0, 80), name: origin.name.slice(0, 100) };
      delete task.inLine;
    } else delete task.approval;
  }

  private create(
    projectId: string,
    messageId: string,
    rawText: string,
    o: {
      reopen?: RoomTask;
      proposed?: boolean;
      parentTaskId?: string;
      /** Routed straight to this Duck (an @mention): the decider does not run. */
      direct?: { duckId: string; reason: string };
      origin?: TaskOrigin;
    } = {},
  ): RoomTask {
    const post = this.o.store.roomPostById(messageId);
    const discussion = post ? this.discussionFor(projectId, post, o.reopen?.id) : [];
    let text = rawText.replace(/\s+/g, " ").trim().slice(0, 500);
    // "make it a task" alone says nothing: the work is what was being discussed.
    if (post && asksForTask(text) && !stripTaskPhrase(text)) {
      text = [...discussion].reverse().find((m) => m.id !== messageId && m.authorKind === "person")?.text ?? "";
      text = text.replace(/\s+/g, " ").trim().slice(0, 500);
    } else if (post && asksForTask(text)) {
      text = stripTaskPhrase(text);
    }
    // A message that is only pictures or files still says what to do.
    if (!text) {
      const c = this.o.room.attachments.counts(messageId);
      if (c.images + c.files > 0) text = c.files > 0 ? "See the attached files." : "See the attached images.";
    }
    if (!text) text = "See the discussion in the room.";
    // Tasks line up by creation time, so two made in the same millisecond must not tie (the line starts them in order).
    const newest = this.o.store
      .roomJobRows(projectId)
      .reduce((m, r) => Math.max(m, (JSON.parse(r.data) as RoomTask).createdAt), 0);
    const at = Math.max(this.now(), newest + 1);
    const task: RoomTask = {
      id: o.reopen?.id ?? `task:${randomUUID()}`,
      messageId,
      text,
      title: taskTitle(text),
      state: "waiting",
      ...(o.proposed ? { proposed: true } : {}),
      ...(o.parentTaskId ? { parentTaskId: o.parentTaskId } : {}),
      discussion,
      createdAt: o.reopen?.createdAt ?? at,
      updatedAt: at,
    };
    if (!o.proposed) this.gate(task, o.origin ?? this.memberPosts.get(messageId));
    this.save(projectId, task);
    // A Member's Task without the start permission is routed (so the Owner sees where it would go) but does not start;
    // an @mention still names its Duck (reroute starts nothing while the approval is pending).
    if (o.direct) return this.reroute(projectId, task, o.direct.duckId, o.direct.reason);
    this.route(projectId, task.id, !o.proposed, !o.proposed && !task.approval);
    return task;
  }

  // ---- starting at once, with limits ----

  private rules(projectId: string): StartRules {
    return this.o.settings?.(projectId) ?? { askBeforeStarting: false, maxWorkingDucks: DEFAULT_MAX_WORKING_DUCKS };
  }

  /**
   * THE START SEAM. A Task has a destination when the router (routeFor today, a decider later) named a Duck for it.
   * Anything that sets `suggestion` before this point plugs in; the person's own Go/New never reaches here.
   */
  private hasDestination(task: RoomTask): boolean {
    if (task.routing?.kind === "hatch" && !task.suggestion) return true;
    return !!task.suggestion?.duckId && !!this.o.store.duckRow(task.suggestion.duckId);
  }

  /** The Ducks working in a pond: a running chat, or a Task handed to it that has not ended. */
  private workingDucks(projectId: string): Set<string> {
    const out = new Set<string>();
    for (const d of this.o.store.listDucks(projectId)) {
      if (this.o.room.duckView(d).state === "working") out.add(d.id);
    }
    for (const r of this.o.store.roomJobRows(projectId)) {
      const t = JSON.parse(r.data) as RoomTask;
      if (t.state === "working" && t.handedTo?.duckId) out.add(t.handedTo.duckId);
    }
    return out;
  }

  /** Starts what can start (in the background, never throwing into the caller). */
  private startSoon(projectId: string): void {
    const run = this.startLine(projectId)
      .catch((error) => logger.warn("starting waiting tasks failed", { error: String(error) }))
      .finally(() => this.inflight.delete(run));
    this.inflight.add(run);
  }

  /** A Duck finished, a setting changed or a Task was dropped: whoever is waiting in line may start now. */
  startWaiting(projectId?: string): void {
    for (const p of projectId ? [projectId] : this.o.store.listProjects().map((x) => x.id)) {
      if (this.o.store.roomJobRows(p).some((r) => (JSON.parse(r.data) as RoomTask).inLine)) this.startSoon(p);
    }
  }

  /**
   * Waiting Tasks that Squeak starts itself, oldest first. One that goes to a busy Duck queues behind that Duck's work
   * and takes no slot; one that needs an idle Duck waits while the pond is at its limit, and nobody jumps the line.
   */
  private async startLine(projectId: string): Promise<void> {
    if (this.lining.has(projectId)) {
      this.lineAgain.add(projectId);
      return;
    }
    this.lining.add(projectId);
    try {
      do {
        this.lineAgain.delete(projectId);
        await this.startLineOnce(projectId);
      } while (this.lineAgain.has(projectId));
    } finally {
      this.lining.delete(projectId);
    }
  }

  private async startLineOnce(projectId: string): Promise<void> {
    const rules = this.rules(projectId);
    if (rules.askBeforeStarting) return;
    const line = this.o.store
      .roomJobRows(projectId)
      .map((r) => JSON.parse(r.data) as RoomTask)
      .filter((t) => t.inLine && t.state === "waiting" && !t.proposed && t.claim?.status !== "asking")
      .sort((a, b) => a.createdAt - b.createdAt);
    // Once a Task that needs a slot is stuck, later slot-takers wait behind it; Tasks that only queue still pass.
    let slotsFull = false;
    for (const t of line) {
      const duck = t.suggestion?.duckId ? this.o.store.duckRow(t.suggestion.duckId) : null;
      if (!duck) {
        // The decider chose a new Duck: it hatches (through ChatStarter) once the pond has a free slot.
        if (t.routing?.kind !== "hatch") continue;
        if (slotsFull || this.workingDucks(projectId).size >= rules.maxWorkingDucks) {
          slotsFull = true;
          continue;
        }
        await this.startFromLine(projectId, t.id, { action: "new" }, "could not hatch a duck for a waiting task");
        continue;
      }
      const working = this.workingDucks(projectId);
      const cur = duck.currentSessionId ? this.o.store.getSession(duck.currentSessionId) : null;
      const queues = working.has(duck.id) && cur && !cur.archivedAt;
      if (!queues && (slotsFull || working.size >= rules.maxWorkingDucks)) {
        slotsFull = true;
        continue;
      }
      await this.startFromLine(
        projectId,
        t.id,
        queues ? { action: "go", sessionId: cur.id } : { action: "go" },
        "could not start a waiting task",
      );
    }
  }

  /** One start from the line; a transient refusal is retried after a short backoff instead of waiting for a turn end. */
  private async startFromLine(
    projectId: string,
    taskId: string,
    body: Record<string, unknown>,
    warning: string,
  ): Promise<void> {
    try {
      await this.act(projectId, taskId, body);
      this.retries.delete(taskId);
    } catch (error) {
      logger.warn(warning, { error: String(error) });
      if (isTransientStart(error)) this.retryLater(projectId, taskId);
    }
  }

  private retryLater(projectId: string, taskId: string): void {
    const delays = this.o.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const attempt = this.retries.get(taskId) ?? 0;
    if (attempt >= delays.length || this.retryPending.has(taskId)) return;
    this.retries.set(taskId, attempt + 1);
    this.retryPending.add(taskId);
    const run = () => {
      this.retryPending.delete(taskId);
      this.startWaiting(projectId);
    };
    const schedule =
      this.o.schedule ??
      ((fn: () => void, ms: number) => {
        setTimeout(fn, ms).unref();
      });
    schedule(run, delays[attempt]!);
  }

  // ---- routing (the decider) ----

  /** Resolves when `taskId`'s routing is decided (immediately when none is running). */
  routed(taskId: string): Promise<void> {
    return this.routings.get(taskId) ?? Promise.resolve();
  }

  /**
   * THE ROUTING SEAM. Runs the decider once for a Task that was just made (never on ordinary chat) and records its
   * choice: the suggestion Go sends to, the other Ducks to re-route to, the place, and the one routing line. A suggestion
   * nobody took up routes without the model (`useModel` false) and routes again, with it, when it is taken up.
   * `start`: the Task starts at once on that destination (the line, with its limits) unless the Pond asks first.
   */
  private route(projectId: string, taskId: string, useModel: boolean, start: boolean): void {
    const run: Promise<void> = this.decideRoute(projectId, taskId, useModel, start)
      .catch((error) => logger.warn("task routing failed", { error: String(error) }))
      .finally(() => {
        this.routings.delete(taskId);
        this.inflight.delete(run);
      });
    this.routings.set(taskId, run);
    this.inflight.add(run);
  }

  private async decideRoute(projectId: string, taskId: string, useModel: boolean, start: boolean): Promise<void> {
    const found = this.get(taskId);
    if (!found) return;
    const pool = this.deciderPool(projectId);
    const result = await this.decider.decide(
      found.job.text,
      pool.map((p) => p.duck),
      { useModel },
    );
    // The person may have acted or re-routed while it ran: theirs stands.
    const now = this.get(taskId);
    if (!now || now.job.state !== "waiting" || now.job.routing?.by === "person") return;
    const job = now.job;
    const byId = new Map(pool.map((p) => [p.duck.id, p]));
    const refOf = (r: ScoredDuck, reason = r.reason): TaskThreadRef | null => {
      const p = byId.get(r.duckId);
      return p
        ? ref({ duck: p.row, session: p.session, state: p.state, score: r.score, reason, pitch: pitchOf(reason) })
        : null;
    };
    delete job.suggestion;
    delete job.candidates;
    const chosen = result.kind === "duck" ? byId.get(result.duckId) : undefined;
    const top = result.ranked.find((r) => r.duckId === chosen?.duck.id);
    const pick = top ? refOf(top, result.reason) : null;
    if (pick) job.suggestion = pick;
    const rest = result.ranked
      .filter((r) => r.duckId !== chosen?.duck.id && r.score >= 0.1)
      .slice(0, 3)
      .map((r) => refOf(r))
      .filter((r): r is TaskThreadRef => r !== null);
    if (rest.length) job.candidates = rest;
    job.routing = {
      kind: result.kind === "duck" && !pick ? "hatch" : result.kind,
      ...(pick && chosen ? { duckId: chosen.duck.id, name: chosen.duck.name } : {}),
      reason: result.reason,
      by: "decider",
      at: this.now(),
    };
    const place = this.choosePlace(projectId, job.text, pick ? chosen!.row : null, pick ? chosen!.session : null);
    if (place) job.place = place;
    else delete job.place;
    // The destination is set: a Task that starts at once joins the line now.
    if (start && this.hasDestination(job) && !this.rules(projectId).askBeforeStarting) job.inLine = true;
    const saved = this.save(projectId, job);
    if (saved.inLine) this.startSoon(projectId);
  }

  /** The pond's ducks as the decider reads them: Off-duty ones too (they can come back for related work). */
  private deciderPool(projectId: string): Array<{
    duck: DeciderDuck;
    row: DuckRow;
    session: SessionRow | null;
    state: RoomThread["state"];
  }> {
    const tasks = this.o.store.roomJobRows(projectId).map((r) => JSON.parse(r.data) as RoomTask);
    return this.o.room.duckCandidates(projectId, 30 * 24 * 3_600_000, { offDuty: true }).map((c) => {
      const texts: string[] = [];
      const add = (t: string | null | undefined): void => {
        const clean = (t ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
        if (clean && !texts.includes(clean)) texts.push(clean);
      };
      for (const t of tasks.filter((t) => t.handedTo?.duckId === c.duck.id && t.state !== "dropped").reverse()) {
        add(t.text);
      }
      for (const id of [...this.o.store.duckSessionIds(c.duck.id)].reverse()) {
        add(this.o.store.getSession(id)?.title);
        for (const turn of this.o.room.sessionTurns(id).slice(-4).reverse()) add(stripAttachmentLines(turn.prompt));
      }
      add(c.duck.role);
      for (const line of c.duck.notebook.split("\n").reverse().slice(0, 4)) {
        add(line.replace(/^- \d{4}-\d{2}-\d{2} /, ""));
      }
      return {
        row: c.duck,
        session: c.session,
        state: c.state,
        duck: {
          id: c.duck.id,
          name: c.duck.name ?? c.session?.title ?? "Duck",
          duty: c.duck.duty,
          busy: c.state === "working",
          contextPercent: c.session ? (this.o.contextPercent?.(c.session) ?? null) : null,
          tasks: texts.slice(0, 10),
          touched: this.o.room.touchedFiles(c.duck.id),
        },
      };
    });
  }

  // ---- the discussion a Task carries ----

  /**
   * The Room messages since the previous Task in this pond (a suggestion nobody took up does not count), no older than
   * 2 h before `post`, up to and including `post`. `selfId` is a Task being made again, never its own boundary.
   */
  discussionFor(projectId: string, post: RoomPostRow, selfId?: string): TaskDiscussionMessage[] {
    let boundary = 0;
    for (const r of this.o.store.roomJobRows(projectId)) {
      const t = JSON.parse(r.data) as RoomTask;
      if (t.id === selfId || t.proposed || t.state === "dropped") continue;
      const seq = this.o.store.roomPostById(t.messageId)?.seq ?? 0;
      if (seq < post.seq && seq > boundary) boundary = seq;
    }
    const floor = post.at - TASK_DISCUSSION_WINDOW_MS;
    return this.o.store
      .roomPosts(projectId, { before: post.seq + 1, limit: 300 })
      .filter(
        (p) =>
          p.seq > boundary &&
          p.kind === "message" &&
          p.level === "room" &&
          (p.authorKind === "person" || p.authorKind === "agent") &&
          p.at >= floor &&
          p.text.trim() !== "",
      )
      .slice(-DISCUSSION_MAX_MESSAGES)
      .map((p) => ({
        id: p.id,
        author: p.authorName,
        authorKind: p.authorKind as "person" | "agent",
        text: p.text,
        at: p.at,
      }));
  }

  /** What a Duck is sent: the Task, then the discussion the person kept (never the message that made the Task). */
  promptOf(task: RoomTask): string {
    const rest = task.discussion.filter((m) => m.id !== task.messageId);
    if (rest.length === 0) return task.text;
    const lines = rest.map((m) => `${m.author}: ${m.text.replace(/\s+/g, " ").trim().slice(0, 600)}`);
    return `${task.text}\n\nRoom discussion before this, oldest first:\n${lines.join("\n")}`;
  }

  /**
   * What a Duck is sent when it takes a Task: the Task and its discussion (`promptOf`), then the hand-off note a
   * previous Duck left for it, the Pond's Notebook, and how to work: post only state changes, a spec+plan card only
   * for more than a small Task, and (in a solo pond) skip Room status lines. The first line is always the Task's own
   * text: the turn is matched to the Task by it.
   */
  briefingOf(projectId: string, task: RoomTask, duck: DuckRow): string {
    const parts = [this.promptOf(task)];
    const note = this.handoffNoteFor(projectId, duck);
    if (note) {
      parts.push(`Hand-off note from ${note.from}, who worked on this before you:\n${note.text}`);
    }
    let notebook: string | null | undefined;
    try {
      notebook = this.o.notebook?.(projectId);
    } catch (error) {
      logger.warn("notebook hook failed", { error: String(error) });
    }
    if (notebook?.trim()) parts.push(`Pond Notebook (lessons earlier ducks left for everyone):\n${notebook.trim()}`);
    parts.push(
      [
        "How to work this task:",
        '- When you finish this task, write one message in the room (post_to_room kind message): two or three plain sentences saying what you did, what you found and what you need from the reader, starting with the substance, with no greeting or preamble and no copied tool output; the details stay in your own thread. Skip "took it" and "finished" lines. If you get blocked, post kind needs saying what you need; to pass work on, handoff.',
        "- To give work to another duck, call hand_off: with toDuck it goes straight to that duck (shown as an @mention), without it Squeak decides who takes it and may hatch a new duck. A plain @mention only nudges.",
        "- The shared notebook is for lessons that will last past this task (a command that must run, a trap, a convention), never a log of what you did. Only when you are finishing this task, add at most a few with note_to_notebook (taskDone true); the host refuses it before then.",
        "- Judge the size first. A small task: just do it. More than small (several steps, files or decisions): post a spec and plan card first (post_to_room kind plan, the title as text and the spec and plan as detail) and keep going; comments on it reach you at your next turn.",
      ].join("\n"),
    );
    return parts.join("\n\n");
  }

  /** The newest hand-off note addressed to `duck` (to one of its chats, or @mentioning it) in the last 24 h. */
  private handoffNoteFor(projectId: string, duck: DuckRow): { from: string; text: string } | null {
    const mine = new Set(this.o.store.duckSessionIds(duck.id));
    const floor = this.now() - 24 * 3_600_000;
    const posts = this.o.store.roomPosts(projectId, { limit: 200 });
    for (let i = posts.length - 1; i >= 0; i--) {
      const p = posts[i]!;
      if (p.kind !== "handoff" || p.at < floor || (p.sessionId && mine.has(p.sessionId))) continue;
      const to = p.toSessionId ? mine.has(p.toSessionId) : false;
      if (to || this.o.store.duckNames(duck).some((n) => mentions(p.text, n))) {
        return { from: p.authorName, text: [p.text, p.detail].filter(Boolean).join("\n\n") };
      }
    }
    return null;
  }

  /** The person's trim: keep only these messages of the Task's discussion, in their order. */
  private trim(task: RoomTask, raw: unknown): void {
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string")) {
      throw new TaskError("messageIds must be a list of message ids.", 400);
    }
    const keep = new Set(raw as string[]);
    const known = new Set(task.discussion.map((m) => m.id));
    for (const id of keep) if (!known.has(id)) throw new TaskError("That message isn't part of this task.", 400);
    task.discussion = task.discussion.filter((m) => keep.has(m.id));
  }

  // ---- places ----

  /**
   * Where a job runs. A duck that already works in a stream whose recent turns match the job strongly continues
   * there; anything else goes to a new stream off the default branch (a plain-folder pond has no streams: absent).
   */
  choosePlace(
    projectId: string,
    text: string,
    duck: DuckRow | null,
    session: SessionRow | null,
  ): TaskPlace | undefined {
    const project = this.o.store.getProject(projectId);
    if (!project || project.kind === "folder") return undefined;
    const here = this.o.room.placeOf(session);
    if (here && duck && this.streamScore(session!, tokens(text)) >= JOB_CONTINUE_SCORE) return here;
    const branch = this.o.newBranch?.(projectId, text);
    return branch ? { kind: "new", branch } : undefined;
  }

  /** How well a chat's stream (title, branch) and its last turns fit a job's words. */
  private streamScore(session: SessionRow, want: Set<string>): number {
    const ws = session.workspaceId ? this.o.store.getWorkspace(session.workspaceId) : null;
    const named = tokens(`${session.title ?? ""} ${ws?.title ?? ""} ${ws?.branch.replace(/[-_/]+/g, " ") ?? ""}`);
    const turns = this.o.room
      .sessionTurns(session.id)
      .slice(-4)
      .map((t) => tokens(`${t.prompt} ${firstSentence(t.reply ?? "")}`));
    let raw = 0;
    for (const w of want) raw += named.has(w) ? 3 : turns.some((x) => x.has(w)) ? 1.5 : 0;
    return raw;
  }

  /** A place the person (or the host) names, checked: a stream of this pond that is not archived, or a free branch. */
  private cleanPlace(projectId: string, raw: unknown): TaskPlace {
    const bad = (m: string): never => {
      throw new TaskError(m, 400);
    };
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("place must be an object");
    const o = raw as Record<string, unknown>;
    if (o.kind === "stream") {
      const extra = Object.keys(o).filter((k) => !["kind", "workspaceId", "branch"].includes(k));
      if (extra.length) return bad(`unknown key in place: ${extra[0]}`);
      if (typeof o.workspaceId !== "string" || !o.workspaceId) return bad("place.workspaceId is required");
      const ws = this.o.store.getWorkspace(o.workspaceId);
      if (!ws || ws.projectId !== projectId || ws.state === "archived") {
        throw new TaskError("That stream isn't available in this pond any more.", 409);
      }
      return { kind: "stream", workspaceId: ws.id, branch: ws.branch };
    }
    if (o.kind === "new") {
      const extra = Object.keys(o).filter((k) => !["kind", "branch"].includes(k));
      if (extra.length) return bad(`unknown key in place: ${extra[0]}`);
      if (typeof o.branch !== "string" || !o.branch.trim() || o.branch.length > 200) {
        return bad("place.branch must be a branch name");
      }
      const project = this.o.store.getProject(projectId);
      if (project?.kind === "folder") throw new TaskError("This pond has no streams to start in.", 409);
      return { kind: "new", branch: this.o.checkBranch ? this.o.checkBranch(projectId, o.branch) : o.branch.trim() };
    }
    return bad("place.kind must be stream or new");
  }

  // ---- matching ----

  /** The pond's ducks that fit `text`, best first; empty when none fits well enough. */
  rank(projectId: string, text: string): Scored[] {
    const want = tokens(text);
    if (want.size === 0) return [];
    const marks = this.o.store.latestRoomMarks(projectId);
    const out: Scored[] = [];
    for (const c of this.o.room.duckCandidates(projectId, JOB_MATCH_WINDOW_MS)) {
      const hit = this.score(
        c.duck,
        c.session,
        c.state,
        c.at,
        want,
        c.session ? marks.get(c.session.id)?.working?.text : undefined,
      );
      if (hit && hit.score >= JOB_MIN_SCORE) out.push(hit);
    }
    return out.sort((a, b) => b.score - a.score || a.duck.id.localeCompare(b.duck.id));
  }

  /** How well one duck fits a job's words (name, role, chat title, notebook, last turns), with a phrase for why. */
  score(
    duck: DuckRow,
    session: SessionRow | null,
    state: RoomThread["state"],
    at: number,
    want: Set<string>,
    intent?: string,
  ): Scored | null {
    const title = tokens(`${session?.title ?? ""} ${duck.name ?? ""} ${duck.role ?? ""}`);
    const intentWords = tokens(intent ?? "");
    const notebook = tokens(duck.notebook);
    const turns = this.o.store
      .duckSessionIds(duck.id)
      .flatMap((id) => this.o.room.sessionTurns(id))
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(-4);
    let raw = 0;
    const matched: string[] = [];
    let bestTurn: { at: number; words: string[] } | null = null;
    const turnSets = turns.map((t) => ({ t, words: tokens(`${t.prompt} ${firstSentence(t.reply ?? "")}`) }));
    for (const w of want) {
      let weight = 0;
      if (title.has(w)) weight = 3;
      else if (intentWords.has(w)) weight = 2;
      else if (notebook.has(w) || turnSets.some((x) => x.words.has(w))) weight = 1.5;
      if (weight) {
        raw += weight;
        matched.push(w);
      }
    }
    if (raw === 0) return null;
    for (const x of turnSets) {
      const words = matched.filter((w) => x.words.has(w));
      if (words.length && (!bestTurn || words.length >= bestTurn.words.length)) {
        bestTurn = { at: x.t.endedAt ?? x.t.startedAt, words };
      }
    }
    const age = this.now() - at;
    const recency = age <= 3_600_000 ? 1 : age <= JOB_LISTED_MS ? 0.6 : age <= 3 * JOB_LISTED_MS ? 0.3 : 0;
    const phrase = (words: string[]): string => words.slice(0, 3).join(" ");
    let reason: string;
    let pitch: string;
    if (state === "working") {
      reason = `is working on ${phrase(matched)} now`;
      pitch = `am working on ${phrase(matched)} now`;
    } else if (bestTurn) {
      reason = pitch = `worked on ${phrase(bestTurn.words)} ${ago(this.now() - bestTurn.at)}`;
    } else if (notebook.size && matched.some((w) => notebook.has(w) && !title.has(w))) {
      reason = `has notes about ${phrase(matched)}`;
      pitch = `have notes about ${phrase(matched)}`;
    } else {
      reason = `its thread is about ${phrase(matched)}`;
      pitch = `have a thread about ${phrase(matched)}`;
    }
    return { duck, session, state, score: raw + (raw >= JOB_MIN_SCORE ? recency : 0), reason, pitch };
  }

  /** Suggested jobs of this pond, best fit for `session`'s duck first (the agent's `open_jobs`). */
  openFor(projectId: string, session: SessionRow): Array<{ job: RoomTask; why: string }> {
    const marks = this.o.store.latestRoomMarks(projectId);
    // An off-duty duck is not a candidate, so it is offered nothing.
    const me = this.o.room.duckCandidates(projectId, JOB_MATCH_WINDOW_MS).find((c) => c.session?.id === session.id);
    if (!me) return [];
    const out: Array<{ job: RoomTask; why: string; score: number }> = [];
    for (const job of this.list(projectId)) {
      if (job.state !== "waiting" || job.approval) continue;
      if (job.claim && job.claim.status !== "denied" && job.claim.sessionId !== session.id) continue;
      if (job.claim?.status === "denied" && job.claim.sessionId === session.id) continue;
      const hit = this.score(
        me.duck,
        me.session,
        me.state,
        me.at,
        tokens(job.text),
        marks.get(session.id)?.working?.text,
      );
      const named = job.suggestion?.duckId
        ? job.suggestion.duckId === me.duck.id
        : job.suggestion?.sessionId === session.id;
      if (!named && (!hit || hit.score < JOB_MIN_SCORE / 2)) continue;
      out.push({ job, why: hit?.reason ?? job.suggestion?.reason ?? "", score: (hit?.score ?? 0) + (named ? 10 : 0) });
    }
    return out.sort((a, b) => b.score - a.score).map(({ job, why }) => ({ job, why }));
  }

  // ---- claims (agents) ----

  claim(session: SessionRow, projectId: string, jobId: string, eta?: string): RoomTask {
    const found = this.get(jobId);
    if (!found || found.projectId !== projectId) throw new TaskError("No such job in this pond.", 404);
    const job = found.job;
    if (job.state !== "waiting") throw new TaskError("That task is no longer open.", 409);
    if (job.approval) throw new TaskError("That task is waiting for the Owner's approval.", 409);
    if (this.o.store.duckOf(session.id).duty === "off") {
      throw new TaskError("You are off duty, so you can't take jobs; the person can put you back on duty.", 409);
    }
    const c = job.claim;
    if (c && c.sessionId === session.id) {
      throw new TaskError(
        c.status === "denied"
          ? "The person said no to you taking this job."
          : "You have already asked to take this job.",
        409,
      );
    }
    if (c && c.status !== "denied") throw new TaskError("Another chat has already asked to take this job.", 409);
    const hour = this.now() - 3_600_000;
    const recent = (this.claims.get(session.id) ?? []).filter((t) => t > hour);
    this.claims.set(session.id, recent);
    if (recent.length >= JOB_CLAIMS_PER_HOUR)
      throw new TaskError("This chat has asked for enough jobs this hour.", 429);
    recent.push(this.now());
    const cleanEta = eta?.replace(/\s+/g, " ").trim().slice(0, 60);
    const duck = this.o.store.duckBySession(session.id);
    job.claim = {
      sessionId: session.id,
      ...(duck ? { duckId: duck.id } : {}),
      title: session.title ?? "Untitled",
      ...(cleanEta ? { eta: cleanEta } : {}),
      at: this.now(),
      status: "asking",
    };
    return this.save(projectId, job);
  }

  // ---- the person's actions ----

  async act(projectId: string, jobId: string, body: Record<string, unknown>): Promise<RoomTask> {
    const unknown = Object.keys(body).filter(
      (k) => !["action", "sessionId", "duckId", "place", "messageIds"].includes(k),
    );
    if (unknown.length) throw new TaskError(`unknown key: ${unknown[0]}`, 400);
    const action = body.action;
    if (!["go", "new", "drop", "allow", "deny", "reroute", "approve"].includes(action as string)) {
      throw new TaskError("action must be go, new, drop, allow, deny, reroute or approve", 400);
    }
    if (body.messageIds !== undefined && !["go", "allow", "new"].includes(action as string)) {
      throw new TaskError("messageIds is only for go, allow and new", 400);
    }
    if (body.sessionId !== undefined && (action !== "go" || typeof body.sessionId !== "string")) {
      throw new TaskError("sessionId is only for go, and must be text", 400);
    }
    if (
      body.duckId !== undefined &&
      (!["go", "allow", "new", "reroute"].includes(action as string) || typeof body.duckId !== "string")
    ) {
      throw new TaskError("duckId is only for go, allow, new and reroute, and must be text", 400);
    }
    if (body.sessionId !== undefined && body.duckId !== undefined) {
      throw new TaskError("give a duckId or a sessionId, not both", 400);
    }
    if (body.place !== undefined && !["go", "allow", "new"].includes(action as string)) {
      throw new TaskError("place is only for go, allow and new", 400);
    }
    // A Task still being routed is acted on once its routing has landed (Go needs the suggestion).
    await this.routed(jobId);
    const found = this.get(jobId);
    if (!found || found.projectId !== projectId) throw new TaskError("No such job.", 404);
    const job = found.job;
    if (this.busy.has(jobId)) throw new TaskError("That job is being handed over right now.", 409);
    if (action === "drop") {
      if (job.state === "dropped") throw new TaskError("That task was already dropped.", 409);
      if (job.state === "done") throw new TaskError("That task is done.", 409);
    } else if (job.state !== "waiting") {
      throw new TaskError(
        job.state === "dropped" ? "That task was dropped." : "That task has already been taken up by a Duck.",
        409,
      );
    }
    const override = body.place !== undefined ? this.cleanPlace(projectId, body.place) : undefined;
    this.busy.add(jobId);
    try {
      if (action === "go" || action === "allow" || action === "new") {
        // Taking a suggestion up makes it a Task; the person's trim is what the Duck is sent.
        delete job.proposed;
        delete job.approval;
        if (body.messageIds !== undefined) this.trim(job, body.messageIds);
      }
      switch (action) {
        case "reroute":
          return this.reroute(projectId, job, body.duckId as string | undefined);
        case "approve": {
          // The Owner lets a Member's Task go ahead: it proceeds like the Owner's own, started at once if it can be.
          if (!job.approval) throw new TaskError("That task is not waiting for approval.", 409);
          // Its routing may still be running; the destination it names is what starts.
          const routing = this.routings.get(job.id);
          if (routing) await routing;
          const fresh = this.get(jobId)?.job ?? job;
          delete fresh.approval;
          if (this.hasDestination(fresh) && !this.rules(projectId).askBeforeStarting) fresh.inLine = true;
          const approved = this.save(projectId, fresh);
          // After this call lets go of the Task, or the line would find it busy.
          if (approved.inLine) queueMicrotask(() => this.startSoon(projectId));
          return approved;
        }
        case "drop": {
          const was = job.state as TaskState;
          const sid = job.handedTo?.sessionId;
          job.state = "dropped";
          delete job.inLine;
          delete job.approval;
          const dropped = this.save(projectId, job);
          // A dropped working Task frees its Duck, and the Duck is told (it stops at its next turn).
          this.startWaiting(projectId);
          if (was === "working" && sid) {
            void this.o
              .send(
                sid,
                `[Room] The task "${job.title}" was dropped. Stop work on it unless you are asked to continue.`,
              )
              .catch((error) => logger.warn("task drop notice failed", { error: String(error) }));
          }
          return dropped;
        }
        case "deny":
          if (job.claim?.status !== "asking") throw new TaskError("No Duck is asking to take this task.", 409);
          job.claim.status = "denied";
          return this.save(projectId, job);
        case "allow": {
          if (job.claim?.status !== "asking") throw new TaskError("No Duck is asking to take this task.", 409);
          const claimer = this.o.store.getSession(job.claim.sessionId);
          const duck = claimer ? this.o.room.duckOfSession(claimer) : null;
          if (!duck) throw new TaskError("That thread isn't available in this pond any more.", 409);
          if (body.duckId !== undefined && body.duckId !== duck.id) {
            throw new TaskError("Only the duck that asked can be allowed.", 409);
          }
          const done = await this.handTo(
            projectId,
            job,
            duck,
            override ?? this.placeFor(projectId, job, duck, claimer),
          );
          if (done.claim) done.claim.status = "allowed";
          return this.save(projectId, done);
        }
        case "go": {
          let duck: DuckRow | null = null;
          let place = override;
          let pinned = override !== undefined;
          if (typeof body.duckId === "string") {
            duck = this.o.store.duckRow(body.duckId);
            if (!duck || duck.projectId !== projectId) throw new TaskError("That duck isn't in this pond.", 409);
          } else {
            const id = (body.sessionId as string | undefined) ?? job.suggestion?.sessionId;
            if (id) {
              const s = this.o.store.getSession(id);
              const inPond =
                s &&
                !s.archivedAt &&
                this.o.room.candidates(projectId, Infinity, { offDuty: true }).some((c) => c.session.id === s.id);
              if (!s || !inPond) throw new TaskError("That thread isn't available in this pond any more.", 409);
              duck = this.o.room.duckOfSession(s);
              // The person picked that very thread: it continues there, wherever it is.
              if (!pinned && body.sessionId !== undefined) {
                place = this.o.room.placeOf(s);
                pinned = true;
              }
            } else if (job.suggestion?.duckId) {
              duck = this.o.store.duckRow(job.suggestion.duckId);
            }
          }
          if (!duck) throw new TaskError("There is no thread to send this to; start a new one.", 409);
          const cur = duck.currentSessionId ? this.o.store.getSession(duck.currentSessionId) : null;
          return this.save(
            projectId,
            await this.handTo(projectId, job, duck, pinned ? place : this.placeFor(projectId, job, duck, cur)),
          );
        }
        default: {
          const project = this.o.store.getProject(projectId);
          if (!project) throw new TaskError("No such pond.", 404);
          let duck: DuckRow | null = null;
          if (typeof body.duckId === "string") {
            duck = this.o.store.duckRow(body.duckId);
            if (!duck || duck.projectId !== projectId) throw new TaskError("That duck isn't in this pond.", 409);
          } else {
            duck = this.o.store.createDuck({ projectId, name: this.freshDuckName(projectId, job.text) });
          }
          const cur = duck.currentSessionId ? this.o.store.getSession(duck.currentSessionId) : null;
          // "New": always a session of its own, in the chosen place, even for a duck that works elsewhere.
          const place = override ?? this.placeFor(projectId, job, duck, cur, true);
          return this.save(projectId, await this.startFor(projectId, job, duck, place, cur));
        }
      }
    } finally {
      this.busy.delete(jobId);
    }
  }

  /**
   * The person's one tap on the routing line: give the waiting Task to another Duck, or (no `duckId`) to a new one.
   * Nothing starts; Go does that. The person's choice is final, the decider does not overrule it.
   */
  private reroute(projectId: string, job: RoomTask, duckId: string | undefined, why = "you chose it"): RoomTask {
    const at = this.now();
    delete job.suggestion;
    delete job.place;
    if (duckId === undefined) {
      job.routing = { kind: "hatch", reason: "you chose a new Duck", by: "person", at };
      const branch = this.o.newBranch?.(projectId, job.text);
      if (branch && this.o.store.getProject(projectId)?.kind !== "folder") job.place = { kind: "new", branch };
      return this.enterLine(projectId, job);
    }
    const duck = this.o.store.duckRow(duckId);
    if (!duck || duck.projectId !== projectId) throw new TaskError("That duck isn't in this pond.", 409);
    const session = duck.currentSessionId ? this.o.store.getSession(duck.currentSessionId) : null;
    const live = session && !session.archivedAt ? session : null;
    const reason = why;
    const state = this.o.room.duckView(duck).state;
    job.suggestion = ref({ duck, session: live, state, score: 0, reason, pitch: reason });
    job.routing = { kind: "duck", duckId: duck.id, name: duck.name ?? live?.title ?? "Duck", reason, by: "person", at };
    const place = this.choosePlace(projectId, job.text, duck, live);
    if (place) job.place = place;
    return this.enterLine(projectId, job);
  }

  /** A re-routed Task that is not waiting for the person starts the way a routed one does. */
  private enterLine(projectId: string, job: RoomTask): RoomTask {
    if (!job.proposed && !job.approval && this.hasDestination(job) && !this.rules(projectId).askBeforeStarting)
      job.inLine = true;
    const saved = this.save(projectId, job);
    if (saved.inLine) this.startSoon(projectId);
    return saved;
  }

  /** The place for `duck`: the job's own when the suggested duck takes it, else chosen for this duck. */
  private placeFor(
    projectId: string,
    job: RoomTask,
    duck: DuckRow,
    cur: SessionRow | null,
    forceNew = false,
  ): TaskPlace | undefined {
    const stored = job.suggestion?.duckId === duck.id ? job.place : undefined;
    if (stored?.kind === "new" && this.o.checkBranch) {
      // The branch was free when the job was made; take another one if it is not any more.
      try {
        return { kind: "new", branch: this.o.checkBranch(projectId, stored.branch) };
      } catch {
        const fresh = this.o.newBranch?.(projectId, job.text);
        return fresh ? { kind: "new", branch: fresh } : undefined;
      }
    }
    if (stored && !forceNew) return stored;
    if (forceNew) {
      const project = this.o.store.getProject(projectId);
      if (!project || project.kind === "folder") return undefined;
      const branch = this.o.newBranch?.(projectId, job.text);
      return branch ? { kind: "new", branch } : undefined;
    }
    return this.choosePlace(projectId, job.text, duck, cur);
  }

  private freshDuckName(projectId: string, text: string): string {
    const taken = new Set(this.o.store.listDucks(projectId).map((d) => (d.name ?? "").toLowerCase()));
    const names = DUCK_NAMES.filter((n) => !taken.has(n.toLowerCase()));
    const h = [...text].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    const pick = names.length ? names[h % names.length]! : `Duck ${taken.size + 1}`;
    return pick;
  }

  /** Hands the job to `duck`: the next turn of its current chat when that is in the place, else a fresh session there. */
  private async handTo(
    projectId: string,
    job: RoomTask,
    duck: DuckRow,
    place: TaskPlace | undefined,
  ): Promise<RoomTask> {
    const cur = duck.currentSessionId ? this.o.store.getSession(duck.currentSessionId) : null;
    const live = cur && !cur.archivedAt ? cur : null;
    const inPlace = live && (!place || (place.kind === "stream" && live.workspaceId === place.workspaceId));
    if (!inPlace) return this.startFor(projectId, job, duck, place, live);
    const s = live;
    job.state = "working";
    job.handedTo = { sessionId: s.id, duckId: duck.id, title: this.o.room.duckName(s), newThread: false };
    job.updatedAt = this.now();
    // The person sending a job to an off-duty duck puts it back on duty.
    this.o.room.setDutyById(duck.id, true);
    try {
      await this.o.send(s.id, this.briefingOf(projectId, job, duck) + this.attachLines(projectId, job, s.cwd));
    } catch (error) {
      delete job.handedTo;
      job.state = "waiting";
      throw new TaskError(error instanceof Error ? error.message : "Could not send it.", 409);
    }
    this.save(projectId, job);
    return this.reconcileJob(projectId, job);
  }

  private hasAttachments(job: RoomTask): boolean {
    const c = this.o.room.attachments.counts(job.messageId);
    return c.images + c.files > 0;
  }

  /** The attachment lines of the job's message, copied under `cwd` the way a chat's are; a failure refuses the send. */
  private attachLines(projectId: string, job: RoomTask, cwd: string): string {
    try {
      return this.o.room.attachments.forTurn(projectId, job.messageId, cwd);
    } catch (error) {
      throw new TaskError(error instanceof AttachmentError ? error.message : "Couldn't copy the attachments.", 409);
    }
  }

  /** A fresh session for the duck in `place`; the old one stays as history. A duck busy elsewhere cannot start one. */
  private async startFor(
    projectId: string,
    job: RoomTask,
    duck: DuckRow,
    place: TaskPlace | undefined,
    cur: SessionRow | null,
  ): Promise<RoomTask> {
    if (cur && !cur.archivedAt && this.o.room.duckView(duck).state !== "idle") {
      const name = duck.name ?? this.o.room.duckName(cur);
      throw new TaskError(`${name} is busy in another stream; wait for it to finish, or let it claim this after.`, 409);
    }
    this.o.room.setDutyById(duck.id, true);
    let child: SessionRow;
    try {
      if (this.o.start) {
        child = await this.o.start({
          projectId,
          duck,
          ...(place ? { place } : {}),
          text: this.briefingOf(projectId, job, duck),
          title: job.title,
          ...(this.hasAttachments(job) ? { attach: (cwd: string) => this.attachLines(projectId, job, cwd) } : {}),
        });
      } else {
        child = await this.o.newThread(
          projectId,
          this.briefingOf(projectId, job, duck),
          job.title,
          this.hasAttachments(job) ? (cwd) => this.attachLines(projectId, job, cwd) : undefined,
        );
        this.o.store.attachSessionToDuck(duck.id, child.id);
      }
    } catch (error) {
      if (error instanceof TaskError) throw error;
      throw new TaskError(error instanceof Error ? error.message : "Could not start a thread.", 409);
    }
    this.o.store.attachSessionToDuck(duck.id, child.id);
    this.o.room.emitDuck(duck.id);
    job.state = "working";
    job.handedTo = {
      sessionId: child.id,
      duckId: duck.id,
      title: child.title ?? job.title,
      newThread: true,
    };
    if (place) job.place = place;
    this.save(projectId, job);
    return this.reconcileJob(projectId, job);
  }

  // ---- following the handed turn ----

  private reconcileSession(sessionId: string): void {
    const s = this.o.store.getSession(sessionId);
    if (!s) return;
    for (const [projectId, job] of this.activeFor(sessionId)) this.reconcileJob(projectId, job);
  }

  /** The Task this chat is working now (the one it took from the Room), with its pond; null when it has none. */
  workingTaskOf(sessionId: string): { projectId: string; task: RoomTask } | null {
    const [hit] = this.activeFor(sessionId);
    return hit ? { projectId: hit[0], task: hit[1] } : null;
  }

  private activeFor(sessionId: string): Array<[string, RoomTask]> {
    const out: Array<[string, RoomTask]> = [];
    for (const p of this.o.store.listProjects()) {
      for (const r of this.o.store.roomJobRows(p.id)) {
        const j = JSON.parse(r.data) as RoomTask;
        if (j.state === "working" && j.handedTo?.sessionId === sessionId) out.push([p.id, j]);
      }
    }
    return out;
  }

  /** No turn matched a working Task: once its chat has stopped for `TASK_UNBOUND_MS` it did not finish, so it is blocked. */
  private settleUnbound(projectId: string, job: RoomTask): RoomTask {
    const to = job.handedTo;
    if (!to || job.state !== "working" || this.now() - job.updatedAt < TASK_UNBOUND_MS) return job;
    const session = this.o.store.getSession(to.sessionId);
    if (session && !session.archivedAt && TASK_BUSY_STATUS.has(session.status)) return job;
    job.state = "blocked";
    return this.save(projectId, job);
  }

  /** Binds a working Task to the turn its text started, and follows that turn to its end. Saves only on change. */
  reconcileJob(projectId: string, job: RoomTask): RoomTask {
    const to = job.handedTo;
    if (!to || job.state !== "working") return job;
    const turns = this.o.room.sessionTurns(to.sessionId);
    const want = oneLine(job.text);
    const taken = new Set(
      this.o.store
        .roomJobRows(projectId)
        .map((r) => (JSON.parse(r.data) as RoomTask).handedTo?.turnId)
        .filter((x): x is string => !!x),
    );
    const turn = to.turnId
      ? turns.find((t) => `${to.sessionId}:${t.turnId}` === to.turnId)
      : turns.find(
          (t) =>
            t.startedAt >= job.updatedAt - 10_000 &&
            oneLine(stripAttachmentLines(t.prompt)) === want &&
            !taken.has(`${to.sessionId}:${t.turnId}`),
        );
    if (!turn) return this.settleUnbound(projectId, job);
    const before = JSON.stringify(job);
    to.turnId = `${to.sessionId}:${turn.turnId}`;
    if (turn.endedAt !== undefined) {
      const was = job.state as TaskState;
      job.state = turn.outcome === "finished" ? "done" : "blocked";
      if (job.state === "done" && was !== "done") {
        try {
          this.o.onTaskDone?.(to.sessionId);
        } catch {
          // a title is never worth a Task's bookkeeping
        }
      }
      const outcome = turn.reply ? firstSentence(turn.reply) : "";
      if (outcome) job.result = outcome;
      if (job.state === "done") this.settleFinish(projectId, job, turn);
    }
    return JSON.stringify(job) === before ? job : this.save(projectId, job);
  }

  /**
   * A finished Task's one Room message. The Duck's own (posted during the turn) is the Task's summary; when it posted
   * none, the host writes one from the turn's result on the Duck's behalf, once, and the Task's summary fills in place.
   */
  private settleFinish(projectId: string, job: RoomTask, turn: TurnBase): void {
    const to = job.handedTo;
    if (!to || turn.endedAt === undefined) return;
    const own = this.o.store.duckRoomPosts(to.sessionId, turn.startedAt, turn.endedAt + 5_000).at(-1);
    if (own) {
      job.summary = own.text;
      return;
    }
    const reply = turn.reply?.trim();
    const writers = this.o.finishWriters;
    if (!reply || !writers?.length) return;
    const run = this.writeFinishFor(projectId, job.id, to.sessionId, job.text, reply, writers).finally(() =>
      this.inflight.delete(run),
    );
    this.inflight.add(run);
  }

  /**
   * A finished turn that began in the Room and is no Task (an @mention, a comment on a plan): the person asked in the
   * Room, so the answer goes back there. The Duck's own post during the turn is the answer; without one the host writes
   * it from the turn's reply on the Duck's behalf, once. The Duck's chat keeps the full turn.
   */
  private settleRoomTurn(sessionId: string, turnId: string): void {
    const writers = this.o.finishWriters;
    if (!writers?.length) return;
    const turn = this.o.room.sessionTurns(sessionId).find((t) => t.turnId === turnId);
    if (!turn?.room || turn.endedAt === undefined || turn.outcome !== "finished") return;
    const reply = turn.reply?.trim();
    if (!reply) return;
    const s = this.o.store.getSession(sessionId);
    const project = s ? projectOfSession(this.o.store, s) : null;
    if (!s || !project) return;
    const key = `${sessionId}:${turnId}`;
    // A Task's turn is settled with its Task.
    for (const r of this.o.store.roomJobRows(project.id)) {
      if ((JSON.parse(r.data) as RoomTask).handedTo?.turnId === key) return;
    }
    if (this.o.store.duckRoomPosts(sessionId, turn.startedAt, turn.endedAt + 5_000).length > 0) return;
    // The asking message, not the "[Room] Name mentioned you:" line the Duck was woken with.
    const asked = this.o.store
      .roomPosts(project.id, { limit: 30 })
      .filter((p) => p.authorKind === "person" && p.kind === "message" && p.at <= turn.startedAt + 2_000)
      .at(-1);
    const run = this.writeFinishFor(
      project.id,
      `t:${key}`,
      sessionId,
      asked?.text ?? turn.prompt,
      reply,
      writers,
    ).finally(() => this.inflight.delete(run));
    this.inflight.add(run);
  }

  private async writeFinishFor(
    projectId: string,
    taskId: string,
    sessionId: string,
    task: string,
    reply: string,
    writers: FinishWriterPort[],
  ): Promise<void> {
    try {
      const id = `${FINISH_ID_PREFIX}${taskId}`;
      if (this.o.store.roomPostById(id)) return;
      const text = await writeFinish(writers, { task, reply }, this.o.finishTimeoutMs ?? 12_000, (error) =>
        logger.warn("finish message failed", { error: error instanceof Error ? error.message : String(error) }),
      );
      if (!text) return;
      const s = this.o.store.getSession(sessionId);
      if (!s) return;
      this.o.room.post({
        id,
        projectId,
        author: { kind: "agent", id: s.id, name: this.o.room.duckName(s) },
        sessionId: s.id,
        kind: "message",
        text,
        // Squeak wrote it for the Duck: it must not wake anyone it names.
        noWake: true,
      });
      const fresh = this.get(taskId);
      if (fresh && !fresh.job.summary) {
        fresh.job.summary = text;
        this.save(projectId, fresh.job);
      }
    } catch (error) {
      logger.warn("finish message skipped", { error: String(error) });
    }
  }
}

/** Short names a new duck is given (the first one not used in the pond, picked by the job's words). */
const DUCK_NAMES = [
  "Pip",
  "Mallow",
  "Dabble",
  "Quill",
  "Teal",
  "Bobbin",
  "Puddle",
  "Waddle",
  "Sorrel",
  "Pebble",
  "Nib",
  "Ripple",
  "Tansy",
  "Mina",
  "Otter",
  "Fennel",
  "Bramble",
  "Juniper",
  "Wren",
  "Clover",
];

/** The decider's reason in the first person, for the Duck to say "I <pitch>". */
function pitchOf(reason: string): string {
  const related = reason.match(/^related to (.+) work$/);
  if (related) return `have worked on ${related[1]}`;
  const knows = reason.match(/^knows (.+)$/);
  return knows ? `know ${knows[1]}` : reason;
}

function ref(s: Scored): TaskThreadRef {
  return {
    duckId: s.duck.id,
    name: s.duck.name ?? s.session?.title ?? "Duck",
    sessionId: s.session?.id ?? "",
    title: s.session?.title ?? s.duck.name ?? "Untitled",
    reason: s.reason,
    pitch: s.pitch,
    state: s.state === "working" ? "working" : "idle",
  };
}

/** A new thread's title from the job: its first clause, at most 60 characters. */
export function taskTitle(text: string): string {
  const t = oneLine(text, 60).replace(/[.!?]+$/, "");
  return t || "New task";
}

/**
 * A person saying to make a Task of the recent discussion: "make it a task", "make this a task", "make that into a task",
 * "turn this into a task", "make a task of it". Rules only; a negation ("don't make it a task") or a question about it
 * is not a request.
 */
const TASK_PHRASES = [
  /\bmake (?:it|this|that|these|them) (?:into )?(?:a )?tasks?\b/,
  /\b(?:turn|convert) (?:it|this|that|these|them) into (?:a )?tasks?\b/,
  /\bmake (?:a )?tasks? (?:of|from|out of) (?:it|this|that|these|them)\b/,
];

function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function asksForTask(text: string): boolean {
  const t = plain(text);
  const hit = TASK_PHRASES.map((re) => re.exec(t)).find((m) => m);
  if (!hit) return false;
  const before = t.slice(0, hit.index);
  if (
    /\b(?:don't|dont|do not|not|never|no need to|shouldn't|should not|won't|can't|cannot|without)\s+(?:\w+\s+){0,2}$/.test(
      before,
    )
  ) {
    return false;
  }
  // "Should we make it a task?" asks; "can you make this a task?" requests.
  const lead = before.split(/[.!?]/).pop()!.trim();
  return !/^(?:should|shall|do|does|did|is|are|why|how|what|when|whether|if)\b/.test(lead);
}

const FILLER = "please|pls|let's|lets|can you|could you|would you|just|ok|okay|then|and|so";

/** The message with the "make it a task" phrase and the filler around it taken out ("please make this a task" is empty). */
export function stripTaskPhrase(text: string): string {
  let t = text.replace(/\s+/g, " ").trim();
  for (const re of TASK_PHRASES) t = t.replace(new RegExp(re.source, "i"), " ");
  const edge = new RegExp(`^(?:(?:${FILLER})\\b|[\\s,.;:!?-])+|(?:(?:\\b(?:${FILLER}))|[\\s,.;:!?-])+$`, "gi");
  t = t.replace(edge, "").trim();
  return /[a-z0-9]/i.test(t) ? t : "";
}
