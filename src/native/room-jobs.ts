import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { flag } from "../squeak/flags.js";
import { logger } from "../utils/logger.js";
import { defaultTitleCall, TITLE_TIMEOUT_MS, type TitleModelCall } from "./auto-title.js";
import type { HostEvents, Room, RoomThread } from "./room.js";
import { AttachmentError, stripAttachmentLines } from "./room-attachments.js";
import { firstSentence, oneLine } from "./room-turns.js";
import type { HostEvent } from "./host.js";
import type { DuckRow, NativeStore, RoomPostRow } from "./store.js";
import type { SessionRow } from "./types.js";

/**
 * Room jobs: a person's message that asks for work becomes a job Squeak routes to a thread. Squeak never chats (its
 * only words are action and status lines) and never takes or starts anything without the person's Go / Allow.
 * Matching is rules first (word overlap with the pond's recent threads); the only model call is the yes/no check.
 */

export type RoomJobStatus = "suggested" | "dismissed" | "handed" | "running" | "done" | "failed";

/** Where a job runs: an existing stream, or a new stream (a worktree off the default branch) on this branch. */
export type JobPlace = { kind: "stream"; workspaceId: string; branch: string } | { kind: "new"; branch: string };

export interface JobThreadRef {
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

export interface RoomJob {
  id: string;
  messageId: string;
  text: string;
  status: RoomJobStatus;
  suggestion?: JobThreadRef;
  candidates?: JobThreadRef[];
  /** Chosen by the host when the job is made; the person can override it on Go. Absent in a plain-folder pond. */
  place?: JobPlace;
  claim?: {
    sessionId: string;
    duckId?: string;
    title: string;
    eta?: string;
    at: number;
    status: "asking" | "allowed" | "denied";
  };
  handedTo?: { sessionId: string; duckId?: string; title: string; turnId?: string; newThread: boolean };
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
  place?: JobPlace;
  text: string;
  title: string;
  /** The lines for the job's message's attachments, written under the session's folder once that is known. */
  attach?: (cwd: string) => string;
}

/** A stream's recent turns must match the job this strongly (a title word is 3, a turn word 1.5) to continue there. */
export const JOB_CONTINUE_SCORE = 4.5;

export interface RoomJobsOptions {
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
  /** The typed branch as git accepts it for a new stream, or a JobError saying why not. */
  checkBranch?: (projectId: string, branch: string) => string;
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
    let text = rawText.replace(/\s+/g, " ").trim().slice(0, 500);
    // A message that is only pictures or files still says what to do.
    if (!text) {
      const c = this.o.room.attachments.counts(messageId);
      if (c.images + c.files > 0) text = c.files > 0 ? "See the attached files." : "See the attached images.";
    }
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
    const place = this.choosePlace(projectId, text, best?.duck ?? null, best?.session ?? null);
    if (place) job.place = place;
    return this.save(projectId, job);
  }

  // ---- places ----

