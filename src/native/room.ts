import { EventEmitter } from "node:events";
import { pondCounts, type PondCounts } from "../fleet/pond-counts.js";
import os from "node:os";
import path from "node:path";

import { toFleetState } from "../fleet/observers/squeak-native.js";
import { logger } from "../utils/logger.js";
import type { HostEvent } from "./host.js";
import { defaultTitleCall, type TitleModelCall } from "./auto-title.js";
import { appendNotebook, notebookLine, summariseOutcome } from "./duck-notebook.js";
import type { DuckRow, NativeStore, RoomAuthorKind, RoomLevel, RoomPostKind, RoomPostRow } from "./store.js";
import { resolveOwnerName } from "./thread-context.js";
import {
  askOf,
  firstSentence,
  type RoomAsk,
  type RoomDucklings,
  type RoomProgress,
  type RoomTurn,
  type TurnBase,
  TurnReader,
} from "./room-turns.js";
import { TimelineLog } from "./timeline-log.js";
import type { TimelineEvent } from "./timeline.js";
import type { SessionRow } from "./types.js";

/**
 * A pond's room: a time-ordered stream of short posts saying what each agent is working on (intent, not every edit),
 * where the person talks too. Two levels: `room` (what a person sees) and `agents` (coordination). This Mac only.
 */

import { AttachmentError, checkAttachments, RoomAttachments, type RoomAttachment } from "./room-attachments.js";

export const ROOM_MAX_TEXT = 500;
export const ROOM_AGENT_POSTS_PER_HOUR = 30;
export const ROOM_THREAD_WINDOW_MS = 24 * 3_600_000;
export const ROOM_VIEWED_MS = 10 * 60_000;

export const ROOM_KINDS: readonly RoomPostKind[] = ["working", "done", "needs", "message", "handoff"];
export const ROOM_LEVELS: readonly RoomLevel[] = ["room", "agents"];

export class RoomError extends Error {}

export interface RoomPost {
  seq: number;
  id: string;
  author: { kind: RoomAuthorKind; id?: string; name: string };
  sessionId?: string;
  kind: RoomPostKind;
  level: RoomLevel;
  text: string;
  toSessionId?: string;
  /** Pictures and files the person attached (a person's message only). */
  attachments?: RoomAttachment[];
  at: number;
}

/** Where a duck works: a stream (a git worktree on its own branch). Absent for Main or a plain-folder pond. */
export interface DuckPlace {
  kind: "stream";
  workspaceId: string;
  branch: string;
}

/** One duck of the pond with its current place (GET .../ducks). */
export interface DuckView {
  id: string;
  projectId: string;
  name: string;
  role?: string;
  colourSeed: string;
  duty: "on" | "off";
  /** The duck's current session; absent for a duck that has not worked yet. */
  currentSessionId?: string;
  place?: DuckPlace;
  /** Members' own ducks (design only, `pondOwnThreads` stays off): which Mac runs this duck. Never set today. */
  nest?: string;
  /** Members' own ducks (design only): the member whose machine this duck runs on ("Powered by ..."). Never set today. */
  poweredBy?: string;
  state: "working" | "waiting" | "idle" | "error";
  lastActiveAt: number;
  /** How many sessions it has had (the current one and its history). */
  sessions: number;
  notebook: string;
  createdAt: number;
}

export interface RoomThread {
  /** The duck's id (one thread per duck). */
  duckId?: string;
  /** Keeps the duck's colour stable: a migrated duck's first session id, else the duck id. */
  colourSeed?: string;
  /** Where the duck works now; absent for Main or when it has no session. */
  place?: DuckPlace;
  /** Members' own ducks (design only): which Mac runs this duck. Never set today. */
  nest?: string;
  /** Members' own ducks (design only): "Powered by <member>". Never set today. */
  poweredBy?: string;
  /** The duck's current session; empty for a duck that has not worked yet. */
  sessionId: string;
  title: string;
  /** The duck's name: the person's chosen one, else the chat title. */
  name: string;
  /** One line the person set for what this duck is for. */
  role?: string;
  /** "off" = the person closed the duck's tab: never suggested for jobs, never woken. */
  duty: "on" | "off";
  /** When the chat last did anything (ms epoch). */
  lastActiveAt: number;
  agent: string;
  state: "working" | "waiting" | "idle" | "error";
  workingOn?: string;
  workingOnAt?: number;
  /** How its last turn ended; "idle" when it has none. Set for every thread, working ones included. */
  lastState: "finished" | "stopped" | "error" | "idle";
  /** When that turn ended (ms epoch), else the chat's last activity. */
  lastAt: number;
  /** The progress strip the agent set (`set_progress`), while it works. */
  progress?: RoomProgress;
  /** What a waiting chat asks: the question and its lettered options, from its last message. */
  ask?: RoomAsk;
  /** When the current turn started (ms epoch), while one runs. */
  turnStartedAt?: number;
  /** Files changed in the stream: not carried by the host yet (it costs a git run per chat). */
  filesChanged?: number;
}

export type { RoomAsk, RoomDucklings, RoomProgress, RoomTurn } from "./room-turns.js";

export const DUCK_NAME_MAX = 32;
export const DUCK_ROLE_MAX = 80;

export const ROOM_TURNS_MAX = 100;
export const ROOM_TURN_FRAME_MS = 500;

