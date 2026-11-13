import { claudeSteps, describeClaudeTool, type ActivityStep } from "../fleet/activity.js";
import type { MessageRow } from "./types.js";

/**
 * A native Claude chat's background helpers ("ducklings"): async Agent/Task subagents and `run_in_background`
 * shells, kept from the rows the host stores (`messages` in native.db). The turn does not wait on them: it ends
 * with its `result`, the chat is ready, and a helper's report starts a short turn of its own.
 *
 * A duckling's id is the tool-use id of the call that started it. Everything here is the agent's own output and
 * stays untrusted: titles are the call's description, never a raw command beyond its first line, and the panel
 * reads text only.
 */

export type DucklingKind = "agent" | "shell";
export type DucklingStatus = "running" | "done" | "failed" | "stopped";

export interface Duckling {
  id: string;
  kind: DucklingKind;
  title: string;
  model?: string;
  status: DucklingStatus;
  startedAt: string;
  endedAt?: string;
  summary?: string;
  /** When the agent took the report in: its next assistant row after the task-notification. Optional, absent until then. */
  reportedAt?: string;
}

export interface Ducklings {
  running: number;
  items: Duckling[];
}

export interface DucklingDetail extends Duckling {
  brief: string;
  steps: ActivityStep[];
  report?: string;
}

/** A finished helper stays listed this long (the same rule as the transcript's background work). */
export const FINISHED_SHOWN_MS = 10 * 60_000;
const MAX_ITEMS = 12;
const REPORT_CHARS = 20_000;
const SUMMARY_CHARS = 200;
const STEP_ROWS = 4000;

interface Tracked extends Duckling {
  brief: string;
  report?: string;
  /** Row seq of the launching call: the helper's own rows come after it. */
  seq: number;
  background: boolean;
  /** A task-notification for it arrived; the agent's next assistant row sets `reportedAt`. */
  notified?: boolean;
  /** The Agent tool's `model` input (an alias such as "sonnet"), before a sidechain row names the real one. */
  modelAlias?: string;
}

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function resultText(block: Record<string, unknown>): string {
  const c = block.content;
  if (typeof c === "string") return c;
  return Array.isArray(c)
    ? c
        .map((p) => str(rec(p)?.text) ?? "")
        .filter(Boolean)
        .join("\n")
    : "";
}

