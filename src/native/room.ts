import { EventEmitter } from "node:events";
import path from "node:path";

import { toFleetState } from "../fleet/observers/squeak-native.js";
import { logger } from "../utils/logger.js";
import type { HostEvent } from "./host.js";
import type { NativeStore, RoomAuthorKind, RoomLevel, RoomPostKind, RoomPostRow } from "./store.js";
import { resolveOwnerName } from "./thread-context.js";
import { TimelineLog } from "./timeline-log.js";
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
  agent: string;
  state: "working" | "waiting" | "idle" | "error";
  workingOn?: string;
  workingOnAt?: number;
  /** How its last turn ended; "idle" when it has none. Set for every thread, working ones included. */
  lastState: "finished" | "stopped" | "error" | "idle";
  /** When that turn ended (ms epoch), else the chat's last activity. */
  lastAt: number;
}

/** One line for a Started post: the message's first line, clipped. */
export function startedText(text: string | undefined): string {
  const first =
    (text ?? "")
      .split(/\r?\n/)
      .find((l) => l.trim())
      ?.trim()
      .replace(/\s+/g, " ") ?? "";
  if (!first) return "Started";
  const chars = [...first];
  return `Started: ${chars.length > 120 ? `${chars.slice(0, 119).join("")}…` : first}`;
}

export function endedText(outcome: string): string {
  return outcome === "stopped" ? "Stopped" : outcome === "failed" ? "Hit an error" : "Finished";
}

