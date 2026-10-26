import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FleetSession } from "../../fleet/types.js";
import type { DirectorState, PhoneFilm, WorkflowProgress, WorkflowStatus, WorkflowView } from "../types.js";
import { directorScript, realDirectorDeps, runDirector } from "./director.js";
import type { DirectorDeps } from "./director.js";
import { isChat, type RasanaiProvider } from "./provider.js";
import {
  acceptsExternalActions,
  isFinished,
  isV2,
  readRasanaiRun,
  STALE_WAIT_MS,
  toolOfAsk,
  viewImages,
  viewMedia,
  waitingStatus,
  workflowProgress,
  workflowView,
} from "./run.js";
import type { RasanaiRun } from "./run.js";
import type { RasanaiActionLine } from "./actions.js";

/**
 * Films, independent of chat sessions. A film is a RasanAI project folder (`~/Documents/RasanAI/<film>`, or the
 * cwd of any agent session that has `.rasanai/current`); the phone lists the ones touched in the last week,
 * shows the call waiting on the person, their unread answers and the Ask Rasan thread, and can wake or stop the
 * director even when no agent session is alive.
 *
 * Everything is read from files (and a `ps` for a live pid), cached by the files' mtimes: this runs on every
 * published view, and never starts node. Only the commands below write, and only through the provider's checks
 * (answers, chat) or RasanAI's own `director.mjs` (resume, stop, install-tool).
 */

export const FILMS_MAX = 12;
export const FILM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CHAT_LINES_MAX = 40;
const CHAT_TEXT_MAX = 2_000;
/** One resume/stop per film per this long. */
const DIRECTOR_MIN_GAP_MS = 20_000;
const NOTE_FOR_MS = 10 * 60_000;
const PS_CACHE_MS = 5_000;
const MISS_TTL_MS = 15_000;
const TOOL_NAME = /^[a-z][a-z0-9-]{0,30}$/;

export const STOPPED_PROMPT_CAN_RESUME = "The director stopped. Resume from your phone.";
export const STOPPED_PROMPT_MAC = "The director stopped. Resume it in RasanAI Studio.";
export const NO_RESUME_NOTE = "Update RasanAI Studio to resume from your phone.";

/** `film:` + the first 16 hex of sha256(realpath(projectDir)). */
export function filmIdOf(projectDir: string): string {
  let real = projectDir;
  try {
    real = fs.realpathSync(projectDir);
  } catch {
    // A folder that is gone still has an id; nothing will find it.
  }
  return `film:${crypto.createHash("sha256").update(real).digest("hex").slice(0, 16)}`;
}

export interface FilmCommand {
  v: 1;
  kind: "film";
  filmId: string;
  op: "answer" | "chat" | "resume" | "stop" | "installTool";
  step?: string;
  revision?: string;
  type?: string;
  value?: unknown;
  note?: string;
  text?: string;
  askId?: string;
  tool?: string;
  nonce: string;
  expiresAt: number;
}

export type FilmResult = { ok: true; said: string } | { ok: false; reason: string };

export interface FilmServiceOptions {
  provider: RasanaiProvider;
  /** Folders whose children are film projects. Default `~/Documents/RasanAI`. */
  roots?: string[];
  /** Other project folders to look at: the cwds of the agent sessions the fleet sees. */
  extraDirs?: () => string[];
  now?: () => number;
  director?: DirectorDeps;
  /** Whether a process exists; `kill(pid, 0)` unless a test swaps it. */
  alive?: (pid: number) => boolean;
  /** `ps -o stat=` for a pid, or null; a `T` is a stopped (paused) process. */
  procState?: (pid: number) => string | null;
}

interface DirectorEvent {
  t: string | null;
  event: string;
  pid: number | null;
  code: number | null;
  stopped: boolean;
}

interface Entry {
  stamp: string;
  projectDir: string;
  run: RasanaiRun;
  events: DirectorEvent[];
  actions: RasanaiActionLine[];
  consumed: Set<string>;
  rejected: Set<string>;
  mtimeMs: number;
}

interface Scanned {
  id: string;
  entry: Entry;
  updatedAtMs: number;
}