  /**
   * Where a job runs. A duck that already works in a stream whose recent turns match the job strongly continues
   * there; anything else goes to a new stream off the default branch (a plain-folder pond has no streams: absent).
   */
  choosePlace(projectId: string, text: string, duck: DuckRow | null, session: SessionRow | null): JobPlace | undefined {
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
  private cleanPlace(projectId: string, raw: unknown): JobPlace {
    const bad = (m: string): never => {
      throw new JobError(m, 400);
    };
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("place must be an object");
    const o = raw as Record<string, unknown>;
    if (o.kind === "stream") {
      const extra = Object.keys(o).filter((k) => !["kind", "workspaceId", "branch"].includes(k));
      if (extra.length) return bad(`unknown key in place: ${extra[0]}`);
      if (typeof o.workspaceId !== "string" || !o.workspaceId) return bad("place.workspaceId is required");
      const ws = this.o.store.getWorkspace(o.workspaceId);
      if (!ws || ws.projectId !== projectId || ws.state === "archived") {
        throw new JobError("That stream isn't available in this pond any more.", 409);
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
      if (project?.kind === "folder") throw new JobError("This pond has no streams to start in.", 409);
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
  openFor(projectId: string, session: SessionRow): Array<{ job: RoomJob; why: string }> {
    const marks = this.o.store.latestRoomMarks(projectId);
    // An off-duty duck is not a candidate, so it is offered nothing.
    const me = this.o.room.duckCandidates(projectId, JOB_MATCH_WINDOW_MS).find((c) => c.session?.id === session.id);
    if (!me) return [];
    const out: Array<{ job: RoomJob; why: string; score: number }> = [];
    for (const job of this.list(projectId)) {
      if (job.status !== "suggested") continue;
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

  claim(session: SessionRow, projectId: string, jobId: string, eta?: string): RoomJob {
    const found = this.get(jobId);
    if (!found || found.projectId !== projectId) throw new JobError("No such job in this pond.", 404);
    const job = found.job;
    if (job.status !== "suggested") throw new JobError("That job is no longer open.", 409);
    if (this.o.store.duckOf(session.id).duty === "off") {
      throw new JobError("You are off duty, so you can't take jobs; the person can put you back on duty.", 409);
    }
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

  async act(projectId: string, jobId: string, body: Record<string, unknown>): Promise<RoomJob> {
    const unknown = Object.keys(body).filter((k) => !["action", "sessionId", "duckId", "place"].includes(k));
    if (unknown.length) throw new JobError(`unknown key: ${unknown[0]}`, 400);
    const action = body.action;
    if (!["go", "new", "dismiss", "allow", "deny"].includes(action as string)) {
      throw new JobError("action must be go, new, dismiss, allow or deny", 400);
    }
    if (body.sessionId !== undefined && (action !== "go" || typeof body.sessionId !== "string")) {
      throw new JobError("sessionId is only for go, and must be text", 400);
    }
    if (
      body.duckId !== undefined &&
      (!["go", "allow", "new"].includes(action as string) || typeof body.duckId !== "string")
    ) {
      throw new JobError("duckId is only for go, allow and new, and must be text", 400);
    }
    if (body.sessionId !== undefined && body.duckId !== undefined) {
      throw new JobError("give a duckId or a sessionId, not both", 400);
    }
    if (body.place !== undefined && !["go", "allow", "new"].includes(action as string)) {
      throw new JobError("place is only for go, allow and new", 400);
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
    const override = body.place !== undefined ? this.cleanPlace(projectId, body.place) : undefined;
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
          const claimer = this.o.store.getSession(job.claim.sessionId);
          const duck = claimer ? this.o.room.duckOfSession(claimer) : null;
          if (!duck) throw new JobError("That thread isn't available in this pond any more.", 409);
          if (body.duckId !== undefined && body.duckId !== duck.id) {
            throw new JobError("Only the duck that asked can be allowed.", 409);
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
            if (!duck || duck.projectId !== projectId) throw new JobError("That duck isn't in this pond.", 409);
          } else {
            const id = (body.sessionId as string | undefined) ?? job.suggestion?.sessionId;
            if (id) {
              const s = this.o.store.getSession(id);
              const inPond =
                s &&
                !s.archivedAt &&
                this.o.room.candidates(projectId, Infinity, { offDuty: true }).some((c) => c.session.id === s.id);
              if (!s || !inPond) throw new JobError("That thread isn't available in this pond any more.", 409);
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
          if (!duck) throw new JobError("There is no thread to send this to; start a new one.", 409);
          const cur = duck.currentSessionId ? this.o.store.getSession(duck.currentSessionId) : null;
          return this.save(
            projectId,
            await this.handTo(projectId, job, duck, pinned ? place : this.placeFor(projectId, job, duck, cur)),
          );
        }
        default: {
          const project = this.o.store.getProject(projectId);
          if (!project) throw new JobError("No such pond.", 404);
          let duck: DuckRow | null = null;
          if (typeof body.duckId === "string") {
            duck = this.o.store.duckRow(body.duckId);
            if (!duck || duck.projectId !== projectId) throw new JobError("That duck isn't in this pond.", 409);
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

  /** The place for `duck`: the job's own when the suggested duck takes it, else chosen for this duck. */
  private placeFor(
    projectId: string,
    job: RoomJob,
    duck: DuckRow,
    cur: SessionRow | null,
    forceNew = false,
  ): JobPlace | undefined {
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
  private async handTo(projectId: string, job: RoomJob, duck: DuckRow, place: JobPlace | undefined): Promise<RoomJob> {
    const cur = duck.currentSessionId ? this.o.store.getSession(duck.currentSessionId) : null;
    const live = cur && !cur.archivedAt ? cur : null;
    const inPlace = live && (!place || (place.kind === "stream" && live.workspaceId === place.workspaceId));
    if (!inPlace) return this.startFor(projectId, job, duck, place, live);
    const s = live;
    job.status = "handed";
    job.handedTo = { sessionId: s.id, duckId: duck.id, title: this.o.room.duckName(s), newThread: false };
    job.updatedAt = this.now();
    // The person sending a job to an off-duty duck puts it back on duty.
    this.o.room.setDutyById(duck.id, true);
    try {
      await this.o.send(s.id, job.text + this.attachLines(projectId, job, s.cwd));
    } catch (error) {
      delete job.handedTo;
      job.status = "suggested";
      throw new JobError(error instanceof Error ? error.message : "Could not send it.", 409);
    }
    this.save(projectId, job);
    return this.reconcileJob(projectId, job);
  }

  private hasAttachments(job: RoomJob): boolean {
    const c = this.o.room.attachments.counts(job.messageId);
    return c.images + c.files > 0;
  }

  /** The attachment lines of the job's message, copied under `cwd` the way a chat's are; a failure refuses the send. */
  private attachLines(projectId: string, job: RoomJob, cwd: string): string {
    try {
      return this.o.room.attachments.forTurn(projectId, job.messageId, cwd);
    } catch (error) {
      throw new JobError(error instanceof AttachmentError ? error.message : "Couldn't copy the attachments.", 409);
    }
  }

  /** A fresh session for the duck in `place`; the old one stays as history. A duck busy elsewhere cannot start one. */
  private async startFor(
    projectId: string,
    job: RoomJob,
    duck: DuckRow,
    place: JobPlace | undefined,
    cur: SessionRow | null,
  ): Promise<RoomJob> {
    if (cur && !cur.archivedAt && this.o.room.duckView(duck).state !== "idle") {
      const name = duck.name ?? this.o.room.duckName(cur);
      throw new JobError(`${name} is busy in another stream; wait for it to finish, or let it claim this after.`, 409);
    }
    this.o.room.setDutyById(duck.id, true);
    let child: SessionRow;
    try {
      if (this.o.start) {
        child = await this.o.start({
          projectId,
          duck,
          ...(place ? { place } : {}),
          text: job.text,
          title: jobTitle(job.text),
          ...(this.hasAttachments(job) ? { attach: (cwd: string) => this.attachLines(projectId, job, cwd) } : {}),
        });
      } else {
        child = await this.o.newThread(
          projectId,
          job.text,
          jobTitle(job.text),
          this.hasAttachments(job) ? (cwd) => this.attachLines(projectId, job, cwd) : undefined,
        );
        this.o.store.attachSessionToDuck(duck.id, child.id);
      }
    } catch (error) {
      if (error instanceof JobError) throw error;
      throw new JobError(error instanceof Error ? error.message : "Could not start a thread.", 409);
    }
    this.o.store.attachSessionToDuck(duck.id, child.id);
    this.o.room.emitDuck(duck.id);
    job.status = "handed";
    job.handedTo = {
      sessionId: child.id,
      duckId: duck.id,
      title: child.title ?? jobTitle(job.text),
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
            oneLine(stripAttachmentLines(t.prompt)) === want &&
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

function ref(s: Scored): JobThreadRef {
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
export function jobTitle(text: string): string {
  const t = oneLine(text, 60).replace(/[.!?]+$/, "");
  return t || "New job";
}
