import fs from "node:fs";
import path from "node:path";

import { codexSteps, type ActivityStep } from "./activity.js";
import type { BackgroundStatus, BackgroundTask } from "./background-work.js";
import { asRecord, asString, parseJsonLines, readHeadLines, readTailLines } from "./observers/tail.js";
import type { SubagentActivity } from "./subagent-activity.js";

/**
 * A Codex chat's subagents. Codex writes each one as its own rollout file whose `session_meta` carries
 * `source.subagent.thread_spawn` with the parent's thread id and the task's name (`agent_path`, `/root/<name>`);
 * the parent's own rollout only holds the `spawn_agent` call, with the message encrypted. So the children are
 * found by scanning the day folders from the parent's day onward and reading each file's first line (once: it
 * never changes), and a child's state is its newest lifecycle event: `task_started` runs, `task_complete` is done,
 * `turn_aborted` stopped.
 *
 * The rollout files are the agent's own output and stay untrusted: a task id must match a strict pattern and
 * is only ever resolved against the files found by this scan, never joined into a path.
 */

/** A thread id (a UUID on a real machine); anything else is refused before it is looked up. */
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const TAIL_BYTES = 256 * 1024;
/** A subagent's `session_meta` line carries its instructions: about 22 KB on a real machine. */
const HEAD_BYTES = 128 * 1024;
const INDEX_TTL_MS = 3_000;
const STALE_RUNNING_MS = 24 * 60 * 60_000;
const FINISHED_SHOWN_MS = 10 * 60_000;
const MAX_TASKS = 12;
const DEFAULT_LIMIT = 30;
const DEFAULT_STEP_CHARS = 280;
const SESSIONS_PATH = /^(.*[\\/]sessions)[\\/](\d{4})[\\/](\d{2})[\\/](\d{2})[\\/][^\\/]+\.jsonl$/;

interface Child {
  id: string;
  parentId: string;
  file: string;
  name: string;
  startedAt: string | null;
}

interface Located {
  root: string;
  day: Date;
}

function locate(rolloutPath: string): Located | null {
  const match = SESSIONS_PATH.exec(rolloutPath);
  if (!match) return null;
  const day = new Date(Date.UTC(Number(match[2]), Number(match[3]) - 1, Number(match[4])));
  return Number.isNaN(day.getTime()) ? null : { root: match[1]!, day };
}

/** The thread id a rollout names itself with. */
function threadIdOf(rolloutPath: string): string | null {
  const meta = parseJsonLines(readHeadLines(rolloutPath, HEAD_BYTES)).find((e) => asString(e.type) === "session_meta");
  const payload = asRecord(meta?.payload);
  return asString(payload?.session_id) ?? asString(payload?.id);
}