export class FilmService {
  private readonly provider: RasanaiProvider;
  private readonly roots: string[];
  private readonly extraDirs: () => string[];
  private readonly now: () => number;
  private readonly directorDeps: DirectorDeps;
  private readonly alive: (pid: number) => boolean;
  private readonly procState: (pid: number) => string | null;
  private readonly cache = new Map<string, Entry>();
  private readonly psCache = new Map<number, { at: number; state: string | null }>();
  private readonly lastDirectorAt = new Map<string, number>();
  private readonly lastWakeAt = new Map<string, number>();
  private readonly notes = new Map<string, { text: string; until: number }>();
  private readonly installing = new Map<string, string>();
  /** Folders checked and found not to be projects, so hundreds of session folders are not re-read every few seconds. */
  private readonly misses = new Map<string, number>();
  private readonly stoppedByPhone = new Map<string, number>();

  constructor(options: FilmServiceOptions) {
    this.provider = options.provider;
    this.roots = options.roots ?? [path.join(os.homedir(), "Documents", "RasanAI")];
    this.extraDirs = options.extraDirs ?? (() => []);
    this.now = options.now ?? (() => Date.now());
    this.directorDeps = options.director ?? realDirectorDeps;
    this.alive = options.alive ?? defaultAlive;
    this.procState = options.procState ?? defaultProcState;
  }

  // ---- reading ---------------------------------------------------------------------------------------------

  /** The phone's films, newest first. `active` is the fleet's active sessions, for each film's director session. */
  list(active: FleetSession[] = []): PhoneFilm[] {
    return this.scan().map((scanned) => this.film(scanned, active));
  }

  /** What a phone may fetch for a film: the images its card names plus its poster. Null: not allowed. */
  imageProject(filmId: string, source: string): string | null {
    const scanned = this.find(filmId);
    if (!scanned) {
      return null;
    }
    const card = this.cardOf(scanned.entry);
    const allowed = [
      ...(card ? viewImages(card) : []),
      ...(this.posterOf(scanned.entry.run) ? [this.posterOf(scanned.entry.run)!] : []),
    ];
    return allowed.includes(source) ? scanned.entry.projectDir : null;
  }

  /** The film or soundtrack the waiting card plays. Null: not allowed. */
  mediaProject(filmId: string, source: string): string | null {
    const scanned = this.find(filmId);
    const card = scanned ? this.cardOf(scanned.entry) : null;
    return scanned && card && viewMedia(card).includes(source) ? scanned.entry.projectDir : null;
  }

  /**
   * Mark the director sessions of films whose director stopped or crashed mid-film (not finished, not waiting),
   * so the existing blocked-question push says so once. Runs after the provider's own annotate: a session it
   * marked as waiting stays as it is.
   */
  annotate(sessions: FleetSession[]): FleetSession[] {
    const out = this.provider.annotate(sessions);
    const nowMs = this.now();
    let changed = false;
    const marked = out.map((session) => {
      if (session.agent !== "claude" || !session.cwd || session.workflow || !session.workflowProgress) {
        return session;
      }
      const entry = this.entryFor(session.cwd);
      if (!entry) {
        return session;
      }
      const state = this.directorState(entry, nowMs);
      if (state.state !== "stopped" && state.state !== "crashed") {
        return session;
      }
      const since = state.since;
      if (!since || nowMs - Date.parse(since) > STALE_WAIT_MS || this.stopByPhoneAt(entry.projectDir, since)) {
        return session;
      }
      const resumable =
        directorScript(consoleSkill(entry.run), entry.projectDir, this.directorDeps.engineRoots) !== null;
      const prompt = resumable ? STOPPED_PROMPT_CAN_RESUME : STOPPED_PROMPT_MAC;
      const status: WorkflowStatus = {
        provider: "rasanai",
        projectDir: entry.projectDir,
        runDir: entry.run.runDir,
        title: text(entry.run.session.title),
        call: "other",
        step: text(entry.run.session.current) ?? "brief",
        revision: `stopped@${since}`,
        since,
        prompt,
      };
      changed = true;
      return {
        ...session,
        workflow: status,
        state: session.state === "awaiting_approval" ? session.state : ("awaiting_input" as const),
        detail: `RasanAI · ${prompt}`,
        title: session.title ?? status.title,
      };
    });
    return changed ? marked : out;
  }

  private stopByPhoneAt(projectDir: string, since: string): boolean {
    const at = this.stoppedByPhone.get(projectDir);
    return at !== undefined && Math.abs(Date.parse(since) - at) < 60_000;
  }

