import fs from "node:fs";

import { describeClaudeTool } from "./activity.js";
import { asArray, asRecord, asString, parseJsonLines, readTailLines } from "./observers/tail.js";

/**
 * The work a Claude chat has running beside its turn: subagents (the Agent tool, in the foreground or launched
 * with `run_in_background`) and background shells (`Bash` with `run_in_background`), read from its transcript.
 *
 * A task starts with its `tool_use`. A foreground subagent ends with its `tool_result`; an async one (the default:
 * its result says `async_launched`), or a shell, ends when Claude Code writes a `<task-notification>` naming its tool-use id and a status
 * (`completed`, `failed`, `killed`). Everything here is the agent's own output and stays untrusted: labels are
 * the tool's description, as `describeClaudeTool` says it, never a raw command beyond its first line.
 */

export type BackgroundKind = "agent" | "shell";
export type BackgroundStatus = "running" | "done" | "failed" | "stopped";

export interface BackgroundTask {
  /** The tool-use id that started it. */
  id: string;
  kind: BackgroundKind;
  label: string;
  /** Launched with `run_in_background`: the turn may end while it runs. */
  background: boolean;
  status: BackgroundStatus;
  startedAt: string | null;
  endedAt?: string | null;
  /** Claude Code's one-line summary of how it ended. */
  summary?: string;
  /**
   * A subagent's own id once its launch result has been read: `toolUseResult.agentId`, or the
   * `agentId:` line of the result text. It names `<session>/subagents/agent-<agentId>.jsonl`
   * (subagent-activity.ts). Absent for a shell, and for an agent whose launch is out of the tail.
   */
  agentId?: string;
  /** Set by the surface that checked: the subagent's own transcript can be read. */
  hasSteps?: boolean;
}

/** What Claude Code's agent ids look like (17 hex characters on a real machine); never a path. */
export const AGENT_ID_PATTERN = /^[A-Za-z0-9]{6,40}$/;

/** More than activity's tail: a shell started early in a busy turn must still be found. */
const TAIL_BYTES = 1024 * 1024;
/** A finished task stays listed this long, so its end is seen rather than it just vanishing. */
export const FINISHED_SHOWN_MS = 10 * 60_000;
/** A task with no end this old lost its notification (the session restarted); it is not running. */
const STALE_RUNNING_MS = 24 * 60 * 60_000;
const MAX_TASKS = 12;

export function readBackgroundWork(transcriptPath: string, nowMs: number): BackgroundTask[] {
  return backgroundTasks(parseJsonLines(readTailLines(transcriptPath, TAIL_BYTES)), nowMs);
}

export function backgroundTasks(entries: Record<string, unknown>[], nowMs: number): BackgroundTask[] {
  const tasks = new Map<string, BackgroundTask>();
  for (const entry of entries) {
    if (entry.isSidechain === true) continue;
    const at = asString(entry.timestamp);
    const message = asRecord(entry.message);
    if (!message) continue;
    const type = asString(entry.type);
    const content = message.content;
    if (type === "assistant") {
      for (const raw of asArray(content)) {
        const block = asRecord(raw);
        if (!block || asString(block.type) !== "tool_use") continue;
        const id = asString(block.id);
        const name = asString(block.name) ?? "";
        const input = asRecord(block.input) ?? {};
        const background = input.run_in_background === true;
        const kind: BackgroundKind | null =
          name === "Agent" || name === "Task" ? "agent" : name === "Bash" && background ? "shell" : null;
        if (!id || !kind || tasks.has(id)) continue;
        tasks.set(id, { id, kind, label: label(kind, name, input), background, status: "running", startedAt: at });
      }
      continue;
    }
    if (type !== "user") continue;
    const blocks = asArray(content).map(asRecord);
    for (const block of blocks) {
      if (!block || asString(block.type) !== "tool_result") continue;
      const task = tasks.get(asString(block.tool_use_id) ?? "");
      if (!task) continue;
      const launched = asRecord(entry.toolUseResult);
      if (task.kind === "agent" && !task.agentId) {
        const agentId = asString(launched?.agentId) ?? /\bagentId: ([A-Za-z0-9]+)/.exec(resultText(block))?.[1];
        if (agentId && AGENT_ID_PATTERN.test(agentId)) task.agentId = agentId;
      }
      if (task.background || task.status !== "running") continue;
      // A subagent launches async unless told otherwise: its result only says it started, and a notification
      // ends it later. Only a foreground subagent's result is its end.
      if (launched?.isAsync === true || asString(launched?.status) === "async_launched" || launchedText(block)) {
        task.background = true;
        continue;
      }
      task.status = block.is_error === true ? "failed" : "done";
      task.endedAt = at;
    }
    const text =
      typeof content === "string"
        ? content
        : blocks
            .filter((block) => asString(block?.type) === "text")
            .map((block) => asString(block?.text) ?? "")
            .join("\n");
    for (const match of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
      const body = match[1] ?? "";
      const tag = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(body)?.[1]?.trim();
      const task = tasks.get(tag("tool-use-id") ?? "");
      if (!task || task.status !== "running") continue;
      const status = tag("status");
      task.status = status === "completed" ? "done" : status === "killed" ? "stopped" : "failed";
      task.endedAt = at;
      const summary = tag("summary");
      if (summary) task.summary = clip(summary, 200);
    }
  }
  const age = (iso: string | null | undefined) => (iso ? nowMs - Date.parse(iso) : Number.POSITIVE_INFINITY);
  return [...tasks.values()]
    .filter((task) =>
      task.status === "running" ? age(task.startedAt) < STALE_RUNNING_MS : age(task.endedAt) < FINISHED_SHOWN_MS,
    )
    .slice(-MAX_TASKS);
}

function resultText(block: Record<string, unknown>): string {
  const content = block.content;
  return typeof content === "string"
    ? content
    : asArray(content)
        .map((part) => asString(asRecord(part)?.text) ?? "")
        .join("\n");
}

function launchedText(block: Record<string, unknown>): boolean {
  return resultText(block).startsWith("Async agent launched");
}

function label(kind: BackgroundKind, name: string, input: Record<string, unknown>): string {
  if (kind === "agent") return clip(asString(input.description) ?? "A subagent", 120);
  return describeClaudeTool(name, { ...input, run_in_background: false });
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Re-reads a transcript only when it changed; a working chat is asked every publish. */
export class BackgroundWorkReader {
  private readonly cache = new Map<string, { size: number; mtimeMs: number; entries: Record<string, unknown>[] }>();

  read(transcriptPath: string, nowMs: number): BackgroundTask[] {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(transcriptPath);
    } catch {
      return [];
    }
    let cached = this.cache.get(transcriptPath);
    if (!cached || cached.size !== stat.size || cached.mtimeMs !== stat.mtimeMs) {
      cached = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        entries: parseJsonLines(readTailLines(transcriptPath, TAIL_BYTES)),
      };
      this.cache.set(transcriptPath, cached);
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value as string);
    }
    return backgroundTasks(cached.entries, nowMs);
  }
}
