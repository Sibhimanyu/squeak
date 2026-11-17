import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { flag } from "../squeak/flags.js";
import { logger } from "../utils/logger.js";
import { defaultTitleCall, TITLE_TIMEOUT_MS, type TitleModelCall } from "./auto-title.js";
import type { HostEvents, Room, RoomThread } from "./room.js";
import { firstSentence, oneLine } from "./room-turns.js";
import type { HostEvent } from "./host.js";
import type { NativeStore, RoomPostRow } from "./store.js";
import type { SessionRow } from "./types.js";

/**
 * Room jobs: a person's message that asks for work becomes a job Squeak routes to a thread. Squeak never chats (its
 * only words are action and status lines) and never takes or starts anything without the person's Go / Allow.
 * Matching is rules first (word overlap with the pond's recent threads); the only model call is the yes/no check.
 */

export type RoomJobStatus = "suggested" | "dismissed" | "handed" | "running" | "done" | "failed";

export interface JobThreadRef {
  sessionId: string;
  title: string;
  reason: string;
  state: "working" | "idle";
}

export interface RoomJob {
  id: string;
  messageId: string;
  text: string;
  status: RoomJobStatus;
  suggestion?: JobThreadRef;
  candidates?: JobThreadRef[];
  claim?: { sessionId: string; title: string; eta?: string; at: number; status: "asking" | "allowed" | "denied" };
  handedTo?: { sessionId: string; title: string; turnId?: string; newThread: boolean };
  outcomeText?: string;
  createdAt: number;
  updatedAt: number;
}

export class JobError extends Error {
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
  session: SessionRow;
  state: RoomThread["state"];
  score: number;
  reason: string;
}

export interface RoomJobsOptions {
  store: NativeStore;
  room: Room;
  /** A new turn for an existing chat, from the person (queued if busy). */
  send: (sessionId: string, text: string) => Promise<unknown>;
  /** A new thread in the pond with `text`, run by the owner's defaults. */
  newThread: (projectId: string, text: string, title: string) => Promise<SessionRow>;
  call?: TitleModelCall;
  /** Defaults to the SQUEAK_ROOM_JOBS switch. */
  enabled?: () => boolean;
  now?: () => number;
  timeoutMs?: number;
}

/** Emits `job` `{ projectId, job }` for every create or change. */
export class RoomJobs extends EventEmitter {
  private readonly now: () => number;
  private readonly checks = new Map<string, number[]>();
  private readonly claims = new Map<string, number[]>();
  private readonly busy = new Set<string>();
  private readonly inflight = new Set<Promise<void>>();
  private call: TitleModelCall | null;

  constructor(private readonly o: RoomJobsOptions) {
    super();
    this.setMaxListeners(0);
    this.now = o.now ?? Date.now;
    this.call = o.call ?? null;
  }

  // ---- reading ----