export function toRoomPost(r: RoomPostRow): RoomPost {
  return {
    seq: r.seq,
    id: r.id,
    // A person's post made on this Mac is the owner's (the room is this Mac's own); older rows were stored without an id.
    author: {
      kind: r.authorKind,
      ...(r.authorId ? { id: r.authorId } : r.authorKind === "person" ? { id: "owner" } : {}),
      name: r.authorName,
    },
    ...(r.sessionId ? { sessionId: r.sessionId } : {}),
    kind: r.kind,
    level: r.level,
    text: r.text,
    ...(r.toSessionId ? { toSessionId: r.toSessionId } : {}),
    at: r.at,
  };
}

/** The pond a chat belongs to: its workspace's project, else the project whose folder it runs in. */
export function projectOfSession(store: NativeStore, s: SessionRow): { id: string; name: string } | null {
  const viaWorkspace = s.workspaceId ? (store.getWorkspace(s.workspaceId)?.projectId ?? null) : null;
  const project =
    (viaWorkspace ? store.getProject(viaWorkspace) : null) ??
    store.listProjects().find((p) => path.resolve(p.rootPath) === path.resolve(s.cwd)) ??
    null;
  return project ? { id: project.id, name: project.name } : null;
}

export interface NewRoomPost {
  projectId: string;
  author: { kind: RoomAuthorKind; id?: string; name: string };
  sessionId?: string;
  kind: RoomPostKind;
  level?: RoomLevel;
  text: string;
  toSessionId?: string;
  /** A person's pictures and files, as the Mac sent them (checked here: PNG/JPEG by bytes, size and count limits). */
  attachments?: unknown;
  /** Squeak's own start/end lines: a fixed id makes a replayed event a no-op. */
  id?: string;
  at?: number;
}

export interface RoomOptions {
  store: NativeStore;
  /** The pond member name for the owner, when there is one (else the macOS full name, else "owner"). */
  ownerName?: () => string | null;
  now?: () => number;
  /** A model call that writes a notebook line's outcome (Haiku); absent or failing = the plain line. */
  notebookSummary?: TitleModelCall | "default";
  /** Where attachments' bytes are kept (the support dir's `room-attachments`); a temp folder when absent (tests). */
  attachmentsDir?: string;
}

/** Emits `post` (a `RoomPostRow`) for every new post. */
export class Room extends EventEmitter {
  private readonly store: NativeStore;
  private readonly now: () => number;
  readonly attachments: RoomAttachments;
  private readonly viewed = new Map<string, number>();
  private readonly streams = new Map<string, number>();
  private readonly sent = new Map<string, number[]>();
  private readonly log: TimelineLog;
  private readonly reader: TurnReader;
  /** Per chat: each subagent's state by tool-use id, as the host's tracker last said (a task-notification ends an async one). */
  private readonly helperStates = new Map<string, Map<string, "running" | "done" | "failed">>();
  private readonly frames = new Map<string, { last: number; timer: NodeJS.Timeout | null }>();

  constructor(private readonly options: RoomOptions) {
    super();
    this.setMaxListeners(0);
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.attachments = new RoomAttachments(
      options.store,
      options.attachmentsDir ?? path.join(os.tmpdir(), `squeak-room-attachments-${process.pid}`),
    );
    this.log = new TimelineLog(options.store.db);
    this.reader = new TurnReader(this.log, this.now);
    try {
      this.migrateDucks();
    } catch (error) {
      logger.warn("duck migration failed", { error: String(error) });
    }
  }

  /** Every session in a pond, and every one with an older duck row, becomes a duck once (idempotent). */
  private migrateDucks(): void {
    for (const p of this.store.listProjects()) this.sessionsOf(p.id);
    for (const id of this.store.legacyDuckSessionIds()) {
      const s = this.store.getSession(id);
      const pond = s ? projectOfSession(this.store, s) : null;
      if (s && pond) this.store.duckForSession(s.id, pond.id);
    }
  }

  /** The duck a chat belongs to, made when it has none. */
  duckOfSession(s: SessionRow): DuckRow | null {
    const pond = projectOfSession(this.store, s);
    return this.store.duckForSession(s.id, pond?.id ?? "");
  }

  ownerName(): string {
    return resolveOwnerName(this.options.ownerName?.() ?? null);
  }

  /** Text as a post carries it: trimmed; one line unless it is a message; 1 to 500 characters. */
  static cleanText(raw: unknown, kind: RoomPostKind): string {
    if (typeof raw !== "string") throw new RoomError("text must be text");
    let t = raw.trim();
    if (kind !== "message") t = t.replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ");
    if (!t) throw new RoomError("A post can't be empty.");
    if ([...t].length > ROOM_MAX_TEXT) throw new RoomError(`Keep a post under ${ROOM_MAX_TEXT} characters.`);
    return t;
  }

