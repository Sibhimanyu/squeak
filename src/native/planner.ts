import { randomUUID } from "node:crypto";

import type { NativeStore } from "./store.js";
import type { AgentKind, SessionRow } from "./types.js";

/**
 * Work for later, per project: the backlog (ideas to start as a chat when there is time) and routines (a prompt
 * that starts a chat on a schedule: every N hours, daily at a time, or weekly on a day). Times are the Mac's
 * local time. A routine missed while the Mac slept runs once when the host next checks, never several times.
 */

export class PlannerError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface BacklogItem {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  createdAt: string;
}

export type Schedule =
  | { kind: "hourly"; every: number }
  | { kind: "daily"; at: string }
  | { kind: "weekly"; day: number; at: string };

export interface Routine {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  schedule: Schedule;
  agent: AgentKind;
  model: string;
  permissionMode: string;
  /** A fresh workspace for each run (else the project's own folder). */
  newWorkspace: boolean;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  lastSessionId: string | null;
  lastError: string | null;
  /** When it runs next, given the clock now. */
  nextRunAt: string | null;
}

/** What starting a chat needs; the server's own create path (workspace, then chat). */
export type StartChat = (spec: {
  projectId: string;
  newWorkspace: boolean;
  agent: AgentKind;
  model: string;
  permissionMode: string;
  title: string;
  text: string;
}) => Promise<SessionRow>;

const MAX_TITLE = 120;
const MAX_PROMPT = 20_000;
/** Modes a routine may run in: never one that skips every approval while nobody watches. */
const ROUTINE_MODES = new Set(["default", "acceptEdits", "plan"]);
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function readSchedule(v: unknown): Schedule {
  if (typeof v !== "object" || v === null) throw new PlannerError("schedule is required");
  const o = v as Record<string, unknown>;
  if (
    o.kind === "hourly" &&
    typeof o.every === "number" &&
    Number.isInteger(o.every) &&
    o.every >= 1 &&
    o.every <= 168
  ) {
    return { kind: "hourly", every: o.every };
  }
  if (o.kind === "daily" && typeof o.at === "string" && TIME.test(o.at)) return { kind: "daily", at: o.at };
  if (
    o.kind === "weekly" &&
    typeof o.at === "string" &&
    TIME.test(o.at) &&
    typeof o.day === "number" &&
    Number.isInteger(o.day) &&
    o.day >= 0 &&
    o.day <= 6
  ) {
    return { kind: "weekly", day: o.day, at: o.at };
  }
  throw new PlannerError(
    "schedule is { kind: hourly, every: 1-168 }, { kind: daily, at: HH:MM } or { kind: weekly, day: 0-6, at: HH:MM }",
  );
}

/** The newest time at or before `now` the schedule fires (hourly: counted from `from`). */
export function lastOccurrence(schedule: Schedule, now: Date, from: Date): Date | null {
  if (schedule.kind === "hourly") {
    const step = schedule.every * 3_600_000;
    const n = Math.floor((now.getTime() - from.getTime()) / step);
    return n >= 1 ? new Date(from.getTime() + n * step) : null;
  }
  const [h, m] = schedule.at.split(":").map(Number) as [number, number];
  const at = new Date(now);
  at.setHours(h, m, 0, 0);
  if (schedule.kind === "daily") {
    if (at > now) at.setDate(at.getDate() - 1);
    return at;
  }
  const back = (at.getDay() - schedule.day + 7) % 7;
  at.setDate(at.getDate() - back);
  if (at > now) at.setDate(at.getDate() - 7);
  return at;
}

export function nextOccurrence(schedule: Schedule, now: Date, from: Date): Date {
  if (schedule.kind === "hourly") {
    const last = lastOccurrence(schedule, now, from) ?? from;
    return new Date(last.getTime() + schedule.every * 3_600_000);
  }
  const last = lastOccurrence(schedule, now, from)!;
  const next = new Date(last);
  next.setDate(next.getDate() + (schedule.kind === "daily" ? 1 : 7));
  return next;
}

type Row = Record<string, unknown>;

export class Planner {
  private timer: NodeJS.Timeout | null = null;
  private readonly running = new Set<string>();
  private readonly now: () => Date;