  private film(scanned: Scanned, active: FleetSession[]): PhoneFilm {
    const { entry } = scanned;
    const run = entry.run;
    const nowMs = this.now();
    const finished = isFinished(run);
    const director = this.directorState(entry, nowMs);
    const script = directorScript(consoleSkill(run), entry.projectDir, this.directorDeps.engineRoots);
    const waiting = !finished ? waitingStatus(run, nowMs) : null;
    const card = waiting ? workflowView(run, waiting) : null;
    const accepts = acceptsExternalActions(run);
    const needsWake =
      !finished && (director.state === "stopped" || director.state === "crashed" || director.state === "frozen");
    const note = this.notes.get(entry.projectDir);
    const installing = this.installing.get(entry.projectDir);
    const engineNote =
      installing !== undefined
        ? `Installing ${installing}…`
        : note && note.until > nowMs
          ? note.text
          : needsWake && script === null
            ? NO_RESUME_NOTE
            : null;
    const session = directorSession(active, entry.projectDir);
    const { pending, chat } = this.threadOf(entry);
    return {
      id: scanned.id,
      title: text(run.session.title) ?? path.basename(entry.projectDir),
      updatedAt: new Date(scanned.updatedAtMs).toISOString(),
      progress: workflowProgress(run, nowMs, FILM_MAX_AGE_MS) as WorkflowProgress | null,
      director: {
        state: finished ? "finished" : director.state,
        since: director.since,
        detail: finished ? null : director.detail,
      },
      card,
      pending,
      chat,
      canChat: accepts && !finished && (isV2(run) || waiting !== null),
      canResume: needsWake && script !== null,
      canStop: !finished && (director.state === "running" || director.state === "frozen") && script !== null,
      sessionKey: session?.key ?? null,
      poster: this.posterOf(run),
      engineNote,
    };
  }

  private cardOf(entry: Entry): WorkflowView | null {
    const status = isFinished(entry.run) ? null : waitingStatus(entry.run, this.now());
    return status ? workflowView(entry.run, status) : null;
  }

  /** Your answers the director has not read, and the Ask Rasan thread (its lines, then your unread messages). */
  private threadOf(entry: Entry): { pending: PhoneFilm["pending"]; chat: PhoneFilm["chat"] } {
    const unread = entry.actions.filter(
      (line) => line.source === "squeak-phone" && !entry.consumed.has(line.id) && !entry.rejected.has(line.id),
    );
    const pending = unread
      .filter((line) => !isChat(line))
      .slice(-20)
      .map((line) => ({ id: line.id, type: String(line.type), said: saidOf(line), t: stamp(line.ts) }));
    const lines: {
      id: string;
      who: "you" | "rasan";
      text: string;
      t: string | null;
      state: "sent" | "pending" | null;
      ms: number;
    }[] = [];
    for (const [stepId, step] of Object.entries(entry.run.session.steps ?? {})) {
      const thread = Array.isArray(step?.thread) ? (step!.thread as Record<string, unknown>[]) : [];
      thread.forEach((line, index) => {
        const body = text(line?.text);
        if (!body) {
          return;
        }
        const you = line.who === "you";
        const t = text(line.t);
        lines.push({
          id: `${stepId}:${index}`,
          who: you ? "you" : "rasan",
          text: clip(body, CHAT_TEXT_MAX),
          t,
          state: you ? "sent" : null,
          ms: t ? Date.parse(t) || 0 : 0,
        });
      });
    }
    lines.sort((a, b) => a.ms - b.ms);
    const asked = unread
      .filter((line) => isChat(line))
      .map((line) => ({
        id: line.id,
        who: "you" as const,
        text: clip(String(line.note ?? ""), CHAT_TEXT_MAX),
        t: stamp(line.ts),
        state: "pending" as const,
        ms: Date.parse(line.ts) || 0,
      }));
    const chat = [...lines, ...asked]
      .slice(-CHAT_LINES_MAX)
      .map((line) => ({ id: line.id, who: line.who, text: line.text, t: line.t, state: line.state }));
    return { pending, chat };
  }