  /** Validates and stores a post; no rate limit (see `agentPost`). */
  post(input: NewRoomPost): RoomPostRow {
    if (!ROOM_KINDS.includes(input.kind)) throw new RoomError("Unknown post kind.");
    const level = input.level ?? "room";
    if (!ROOM_LEVELS.includes(level)) throw new RoomError("level must be room or agents.");
    if (!this.store.getProject(input.projectId)) throw new RoomError("No such pond.");
    if (input.id) {
      const existing = this.store.roomPostById(input.id);
      if (existing) return existing;
    }
    const name = input.author.name.replace(/[\r\n]+/g, " ").trim() || "Someone";
    let checked: ReturnType<typeof checkAttachments>;
    try {
      checked = checkAttachments(input.attachments);
    } catch (error) {
      if (error instanceof AttachmentError) throw new RoomError(error.message);
      throw error;
    }
    if (checked.length > 0 && (input.author.kind !== "person" || input.kind !== "message")) {
      throw new RoomError("Only a person's message takes attachments.");
    }
    // A picture or file alone is a message: the text may be empty then.
    const text =
      checked.length > 0 && typeof input.text === "string" && !input.text.trim()
        ? ""
        : Room.cleanText(input.text, input.kind);
    const row = this.store.addRoomPost({
      ...(input.id ? { id: input.id } : {}),
      projectId: input.projectId,
      authorKind: input.author.kind,
      authorId: input.author.id ?? null,
      authorName: name.slice(0, 80),
      sessionId: input.sessionId ?? null,
      kind: input.kind,
      level,
      text,
      toSessionId: input.toSessionId ?? null,
      at: input.at ?? this.now(),
    });
    if (checked.length > 0) {
      try {
        this.attachments.save(input.projectId, row.id, checked);
      } catch (error) {
        this.store.deleteRoomPost(row.id);
        if (error instanceof AttachmentError) throw new RoomError(error.message);
        throw error;
      }
    }
    this.emit("post", row);
    return row;
  }

  /** The person's post. */
  personPost(projectId: string, text: unknown, level: RoomLevel = "room", attachments?: unknown): RoomPostRow {
    return this.post({
      ...(attachments !== undefined ? { attachments } : {}),
      projectId,
      author: { kind: "person", id: "owner", name: this.ownerName() },
      kind: "message",
      level,
      text: text as string,
    });
  }

  /** An agent's own post, limited to 30 an hour per chat. */
  agentPost(
    s: SessionRow,
    input: { kind: RoomPostKind; level?: RoomLevel; text: string; toSessionId?: string },
  ): RoomPostRow {
    const pond = projectOfSession(this.store, s);
    if (!pond) throw new RoomError("This chat isn't in a pond, so it has no room to post to.");
    const hour = this.now() - 3_600_000;
    const recent = (this.sent.get(s.id) ?? []).filter((t) => t > hour);
    if (recent.length >= ROOM_AGENT_POSTS_PER_HOUR) {
      this.sent.set(s.id, recent);
      throw new RoomError("This chat has posted enough to the room this hour; keep to what matters.");
    }
    const row = this.post({
      projectId: pond.id,
      author: { kind: "agent", id: s.id, name: agentName(s) },
      sessionId: s.id,
      ...input,
    });
    recent.push(this.now());
    this.sent.set(s.id, recent);
    return row;
  }

  /** The wire form of posts, with their attachments. */
  toPosts(projectId: string, rows: RoomPostRow[]): RoomPost[] {
    const atts = this.attachments.forPosts(
      projectId,
      rows.filter((r) => r.authorKind === "person").map((r) => r.id),
    );
    return rows.map((r) => {
      const a = atts.get(r.id);
      return a?.length ? { ...toRoomPost(r), attachments: a } : toRoomPost(r);
    });
  }