  constructor(
    private readonly store: NativeStore,
    private readonly startChat: StartChat,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private project(id: string): void {
    if (!this.store.getProject(id)) throw new PlannerError("no such project", 404);
  }

  private text(v: unknown, name: string, max: number): string {
    if (typeof v !== "string" || !v.trim()) throw new PlannerError(`${name} is required`);
    if (v.length > max) throw new PlannerError(`${name} is too long`);
    return v.trim();
  }

  // backlog

  backlog(projectId: string): BacklogItem[] {
    this.project(projectId);
    return (
      this.store.db
        .prepare("SELECT * FROM backlog WHERE project_id=? ORDER BY created_at DESC, id")
        .all(projectId) as Row[]
    ).map((r) => ({
      id: r.id as string,
      projectId: r.project_id as string,
      title: r.title as string,
      prompt: r.prompt as string,
      createdAt: r.created_at as string,
    }));
  }

  addBacklog(projectId: string, body: Record<string, unknown>): BacklogItem {
    this.project(projectId);
    const prompt = this.text(body.prompt, "prompt", MAX_PROMPT);
    const title =
      typeof body.title === "string" && body.title.trim()
        ? body.title.trim().slice(0, MAX_TITLE)
        : prompt.split("\n")[0]!.slice(0, 80);
    const item: BacklogItem = { id: randomUUID(), projectId, title, prompt, createdAt: this.now().toISOString() };
    this.store.db
      .prepare("INSERT INTO backlog (id,project_id,title,prompt,created_at) VALUES (?,?,?,?,?)")
      .run(item.id, projectId, title, prompt, item.createdAt);
    return item;
  }

  removeBacklog(id: string): void {
    if (this.store.db.prepare("DELETE FROM backlog WHERE id=?").run(id).changes === 0) {
      throw new PlannerError("no such backlog item", 404);
    }
  }

  /** Starts the item as a chat (a new workspace unless asked otherwise); it leaves the backlog once started. */
  async startBacklog(id: string, body: Record<string, unknown>): Promise<SessionRow> {
    const r = this.store.db.prepare("SELECT * FROM backlog WHERE id=?").get(id) as Row | undefined;
    if (!r) throw new PlannerError("no such backlog item", 404);
    const agent = body.agent === "codex" ? "codex" : body.agent === "claude" ? "claude" : null;
    if (!agent) throw new PlannerError("agent must be claude or codex");
    const model = this.text(body.model, "model", 200);
    const session = await this.startChat({
      projectId: r.project_id as string,
      newWorkspace: body.newWorkspace !== false,
      agent,
      model,
      permissionMode: typeof body.permissionMode === "string" ? body.permissionMode : "default",
      title: r.title as string,
      text: r.prompt as string,
    });
    this.store.db.prepare("DELETE FROM backlog WHERE id=?").run(id);
    return session;
  }

  // routines

  private routine(r: Row): Routine {
    const schedule = JSON.parse(r.schedule as string) as Schedule;
    const enabled = r.enabled === 1;
    const from = new Date((r.last_run_at as string | null) ?? (r.created_at as string));
    return {
      id: r.id as string,
      projectId: r.project_id as string,
      title: r.title as string,
      prompt: r.prompt as string,
      schedule,
      agent: r.agent as AgentKind,
      model: r.model as string,
      permissionMode: r.permission_mode as string,
      newWorkspace: r.new_workspace === 1,
      enabled,
      createdAt: r.created_at as string,
      lastRunAt: (r.last_run_at as string | null) ?? null,
      lastSessionId: (r.last_session_id as string | null) ?? null,
      lastError: (r.last_error as string | null) ?? null,
      nextRunAt: enabled
        ? nextOccurrence(
            schedule,
            this.now(),
            new Date(r.created_at as string) > from ? new Date(r.created_at as string) : from,
          ).toISOString()
        : null,
    };
  }

  routines(projectId: string): Routine[] {
    this.project(projectId);
    return (
      this.store.db.prepare("SELECT * FROM routines WHERE project_id=? ORDER BY created_at, id").all(projectId) as Row[]
    ).map((r) => this.routine(r));
  }

  private getRoutine(id: string): Routine {
    const r = this.store.db.prepare("SELECT * FROM routines WHERE id=?").get(id) as Row | undefined;
    if (!r) throw new PlannerError("no such routine", 404);
    return this.routine(r);
  }

  private readFields(body: Record<string, unknown>, base?: Routine) {
    const has = (k: string): boolean => k in body;
    const prompt = has("prompt") || !base ? this.text(body.prompt, "prompt", MAX_PROMPT) : base.prompt;
    const title =
      has("title") && typeof body.title === "string" && body.title.trim()
        ? body.title.trim().slice(0, MAX_TITLE)
        : (base?.title ?? prompt.split("\n")[0]!.slice(0, 80));
    const schedule = has("schedule") || !base ? readSchedule(body.schedule) : base.schedule;
    const agent = has("agent") || !base ? body.agent : base.agent;
    if (agent !== "claude" && agent !== "codex") throw new PlannerError("agent must be claude or codex");
    const model = has("model") || !base ? this.text(body.model, "model", 200) : base.model;
    const permissionMode = has("permissionMode") || !base ? (body.permissionMode ?? "default") : base.permissionMode;
    if (typeof permissionMode !== "string" || !ROUTINE_MODES.has(permissionMode)) {
      throw new PlannerError("a routine runs in default, acceptEdits or plan mode, never one that skips approvals");
    }
    const newWorkspace = has("newWorkspace") ? body.newWorkspace === true : (base?.newWorkspace ?? true);
    const enabled = has("enabled") ? body.enabled !== false : (base?.enabled ?? true);
    return { prompt, title, schedule, agent: agent as AgentKind, model, permissionMode, newWorkspace, enabled };
  }

  addRoutine(projectId: string, body: Record<string, unknown>): Routine {
    this.project(projectId);
    const f = this.readFields(body);
    const id = randomUUID();
    this.store.db
      .prepare(
        "INSERT INTO routines (id,project_id,title,prompt,schedule,agent,model,permission_mode,new_workspace,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        projectId,
        f.title,
        f.prompt,
        JSON.stringify(f.schedule),
        f.agent,
        f.model,
        f.permissionMode,
        f.newWorkspace ? 1 : 0,
        f.enabled ? 1 : 0,
        this.now().toISOString(),
      );
    return this.getRoutine(id);
  }

  updateRoutine(id: string, body: Record<string, unknown>): Routine {
    const f = this.readFields(body, this.getRoutine(id));
    this.store.db
      .prepare(
        "UPDATE routines SET title=?,prompt=?,schedule=?,agent=?,model=?,permission_mode=?,new_workspace=?,enabled=? WHERE id=?",
      )
      .run(
        f.title,
        f.prompt,
        JSON.stringify(f.schedule),
        f.agent,
        f.model,
        f.permissionMode,
        f.newWorkspace ? 1 : 0,
        f.enabled ? 1 : 0,
        id,
      );
    return this.getRoutine(id);
  }

  removeRoutine(id: string): void {
    if (this.store.db.prepare("DELETE FROM routines WHERE id=?").run(id).changes === 0) {
      throw new PlannerError("no such routine", 404);
    }
  }

  /** Runs a routine now (by hand, or because it is due). One run at a time per routine. */
  async runRoutine(id: string): Promise<SessionRow> {
    const r = this.getRoutine(id);
    if (this.running.has(id)) throw new PlannerError("this routine is already starting", 409);
    this.running.add(id);
    const at = this.now().toISOString();
    try {
      const session = await this.startChat({
        projectId: r.projectId,
        newWorkspace: r.newWorkspace,
        agent: r.agent,
        model: r.model,
        permissionMode: r.permissionMode,
        title: r.title,
        text: `[Routine "${r.title}", started by Squeak on its schedule.]\n\n${r.prompt}`,
      });
      this.store.db
        .prepare("UPDATE routines SET last_run_at=?, last_session_id=?, last_error=NULL WHERE id=?")
        .run(at, session.id, id);
      return session;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A failed run still counts as this occurrence: it is not retried every minute.
      this.store.db
        .prepare("UPDATE routines SET last_run_at=?, last_error=? WHERE id=?")
        .run(at, message.slice(0, 500), id);
      throw error;
    } finally {
      this.running.delete(id);
    }
  }

  /** Every enabled routine whose latest occurrence is after its last run (or its creation). */
  due(): string[] {
    const now = this.now();
    return (this.store.db.prepare("SELECT * FROM routines WHERE enabled=1").all() as Row[])
      .filter((r) => {
        const created = new Date(r.created_at as string);
        const last = r.last_run_at ? new Date(r.last_run_at as string) : created;
        const occ = lastOccurrence(JSON.parse(r.schedule as string) as Schedule, now, last > created ? last : created);
        return occ !== null && occ > last && occ > created;
      })
      .map((r) => r.id as string);
  }

  async tick(): Promise<void> {
    for (const id of this.due()) await this.runRoutine(id).catch(() => undefined);
  }

  start(intervalMs = 60_000): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
