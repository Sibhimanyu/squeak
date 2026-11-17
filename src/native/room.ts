import { EventEmitter } from "node:events";
import path from "node:path";

import { toFleetState } from "../fleet/observers/squeak-native.js";
import { logger } from "../utils/logger.js";
import type { HostEvent } from "./host.js";
import type { NativeStore, RoomAuthorKind, RoomLevel, RoomPostKind, RoomPostRow } from "./store.js";
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
  at: number;
}

export interface RoomThread {
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
    author: { kind: r.authorKind, ...(r.authorId ? { id: r.authorId } : {}), name: r.authorName },
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
  /** Squeak's own start/end lines: a fixed id makes a replayed event a no-op. */
  id?: string;
  at?: number;
}

export interface RoomOptions {
  store: NativeStore;
  /** The pond member name for the owner, when there is one (else the macOS full name, else "owner"). */
  ownerName?: () => string | null;
  now?: () => number;
}

/** Emits `post` (a `RoomPostRow`) for every new post. */
export class Room extends EventEmitter {
  private readonly store: NativeStore;
  private readonly now: () => number;
  private readonly viewed = new Map<string, number>();
  private readonly streams = new Map<string, number>();
  private readonly sent = new Map<string, number[]>();
  private readonly log: TimelineLog;
  private readonly reader: TurnReader;
  private readonly frames = new Map<string, { last: number; timer: NodeJS.Timeout | null }>();

  constructor(private readonly options: RoomOptions) {
    super();
    this.setMaxListeners(0);
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.log = new TimelineLog(options.store.db);
    this.reader = new TurnReader(this.log, this.now);
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
    const row = this.store.addRoomPost({
      ...(input.id ? { id: input.id } : {}),
      projectId: input.projectId,
      authorKind: input.author.kind,
      authorId: input.author.id ?? null,
      authorName: name.slice(0, 80),
      sessionId: input.sessionId ?? null,
      kind: input.kind,
      level,
      text: Room.cleanText(input.text, input.kind),
      toSessionId: input.toSessionId ?? null,
      at: input.at ?? this.now(),
    });
    this.emit("post", row);
    return row;
  }

  /** The person's post. */
  personPost(projectId: string, text: unknown, level: RoomLevel = "room"): RoomPostRow {
    return this.post({
      projectId,
      author: { kind: "person", name: this.ownerName() },
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

  /** Posts for the room's page: `since` forwards, `before` backwards, else the newest. Oldest first. */
  page(
    projectId: string,
    opts: { since?: number; before?: number; limit?: number },
  ): { posts: RoomPost[]; latestSeq: number; threads: RoomThread[]; turns: RoomTurn[] } {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 100));
    const rows = this.store
      .roomPosts(projectId, {
        ...(opts.since !== undefined ? { since: opts.since } : {}),
        ...(opts.before !== undefined ? { before: opts.before } : {}),
        limit,
      })
      .filter((r) => !isSqueakLine(r));
    const posts = rows.map(toRoomPost);
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
    };
  }

  /** Turns that started in `[from, to]`, oldest to newest, at most the newest 100. */
  turns(projectId: string, from: number, to = Infinity): RoomTurn[] {
    const out: RoomTurn[] = [];
    for (const s of this.sessionsOf(projectId)) {
      for (const t of this.reader.turns(s.id)) {
        if (t.startedAt >= from && t.startedAt <= to) out.push(this.toTurn(s, t));
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
    return {
      id: `${s.id}:${t.turnId}`,
      sessionId: s.id,
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
    for (const e of this.log.duckSteps(sessionId, turnId)) {
      byStep.set(e.stepId, { label: e.label, state: e.status });
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
    this.scheduleTurn(sessionId, turnId);
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
      if (!s || !pond || !base) return;
      this.emit("turn", { projectId: pond.id, turn: this.toTurn(s, base) });
      if (base.endedAt !== undefined) {
        // An ended turn changes no more (but a late reply may still land): forget its window soon.
        setTimeout(() => this.frames.delete(key), 2 * ROOM_TURN_FRAME_MS).unref();
      }
    } catch (error) {
      logger.warn("room turn frame failed", { error: String(error) });
    }
  }

  private sessionsOf(projectId: string): SessionRow[] {
    const project = this.store.getProject(projectId);
    if (!project) return [];
    const streams = new Set(this.store.listWorkspaces(projectId).map((w) => w.id));
    return this.store
      .listSessions()
      .filter((s) => !s.archivedAt && (s.workspaceId ? streams.has(s.workspaceId) : s.cwd === project.rootPath));
  }

  /** A chat's turns (not agent-run ones), oldest first. */
  sessionTurns(sessionId: string): TurnBase[] {
    return this.reader.turns(sessionId);
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

  /** The pond's non-archived chats active in the last 24 h, newest activity first, with what each is working on. */
  threads(projectId: string): RoomThread[] {
    if (!this.store.getProject(projectId)) return [];
    const cutoff = this.now() - ROOM_THREAD_WINDOW_MS;
    const marks = this.store.latestRoomMarks(projectId);
    return this.sessionsOf(projectId)
      .map((s) => ({ s, at: Date.parse(s.updatedAt) }))
      .filter((x) => Number.isFinite(x.at) && x.at >= cutoff)
      .sort((a, b) => b.at - a.at || a.s.id.localeCompare(b.s.id))
      .map(({ s }): RoomThread => this.threadOf(s, marks));
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
    const duck = this.store.duckOf(s.id);
    return {
      sessionId: s.id,
      title: s.title ?? "Untitled",
      name: duck.name ?? agentName(s),
      ...(duck.role ? { role: duck.role } : {}),
      duty: duck.duty,
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

  /** Changes a duck's name and/or role (null clears) and tells `thread` listeners. */
  setDuck(sessionId: string, patch: { name?: unknown; role?: unknown }): { name: string; role?: string } {
    const s = this.store.getSession(sessionId);
    if (!s) throw new RoomError("No such chat.");
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
    this.store.setDuck(sessionId, clean);
    this.emitThread(s);
    const t = this.store.duckOf(sessionId);
    return { name: t.name ?? agentName(s), ...(t.role ? { role: t.role } : {}) };
  }

  /** Puts a duck on or off duty; tells `thread` listeners only on a change. */
  setDuty(sessionId: string, on: boolean): "on" | "off" {
    const s = this.store.getSession(sessionId);
    if (!s) throw new RoomError("No such chat.");
    const before = this.store.duckOf(sessionId).duty;
    this.store.setDuty(sessionId, on);
    if (before !== (on ? "on" : "off")) this.emitThread(s);
    return on ? "on" : "off";
  }

  private emitThread(s: SessionRow): void {
    const pond = projectOfSession(this.store, s);
    if (!pond) return;
    try {
      this.emit("thread", { projectId: pond.id, thread: this.threadOf(s) });
    } catch (error) {
      logger.warn("room thread frame failed", { error: String(error) });
    }
  }

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