  /** Posts for the room's page: `since` forwards, `before` backwards, else the newest. Oldest first. */
  page(
    projectId: string,
    opts: { since?: number; before?: number; limit?: number },
  ): { posts: RoomPost[]; latestSeq: number; threads: RoomThread[]; turns: RoomTurn[]; counts?: PondCounts } {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 100));
    const rows = this.store
      .roomPosts(projectId, {
        ...(opts.since !== undefined ? { since: opts.since } : {}),
        ...(opts.before !== undefined ? { before: opts.before } : {}),
        limit,
      })
      .filter((r) => !isSqueakLine(r));
    const posts = this.toPosts(projectId, rows);
    // The turns that started inside the posts' time window: the newest page covers the last 24 h.
    let from = this.now() - ROOM_THREAD_WINDOW_MS;
    let to = Infinity;
    if (opts.since !== undefined) {
      from = this.store.roomPostAtSeq(projectId, opts.since) ?? posts[0]?.at ?? from;
    } else if (opts.before !== undefined) {
      if (posts.length === 0)
        return { posts, latestSeq: this.store.latestRoomSeq(projectId), threads: this.threads(projectId), turns: [] };
      from = posts[0]!.at;
      to = posts[posts.length - 1]!.at;
    }
    return {
      posts,
      latestSeq: this.store.latestRoomSeq(projectId),
      threads: this.threads(projectId),
      turns: this.turns(projectId, from, to),
      counts: this.duckCounts(projectId),
    };
  }

  /** Turns that started in `[from, to]`, oldest to newest, at most the newest 100. */
  turns(projectId: string, from: number, to = Infinity): RoomTurn[] {
    const out: RoomTurn[] = [];
    for (const s of this.sessionsOf(projectId)) {
      for (const t of this.reader.turns(s.id)) {
        // A person's direct chat with a duck is never the room's: only turns sent from the room.
        if (t.room && t.startedAt >= from && t.startedAt <= to) out.push(this.toTurn(s, t));
      }
    }
    out.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
    return out.slice(-ROOM_TURNS_MAX);
  }

  private toTurn(s: SessionRow, t: TurnBase): RoomTurn {
    const running = t.endedAt === undefined;
    const intent = running ? this.store.latestWorkingPost(s.id, t.startedAt, Infinity)?.text : undefined;
    const progress = running ? this.progressOf(s.id, t.startSeq) : undefined;
    const outcomeText = !running && t.reply ? firstSentence(t.reply) : "";
    const owner = t.authorName === undefined;
    const ducklings = this.ducklingsOf(s.id, t.turnId);
    const duckId = this.store.duckBySession(s.id)?.id;
    return {
      id: `${s.id}:${t.turnId}`,
      sessionId: s.id,
      ...(duckId ? { duckId } : {}),
      threadTitle: this.duckName(s),
      agent: s.agent,
      startedAt: t.startedAt,
      ...(t.endedAt !== undefined ? { endedAt: t.endedAt, durationMs: Math.max(0, t.endedAt - t.startedAt) } : {}),
      ...(t.outcome ? { outcome: t.outcome } : {}),
      prompt: t.prompt,
      author: { kind: "person", name: owner ? this.ownerName() : t.authorName!, me: owner },
      ...(t.answer ? { answer: t.answer } : {}),
      ...(outcomeText ? { outcomeText } : {}),
      ...(intent ? { intent } : {}),
      ...(progress ? { progress: { current: progress.current, total: progress.total } } : {}),
      ...(ducklings ? { ducklings } : {}),
    };
  }

  /** The subagents a turn started, from its Agent/Task tool steps: how many, how many are over, and each one. */
  private ducklingsOf(sessionId: string, turnId: string): RoomDucklings | undefined {
    const byStep = new Map<string, { label: string; state: "running" | "done" | "failed" }>();
    const tracked = this.helperStates.get(sessionId);
    for (const e of this.log.duckSteps(sessionId, turnId)) {
      // An async launch's step ends at once; the helper runs until its <task-notification> says how it ended.
      byStep.set(e.stepId, { label: e.label, state: tracked?.get(e.stepId) ?? e.status });
    }
    const items = [...byStep.values()].slice(0, 12).map((i) => ({
      label: i.label.replace(/^Start (a |the )?/i, "").replace(/ in the background$/, "") || i.label,
      state: i.state,
    }));
    if (byStep.size === 0) return undefined;
    return {
      count: byStep.size,
      done: [...byStep.values()].filter((i) => i.state !== "running").length,
      items,
    };
  }

  /** The progress strip as it stands in the turn that began at `startSeq`: step `current` of `total`. */
  private progressOf(sessionId: string, startSeq: number): RoomProgress | undefined {
    const detail = this.log.latestProgress(sessionId, startSeq)?.detail;
    const steps = Array.isArray(detail?.steps) ? (detail.steps as unknown[]).map(String) : [];
    if (steps.length === 0) return undefined;
    const at = typeof detail?.current === "number" ? detail.current : 0;
    const index = Math.min(steps.length - 1, Math.max(0, at));
    const label = steps[index] || (typeof detail?.status === "string" ? detail.status : "");
    return { current: index + 1, total: steps.length, ...(label ? { label } : {}) };
  }

  /**
   * A timeline event (or a new `working` post) may change a turn the Mac shows: tell `turn` listeners, at most one
   * frame per turn per 500 ms (a burst sends its newest state once, after the window).
   */
  noteTimeline(sessionId: string, event: TimelineEvent | { type: string }): void {
    const t = event.type;
    const turnId = (event as { turnId?: string }).turnId;
    const relevant =
      t === "turn.started" ||
      t === "turn.ended" ||
      t === "reply.done" ||
      (t === "step.updated" && (event as { stepId?: string }).stepId === "progress") ||
      // A duckling (Agent/Task step) starting or ending changes the turn's ducklings.
      ((t === "step.added" || t === "step.updated") && isDucklingStep(event));
    if (!relevant || !turnId) return;
    if (t === "turn.ended") {
      try {
        this.noteTurnEnded(sessionId, turnId);
      } catch (error) {
        logger.warn("duck notebook failed", { error: String(error) });
      }
    }
    this.scheduleTurn(sessionId, turnId);
  }

  /**
   * The host's helper list for a chat changed (a start, or a report ending an async one): remember each helper's
   * state by tool-use id and send a `turn` frame for every turn whose subagent changed.
   */
  noteHelpers(sessionId: string, items: Array<{ id: string; status: string }>): void {
    const next = new Map<string, "running" | "done" | "failed">();
    for (const i of items) next.set(i.id, i.status === "running" ? "running" : i.status === "done" ? "done" : "failed");
    const prev = this.helperStates.get(sessionId);
    if (next.size === 0) this.helperStates.delete(sessionId);
    else this.helperStates.set(sessionId, next);
    const changed = [...next].filter(([id, st]) => prev?.get(id) !== st).map(([id]) => id);
    if (changed.length === 0) return;
    for (const t of this.reader.turns(sessionId).slice(-6)) {
      if (this.log.duckSteps(sessionId, t.turnId).some((e) => changed.includes(e.stepId))) {
        this.scheduleTurn(sessionId, t.turnId);
      }
    }
  }

  /** A `working` post names what the chat's running turn is doing. */
  noteWorking(sessionId: string): void {
    const open = this.reader
      .turns(sessionId)
      .filter((t) => t.endedAt === undefined)
      .pop();
    if (open) this.scheduleTurn(sessionId, open.turnId);
  }

  private scheduleTurn(sessionId: string, turnId: string): void {
    const key = `${sessionId}:${turnId}`;
    const f = this.frames.get(key) ?? { last: -Infinity, timer: null };
    this.frames.set(key, f);
    if (f.timer) return;
    const wait = f.last + ROOM_TURN_FRAME_MS - this.now();
    if (wait <= 0) return this.emitTurn(key, sessionId, turnId);
    f.timer = setTimeout(() => {
      f.timer = null;
      this.emitTurn(key, sessionId, turnId);
    }, wait);
    f.timer.unref();
  }

  private emitTurn(key: string, sessionId: string, turnId: string): void {
    const f = this.frames.get(key);
    if (f) f.last = this.now();
    try {
      const s = this.store.getSession(sessionId);
      const pond = s ? projectOfSession(this.store, s) : null;
      const base = s ? this.reader.turns(sessionId).find((x) => x.turnId === turnId) : undefined;
      if (!s || !pond || !base?.room) return;
      this.emit("turn", { projectId: pond.id, turn: this.toTurn(s, base) });
      if (base.endedAt !== undefined) {
        // An ended turn changes no more (but a late reply may still land): forget its window soon.
        setTimeout(() => this.frames.delete(key), 2 * ROOM_TURN_FRAME_MS).unref();
      }
    } catch (error) {
      logger.warn("room turn frame failed", { error: String(error) });
    }
  }

  /**
   * Once per install: every duck quiet for more than a day starts off duty. Before closing a duck existed every old chat
   * stayed on duty, so a pond listed all of them; a duck working or waiting on the person is never put off duty.
   */
  retireStaleDucksOnce(): number {
    if (!this.store.markOnce("ducks-duty-cleanup-v1", this.now())) return 0;
    const cutoff = this.now() - 24 * 60 * 60_000;
    let off = 0;
    for (const p of this.store.listProjects()) {
      this.sessionsOf(p.id); // makes a duck of any chat that has none yet
      for (const d of this.store.listDucks(p.id)) {
        if (d.duty !== "on") continue;
        const s = d.currentSessionId ? this.store.getSession(d.currentSessionId) : null;
        if (s && (s.status === "working" || /^(awaiting_|needs_)/.test(s.status))) continue;
        const last = Date.parse(s?.updatedAt ?? d.createdAt);
        if (Number.isFinite(last) && last > cutoff) continue;
        this.store.updateDuck(d.id, { duty: "off" });
        off += 1;
      }
    }
    return off;
  }

  /** When a duck was last put on duty in this run (a duck put back on duty gets a fresh hour). */
  private readonly onDutyAt = new Map<string, number>();

  /**
   * Puts every on-duty duck with no new work for `idleMs` off duty (history stays). Busy means a running or waiting turn,
   * or a Task it holds (`busyDuckIds`, from the Tasks); a new message in any of its chats counts as work.
   */
  retireIdleDucks(busyDuckIds: ReadonlySet<string> = new Set(), idleMs = 3_600_000): number {
    const cutoff = this.now() - idleMs;
    let off = 0;
    for (const p of this.store.listProjects()) {
      this.sessionsOf(p.id);
      for (const d of this.store.listDucks(p.id)) {
        if (d.duty !== "on" || busyDuckIds.has(d.id)) continue;
        let last = Math.max(Date.parse(d.createdAt) || 0, this.onDutyAt.get(d.id) ?? 0);
        let busy = false;
        for (const sid of this.store.duckSessionIds(d.id)) {
          const s = this.store.getSession(sid);
          if (!s) continue;
          if (s.status === "working" || /^(awaiting_|needs_)/.test(s.status)) busy = true;
          last = Math.max(last, Date.parse(s.updatedAt) || 0);
        }
        if (busy || last > cutoff) continue;
        this.setDutyById(d.id, false);
        off += 1;
      }
    }
    return off;
  }

  private sessionsOf(projectId: string): SessionRow[] {
    const project = this.store.getProject(projectId);
    if (!project) return [];
    const streams = new Set(this.store.listWorkspaces(projectId).map((w) => w.id));
    const mine = this.store
      .listSessions()
      .filter((s) => !s.archivedAt && (s.workspaceId ? streams.has(s.workspaceId) : s.cwd === project.rootPath));
    // A chat with no duck yet becomes one (its own, seeded by its id), so the room is all ducks.
    const mapped = this.store.mappedSessionIds();
    for (const s of mine) if (!mapped.has(s.id)) this.store.duckForSession(s.id, projectId);
    return mine;
  }

  /** A chat's turns (not agent-run ones), oldest first. */
  sessionTurns(sessionId: string): TurnBase[] {
    return this.reader.turns(sessionId);
  }

  /** The files a duck's chats changed, newest first, each once (the decider's code areas). */
  touchedFiles(duckId: string): string[] {
    const out: string[] = [];
    for (const id of [...this.store.duckSessionIds(duckId)].reverse()) {
      for (const f of this.log.touchedFiles(id)) if (!out.includes(f)) out.push(f);
    }
    return out.slice(0, 60);
  }

  /** The pond's on-duty, non-archived chats active within `windowMs`, newest activity first, with their state (job matching). */
  candidates(
    projectId: string,
    windowMs: number,
    opts: { offDuty?: boolean } = {},
  ): Array<{ session: SessionRow; state: RoomThread["state"]; at: number }> {
    const cutoff = this.now() - windowMs;
    const off = opts.offDuty ? new Set<string>() : this.store.offDutyIds();
    return this.sessionsOf(projectId)
      .filter((s) => !off.has(s.id))
      .map((s) => ({ session: s, state: threadState(s.status, s.lastTurnEndedAt), at: Date.parse(s.updatedAt) }))
      .filter((x) => Number.isFinite(x.at) && x.at >= cutoff)
      .sort((a, b) => b.at - a.at || a.session.id.localeCompare(b.session.id));
  }

  /** Where a chat runs: its stream, else nothing (Main, or a plain folder). */
  placeOf(s: SessionRow | null): DuckPlace | undefined {
    const ws = s?.workspaceId ? this.store.getWorkspace(s.workspaceId) : null;
    return ws && ws.state !== "archived" ? { kind: "stream", workspaceId: ws.id, branch: ws.branch } : undefined;
  }

  /** The ducks of a pond with a current place, matching and listing: sessionless ones always, others while their chat is recent. */
  duckCandidates(
    projectId: string,
    windowMs: number,
    opts: { offDuty?: boolean } = {},
  ): Array<{ duck: DuckRow; session: SessionRow | null; state: RoomThread["state"]; at: number }> {
    if (!this.store.getProject(projectId)) return [];
    this.sessionsOf(projectId); // makes ducks for chats that have none
    const cutoff = this.now() - windowMs;
    const out: Array<{ duck: DuckRow; session: SessionRow | null; state: RoomThread["state"]; at: number }> = [];
    for (const duck of this.store.listDucks(projectId)) {
      if (!opts.offDuty && duck.duty === "off") continue;
      const session = duck.currentSessionId ? this.store.getSession(duck.currentSessionId) : null;
      if (session) {
        if (session.archivedAt) continue;
        const at = Date.parse(session.updatedAt);
        if (!Number.isFinite(at) || at < cutoff) continue;
        out.push({ duck, session, state: threadState(session.status, session.lastTurnEndedAt), at });
      } else if (this.store.duckSessionIds(duck.id).length === 0) {
        out.push({ duck, session: null, state: "idle", at: Date.parse(duck.createdAt) || 0 });
      }
    }
    return out.sort((a, b) => b.at - a.at || a.duck.id.localeCompare(b.duck.id));
  }

  /** The pond's ducks active in the last 24 h (and those that have not worked yet), newest activity first. */
  threads(projectId: string): RoomThread[] {
    if (!this.store.getProject(projectId)) return [];
    const marks = this.store.latestRoomMarks(projectId);
    return this.duckCandidates(projectId, ROOM_THREAD_WINDOW_MS, { offDuty: true }).map((c) =>
      c.session ? this.threadOf(c.session, marks) : this.threadOfDuck(c.duck),
    );
  }

  /** A duck that has not worked yet: a name and a role, no place. */
  threadOfDuck(duck: DuckRow): RoomThread {
    const at = Date.parse(duck.createdAt) || 0;
    return {
      duckId: duck.id,
      colourSeed: duck.colourSeed,
      sessionId: "",
      title: duck.name ?? "Duck",
      name: duck.name ?? "Duck",
      ...(duck.role ? { role: duck.role } : {}),
      duty: duck.duty,
      lastActiveAt: at,
      agent: "claude",
      state: "idle",
      lastState: "idle",
      lastAt: at,
    };
  }

  /** The duck's view for GET .../ducks. */
  duckView(duck: DuckRow): DuckView {
    const s = duck.currentSessionId ? this.store.getSession(duck.currentSessionId) : null;
    const created = Date.parse(duck.createdAt) || 0;
    const at = s ? Date.parse(s.updatedAt) : created;
    const place = this.placeOf(s);
    return {
      id: duck.id,
      projectId: duck.projectId,
      name: duck.name ?? (s ? agentName(s) : "Duck"),
      ...(duck.role ? { role: duck.role } : {}),
      colourSeed: duck.colourSeed,
      duty: duck.duty,
      ...(s ? { currentSessionId: s.id } : {}),
      ...(place ? { place } : {}),
      state: s ? threadState(s.status, s.lastTurnEndedAt) : "idle",
      lastActiveAt: Number.isFinite(at) ? at : created,
      sessions: this.store.duckSessionIds(duck.id).length,
      notebook: duck.notebook,
      createdAt: created,
    };
  }

  /** Every duck of the pond worth listing (sessionless ones, and those whose chat was active in 30 days). */
  listDucks(projectId: string): DuckView[] {
    return this.duckCandidates(projectId, 30 * 24 * 3_600_000, { offDuty: true })
      .map((c) => this.duckView(c.duck))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt || a.id.localeCompare(b.id));
  }

  /** The pond dashboard's numbers over the ducks `listDucks` lists (`fleet/pond-counts.ts`). */
  duckCounts(projectId: string): PondCounts {
    return pondCounts(
      this.listDucks(projectId).map((d) => ({
        duty: d.duty,
        working: d.state === "working",
        needsYou: d.state === "waiting",
      })),
    );
  }

  /** An identity with no session yet: a name (1..32) and an optional role. */
  createDuck(projectId: string, input: { name?: unknown; role?: unknown }): DuckView {
    if (!this.store.getProject(projectId)) throw new RoomError("No such pond.");
    const patch = cleanDuckPatch({ name: input.name, ...(input.role !== undefined ? { role: input.role } : {}) });
    if (!patch.name) throw new RoomError("name is required");
    const duck = this.store.createDuck({ projectId, name: patch.name, role: patch.role ?? null });
    this.emitDuck(duck.id);
    return this.duckView(duck);
  }

  /** One chat as a room thread (a `thread` frame carries it alone). */
  threadOf(s: SessionRow, marks = this.store.latestRoomMarks(projectIdOf(this.store, s))): RoomThread {
    const m = marks.get(s.id);
    const ended = this.log.lastEnded(s.id);
    const endedAt = ended ? Date.parse(ended.at) : NaN;
    const on = m?.working && !(m.done && m.done.seq > m.working.seq) ? m.working : undefined;
    const state = threadState(s.status, s.lastTurnEndedAt);
    const turns = this.reader.turns(s.id);
    const last = turns[turns.length - 1];
    const open = last && last.endedAt === undefined ? last : undefined;
    const progress = state === "working" && open ? this.progressOf(s.id, open.startSeq) : undefined;
    const ask = state === "waiting" ? askOf(last?.reply) : null;
    const duck = this.duckOfSession(s);
    const place = this.placeOf(s);
    return {
      ...(duck ? { duckId: duck.id, colourSeed: duck.colourSeed } : {}),
      ...(place ? { place } : {}),
      sessionId: s.id,
      title: s.title ?? "Untitled",
      name: duck?.name ?? agentName(s),
      ...(duck?.role ? { role: duck.role } : {}),
      duty: duck?.duty ?? "on",
      lastActiveAt: Date.parse(s.updatedAt),
      agent: s.agent,
      state,
      ...(on ? { workingOn: on.text, workingOnAt: on.at } : {}),
      lastState: !ended
        ? "idle"
        : ended.outcome === "done"
          ? "finished"
          : ended.outcome === "stopped"
            ? "stopped"
            : "error",
      lastAt: Number.isFinite(endedAt) ? endedAt : Date.parse(s.updatedAt),
      ...(progress ? { progress } : {}),
      ...(ask ? { ask } : {}),
      ...(open ? { turnStartedAt: open.startedAt } : {}),
    };
  }

  /** The duck's name: the person's, else the chat title. */
  duckName(s: SessionRow): string {
    return this.store.duckOf(s.id).name ?? agentName(s);
  }

  /** Changes a chat's duck name and/or role (null clears) and tells `thread` listeners. */
  setDuck(sessionId: string, patch: { name?: unknown; role?: unknown }): { name: string; role?: string } {
    const s = this.store.getSession(sessionId);
    if (!s) throw new RoomError("No such chat.");
    const duck = this.duckOfSession(s);
    if (!duck) throw new RoomError("No such chat.");
    return this.setDuckById(duck.id, patch, s);
  }

  /** Changes a duck's name and/or role (null clears) and tells `thread` listeners. */
  setDuckById(
    duckId: string,
    patch: { name?: unknown; role?: unknown },
    via?: SessionRow,
  ): { name: string; role?: string } {
    const duck = this.store.duckRow(duckId);
    if (!duck) throw new RoomError("No such duck.");
    this.store.updateDuck(duckId, cleanDuckPatch(patch));
    this.emitDuck(duckId);
    const t = this.store.duckRow(duckId)!;
    const cur = via ?? (t.currentSessionId ? this.store.getSession(t.currentSessionId) : null);
    return { name: t.name ?? (cur ? agentName(cur) : "Duck"), ...(t.role ? { role: t.role } : {}) };
  }

  /** Puts a chat's duck on or off duty; tells `thread` listeners only on a change. */
  setDuty(sessionId: string, on: boolean): "on" | "off" {
    const s = this.store.getSession(sessionId);
    if (!s) throw new RoomError("No such chat.");
    const duck = this.duckOfSession(s);
    if (!duck) throw new RoomError("No such chat.");
    return this.setDutyById(duck.id, on);
  }

  setDutyById(duckId: string, on: boolean): "on" | "off" {
    const duck = this.store.duckRow(duckId);
    if (!duck) throw new RoomError("No such duck.");
    if (duck.duty !== (on ? "on" : "off")) {
      this.store.updateDuck(duckId, { duty: on ? "on" : "off" });
      if (on) this.onDutyAt.set(duckId, this.now());
      this.emitDuck(duckId);
    }
    return on ? "on" : "off";
  }

  /** Tells `thread` listeners the duck changed (its place, name, role, duty). */
  emitDuck(duckId: string): void {
    try {
      const duck = this.store.duckRow(duckId);
      if (!duck?.projectId) return;
      const s = duck.currentSessionId ? this.store.getSession(duck.currentSessionId) : null;
      this.emit("thread", { projectId: duck.projectId, thread: s ? this.threadOf(s) : this.threadOfDuck(duck) });
    } catch (error) {
      logger.warn("room thread frame failed", { error: String(error) });
    }
  }

  // ---- the notebook ----

  private readonly notebookChain = new Map<string, Promise<void>>();
  private readonly notebooked = new Set<string>();

  /** Resolves when the notebook writes so far are done (tests). */
  notebookIdle(): Promise<void> {
    return Promise.all([...this.notebookChain.values()]).then(() => undefined);
  }

  /** A turn of a duck's chat ended: one compact line in its notebook (a model sentence when one answers in time). */
  private noteTurnEnded(sessionId: string, turnId: string): void {
    const key = `${sessionId}:${turnId}`;
    if (this.notebooked.has(key)) return;
    const s = this.store.getSession(sessionId);
    const duck = s ? this.duckOfSession(s) : null;
    if (!s || !duck) return;
    this.notebooked.add(key);
    const prev = this.notebookChain.get(duck.id) ?? Promise.resolve();
    const run = prev
      .then(() => this.writeNotebook(duck.id, s, turnId))
      .catch((error) => logger.warn("duck notebook failed", { error: String(error) }))
      .finally(() => {
        if (this.notebookChain.get(duck.id) === run) this.notebookChain.delete(duck.id);
      });
    this.notebookChain.set(duck.id, run);
  }

  private async writeNotebook(duckId: string, s: SessionRow, turnId: string): Promise<void> {
    const t = this.reader.turns(s.id).find((x) => x.turnId === turnId);
    if (!t || t.endedAt === undefined) return;
    const plain = t.reply ? firstSentence(t.reply) : "";
    let outcome = plain;
    const opt = this.options.notebookSummary;
    if (opt && t.reply && t.reply.length > 200) {
      const call = opt === "default" ? (this.summaryCall ??= defaultTitleCall()) : opt;
      outcome = (await summariseOutcome(call, t.prompt, t.reply)) ?? plain;
    }
    const duck = this.store.duckRow(duckId);
    if (!duck) return;
    const ws = s.workspaceId ? this.store.getWorkspace(s.workspaceId) : null;
    const line = notebookLine({
      at: t.endedAt,
      job: t.prompt,
      outcome,
      ...(t.outcome ? { ended: t.outcome } : {}),
      branch: ws?.branch ?? null,
    });
    this.store.updateDuck(duckId, { notebook: appendNotebook(duck.notebook, line) });
  }

  private summaryCall: TitleModelCall | null = null;

  /** A person (or a stream) looked at the room. */
  markViewed(projectId: string): void {
    this.viewed.set(projectId, this.now());
  }

  streamOpened(projectId: string): void {
    this.markViewed(projectId);
    this.streams.set(projectId, (this.streams.get(projectId) ?? 0) + 1);
  }

  streamClosed(projectId: string): void {
    this.markViewed(projectId);
    const n = (this.streams.get(projectId) ?? 1) - 1;
    if (n <= 0) this.streams.delete(projectId);
    else this.streams.set(projectId, n);
  }

  /** Viewed in the last 10 minutes, or a stream is open now. */
  recentlyViewed(projectId: string): boolean {
    if ((this.streams.get(projectId) ?? 0) > 0) return true;
    const at = this.viewed.get(projectId);
    return at !== undefined && this.now() - at <= ROOM_VIEWED_MS;
  }
}