  /** Open jobs plus those updated in the last 24 h, oldest first (newest last). */
  list(projectId: string): RoomJob[] {
    const cutoff = this.now() - JOB_LISTED_MS;
    return this.o.store
      .roomJobRows(projectId)
      .map((r) => JSON.parse(r.data) as RoomJob)
      .filter(
        (j) => j.status === "suggested" || j.status === "handed" || j.status === "running" || j.updatedAt >= cutoff,
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .slice(-50);
  }

  get(id: string): { job: RoomJob; projectId: string } | null {
    const r = this.o.store.roomJobRow(id);
    return r ? { job: JSON.parse(r.data) as RoomJob, projectId: r.projectId } : null;
  }

  private save(projectId: string, job: RoomJob): RoomJob {
    job.updatedAt = Math.max(this.now(), job.updatedAt);
    this.o.store.saveRoomJob({
      id: job.id,
      projectId,
      messageId: job.messageId,
      data: JSON.stringify(job),
      updatedAt: job.updatedAt,
    });
    this.emit("job", { projectId, job });
    return job;
  }

  // ---- making jobs ----

  /** Watches the room: every person message gets the background check. Returns the detach. */
  attach(host: HostEvents): () => void {
    const onPost = (p: RoomPostRow): void => {
      if (p.authorKind === "person" && p.kind === "message" && p.level === "room") this.check(p);
    };
    const onEvent = (e: HostEvent): void => {
      try {
        if (e.type === "timeline" && ["turn.started", "reply.done", "turn.ended"].includes(e.event.type)) {
          this.reconcileSession(e.sessionId);
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
          prompt: `Message:\n${post.text.slice(0, 1500)}\n\nJSON:`,
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
    this.create(post.projectId, post.id, answer.text.trim() || post.text);
  }

  /** The person marks a message as a job (skips the check). */
  fromMessage(projectId: string, messageId: unknown): RoomJob {
    if (typeof messageId !== "string" || !messageId) throw new JobError("messageId is required.", 400);
    const post = this.o.store.roomPostById(messageId);
    if (!post || post.projectId !== projectId || post.kind !== "message") {
      throw new JobError("That isn't a message in this pond's room.", 404);
    }
    const existing = this.o.store.roomJobRowByMessage(messageId);
    if (existing) {
      const job = JSON.parse(existing.data) as RoomJob;
      if (job.status !== "dismissed") throw new JobError("That message is already a job.", 409);
      return this.create(projectId, messageId, job.text, job);
    }
    return this.create(projectId, messageId, post.text);
  }

  private create(projectId: string, messageId: string, rawText: string, reopen?: RoomJob): RoomJob {
    const text = rawText.replace(/\s+/g, " ").trim().slice(0, 500);
    const at = this.now();
    const job: RoomJob = {
      id: reopen?.id ?? `job:${randomUUID()}`,
      messageId,
      text,
      status: "suggested",
      createdAt: reopen?.createdAt ?? at,
      updatedAt: at,
    };
    const ranked = this.rank(projectId, text);
    const best = ranked[0];
    if (best) {
      job.suggestion = ref(best);
      const rest = ranked.slice(1, 4).map(ref);
      if (rest.length) job.candidates = rest;
    }
    return this.save(projectId, job);
  }

  // ---- matching ----

  /** The pond's recent threads that fit `text`, best first; empty when none fits well enough. */
  rank(projectId: string, text: string): Scored[] {
    const want = tokens(text);
    if (want.size === 0) return [];
    const marks = this.o.store.latestRoomMarks(projectId);
    const out: Scored[] = [];
    for (const c of this.o.room.candidates(projectId, JOB_MATCH_WINDOW_MS)) {
      const hit = this.score(c.session, c.state, c.at, want, marks.get(c.session.id)?.working?.text);
      if (hit && hit.score >= JOB_MIN_SCORE) out.push(hit);
    }
    return out.sort((a, b) => b.score - a.score || a.session.id.localeCompare(b.session.id));
  }

  /** How well one thread fits a job's words, with a phrase for why. Null: nothing in common. */
  score(
    session: SessionRow,
    state: RoomThread["state"],
    at: number,
    want: Set<string>,
    intent?: string,
  ): Scored | null {
    const title = tokens(session.title ?? "");
    const intentWords = tokens(intent ?? "");
    const turns = this.o.room.sessionTurns(session.id).slice(-4);
    let raw = 0;
    const matched: string[] = [];
    let bestTurn: { at: number; words: string[] } | null = null;
    const turnSets = turns.map((t) => ({ t, words: tokens(`${t.prompt} ${firstSentence(t.reply ?? "")}`) }));
    for (const w of want) {
      let weight = 0;
      if (title.has(w)) weight = 3;
      else if (intentWords.has(w)) weight = 2;
      else if (turnSets.some((x) => x.words.has(w))) weight = 1.5;
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
    if (state === "working") reason = `is working on ${phrase(matched)} now`;
    else if (bestTurn) reason = `worked on ${phrase(bestTurn.words)} ${ago(this.now() - bestTurn.at)}`;
    else reason = `its thread is about ${phrase(matched)}`;
    return { session, state, score: raw + (raw >= JOB_MIN_SCORE ? recency : 0), reason };
  }

  /** Suggested jobs of this pond, best fit for `session` first (the agent's `open_jobs`). */
  openFor(projectId: string, session: SessionRow): Array<{ job: RoomJob; why: string }> {
    const marks = this.o.store.latestRoomMarks(projectId);
    const me = this.o.room.candidates(projectId, JOB_MATCH_WINDOW_MS).find((c) => c.session.id === session.id);
    const out: Array<{ job: RoomJob; why: string; score: number }> = [];
    for (const job of this.list(projectId)) {
      if (job.status !== "suggested") continue;
      if (job.claim && job.claim.status !== "denied" && job.claim.sessionId !== session.id) continue;
      if (job.claim?.status === "denied" && job.claim.sessionId === session.id) continue;
      const hit = me
        ? this.score(me.session, me.state, me.at, tokens(job.text), marks.get(session.id)?.working?.text)
        : null;
      const named = job.suggestion?.sessionId === session.id;
      if (!named && (!hit || hit.score < JOB_MIN_SCORE / 2)) continue;
      out.push({ job, why: hit?.reason ?? job.suggestion?.reason ?? "", score: (hit?.score ?? 0) + (named ? 10 : 0) });
    }
    return out.sort((a, b) => b.score - a.score).map(({ job, why }) => ({ job, why }));
  }

  // ---- claims (agents) ----

  claim(session: SessionRow, projectId: string, jobId: string, eta?: string): RoomJob {
    const found = this.get(jobId);
    if (!found || found.projectId !== projectId) throw new JobError("No such job in this pond.", 404);
    const job = found.job;
    if (job.status !== "suggested") throw new JobError("That job is no longer open.", 409);
    const c = job.claim;
    if (c && c.sessionId === session.id) {
      throw new JobError(
        c.status === "denied"
          ? "The person said no to you taking this job."
          : "You have already asked to take this job.",
        409,
      );
    }
    if (c && c.status !== "denied") throw new JobError("Another chat has already asked to take this job.", 409);
    const hour = this.now() - 3_600_000;
    const recent = (this.claims.get(session.id) ?? []).filter((t) => t > hour);
    this.claims.set(session.id, recent);
    if (recent.length >= JOB_CLAIMS_PER_HOUR) throw new JobError("This chat has asked for enough jobs this hour.", 429);
    recent.push(this.now());
    const cleanEta = eta?.replace(/\s+/g, " ").trim().slice(0, 60);
    job.claim = {
      sessionId: session.id,
      title: session.title ?? "Untitled",
      ...(cleanEta ? { eta: cleanEta } : {}),
      at: this.now(),
      status: "asking",
    };
    return this.save(projectId, job);
  }

  // ---- the person's actions ----

  async act(projectId: string, jobId: string, body: Record<string, unknown>): Promise<RoomJob> {
    const unknown = Object.keys(body).filter((k) => k !== "action" && k !== "sessionId");
    if (unknown.length) throw new JobError(`unknown key: ${unknown[0]}`, 400);
    const action = body.action;
    if (!["go", "new", "dismiss", "allow", "deny"].includes(action as string)) {
      throw new JobError("action must be go, new, dismiss, allow or deny", 400);
    }
    if (body.sessionId !== undefined && (action !== "go" || typeof body.sessionId !== "string")) {
      throw new JobError("sessionId is only for go, and must be text", 400);
    }
    const found = this.get(jobId);
    if (!found || found.projectId !== projectId) throw new JobError("No such job.", 404);
    const job = found.job;
    if (this.busy.has(jobId)) throw new JobError("That job is being handed over right now.", 409);
    if (job.status !== "suggested") {
      throw new JobError(
        job.status === "dismissed" ? "That job was dismissed." : "That job has already been handed to a thread.",
        409,
      );
    }
    this.busy.add(jobId);
    try {
      switch (action) {
        case "dismiss":
          job.status = "dismissed";
          return this.save(projectId, job);
        case "deny":
          if (job.claim?.status !== "asking") throw new JobError("No thread is asking to take this job.", 409);
          job.claim.status = "denied";
          return this.save(projectId, job);
        case "allow": {
          if (job.claim?.status !== "asking") throw new JobError("No thread is asking to take this job.", 409);
          const done = await this.handTo(projectId, job, job.claim.sessionId);
          if (done.claim) done.claim.status = "allowed";
          return this.save(projectId, done);
        }
        case "go": {
          const id = (body.sessionId as string | undefined) ?? job.suggestion?.sessionId;
          if (!id) throw new JobError("There is no thread to send this to; start a new one.", 409);
          return this.save(projectId, await this.handTo(projectId, job, id));
        }
        default: {
          const project = this.o.store.getProject(projectId);
          if (!project) throw new JobError("No such pond.", 404);
          let child: SessionRow;
          try {
            child = await this.o.newThread(projectId, job.text, jobTitle(job.text));
          } catch (error) {
            if (error instanceof JobError) throw error;
            throw new JobError(error instanceof Error ? error.message : "Could not start a thread.", 409);
          }
          job.status = "handed";
          job.handedTo = { sessionId: child.id, title: child.title ?? jobTitle(job.text), newThread: true };
          this.save(projectId, job);
          return this.reconcileJob(projectId, job);
        }
      }
    } finally {
      this.busy.delete(jobId);
    }
  }

  private async handTo(projectId: string, job: RoomJob, sessionId: string): Promise<RoomJob> {
    const s = this.o.store.getSession(sessionId);
    const inPond = s && !s.archivedAt && this.o.room.candidates(projectId, Infinity).some((c) => c.session.id === s.id);
    if (!s || !inPond) throw new JobError("That thread isn't available in this pond any more.", 409);
    job.status = "handed";
    job.handedTo = { sessionId: s.id, title: s.title ?? "Untitled", newThread: false };
    job.updatedAt = this.now();
    try {
      await this.o.send(s.id, job.text);
    } catch (error) {
      delete job.handedTo;
      job.status = "suggested";
      throw new JobError(error instanceof Error ? error.message : "Could not send it.", 409);
    }
    this.save(projectId, job);
    return this.reconcileJob(projectId, job);
  }

  // ---- following the handed turn ----

  private reconcileSession(sessionId: string): void {
    const s = this.o.store.getSession(sessionId);
    if (!s) return;
    for (const [projectId, job] of this.activeFor(sessionId)) this.reconcileJob(projectId, job);
  }

  private activeFor(sessionId: string): Array<[string, RoomJob]> {
    const out: Array<[string, RoomJob]> = [];
    for (const p of this.o.store.listProjects()) {
      for (const r of this.o.store.roomJobRows(p.id)) {
        const j = JSON.parse(r.data) as RoomJob;
        if ((j.status === "handed" || j.status === "running") && j.handedTo?.sessionId === sessionId)
          out.push([p.id, j]);
      }
    }
    return out;
  }

  /** Binds a handed job to the turn its text started, and follows that turn to its end. Saves only on change. */
  reconcileJob(projectId: string, job: RoomJob): RoomJob {
    const to = job.handedTo;
    if (!to || (job.status !== "handed" && job.status !== "running")) return job;
    const turns = this.o.room.sessionTurns(to.sessionId);
    const want = oneLine(job.text);
    const taken = new Set(
      this.o.store
        .roomJobRows(projectId)
        .map((r) => (JSON.parse(r.data) as RoomJob).handedTo?.turnId)
        .filter((x): x is string => !!x),
    );
    const turn = to.turnId
      ? turns.find((t) => `${to.sessionId}:${t.turnId}` === to.turnId)
      : turns.find(
          (t) =>
            t.startedAt >= job.updatedAt - 10_000 &&
            oneLine(t.prompt) === want &&
            !taken.has(`${to.sessionId}:${t.turnId}`),
        );
    if (!turn) return job;
    const before = JSON.stringify(job);
    to.turnId = `${to.sessionId}:${turn.turnId}`;
    if (turn.endedAt === undefined) {
      job.status = "running";
    } else {
      job.status = turn.outcome === "finished" ? "done" : "failed";
      const outcome = turn.reply ? firstSentence(turn.reply) : "";
      if (outcome) job.outcomeText = outcome;
    }
    return JSON.stringify(job) === before ? job : this.save(projectId, job);
  }
}

function ref(s: Scored): JobThreadRef {
  return {
    sessionId: s.session.id,
    title: s.session.title ?? "Untitled",
    reason: s.reason,
    state: s.state === "working" ? "working" : "idle",
  };
}

/** A new thread's title from the job: its first clause, at most 60 characters. */
export function jobTitle(text: string): string {
  const t = oneLine(text, 60).replace(/[.!?]+$/, "");
  return t || "New job";
}