  /** A newest look poster, the animatic's first still, a styleframe, a story's picture, or a brief capture. */
  private posterOf(run: RasanaiRun): string | null {
    const steps = run.session.steps ?? {};
    const first = (...values: unknown[]): string | null => {
      for (const value of values) {
        const found = image(value);
        if (found) {
          return found;
        }
      }
      return null;
    };
    const list = (value: unknown): Record<string, unknown>[] =>
      Array.isArray(value)
        ? (value.filter((entry) => entry && typeof entry === "object") as Record<string, unknown>[])
        : [];
    const render = steps.final ?? steps.render;
    const animatic = steps.animatic;
    const styleframes = steps.styleframes;
    const look = steps.look ?? steps.films;
    const story = steps.story;
    const brief = steps.brief;
    return (
      first(render?.poster) ??
      first(...list(animatic?.scenes).map((scene) => scene.thumb)) ??
      first(...list(styleframes?.frames).map((frame) => frame.image)) ??
      first(
        ...list(look?.styles ?? look?.films).flatMap((entry) => [
          entry.poster,
          ...(Array.isArray(entry.frames)
            ? (entry.frames as unknown[]).map((frame) =>
                frame && typeof frame === "object" ? (frame as Record<string, unknown>).image : frame,
              )
            : []),
        ]),
      ) ??
      first(...list(story?.stories).map((entry) => entry.image)) ??
      first(...list(brief?.captures).map((capture) => capture.image))
    );
  }

  // ---- the director's liveness ------------------------------------------------------------------------------

  private directorState(
    entry: Entry,
    nowMs: number,
  ): { state: DirectorState; since: string | null; detail: string | null } {
    const events = entry.events;
    let lastStart = -1;
    let lastExit = -1;
    events.forEach((event, index) => {
      if (event.event === "start") {
        lastStart = index;
      } else if (event.event === "exit") {
        lastExit = index;
      }
    });
    if (lastStart < 0 && lastExit < 0) {
      return { state: "none", since: null, detail: null };
    }
    if (lastExit > lastStart) {
      const exit = events[lastExit]!;
      if (exit.stopped) {
        return { state: "stopped", since: exit.t, detail: "Stopped before the film was done." };
      }
      if (exit.code === 0) {
        return { state: "stopped", since: exit.t, detail: "The director's turn ended." };
      }
      return {
        state: "crashed",
        since: exit.t,
        detail: exit.code === null ? "The director exited." : `The director exited with code ${exit.code}.`,
      };
    }
    const start = events[lastStart]!;
    if (start.pid === null || !this.alive(start.pid)) {
      return { state: "crashed", since: start.t, detail: "The director's process is gone." };
    }
    const state = this.processState(start.pid, nowMs);
    return state !== null && state.includes("T")
      ? { state: "frozen", since: start.t, detail: "Paused." }
      : { state: "running", since: start.t, detail: null };
  }

  private processState(pid: number, nowMs: number): string | null {
    const held = this.psCache.get(pid);
    if (held && nowMs - held.at < PS_CACHE_MS) {
      return held.state;
    }
    const state = this.procState(pid);
    if (this.psCache.size > 50) {
      this.psCache.clear();
    }
    this.psCache.set(pid, { at: nowMs, state });
    return state;
  }

  // ---- finding films ----------------------------------------------------------------------------------------

  private scan(): Scanned[] {
    const dirs = new Set<string>();
    for (const root of this.roots) {
      try {
        for (const name of fs.readdirSync(root)) {
          if (!name.startsWith(".")) {
            dirs.add(path.join(root, name));
          }
        }
      } catch {
        // No such folder on this Mac.
      }
    }
    for (const dir of this.extraDirs()) {
      if (dir) {
        dirs.add(dir);
      }
    }
    const nowMs = this.now();
    const seen = new Set<string>();
    const found: Scanned[] = [];
    for (const dir of dirs) {
      const missed = this.misses.get(dir);
      if (missed !== undefined && nowMs - missed < MISS_TTL_MS) {
        continue;
      }
      const entry = this.entryFor(dir);
      if (!entry) {
        this.misses.set(dir, nowMs);
        continue;
      }
      this.misses.delete(dir);
      const id = filmIdOf(entry.projectDir);
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const updatedAtMs = this.updatedAt(entry);
      if (nowMs - updatedAtMs > FILM_MAX_AGE_MS) {
        continue;
      }
      found.push({ id, entry, updatedAtMs });
    }
    for (const key of this.cache.keys()) {
      if (!dirs.has(key)) {
        this.cache.delete(key);
      }
    }
    if (this.misses.size > 2_000) {
      this.misses.clear();
    }
    return found.sort((a, b) => b.updatedAtMs - a.updatedAtMs || title(a).localeCompare(title(b))).slice(0, FILMS_MAX);
  }

  private find(filmId: string): Scanned | null {
    return this.scan().find((scanned) => scanned.id === filmId) ?? null;
  }

