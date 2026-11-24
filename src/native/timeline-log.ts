import type Database from "better-sqlite3";

import {
  TimelineProjector,
  authorOf,
  type MessageLike,
  type ReplyDelta,
  type TimelineBody,
  type TimelineEvent,
  type TurnOutcome,
} from "./timeline.js";
import type { MessageAuthor } from "./types.js";

type Db = InstanceType<typeof Database>;
type Row = Record<string, unknown>;

/** How many turns a chat keeps in its log; older ones are trimmed when a turn ends. */
export const KEEP_TURNS = 400;
export const DEFAULT_PAGE_TURNS = 30;
export const MAX_PAGE_EVENTS = 5000;

export interface TimelinePage {
  events: TimelineEvent[];
  /** The newest seq the chat's log holds (0: none). */
  lastSeq: number;
  /** Turns older than the first event returned exist. */
  hasEarlier: boolean;
}

/** The per-chat ordered event log in native.db. */
export class TimelineLog {
  private readonly last = new Map<string, number>();

  constructor(private readonly db: Db) {}

  lastSeq(sessionId: string): number {
    let n = this.last.get(sessionId);
    if (n === undefined) {
      const r = this.db.prepare("SELECT MAX(seq) AS m FROM timeline_events WHERE session_id=?").get(sessionId) as Row;
      n = (r.m as number | null) ?? 0;
      this.last.set(sessionId, n);
    }
    return n;
  }

  /** The newest seq as the database holds it now (another writer included), unlike the memoised `lastSeq`. */
  peekSeq(sessionId: string): number {
    const r = this.db.prepare("SELECT MAX(seq) AS m FROM timeline_events WHERE session_id=?").get(sessionId) as Row;
    return (r.m as number | null) ?? 0;
  }

  hasAny(sessionId: string): boolean {
    return this.lastSeq(sessionId) > 0;
  }

  /** Stores one event under the chat's next seq. Synchronous, so seqs are gap-free and ordered with the caller. */
  append(sessionId: string, body: TimelineBody): TimelineEvent {
    const seq = this.lastSeq(sessionId) + 1;
    const turnId = "turnId" in body ? body.turnId : null;
    this.db
      .prepare("INSERT INTO timeline_events (session_id, seq, turn_id, type, body, at) VALUES (?,?,?,?,?,?)")
      .run(sessionId, seq, turnId, body.type, JSON.stringify(body), body.at);
    this.last.set(sessionId, seq);
    return { ...body, seq } as TimelineEvent;
  }

  private read(rows: Row[]): TimelineEvent[] {
    return rows.map((r) => ({ ...(JSON.parse(r.body as string) as TimelineBody), seq: r.seq as number }));
  }

  /** The chat's newest `turn.ended`, if it has one. */
  lastEnded(sessionId: string): Extract<TimelineEvent, { type: "turn.ended" }> | null {
    const r = this.db
      .prepare(
        "SELECT seq, body FROM timeline_events WHERE session_id=? AND type='turn.ended' ORDER BY seq DESC LIMIT 1",
      )
      .get(sessionId) as Row | undefined;
    return r ? (this.read([r])[0] as Extract<TimelineEvent, { type: "turn.ended" }>) : null;
  }

  /** The `turn.started` and `turn.ended` events at or after an instant (ISO), oldest first. */
  turnEdges(sessionId: string, sinceIso: string): TimelineEvent[] {
    return this.read(
      this.db
        .prepare(
          "SELECT seq, body FROM timeline_events WHERE session_id=? AND type IN ('turn.started','turn.ended') AND at>=? ORDER BY seq LIMIT 2000",
        )
        .all(sessionId, sinceIso) as Row[],
    );
  }

