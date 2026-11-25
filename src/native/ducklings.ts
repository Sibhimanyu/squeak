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
/** `unknown`: it was running and nothing says how it ended (no live agent process to ask: a restart); never dropped. */
export type DucklingStatus = "running" | "done" | "failed" | "stopped" | "unknown";

export interface Duckling {
  id: string;
  kind: DucklingKind;
  title: string;
  /**
   * The one model of this helper, named by the host from the best evidence (the helper's own reported model, then
   * the call's `model`, then the chat's) and drawn as it is by every surface.
   */
  model?: string;
  /** True when no better evidence than the chat's own model exists: it runs on the chat's model. */
  modelInherited?: true;
  status: DucklingStatus;
  startedAt: string;
  endedAt?: string;
  /** For `unknown`: the last time anything about it was seen. */
  lastSeenAt?: string;
  summary?: string;
  /** When the agent took the report in: its next assistant row after the task-notification. Optional, absent until then. */
  reportedAt?: string;
  /** A shell's exit code, from its task notification ("(exit code 0)"). Optional; absent for agents and until it ends. */
  exitCode?: number;
}

export interface Ducklings {
  running: number;
  items: Duckling[];
  /** Claude's turn is open and only a duckling it waits on works: surfaces show no Working row (`DucklingOnlyTracker`). */
  onlyDucklings?: boolean;
}

export interface DucklingDetail extends Duckling {
  /** An agent's prompt (Markdown); a shell's command (always shown as code). */
  brief: string;
  steps: ActivityStep[];
  report?: string;
  /** Shells only: the tail of the command's output, set by the host from its recorded output file. */
  output?: DucklingOutput;
}

export interface DucklingOutput {
  /** The last lines of the output (at most `OUTPUT_LINES`), text only. */
  text: string;
  /** Earlier output was cut. */
  truncated: boolean;
  /** False while the output file does not exist (yet). */
  exists: boolean;
}

export const OUTPUT_LINES = 200;
export const OUTPUT_BYTES = 64 * 1024;

/**
 * The output file Claude Code names for a background task: under its own temp tree, a `tasks/<id>.output`. Anything
 * else (a path the agent's text made up, `..`) is refused, so the route can never be pointed at another file.
 */
export function isTaskOutputPath(path: string | undefined): path is string {
  return (
    !!path &&
    !path.split("/").includes("..") &&
    /^\/(?:private\/)?tmp\/claude-\d+\/[^\0]+\/tasks\/[A-Za-z0-9_-]+\.output$/.test(path)
  );
}

/** The last `lines` lines of `raw` (a tail read of the file, which starts mid-line when `cut`), escapes stripped. */
export function tailOutput(raw: string, cut: boolean, lines = OUTPUT_LINES): DucklingOutput {
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r\n?/g, "\n");
  let all = clean.split("\n");
  if (all.at(-1) === "") all.pop();
  let truncated = cut;
  if (cut && all.length > 0) all = all.slice(1); // the first line is a fragment of a longer one
  if (all.length > lines) {
    all = all.slice(-lines);
    truncated = true;
  }
  return { text: all.join("\n"), truncated, exists: true };
}

/** "Background command "x" completed (exit code 0)" gives 0. */
export function exitCodeOf(summary: string | undefined): number | undefined {
  const m = summary ? /\(exit code (-?\d+)\)/.exec(summary) : null;
  return m ? Number(m[1]) : undefined;
}

/** The output path in a background launch's result text: "Output is being written to: <path>." or "output_file: <path>". */
export function outputPathOf(text: string): string | undefined {
  const m = /Output is being written to: (\S+?\.output)/.exec(text) ?? /\boutput_file: (\S+?\.output)/.exec(text);
  return isTaskOutputPath(m?.[1]) ? m![1] : undefined;
}

/** A finished helper stays listed this long (the same rule as the transcript's background work). */
export const FINISHED_SHOWN_MS = 10 * 60_000;
/** One whose state is unknown stays listed this long after it was last seen. */
export const UNKNOWN_SHOWN_MS = 24 * 60 * 60_000;
/** How far back a restarted host reads a chat's rows to rebuild its helpers. */
export const REBUILD_WINDOW_MS = UNKNOWN_SHOWN_MS;
const MAX_ITEMS = 12;
const REPORT_CHARS = 20_000;
const SUMMARY_CHARS = 200;
const STEP_ROWS = 4000;