/** A name (1..32) and role (0..80) as the person typed them; null clears, a key left out is kept. */
export function cleanDuckPatch(patch: { name?: unknown; role?: unknown }): {
  name?: string | null;
  role?: string | null;
} {
  const clean: { name?: string | null; role?: string | null } = {};
  if (patch.name !== undefined) {
    if (patch.name === null) clean.name = null;
    else if (typeof patch.name !== "string") throw new RoomError("name must be text or null");
    else {
      const n = patch.name.replace(/\s+/g, " ").trim();
      if (n.length < 1 || [...n].length > DUCK_NAME_MAX)
        throw new RoomError(`name is 1 to ${DUCK_NAME_MAX} characters`);
      clean.name = n;
    }
  }
  if (patch.role !== undefined) {
    if (patch.role === null) clean.role = null;
    else if (typeof patch.role !== "string") throw new RoomError("role must be text or null");
    else {
      const r = patch.role.replace(/\s+/g, " ").trim();
      if ([...r].length > DUCK_ROLE_MAX) throw new RoomError(`role is at most ${DUCK_ROLE_MAX} characters`);
      clean.role = r || null;
    }
  }
  return clean;
}

function isDucklingStep(event: object): boolean {
  const e = event as { kind?: string; label?: string };
  return e.kind === "tool" && typeof e.label === "string" && e.label.startsWith("Start ");
}