function humanize(agentPath: string | null): string {
  const name = (agentPath ?? "").split("/").filter(Boolean).pop() ?? "";
  const words = name.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Subagent";
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export class CodexSubagentReader {
  private readonly heads = new Map<string, Child | null>();
  private readonly index = new Map<string, { at: number; children: Child[] }>();
  private readonly tails = new Map<string, { size: number; mtimeMs: number; entries: Record<string, unknown>[] }>();

  /** The subagent tasks of the Codex chat whose rollout is `rolloutPath`. */
  tasks(rolloutPath: string, nowMs: number): BackgroundTask[] {
    const parentId = threadIdOf(rolloutPath);
    const where = locate(rolloutPath);
    if (!parentId || !where) return [];
    const tasks: BackgroundTask[] = [];
    for (const child of this.children(parentId, where, nowMs)) {
      const task = this.taskOf(child, nowMs);
      if (task) tasks.push(task);
    }
    // Running first, then the newest.
    tasks.sort((a, b) => {
      const running = Number(b.status === "running") - Number(a.status === "running");
      return running || (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
    });
    return tasks.slice(0, MAX_TASKS);
  }

  /** One subagent's steps, or null when this chat has no such subagent. */
  read(
    rolloutPath: string,
    taskId: string,
    nowMs: number,
    options: { limit?: number; stepChars?: number } = {},
  ): SubagentActivity | null {
    if (!TASK_ID_PATTERN.test(taskId)) return null;
    const parentId = threadIdOf(rolloutPath);
    const where = locate(rolloutPath);
    if (!parentId || !where) return null;
    const child = this.children(parentId, where, nowMs).find((candidate) => candidate.id === taskId);
    if (!child) return null;
    const task = this.taskOf(child, nowMs);
    if (!task) return null;
    const steps: ActivityStep[] = codexSteps(this.entries(child.file), options.stepChars ?? DEFAULT_STEP_CHARS);
    return {
      taskId,
      agentId: child.id,
      label: task.label,
      status: task.status,
      available: true,
      steps: steps.slice(-(options.limit ?? DEFAULT_LIMIT)),
      total: steps.length,
      startedAt: task.startedAt,
      endedAt: task.endedAt ?? null,
    };
  }

  /** Whether a child's rollout file belongs to a subagent (`source.subagent`): the radar leaves those to their parent. */
  static isSubagentMeta(meta: Record<string, unknown>): boolean {
    const source = asRecord(meta.source);
    return source !== null && asRecord(source.subagent) !== null;
  }

  private children(parentId: string, where: Located, nowMs: number): Child[] {
    const cached = this.index.get(parentId);
    if (cached && nowMs - cached.at < INDEX_TTL_MS) return cached.children;
    const children: Child[] = [];
    // Day folders from the parent's day through tomorrow (folders are local days, `nowMs` is UTC), at most two weeks.
    for (let i = 0; i < 14; i += 1) {
      const day = new Date(where.day.getTime() + i * 24 * 60 * 60_000);
      if (day.getTime() > nowMs + 24 * 60 * 60_000) break;
      const dir = path.join(
        where.root,
        String(day.getUTCFullYear()),
        pad(day.getUTCMonth() + 1),
        pad(day.getUTCDate()),
      );
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        // No sessions that day.
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const child = this.head(path.join(dir, name));
        if (child && child.parentId === parentId) children.push(child);
      }
    }
    this.index.set(parentId, { at: nowMs, children });
    if (this.index.size > 32) this.index.delete(this.index.keys().next().value as string);
    return children;
  }

  /** A rollout's first line, read once. Null when it is not a subagent's. */
  private head(file: string): Child | null {
    if (this.heads.has(file)) return this.heads.get(file) ?? null;
    let child: Child | null = null;
    const meta = parseJsonLines(readHeadLines(file, HEAD_BYTES)).find((e) => asString(e.type) === "session_meta");
    const payload = asRecord(meta?.payload);
    const spawn = asRecord(asRecord(asRecord(payload?.source)?.subagent)?.thread_spawn);
    const parentId = asString(spawn?.parent_thread_id) ?? asString(payload?.parent_thread_id);
    const id = asString(payload?.id);
    if (payload && spawn && parentId && id && TASK_ID_PATTERN.test(id)) {
      child = {
        id,
        parentId,
        file,
        name: humanize(asString(spawn.agent_path)),
        startedAt: asString(payload.timestamp),
      };
    }
    // A head with no session_meta yet may still be being written; do not remember that.
    if (meta) {
      this.heads.set(file, child);
      if (this.heads.size > 2000) this.heads.delete(this.heads.keys().next().value as string);
    }
    return child;
  }

  private entries(file: string): Record<string, unknown>[] {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return [];
    }
    let cached = this.tails.get(file);
    if (!cached || cached.size !== stat.size || cached.mtimeMs !== stat.mtimeMs) {
      cached = { size: stat.size, mtimeMs: stat.mtimeMs, entries: parseJsonLines(readTailLines(file, TAIL_BYTES)) };
      this.tails.set(file, cached);
      if (this.tails.size > 64) this.tails.delete(this.tails.keys().next().value as string);
    }
    return cached.entries;
  }

  private taskOf(child: Child, nowMs: number): BackgroundTask | null {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(child.file).mtimeMs;
    } catch {
      return null;
    }
    let status: BackgroundStatus = "running";
    let endedAt: string | null = null;
    let summary: string | undefined;
    for (const entry of this.entries(child.file)) {
      if (asString(entry.type) !== "event_msg") continue;
      const payload = asRecord(entry.payload);
      const kind = asString(payload?.type);
      if (kind === "task_started") {
        status = "running";
        endedAt = null;
        summary = undefined;
      } else if (kind === "task_complete") {
        status = "done";
        endedAt = asString(entry.timestamp);
        const last = asString(payload?.last_agent_message);
        if (last) summary = last.replace(/\s+/g, " ").trim().slice(0, 200);
      } else if (kind === "turn_aborted") {
        status = "stopped";
        endedAt = asString(entry.timestamp);
      }
    }
    // No end and no sign of life for a day: its session ended without saying so.
    if (status === "running" && nowMs - mtimeMs > STALE_RUNNING_MS) status = "stopped";
    if (status !== "running") {
      const ended = endedAt ? Date.parse(endedAt) : mtimeMs;
      if (Number.isFinite(ended) && nowMs - ended > FINISHED_SHOWN_MS) return null;
    }
    return {
      id: child.id,
      kind: "agent",
      label: child.name,
      background: true,
      status,
      startedAt: child.startedAt,
      ...(endedAt ? { endedAt } : {}),
      ...(summary ? { summary } : {}),
      agentId: child.id,
      hasSteps: true,
    };
  }
}