interface Tracked extends Omit<Duckling, "modelInherited"> {
  brief: string;
  report?: string;
  /** Row seq of the launching call: the helper's own rows come after it. */
  seq: number;
  background: boolean;
  /** A task-notification for it arrived; the agent's next assistant row sets `reportedAt`. */
  notified?: boolean;
  /** The latest row seen about it (its own rows, task events, a follow-up message). */
  lastSeenAt?: string;
  /** The model came from the chat's own (the call named none), until the call's or the helper's own says better. */
  modelInherited?: boolean;
  /** The helper's own rows named its model: nothing overrides it. */
  modelReported?: boolean;
  /** The subagent's own id, from its launch (or resume) result. */
  agentId?: string;
  /** Where Claude Code writes the task's output (validated by `isTaskOutputPath`). */
  outputFile?: string;
  exitCode?: number;
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
  /** SendMessage calls waiting for their result: tool-use id → the call's `to` and `message`. */
  private readonly sends = new Map<string, { to: string; message: string }>();
  /** A SendMessage tool-use id that reached a subagent → the id of that subagent's one entry. */
  private readonly aliases = new Map<string, string>();
  /** The chat's own model, from its latest assistant row: what a helper that names none runs on. */
  private parentModel: string | undefined;

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
      const owner = this.tasks.get(this.resolve(p.parent_tool_use_id) ?? "");
      if (owner) {
        owner.lastSeenAt = row.createdAt;
        if (owner.status === "unknown") owner.status = "running"; // its own rows are still arriving: it is alive
      }
      const model = str(rec(p.message)?.model);
      // the helper's own report beats the call's alias and the chat's model
      if (owner && model && !owner.modelReported) {
        owner.model = modelLabel(model);
        owner.modelReported = true;
        owner.modelInherited = false;
      }
      return;
    }
    const message = rec(p.message);
    const rowModel = p.type === "assistant" ? str(message?.model) : undefined;
    if (rowModel) this.parentModel = modelLabel(rowModel);
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
        if (name === "SendMessage" && id) {
          this.sends.set(id, { to: str(input.to) ?? "", message: str(input.message) ?? "" });
          continue;
        }
        const background = input.run_in_background === true;
        const kind: DucklingKind | null =
          name === "Agent" || name === "Task" ? "agent" : name === "Bash" && background ? "shell" : null;
        if (!id || !kind || this.tasks.has(id)) continue;
        const alias = kind === "agent" ? str(input.model) : undefined;
        const named = alias && alias !== "inherit" ? modelLabel(alias) : undefined;
        const model = named ?? (kind === "agent" ? this.parentModel : undefined);
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
          ...(model ? { model } : {}),
          ...(model && !named ? { modelInherited: true } : {}),
        });
      }
      return;
    }
    if (p.type !== "user") return;
    const blocks = Array.isArray(content) ? content.map(rec) : [];
    for (const block of blocks) {
      if (!block || block.type !== "tool_result") continue;
      const launched = rec(p.tool_use_result) ?? rec(p.toolUseResult);
      const text = resultText(block);
      const sent = this.sends.get(str(block.tool_use_id) ?? "");
      if (sent) {
        this.sends.delete(str(block.tool_use_id) ?? "");
        this.resume(str(block.tool_use_id)!, sent, block, launched, text, row);
        continue;
      }
      const task = this.tasks.get(str(block.tool_use_id) ?? "");
      if (!task) continue;
      const written = outputPathOf(text);
      if (written && !task.outputFile) task.outputFile = written;
      if (task.kind === "agent" && !task.agentId) {
        const agentId = str(launched?.agentId) ?? /\bagentId: ([A-Za-z0-9]+)/.exec(text)?.[1];
        if (agentId) task.agentId = agentId;
      }
      if (task.status !== "running") continue;
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
      const task = this.tasks.get(this.resolve(tag("tool-use-id")) ?? "");
      if (!task) continue;
      task.notified = true;
      const file = tag("output-file");
      if (isTaskOutputPath(file)) task.outputFile = file;
      const code = exitCodeOf(tag("summary"));
      if (code !== undefined && task.kind === "shell") task.exitCode = code;
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

  /** The launch a tool-use id belongs to: a SendMessage id that woke a subagent stands for that subagent's entry. */
  private resolve(id: string | undefined): string | undefined {
    return id === undefined ? undefined : (this.aliases.get(id) ?? id);
  }

  /**
   * A successful SendMessage to a known subagent is the same subagent, not a new one: its entry stays the one keyed by
   * its launch. A message queued to a running subagent changes nothing; one that woke a finished subagent puts the
   * entry back to running (ended again by its notification). The SendMessage's id becomes an alias of the entry.
   */
  private resume(
    id: string,
    sent: { to: string; message: string },
    block: Record<string, unknown>,
    launched: Record<string, unknown> | undefined,
    text: string,
    row: MessageRow,
  ): void {
    if (block.is_error === true || this.aliases.has(id)) return;
    let body: Record<string, unknown> | undefined;
    try {
      body = rec(JSON.parse(text));
    } catch {
      body = undefined;
    }
    if (launched?.success === false || body?.success === false) return;
    const ids = [
      str(launched?.resumedAgentId),
      str(launched?.revivedAgentId),
      str(body?.resumedAgentId),
      str(body?.revivedAgentId),
    ].filter((v): v is string => !!v);
    const candidates = ids.length > 0 ? ids : sent.to ? [sent.to] : [];
    if (ids.length === 0) {
      const pin = str(rec(launched?.pin)?.id) ?? str(rec(body?.pin)?.id);
      if (pin && !candidates.includes(pin)) candidates.push(pin);
    }
    let origin: Tracked | undefined;
    for (const t of this.tasks.values()) {
      if (t.kind !== "agent" || !t.agentId) continue;
      if (candidates.includes(t.agentId)) origin = t;
    }
    if (!origin) return;
    this.aliases.set(id, origin.id);
    origin.lastSeenAt = row.createdAt;
    if (origin.status === "running") return;
    origin.status = "running";
    delete origin.endedAt;
    delete origin.summary;
    delete origin.report;
    delete origin.reportedAt;
    delete origin.notified;
    delete origin.lastSeenAt;
    origin.startedAt = row.createdAt;
  }

  private feedTask(subtype: string, p: Record<string, unknown>, at: string): void {
    const taskId = str(p.task_id);
    const toolUseId = str(p.tool_use_id);
    if (subtype === "task_started") {
      if (taskId && toolUseId) {
        this.byTask.set(taskId, toolUseId);
        const t = this.tasks.get(toolUseId);
        if (t && !t.agentId) t.agentId = taskId;
        if (t) t.lastSeenAt = at;
      }
      return;
    }
    const id = this.resolve(toolUseId ?? (taskId ? this.byTask.get(taskId) : undefined));
    const task = id ? this.tasks.get(id) : undefined;
    if (!task) return;
    task.lastSeenAt = at;
    if (subtype === "task_notification") {
      task.notified = true;
      const file = str(p.output_file);
      if (isTaskOutputPath(file)) task.outputFile = file;
      const code = exitCodeOf(str(p.summary));
      if (code !== undefined && task.kind === "shell") task.exitCode = code;
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
    if (task.status === "running" || task.status === "unknown") {
      delete task.lastSeenAt;
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
  settle(live: boolean): void {
    if (live) return;
    for (const t of this.tasks.values()) {
      if (t.status !== "running" && t.status !== "unknown") continue;
      t.status = "unknown";
      t.lastSeenAt ??= t.startedAt;
    }
  }

  list(nowMs: number): Ducklings {
    const active = (t: Tracked) => t.status === "running" || t.status === "unknown";
    const sorted = [...this.tasks.values()]
      .filter((t) =>
        t.status === "running"
          ? true
          : t.status === "unknown"
            ? nowMs - Date.parse(t.lastSeenAt ?? t.startedAt) < UNKNOWN_SHOWN_MS
            : nowMs - Date.parse(t.endedAt ?? t.startedAt) < FINISHED_SHOWN_MS,
      )
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    // a helper that may still be at work is never the one cut off: only finished ones make room
    let room = Math.max(0, MAX_ITEMS - sorted.filter(active).length);
    const items = sorted
      .filter((t) => active(t) || room-- > 0)
      .map(
        (t): Duckling => ({
          id: t.id,
          kind: t.kind,
          title: t.title,
          ...(t.model ? { model: t.model } : {}),
          ...(t.model && t.modelInherited ? { modelInherited: true as const } : {}),
          status: t.status,
          startedAt: t.startedAt,
          ...(t.endedAt ? { endedAt: t.endedAt } : {}),
          ...(t.status === "unknown" && t.lastSeenAt ? { lastSeenAt: t.lastSeenAt } : {}),
          ...(t.summary && t.status !== "running" ? { summary: t.summary } : {}),
          ...(t.reportedAt ? { reportedAt: t.reportedAt } : {}),
          ...(t.exitCode !== undefined ? { exitCode: t.exitCode } : {}),
        }),
      );
    return { running: items.filter((i) => i.status === "running").length, items };
  }

  /** The recorded output file of a helper (a shell's output, an agent's transcript), or undefined. */
  outputFileOf(id: string): string | undefined {
    return this.tasks.get(id)?.outputFile;
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
      ...(t.model && t.modelInherited ? { modelInherited: true as const } : {}),
      status: t.status,
      startedAt: t.startedAt,
      ...(t.endedAt ? { endedAt: t.endedAt } : {}),
      ...(t.reportedAt ? { reportedAt: t.reportedAt } : {}),
      ...(t.exitCode !== undefined ? { exitCode: t.exitCode } : {}),
    };
    const entries = rowsAfterLaunch
      .filter((r) => {
        if (r.role !== "agent") return false;
        const parent = rec(r.payload)?.parent_tool_use_id;
        return typeof parent === "string" && this.resolve(parent) === id;
      })
      .map((r) => ({ ...(rec(r.payload) as Record<string, unknown>), isSidechain: true, timestamp: r.createdAt }));
    const steps = claudeSteps(entries, 40, { sidechain: true });
    return { ...item, brief: t.brief, steps, ...(t.report ? { report: t.report } : {}) };
  }
}

export const DUCKLING_STEP_ROWS = STEP_ROWS;