  private updatedAt(entry: Entry): number {
    const session = entry.run.session;
    const current = text(session.current);
    const stamps = [
      session.updated,
      session.working?.t,
      current ? session.steps?.[current]?.updated : null,
      entry.events[entry.events.length - 1]?.t,
    ]
      .map((value) => Date.parse(text(value) ?? ""))
      .filter((value) => Number.isFinite(value));
    return Math.max(entry.mtimeMs, ...stamps);
  }

  /** A project's files, read again only when one of them changes. Null: not a RasanAI project. */
  private entryFor(projectDir: string): Entry | null {
    const stateDir = path.join(projectDir, ".rasanai");
    let runName: string;
    try {
      runName = fs.readFileSync(path.join(stateDir, "current"), "utf8").trim();
    } catch {
      this.cache.delete(projectDir);
      return null;
    }
    const runDir = path.join(stateDir, runName);
    const files = [
      "session.json",
      "console.json",
      "actions.jsonl",
      "consumed.json",
      "rejected.json",
      "director-events.jsonl",
    ];
    const parts = [runName];
    let mtimeMs = 0;
    for (const name of files) {
      try {
        const stat = fs.statSync(path.join(runDir, name));
        parts.push(`${stat.mtimeMs}:${stat.size}`);
        if (name === "session.json") {
          mtimeMs = stat.mtimeMs;
        }
      } catch {
        parts.push("-");
      }
    }
    const stamped = parts.join("|");
    const held = this.cache.get(projectDir);
    if (held && held.stamp === stamped) {
      return held;
    }
    const run = readRasanaiRun(projectDir);
    if (!run) {
      this.cache.delete(projectDir);
      return null;
    }
    const entry: Entry = {
      stamp: stamped,
      projectDir,
      run,
      events: readEvents(path.join(runDir, "director-events.jsonl")),
      actions: readLines(path.join(runDir, "actions.jsonl")),
      consumed: new Set(readIds(path.join(runDir, "consumed.json"), false)),
      rejected: new Set(readIds(path.join(runDir, "rejected.json"), true)),
      mtimeMs,
    };
    if (this.cache.size > 100) {
      this.cache.clear();
    }
    this.cache.set(projectDir, entry);
    return entry;
  }

  // ---- commands ---------------------------------------------------------------------------------------------

  /**
   * A signed film command (signature, expiry and nonce already held). The film must be one the phone is shown
   * (the Mac's own list, never the phone's copy); everything else is checked against the files as they are now.
   */
  async handle(command: FilmCommand): Promise<FilmResult> {
    const scanned = this.find(command.filmId);
    if (!scanned) {
      return { ok: false, reason: "That film isn't on this Mac any more." };
    }
    const { entry } = scanned;
    switch (command.op) {
      case "answer":
        return this.answer(entry, command);
      case "chat":
        return this.talk(entry, command);
      case "resume":
        return this.resume(entry, scanned.id);
      case "stop":
        return this.stop(entry, scanned.id);
      case "installTool":
        return this.installTool(entry, command);
      default:
        return { ok: false, reason: "Not a request this Mac understands." };
    }
  }

  private async answer(entry: Entry, command: FilmCommand): Promise<FilmResult> {
    const result = this.provider.act(entry.projectDir, {
      step: command.step as string,
      revision: command.revision as string,
      type: command.type as string,
      value: command.value ?? null,
      ...(command.note !== undefined ? { note: command.note } : {}),
    });
    if (!result.ok) {
      return result;
    }
    const woke = this.wake(entry);
    return { ok: true, said: woke ? `${result.said}. Waking the director.` : result.said };
  }

  private talk(entry: Entry, command: FilmCommand): FilmResult {
    const nowMs = this.now();
    const state = this.directorState(entry, nowMs);
    const result = this.provider.chat(entry.projectDir, command.text as string, {
      lastError: state.state === "crashed" ? state.detail : null,
    });
    if (!result.ok) {
      return result;
    }
    const woke = this.wake(entry);
    return { ok: true, said: woke ? "Sent to Rasan. Waking the director." : result.said };
  }

