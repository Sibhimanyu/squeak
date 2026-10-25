import fs from "node:fs";
import path from "node:path";

import { claudeSteps, type ActivityStep } from "./activity.js";
import {
  AGENT_ID_PATTERN,
  BackgroundWorkReader,
  type BackgroundStatus,
  type BackgroundTask,
} from "./background-work.js";
import { asString, parseJsonLines, readTailLines } from "./observers/tail.js";

/**
 * What one Claude subagent is doing, read from its own transcript.
 *
 * Claude Code writes each subagent to `<project>/<session-id>/subagents/agent-<agentId>.jsonl` (entries shaped
 * like the main transcript, all `isSidechain: true`) with a sibling `agent-<agentId>.meta.json` that carries
 * the `toolUseId` of the parent's Agent/Task call. The parent's launch result names the same agentId
 * (`toolUseResult.agentId`), which background-work.ts reads; the meta file is the fallback when the launch
 * has scrolled out of the parent's tail.
 *
 * The task id and agent id arrive from a surface and the transcript is the subagent's own output: the id must
 * match a strict pattern, the file must resolve inside this session's own `subagents` directory (no
 * traversal, no symlink out), and the steps are the same short labels as the main feed, never raw tool input.
 */

/** Same tail as background-work.ts. */
const TAIL_BYTES = 1024 * 1024;
const DEFAULT_LIMIT = 30;
const DEFAULT_STEP_CHARS = 280;
/** A tool-use id as Claude Code writes it (`toolu_…`); anything else is refused before any path is built. */
export const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
/** More than this many sessions' subagent files are not kept parsed. */
const CACHE_ENTRIES = 32;

export interface SubagentActivity {
  taskId: string;
  agentId: string | null;
  label: string;
  /** The parent's view of the task. */
  status: BackgroundStatus;
  /** False while the subagent's transcript cannot be read (not written yet, or not found): `steps` is then empty. */
  available: boolean;
  /** Oldest first, the newest `limit`. */
  steps: ActivityStep[];
  total: number;
  startedAt: string | null;
  endedAt: string | null;
}

/** The directory a session's subagents live in, from the session's own transcript path. */
export function subagentsDir(transcriptPath: string): string {
  return path.join(path.dirname(transcriptPath), path.basename(transcriptPath, ".jsonl"), "subagents");
}

/**
 * The subagent's transcript, only if it is a regular file inside the session's subagents directory.
 * Null for a bad id, a missing file, a symlink, or anything resolving elsewhere.
 */
export function subagentTranscriptPath(transcriptPath: string, agentId: string): string | null {
  if (!AGENT_ID_PATTERN.test(agentId)) return null;
  const dir = subagentsDir(transcriptPath);
  const file = path.join(dir, `agent-${agentId}.jsonl`);
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    const root = fs.realpathSync(dir);
    const real = fs.realpathSync(file);
    return real === path.join(root, `agent-${agentId}.jsonl`) ? real : null;
  } catch {
    return null;
  }
}

/** The agent id whose meta file names this tool-use id; null when none does. */
export function agentIdFromMeta(transcriptPath: string, taskId: string): string | null {
  if (!TASK_ID_PATTERN.test(taskId)) return null;
  const dir = subagentsDir(transcriptPath);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const match = /^agent-([A-Za-z0-9]{6,40})\.meta\.json$/.exec(name);
    if (!match) continue;
    try {
      const file = path.join(dir, name);
      if (fs.statSync(file).size > 64 * 1024) continue;
      const meta: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      const id = meta && typeof meta === "object" ? asString((meta as Record<string, unknown>).toolUseId) : null;
      if (id === taskId) return match[1]!;
    } catch {
      // A half-written meta file: the next look finds it.
    }
  }
  return null;
}

export class SubagentActivityReader {
  private readonly cache = new Map<string, { size: number; mtimeMs: number; entries: Record<string, unknown>[] }>();

  constructor(private readonly background: BackgroundWorkReader = new BackgroundWorkReader()) {}

  /** The parent's task list with `hasSteps` set where the subagent's transcript can be read. */
  tasks(transcriptPath: string, nowMs: number): BackgroundTask[] {
    return this.background.read(transcriptPath, nowMs).map((task) => {
      if (task.kind !== "agent") return task;
      const agentId = task.agentId ?? agentIdFromMeta(transcriptPath, task.id) ?? undefined;
      const hasSteps = agentId ? subagentTranscriptPath(transcriptPath, agentId) !== null : false;
      return { ...task, ...(agentId ? { agentId } : {}), hasSteps };
    });
  }

  /**
   * One subagent's steps, or null when the parent has no such agent task (or the id is malformed).
   * `stepChars` lifts the cap on what the agent wrote, as the phone's verbose feed does.
   */
  read(
    transcriptPath: string,
    taskId: string,
    nowMs: number,
    options: { limit?: number; stepChars?: number } = {},
  ): SubagentActivity | null {
    if (!TASK_ID_PATTERN.test(taskId)) return null;
    const task = this.tasks(transcriptPath, nowMs).find((candidate) => candidate.id === taskId);
    if (!task || task.kind !== "agent") return null;
    const file = task.agentId ? subagentTranscriptPath(transcriptPath, task.agentId) : null;
    const steps = file
      ? claudeSteps(this.entries(file), options.stepChars ?? DEFAULT_STEP_CHARS, { sidechain: true })
      : [];
    return {
      taskId,
      agentId: task.agentId ?? null,
      label: task.label,
      status: task.status,
      available: file !== null,
      steps: steps.slice(-(options.limit ?? DEFAULT_LIMIT)),
      total: steps.length,
      startedAt: task.startedAt,
      endedAt: task.endedAt ?? null,
    };
  }

  private entries(file: string): Record<string, unknown>[] {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return [];
    }
    let cached = this.cache.get(file);
    if (!cached || cached.size !== stat.size || cached.mtimeMs !== stat.mtimeMs) {
      cached = { size: stat.size, mtimeMs: stat.mtimeMs, entries: parseJsonLines(readTailLines(file, TAIL_BYTES)) };
      this.cache.set(file, cached);
      if (this.cache.size > CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value as string);
    }
    return cached.entries;
  }
}