export const startPostId = (sessionId: string, turnId: string): string => `sq:start:${sessionId}:${turnId}`;
export const endPostId = (sessionId: string, turnId: string): string => `sq:end:${sessionId}:${turnId}`;

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

  constructor(private readonly options: RoomOptions) {
    super();
    this.setMaxListeners(0);
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.log = new TimelineLog(options.store.db);
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
  ): { posts: RoomPost[]; latestSeq: number; threads: RoomThread[] } {
    const limit = Math.min(200, Math.max(1, opts.limit ?? 100));
    if (opts.since === undefined && opts.before === undefined) {
      try {
        this.backfill(projectId);
      } catch (error) {
        logger.warn("room backfill failed", { error: String(error) });
      }
    }
    const rows = this.store.roomPosts(projectId, {
      ...(opts.since !== undefined ? { since: opts.since } : {}),
      ...(opts.before !== undefined ? { before: opts.before } : {}),
      limit,
    });
    return {
      posts: rows.map(toRoomPost),
      latestSeq: this.store.latestRoomSeq(projectId),
      threads: this.threads(projectId),
    };
  }

  /**
   * Once per pond: Started/Finished lines for the last 24 h of its chats' turns, from their timelines with the real
   * times, merged with what the room already holds in time order (ids kept, seqs renumbered). Never duplicates a post.
   */
  backfill(projectId: string): void {
    if (!this.store.getProject(projectId)) return;
    if (this.store.markRoomBackfilled(projectId, this.now())) return;
    const cutoff = this.now() - ROOM_THREAD_WINDOW_MS;
    const made: Array<Omit<RoomPostRow, "seq">> = [];
    for (const s of this.sessionsOf(projectId)) {
      const name = agentName(s);
      const started = new Set<string>();
      for (const e of this.log.turnEdges(s.id, new Date(cutoff).toISOString())) {
        if (e.type !== "turn.started" && e.type !== "turn.ended") continue;
        if (e.type === "turn.started" && e.auto) continue;
        // A turn the agent ran by itself (a worker reporting in) has no Started line, so it gets no Finished line either.
        if (e.type === "turn.ended" && !started.has(e.turnId)) continue;
        if (e.type === "turn.started") started.add(e.turnId);
        const at = Date.parse(e.at);
        if (!Number.isFinite(at) || at < cutoff) continue;
        const start = e.type === "turn.started";
        const id = start ? startPostId(s.id, e.turnId) : endPostId(s.id, e.turnId);
        if (this.store.roomPostById(id)) continue;
        made.push({
          id,
          projectId,
          authorKind: "squeak",
          authorId: null,
          authorName: name.slice(0, 80),
          sessionId: s.id,
          kind: start ? "working" : "done",
          level: "room",
          text: start ? startedText(e.text) : endedText(e.outcome),
          toSessionId: null,
          at,
        });
      }
    }
    if (made.length === 0) return;
    const existing = this.store.roomPosts(projectId, { limit: 100_000 });
    const merged = [...existing.map((r, i) => ({ r, i })), ...made.map((r, i) => ({ r, i: existing.length + i }))]
      .sort((a, b) => a.r.at - b.r.at || a.i - b.i)
      .map(({ r }) => {
        const rest: Partial<RoomPostRow> = { ...r };
        delete rest.seq;
        return rest as Omit<RoomPostRow, "seq">;
      });
    this.store.replaceRoomPosts(projectId, merged);
  }

  private sessionsOf(projectId: string): SessionRow[] {
    const project = this.store.getProject(projectId);
    if (!project) return [];
    const streams = new Set(this.store.listWorkspaces(projectId).map((w) => w.id));
    return this.store
      .listSessions()
      .filter((s) => !s.archivedAt && (s.workspaceId ? streams.has(s.workspaceId) : s.cwd === project.rootPath));
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
      .map(({ s }): RoomThread => {
        const m = marks.get(s.id);
        const ended = this.log.lastEnded(s.id);
        const endedAt = ended ? Date.parse(ended.at) : NaN;
        const on = m?.working && !(m.done && m.done.seq > m.working.seq) ? m.working : undefined;
        return {
          sessionId: s.id,
          title: s.title ?? "Untitled",
          agent: s.agent,
          state: threadState(s.status, s.lastTurnEndedAt),
          ...(on ? { workingOn: on.text, workingOnAt: on.at } : {}),
          lastState: !ended
            ? "idle"
            : ended.outcome === "done"
              ? "finished"
              : ended.outcome === "stopped"
                ? "stopped"
                : "error",
          lastAt: Number.isFinite(endedAt) ? endedAt : Date.parse(s.updatedAt),
        };
      });
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

const WAITING = new Set([
  "awaiting_approval",
  "awaiting_plan",
  "awaiting_answer",
  "needs_user_permission",
  "needs_plan_response",
  "needs_user_input",
]);

/** The slice of the host Squeak's own posts listen to. */
export interface HostEvents {
  on(event: "event", listener: (e: HostEvent) => void): unknown;
  off(event: "event", listener: (e: HostEvent) => void): unknown;
}

/**
 * Squeak's own posts: "<title> needs you" once per waiting episode; for every turn, whatever the agent, one
 * `working` line "Started: <message>" and one `done` line (Finished / Stopped / Hit an error), the latter skipped when
 * the agent posted its own `done` during the turn. Fixed ids make a replayed event a no-op. Never throws.
 */
export function attachSqueakPosts(host: HostEvents, store: NativeStore, room: Room): () => void {
  const waiting = new Set<string>();
  const agentDone = new Set<string>();
  const post = (
    s: SessionRow,
    kind: "needs" | "working" | "done",
    text: string,
    extra: { id?: string; name?: string } = {},
  ): void => {
    try {
      const pond = projectOfSession(store, s);
      if (!pond) return;
      room.post({
        projectId: pond.id,
        author: { kind: "squeak", name: extra.name ?? "Squeak" },
        sessionId: s.id,
        kind,
        text,
        ...(extra.id ? { id: extra.id } : {}),
      });
    } catch (error) {
      logger.warn("room post failed", { error: String(error) });
    }
  };
  const needs = (sessionId: string): void => {
    if (waiting.has(sessionId)) return;
    waiting.add(sessionId);
    const s = store.getSession(sessionId);
    if (s) post(s, "needs", `${agentName(s)} needs you`);
  };
  const onPost = (p: RoomPostRow): void => {
    if (p.kind === "done" && p.authorKind === "agent" && p.sessionId) agentDone.add(p.sessionId);
  };
  room.on("post", onPost);
  const onEvent = (e: HostEvent): void => {
    try {
      if (e.type === "request") needs(e.sessionId);
      else if (e.type === "status") {
        if (WAITING.has(e.status)) needs(e.sessionId);
        else waiting.delete(e.sessionId);
      } else if (e.type === "timeline" && e.event.type === "turn.started" && !e.event.auto) {
        agentDone.delete(e.sessionId);
        const s = store.getSession(e.sessionId);
        if (s)
          post(s, "working", startedText(e.event.text), { id: startPostId(s.id, e.event.turnId), name: agentName(s) });
      } else if (e.type === "timeline" && e.event.type === "turn.ended") {
        const s = store.getSession(e.sessionId);
        if (!s) return;
        const own = agentDone.delete(e.sessionId);
        // Only a turn that got a Started line gets an end line: the agent's own turns (workers reporting in) post nothing.
        if (!own && store.roomPostById(startPostId(s.id, e.event.turnId)))
          post(s, "done", endedText(e.event.outcome), { id: endPostId(s.id, e.event.turnId), name: agentName(s) });
      }
    } catch (error) {
      logger.warn("room watcher failed", { error: String(error) });
    }
  };
  host.on("event", onEvent);
  return () => {
    host.off("event", onEvent);
    room.off("post", onPost);
  };
}