  /**
   * Turn edges and final replies (`turn.started`, `turn.ended`, `reply.done`) after a seq, or, with no seq, at or after
   * an instant (ISO): what the room derives its turns from. Oldest first.
   */
  roomEvents(sessionId: string, from: { afterSeq: number } | { sinceIso: string }): TimelineEvent[] {
    const types = "type IN ('turn.started','turn.ended','reply.done')";
    return this.read(
      "afterSeq" in from
        ? (this.db
            .prepare(`SELECT seq, body FROM timeline_events WHERE session_id=? AND seq>? AND ${types} ORDER BY seq`)
            .all(sessionId, from.afterSeq) as Row[])
        : (this.db
            .prepare(`SELECT seq, body FROM timeline_events WHERE session_id=? AND at>=? AND ${types} ORDER BY seq`)
            .all(sessionId, from.sinceIso) as Row[]),
    );
  }

  /** A turn's subagent tool steps (Agent/Task: their labels start "Start "), as step events, oldest first. */
  duckSteps(sessionId: string, turnId: string): Array<Extract<TimelineEvent, { type: "step.added" | "step.updated" }>> {
    return this.read(
      this.db
        .prepare(
          `SELECT seq, body FROM timeline_events WHERE session_id=? AND turn_id=? AND type IN ('step.added','step.updated')
             AND body LIKE '%"kind":"tool"%' AND body LIKE '%"label":"Start %' ORDER BY seq LIMIT 400`,
        )
        .all(sessionId, turnId) as Row[],
    ) as Array<Extract<TimelineEvent, { type: "step.added" | "step.updated" }>>;
  }