  /** Studio's `wakeForSentCall`: an answer for a stopped or crashed director starts it again. Not awaited. */
  private wake(entry: Entry): boolean {
    const nowMs = this.now();
    const state = this.directorState(entry, nowMs);
    if (isFinished(entry.run) || (state.state !== "stopped" && state.state !== "crashed")) {
      return false;
    }
    const script = directorScript(consoleSkill(entry.run), entry.projectDir, this.directorDeps.engineRoots);
    const last = this.lastWakeAt.get(entry.projectDir);
    if (script === null || (last !== undefined && nowMs - last < DIRECTOR_MIN_GAP_MS)) {
      return false;
    }
    this.lastWakeAt.set(entry.projectDir, nowMs);
    void runDirector(script, "resume", entry.projectDir, [], this.directorDeps).then((outcome) => {
      if (!outcome.ok) {
        this.say(entry.projectDir, outcome.reason ?? "The director didn't wake. Try Resume.");
      }
    });
    return true;
  }

  private async resume(entry: Entry, filmId: string): Promise<FilmResult> {
    const nowMs = this.now();
    const state = this.directorState(entry, nowMs);
    if (isFinished(entry.run)) {
      return { ok: false, reason: "This film is finished." };
    }
    if (state.state === "running") {
      return { ok: false, reason: "The director is already running." };
    }
    if (state.state === "none") {
      return { ok: false, reason: "There is nothing to resume yet." };
    }
    const script = directorScript(consoleSkill(entry.run), entry.projectDir, this.directorDeps.engineRoots);
    if (script === null) {
      return { ok: false, reason: NO_RESUME_NOTE };
    }
    const limited = this.limit(filmId);
    if (limited) {
      return limited;
    }
    const outcome = await runDirector(script, "resume", entry.projectDir, [], this.directorDeps);
    return outcome.ok ? { ok: true, said: "Waking the director." } : { ok: false, reason: outcome.reason! };
  }

  private async stop(entry: Entry, filmId: string): Promise<FilmResult> {
    const nowMs = this.now();
    const state = this.directorState(entry, nowMs);
    if (state.state !== "running" && state.state !== "frozen") {
      return { ok: false, reason: "The director isn't running." };
    }
    const script = directorScript(consoleSkill(entry.run), entry.projectDir, this.directorDeps.engineRoots);
    if (script === null) {
      return { ok: false, reason: "Update RasanAI Studio to stop the director from your phone." };
    }
    const limited = this.limit(filmId);
    if (limited) {
      return limited;
    }
    // The exit this causes is the person's own doing, not a director that died: no page about it.
    this.stoppedByPhone.set(entry.projectDir, nowMs);
    const outcome = await runDirector(script, "stop", entry.projectDir, [], this.directorDeps);
    if (!outcome.ok) {
      this.stoppedByPhone.delete(entry.projectDir);
      return { ok: false, reason: outcome.reason! };
    }
    return { ok: true, said: "Stopped the director." };
  }

  private installTool(entry: Entry, command: FilmCommand): FilmResult {
    const tool = command.tool;
    const askId = command.askId;
    if (
      typeof tool !== "string" ||
      !TOOL_NAME.test(tool) ||
      typeof askId !== "string" ||
      !askId ||
      askId.length > 120
    ) {
      return { ok: false, reason: "Not a request this Mac understands." };
    }
    const run = entry.run;
    const ask = run.session.ask;
    const status = waitingStatus(run, this.now());
    if (!isV2(run) || !ask || status?.call !== "ask" || String(ask.id) !== askId || toolOfAsk(ask)?.tool !== tool) {
      return { ok: false, reason: "RasanAI isn't asking for that tool any more." };
    }
    const script = directorScript(consoleSkill(run), entry.projectDir, this.directorDeps.engineRoots);
    if (script === null) {
      return { ok: false, reason: "Update RasanAI Studio to install tools from your phone." };
    }
    if (this.installing.has(entry.projectDir)) {
      return { ok: false, reason: "Rasan is already installing a tool for this film." };
    }
    this.installing.set(entry.projectDir, tool);
    void runDirector(script, "install-tool", entry.projectDir, [tool], this.directorDeps)
      .then((outcome) => {
        this.installing.delete(entry.projectDir);
        if (!outcome.ok) {
          this.say(entry.projectDir, outcome.reason ?? `Couldn't install ${tool}.`);
          return;
        }
        // Answered only if the same ask is still the one open, with the tool Squeak installed.
        const answered = this.provider.act(
          entry.projectDir,
          { step: status.step, revision: status.revision, type: "answer", value: { choice: `tool-ready:${tool}` } },
          { toolReady: tool },
        );
        this.say(entry.projectDir, answered.ok ? `${tool} is installed.` : answered.reason);
      })
      .catch(() => {
        this.installing.delete(entry.projectDir);
        this.say(entry.projectDir, `Couldn't install ${tool}.`);
      });
    return { ok: true, said: `Installing ${tool}…` };
  }