/** "claude-sonnet-5-5" / "sonnet" → "Sonnet 5.5" / "Sonnet". Unknown shapes come back as they are. */
export function modelLabel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?(?:\[.*\])?$/.exec(model);
  if (m) return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] && m[3].length < 3 ? `.${m[3]}` : ""}`;
  return /^[a-z]+$/.test(model) ? `${model[0]!.toUpperCase()}${model.slice(1)}` : model;
}

/** The helpers of one chat, fed row by row as the host stores them. */
export class DucklingTracker {
  private readonly tasks = new Map<string, Tracked>();
  /** The CLI's `task_id` → our id (the tool-use id), from `task_started`. */
  private readonly byTask = new Map<string, string>();

  feed(row: MessageRow): void {
    const p = rec(row.payload);
    if (!p) return;
    if (row.role === "agent" && row.kind === "error" && p.content === "aborted by user") {
      this.stopRunning(row.createdAt);
      return;
    }
    if (
      row.kind === "system/task_started" ||
      row.kind === "system/task_notification" ||
      row.kind === "system/task_updated"
    ) {
      this.feedTask(row.kind.slice("system/".length), p, row.createdAt);
      return;
    }
    if (typeof p.parent_tool_use_id === "string") {
      // a helper's own row: its model names the helper's model
      const owner = this.tasks.get(p.parent_tool_use_id);
      const model = str(rec(p.message)?.model);
      if (owner && model && !owner.model) owner.model = modelLabel(model);
      return;
    }
    const message = rec(p.message);
    const content = message?.content;
    if (p.type === "assistant") {
      // the agent's next assistant row after a helper's notification is the report reaching it
      for (const t of this.tasks.values()) if (t.notified && !t.reportedAt) t.reportedAt = row.createdAt;
    }
    if (p.type === "assistant" && Array.isArray(content)) {
      for (const raw of content) {
        const block = rec(raw);
        if (!block || block.type !== "tool_use") continue;
        const id = str(block.id);
        const name = str(block.name) ?? "";
        const input = rec(block.input) ?? {};
        const background = input.run_in_background === true;
        const kind: DucklingKind | null =
          name === "Agent" || name === "Task" ? "agent" : name === "Bash" && background ? "shell" : null;
        if (!id || !kind || this.tasks.has(id)) continue;
        const alias = str(input.model);
        this.tasks.set(id, {
          id,
          kind,
          title:
            kind === "agent"
              ? clip(str(input.description) ?? "A duckling", 120)
              : describeClaudeTool(name, { ...input, run_in_background: false }),
          status: "running",
          startedAt: row.createdAt,
          brief: kind === "agent" ? (str(input.prompt) ?? "") : (str(input.command) ?? ""),
          seq: row.seq,
          background,
          ...(alias ? { modelAlias: alias, model: modelLabel(alias) } : {}),
        });
      }
      return;
    }
    if (p.type !== "user") return;
    const blocks = Array.isArray(content) ? content.map(rec) : [];
    for (const block of blocks) {
      if (!block || block.type !== "tool_result") continue;
      const task = this.tasks.get(str(block.tool_use_id) ?? "");
      if (!task || task.status !== "running") continue;
      const launched = rec(p.tool_use_result) ?? rec(p.toolUseResult);
      const text = resultText(block);
      // A subagent launches async unless told otherwise: its result only says it started. A foreground one ends here.
      if (task.background) continue;
      if (
        task.kind === "agent" &&
        (launched?.isAsync === true || launched?.status === "async_launched" || text.startsWith("Async agent launched"))
      ) {
        task.background = true;
        continue;
      }
      this.end(task, block.is_error === true ? "failed" : "done", row.createdAt, text);
    }
    const text =
      typeof content === "string"
        ? content
        : blocks
            .filter((b) => b?.type === "text")
            .map((b) => str(b?.text) ?? "")
            .join("\n");
    for (const match of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
      const body = match[1] ?? "";
      const tag = (n: string) => new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(body)?.[1]?.trim();
      const task = this.tasks.get(tag("tool-use-id") ?? "");
      if (!task) continue;
      task.notified = true;
      const status = tag("status");
      this.end(
        task,
        status === "completed" ? "done" : status === "killed" ? "stopped" : "failed",
        row.createdAt,
        tag("result") ?? tag("summary"),
        tag("summary"),
      );
    }
  }

  private feedTask(subtype: string, p: Record<string, unknown>, at: string): void {
    const taskId = str(p.task_id);
    const toolUseId = str(p.tool_use_id);
    if (subtype === "task_started") {
      if (taskId && toolUseId) this.byTask.set(taskId, toolUseId);
      return;
    }
    const id = toolUseId ?? (taskId ? this.byTask.get(taskId) : undefined);
    const task = id ? this.tasks.get(id) : undefined;
    if (!task) return;
    if (subtype === "task_notification") {
      task.notified = true;
      const status = str(p.status);
      this.end(
        task,
        status === "completed" ? "done" : status === "killed" ? "stopped" : "failed",
        at,
        undefined,
        str(p.summary),
      );
      return;
    }
    const patch = rec(p.patch);
    const status = str(p.status) ?? str(patch?.status);
    if (status === "completed" || status === "failed" || status === "killed")
      this.end(task, status === "completed" ? "done" : status === "killed" ? "stopped" : "failed", at);
  }

  private end(task: Tracked, status: DucklingStatus, at: string, report?: string, summary?: string): void {
    if (task.status === "running") {
      task.status = status;
      task.endedAt = at;
    }
    // the report text can arrive after the status (the notification's own row follows the system one)
    if (report && !task.report) {
      task.report = report.slice(0, REPORT_CHARS);
      task.summary = clip(report, SUMMARY_CHARS);
    }
    if (summary && !task.summary) task.summary = clip(summary, SUMMARY_CHARS);
  }

  /** Stop ends every running helper: the process is closed and nothing will report. */
  stopRunning(at: string): void {
    for (const t of this.tasks.values()) if (t.status === "running") this.end(t, "stopped", at);
  }

  /** No live agent process any more (the host restarted, the runner closed): nothing is running. */
  settle(live: boolean, at: string): void {
    if (!live) this.stopRunning(at);
  }

  list(nowMs: number): Ducklings {
    const items = [...this.tasks.values()]
      .filter((t) => t.status === "running" || nowMs - Date.parse(t.endedAt ?? t.startedAt) < FINISHED_SHOWN_MS)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, MAX_ITEMS)
      .map(
        (t): Duckling => ({
          id: t.id,
          kind: t.kind,
          title: t.title,
          ...(t.model ? { model: t.model } : {}),
          status: t.status,
          startedAt: t.startedAt,
          ...(t.endedAt ? { endedAt: t.endedAt } : {}),
          ...(t.summary && t.status !== "running" ? { summary: t.summary } : {}),
          ...(t.reportedAt ? { reportedAt: t.reportedAt } : {}),
        }),
      );
    return { running: items.filter((i) => i.status === "running").length, items };
  }

  /** The seq of the helper's launching call, or null when this id is not one. */
  launchSeq(id: string): number | null {
    return this.tasks.get(id)?.seq ?? null;
  }

  detail(id: string, nowMs: number, rowsAfterLaunch: MessageRow[]): DucklingDetail | null {
    const t = this.tasks.get(id);
    if (!t) return null;
    const item = this.list(nowMs).items.find((i) => i.id === id) ?? {
      id: t.id,
      kind: t.kind,
      title: t.title,
      ...(t.model ? { model: t.model } : {}),
      status: t.status,
      startedAt: t.startedAt,
      ...(t.endedAt ? { endedAt: t.endedAt } : {}),
      ...(t.reportedAt ? { reportedAt: t.reportedAt } : {}),
    };
    const entries = rowsAfterLaunch
      .filter((r) => r.role === "agent" && rec(r.payload)?.parent_tool_use_id === id)
      .map((r) => ({ ...(rec(r.payload) as Record<string, unknown>), isSidechain: true, timestamp: r.createdAt }));
    const steps = claudeSteps(entries, 40, { sidechain: true });
    return { ...item, brief: t.brief, steps, ...(t.report ? { report: t.report } : {}) };
  }
}

export const DUCKLING_STEP_ROWS = STEP_ROWS;