  /**
   * The file names the chat changed (its "Edit <file>" and "Write <file>" tool steps), newest first, each once: the
   * code areas the decider matches a new Task against. Names only: the timeline keeps the label, not the path.
   */
  touchedFiles(sessionId: string, limit = 40): string[] {
    const rows = this.db
      .prepare(
        `SELECT body FROM timeline_events WHERE session_id=? AND type IN ('step.added','step.updated')
           AND body LIKE '%"kind":"tool"%' AND (body LIKE '%"label":"Edit %' OR body LIKE '%"label":"Write %')
           ORDER BY seq DESC LIMIT 400`,
      )
      .all(sessionId) as Row[];
    const out: string[] = [];
    for (const r of rows) {
      const label = (JSON.parse(r.body as string) as { label?: unknown }).label;
      const m = typeof label === "string" ? label.match(/^(?:Edit|Write) (\S.*)$/) : null;
      if (m && !out.includes(m[1]!)) out.push(m[1]!);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** The newest progress-strip update after a seq (the strip is one step, id `progress`), if any. */
  latestProgress(
    sessionId: string,
    afterSeq: number,
  ): Extract<TimelineEvent, { type: "step.added" | "step.updated" }> | null {
    const r = this.db
      .prepare(
        `SELECT seq, body FROM timeline_events WHERE session_id=? AND seq>? AND type='step.updated'
           AND body LIKE '%"stepId":"progress"%' ORDER BY seq DESC LIMIT 1`,
      )
      .get(sessionId, afterSeq) as Row | undefined;
    return r ? (this.read([r])[0] as Extract<TimelineEvent, { type: "step.added" | "step.updated" }>) : null;
  }

  /** Events after `since`, oldest first. */
  after(sessionId: string, since: number, limit = 1000): TimelineEvent[] {
    return this.read(
      this.db
        .prepare("SELECT seq, body FROM timeline_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?")
        .all(sessionId, since, Math.max(1, Math.min(limit, MAX_PAGE_EVENTS))) as Row[],
    );
  }

  /**
   * The newest `turns` turns (with the queue events among them), or the `turns` before `before` (a seq the reader
   * already holds the start of): whole turns, oldest first.
   */
  turnsPage(sessionId: string, turns: number, before?: number): TimelinePage {
    const n = Math.max(1, Math.min(turns, 200));
    const starts = this.db
      .prepare(
        "SELECT seq FROM timeline_events WHERE session_id=? AND type='turn.started' AND seq<? ORDER BY seq DESC LIMIT ?",
      )
      .all(sessionId, before ?? Number.MAX_SAFE_INTEGER, n) as Row[];
    const lastSeq = this.lastSeq(sessionId);
    if (starts.length === 0) return { events: [], lastSeq, hasEarlier: false };
    const from = starts[starts.length - 1]!.seq as number;
    const rows = this.db
      .prepare("SELECT seq, body FROM timeline_events WHERE session_id=? AND seq>=? AND seq<? ORDER BY seq LIMIT ?")
      .all(sessionId, from, before ?? Number.MAX_SAFE_INTEGER, MAX_PAGE_EVENTS) as Row[];
    const earlier = this.db
      .prepare("SELECT 1 FROM timeline_events WHERE session_id=? AND type='turn.started' AND seq<? LIMIT 1")
      .get(sessionId, from);
    return { events: this.read(rows), lastSeq, hasEarlier: earlier !== undefined };
  }

  /** Turns whose newest event is not a `turn.ended`: a restart left them open. */
  openTurns(): Array<{ sessionId: string; turnId: string }> {
    const rows = this.db
      .prepare(
        `SELECT s.session_id AS sid, s.turn_id AS tid FROM timeline_events s
         WHERE s.type='turn.started'
           AND NOT EXISTS (SELECT 1 FROM timeline_events e WHERE e.session_id=s.session_id AND e.turn_id=s.turn_id AND e.type='turn.ended')`,
      )
      .all() as Row[];
    return rows.map((r) => ({ sessionId: r.sid as string, turnId: r.tid as string }));
  }

  /** Keeps the newest `keep` turns' events. */
  trim(sessionId: string, keep = KEEP_TURNS): void {
    const edge = this.db
      .prepare(
        "SELECT seq FROM timeline_events WHERE session_id=? AND type='turn.started' ORDER BY seq DESC LIMIT 1 OFFSET ?",
      )
      .get(sessionId, keep) as Row | undefined;
    if (edge) this.db.prepare("DELETE FROM timeline_events WHERE session_id=? AND seq<?").run(sessionId, edge.seq);
  }

  drop(sessionId: string): void {
    this.db.prepare("DELETE FROM timeline_events WHERE session_id=?").run(sessionId);
    this.last.delete(sessionId);
  }
}

export type TimelineEmit = (sessionId: string, event: TimelineEvent | ReplyDelta) => void;

const isoNow = (): string => new Date().toISOString();

/**
 * Where the host's moments become events: it keeps one projector per chat, stores what they produce and tells the
 * listener. Nothing here reads the transcript to guess a turn: a turn opens when the host accepts a send, closes
 * when the host ends it.
 */
export class TimelineRecorder {
  private readonly projectors = new Map<string, TimelineProjector>();

  constructor(
    readonly log: TimelineLog,
    private readonly emit: TimelineEmit,
  ) {}

  private projector(sessionId: string): TimelineProjector {
    let p = this.projectors.get(sessionId);
    if (!p) this.projectors.set(sessionId, (p = new TimelineProjector()));
    return p;
  }

  private store(sessionId: string, bodies: TimelineBody[]): void {
    for (const b of bodies) this.emit(sessionId, this.log.append(sessionId, b));
  }

  /**
   * A chat made before the log existed has none: it is built once from its stored rows, through the projector the
   * live path uses. `rows` is the chat's tail, oldest first, read lazily (only when the log is empty).
   */
  ensure(
    sessionId: string,
    rows: () => Array<MessageLike & { author?: MessageAuthor | undefined }>,
    busy: boolean,
  ): void {
    if (this.log.hasAny(sessionId)) return;
    const all = rows();
    if (all.length === 0) return;
    const p = this.projector(sessionId);
    let lastEnd = false;
    for (const row of all) {
      const at = row.createdAt;
      if (row.kind === "user/text") {
        const text = (row.payload as { text?: unknown } | null)?.text;
        if (typeof text !== "string" || !text || text.trimStart().startsWith("<task-notification>")) continue;
        const steered = (row.payload as { steered?: unknown }).steered === true;
        if (steered && p.openTurnId) this.store(sessionId, p.steer({ seq: row.seq, text, author: row.author, at }));
        else this.store(sessionId, p.begin({ promptSeq: row.seq, text, author: row.author, at }));
        lastEnd = false;
        continue;
      }
      this.feed(sessionId, p, row);
      if (row.kind.startsWith("result") || row.kind.startsWith("turn/")) {
        this.store(sessionId, p.end(row.kind.includes("error") ? "failed" : "done", undefined, at));
        lastEnd = true;
      } else if (row.kind === "error" || row.kind === "system/error" || row.kind === "system/restart") {
        this.store(sessionId, p.end("failed", undefined, at));
        lastEnd = true;
      }
    }
    // A turn the rows leave open stays open only if the chat is really working.
    if (!lastEnd && !busy && p.openTurnId) this.store(sessionId, p.end("stopped", undefined, isoNow()));
  }

  begin(
    sessionId: string,
    input: {
      promptSeq: number;
      text: string;
      author?: MessageAuthor | undefined;
      clientNonce?: string | undefined;
      queuedId?: string | undefined;
      room?: boolean | undefined;
      at: string;
    },
  ): void {
    this.store(sessionId, this.projector(sessionId).begin(input));
  }

  steer(
    sessionId: string,
    input: {
      seq: number;
      text: string;
      author?: MessageAuthor | undefined;
      clientNonce?: string | undefined;
      waiting?: boolean | undefined;
      at: string;
    },
  ): void {
    this.store(sessionId, this.projector(sessionId).steer(input));
  }

  steerTaken(sessionId: string, seq: number, at: string): void {
    this.store(sessionId, this.projector(sessionId).steerTaken(seq, at));
  }

  queued(
    sessionId: string,
    input: {
      queuedId: string;
      text: string;
      author?: MessageAuthor | undefined;
      clientNonce?: string | undefined;
      at: string;
    },
  ): void {
    const author = authorOf(input.author);
    this.store(sessionId, [
      {
        type: "prompt.queued",
        queuedId: input.queuedId,
        text: input.text,
        ...(author ? { author } : {}),
        ...(input.clientNonce ? { clientNonce: input.clientNonce } : {}),
        at: input.at,
      },
    ]);
  }

  dequeued(sessionId: string, queuedId: string): void {
    this.store(sessionId, [{ type: "prompt.dequeued", queuedId, at: isoNow() }]);
  }

  /** True when this row began a turn the agent ran by itself (a background helper reported in). */
  message(sessionId: string, row: MessageLike): boolean {
    if (row.kind === "user/text") return false;
    return this.feed(sessionId, this.projector(sessionId), row);
  }

  /**
   * A row into the projector. The agent speaking with no turn open means Claude Code ran a turn by itself (a helper
   * reported in): it is a turn of its own, without a prompt, so its words are not lost.
   */
  private feed(sessionId: string, p: TimelineProjector, row: MessageLike): boolean {
    const speaks = row.kind === "assistant" || row.kind.startsWith("item/");
    let began = false;
    if (!p.openTurnId && speaks && !(row.payload as { parent_tool_use_id?: unknown } | null)?.parent_tool_use_id) {
      this.store(sessionId, p.begin({ promptSeq: row.seq, text: "", auto: true, at: row.createdAt }));
      began = true;
    }
    this.store(sessionId, p.message(row));
    return began;
  }

  delta(sessionId: string, payload: unknown): void {
    const { bodies, delta } = this.projector(sessionId).delta(payload, isoNow());
    this.store(sessionId, bodies);
    if (delta) this.emit(sessionId, delta);
  }

  noteFailure(sessionId: string, text: string): void {
    this.projector(sessionId).note(text);
  }

  end(sessionId: string, outcome: TurnOutcome, error?: string): void {
    const p = this.projectors.get(sessionId);
    if (!p?.openTurnId) return;
    this.store(sessionId, p.end(outcome, error, isoNow()));
    this.log.trim(sessionId);
  }

  /** At start: turns a restart left open end as stopped. */
  recover(): void {
    for (const { sessionId, turnId } of this.log.openTurns()) {
      this.store(sessionId, [{ type: "turn.ended", turnId, outcome: "stopped", at: isoNow() }]);
    }
  }

  drop(sessionId: string): void {
    this.projectors.delete(sessionId);
    this.log.drop(sessionId);
  }
}