function projectIdOf(store: NativeStore, s: SessionRow): string {
  return projectOfSession(store, s)?.id ?? "";
}

export function agentName(s: SessionRow): string {
  return s.title?.trim() || (s.agent === "codex" ? "Codex" : "Claude");
}

function threadState(status: string, lastTurnEndedAt: string | null): RoomThread["state"] {
  switch (toFleetState(status, lastTurnEndedAt)) {
    case "working":
      return "working";
    case "awaiting_approval":
    case "awaiting_input":
      return "waiting";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

/** The slice of the host Squeak's own posts listen to. */
export interface HostEvents {
  on(event: "event", listener: (e: HostEvent) => void): unknown;
  off(event: "event", listener: (e: HostEvent) => void): unknown;
}

/** The per-turn lines and `needs` posts Squeak used to make (the room derives turns from timelines now). */
export function isSqueakLine(r: RoomPostRow): boolean {
  return r.authorKind === "squeak" && (r.id.startsWith("sq:") || r.kind === "needs");
}

/**
 * Feeds the room's `turn` frames from the host: a turn starting, ending, closing with a reply or moving its progress
 * strip, and a new `working` line (intent). Squeak no longer posts a line per turn. Never throws.
 */
export function attachSqueakPosts(host: HostEvents, _store: NativeStore, room: Room): () => void {
  const onEvent = (e: HostEvent): void => {
    try {
      if (e.type === "timeline") room.noteTimeline(e.sessionId, e.event);
      else if (e.type === "status") room.noteHelpers(e.sessionId, e.ducklings?.items ?? []);
    } catch (error) {
      logger.warn("room watcher failed", { error: String(error) });
    }
  };
  const onPost = (p: RoomPostRow): void => {
    if (p.kind === "working" && p.sessionId) room.noteWorking(p.sessionId);
  };
  host.on("event", onEvent);
  room.on("post", onPost);
  return () => {
    host.off("event", onEvent);
    room.off("post", onPost);
  };
}