  private limit(filmId: string): FilmResult | null {
    const nowMs = this.now();
    const last = this.lastDirectorAt.get(filmId);
    if (last !== undefined && nowMs - last < DIRECTOR_MIN_GAP_MS) {
      return { ok: false, reason: "Give the director a moment, then try again." };
    }
    this.lastDirectorAt.set(filmId, nowMs);
    return null;
  }

  private say(projectDir: string, line: string): void {
    this.notes.set(projectDir, { text: line, until: this.now() + NOTE_FOR_MS });
  }
}

// ---- helpers -----------------------------------------------------------------------------------------------

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultProcState(pid: number): string | null {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 }).trim() || null;
  } catch {
    return null;
  }
}

function consoleSkill(run: RasanaiRun): string | null {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(run.runDir, "console.json"), "utf8")) as { skill?: unknown };
    return typeof info.skill === "string" ? info.skill : null;
  } catch {
    return null;
  }
}

function directorSession(active: FleetSession[], projectDir: string): FleetSession | null {
  let real = projectDir;
  try {
    real = fs.realpathSync(projectDir);
  } catch {
    // Compare the plain path.
  }
  let best: FleetSession | null = null;
  for (const session of active) {
    if (session.agent !== "claude" || !session.cwd || session.retired) {
      continue;
    }
    if (session.cwd !== projectDir && session.cwd !== real) {
      continue;
    }
    if (!best || Date.parse(session.lastActivityAt) > Date.parse(best.lastActivityAt)) {
      best = session;
    }
  }
  return best;
}

function readEvents(file: string): DirectorEvent[] {
  return readLines(file)
    .slice(-200)
    .flatMap((line: Record<string, unknown>) => {
      const event = typeof line.event === "string" ? line.event : null;
      if (event !== "start" && event !== "exit") {
        return [];
      }
      return [
        {
          t: text(line.t),
          event,
          pid: typeof line.pid === "number" && Number.isInteger(line.pid) && line.pid > 0 ? line.pid : null,
          code: typeof line.code === "number" && Number.isFinite(line.code) ? line.code : null,
          stopped: line.stopped === true,
        },
      ];
    });
}

/** The lines of a JSON-lines file that parse as objects (the last 500). */
function readLines<T = Record<string, unknown>>(file: string): T[] {
  let body: string;
  try {
    body = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of body.split("\n").slice(-500)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push(parsed as T);
      }
    } catch {
      // A line RasanAI itself will reject.
    }
  }
  return out;
}

/** `consumed.json` is a list of ids; `rejected.json` a list of `{id, error, ts}`. */
function readIds(file: string, objects: boolean): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((entry) => {
      const id = objects ? (entry as { id?: unknown } | null)?.id : entry;
      return typeof id === "string" ? [id] : [];
    });
  } catch {
    return [];
  }
}

/** A short line for an answer not yet read: what it was, in the person's words. */
function saidOf(line: RasanaiActionLine): string {
  const value = line.value;
  switch (line.type) {
    case "choose":
      return typeof value === "string" ? `Picked ${value}` : "Picked an option";
    case "more":
      return "Asked for three more";
    case "approve":
      return "Approved";
    case "comment":
      return "A note";
    case "apply":
      return "Applied the notes";
    case "answer":
      return "Answered a question";
    case "submit":
      return "Sent the brief";
    case "decide":
      return "Left this one to Rasan";
    case "decide-rest":
      return "Asked Rasan to make the rest";
    case "redo":
      return "Asked for frames again";
    case "note":
      return "Sent a note";
    default:
      return "Sent an answer";
  }
}

function stamp(value: unknown): string {
  const at = Date.parse(typeof value === "string" ? value : "");
  return Number.isFinite(at) ? new Date(at).toISOString() : new Date(0).toISOString();
}

function image(value: unknown): string | null {
  const raw = text(value);
  return raw && /\.(png|jpe?g|webp|gif)$/i.test(raw) && raw.length <= 1_000 ? raw : null;
}

function title(scanned: Scanned): string {
  return text(scanned.entry.run.session.title) ?? path.basename(scanned.entry.projectDir);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
