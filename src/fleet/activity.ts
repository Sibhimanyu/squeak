import path from "node:path";

import { asArray, asRecord, asString, parseJsonLines, readTailLines } from "./observers/tail.js";
import type { AgentKind } from "./types.js";

/**
 * What an agent is doing in its current turn, step by step, read from its
 * transcript: the thinking it chose to show, the notes it writes between
 * steps, and each tool call as a short line ("Edit radar.ts", "Run tests").
 *
 * The card's `detail` is one line about the newest step; this is the turn so
 * far, for the window to show while a session works. Claude writes thinking
 * as summaries when the host asks for them (Conductor does); Codex's reasoning
 * is encrypted and its summary usually empty, so a Codex feed is its notes
 * and commands. Everything here is the agent's own output and stays untrusted.
 *
 * One kind is not the agent's: `you` is a message the user sent into a turn
 * that was still running (a steer). It belongs to the turn, in place, rather
 * than starting a new one.
 */

export type ActivityKind = "thinking" | "note" | "tool" | "background" | "you";

export interface ActivityStep {
  kind: ActivityKind;
  text: string;
  at: string | null;
}

export interface Activity {
  /** Oldest first, the newest `limit` of the turn. */
  steps: ActivityStep[];
  /** How many steps the turn has had in all, so the window can say it shows the latest. */
  total: number;
}

const DEFAULT_LIMIT = 14;
/** A step is a line in a feed, not the message itself. */
const MAX_STEP_CHARS = 280;

/**
 * `stepChars` lifts the cap on what the agent wrote (thinking, notes, a
 * worker's report); tool labels keep theirs. The phone's verbose view asks
 * for whole steps; everything else keeps a feed of short lines.
 */
export function readActivity(
  agent: AgentKind,
  transcriptPath: string,
  limit = DEFAULT_LIMIT,
  options: { stepChars?: number } = {},
): Activity {
  const entries = parseJsonLines(readTailLines(transcriptPath));
  const max = options.stepChars ?? MAX_STEP_CHARS;
  const steps = agent === "claude" ? claudeSteps(entries, max) : codexSteps(entries, max);
  return { steps: steps.slice(-limit), total: steps.length };
}

/** An assistant entry with one of these ends the turn; anything else (`tool_use`, null) leaves it open. */
const CLAUDE_TURN_ENDS = new Set(["end_turn", "stop_sequence", "refusal"]);

/**
 * A Claude transcript's steps. `sidechain` reads a subagent's own transcript, whose every entry is
 * `isSidechain: true`; the main feed leaves such entries out.
 */
export function claudeSteps(
  entries: Record<string, unknown>[],
  max: number,
  options: { sidechain?: boolean } = {},
): ActivityStep[] {
  // Claude Code writes each block of a message as its own entry, all under
  // one message id, and may write a block again as it streams; a block is
  // keyed by what it is, so repeats collapse and distinct blocks stay.
  let steps = new Map<string, ActivityStep>();
  // Whether a turn is still running, so a message typed now is a steer
  // inside it rather than the start of the next one.
  let open = false;
  for (const entry of entries) {
    if ((entry.isSidechain === true) !== (options.sidechain === true)) {
      continue;
    }
    const type = asString(entry.type);
    const at = asString(entry.timestamp);
    const message = asRecord(entry.message);
    if (type === "user" && message) {
      // Skill bodies and "[Image: …]" notes are written as user entries
      // marked isMeta; they are not anything the user said.
      if (entry.isMeta === true) {
        continue;
      }
      const blocks = asArray(message.content).map(asRecord);
      if (blocks.some((block) => asString(block?.type) === "tool_result")) {
        open = true;
        continue;
      }
      const text =
        typeof message.content === "string"
          ? message.content
          : blocks
              .filter((block) => asString(block?.type) === "text")
              .map((block) => asString(block?.text) ?? "")
              .join("\n");
      const hasText = typeof message.content === "string" || blocks.some((block) => asString(block?.type) === "text");
      if (!hasText) {
        continue;
      }
      // A worker reporting in is part of the work; other tags are Claude
      // Code's own notes.
      const finished = /<task-notification>[\s\S]*?<summary>([^<]*)<\/summary>/.exec(text);
      if (finished) {
        steps.set(`bg:${steps.size}`, { kind: "background", text: clip(finished[1]!.trim(), max), at });
      } else if (text.startsWith("[Request interrupted")) {
        open = false;
      } else if (!text.startsWith("<")) {
        if (open) {
          const said = text.trim();
          if (said) {
            steps.set(`you:${said}`, { kind: "you", text: clip(said, max), at });
          }
        } else {
          steps = new Map();
        }
      }
      continue;
    }
    if (type !== "assistant" || !message) {
      continue;
    }
    open = !CLAUDE_TURN_ENDS.has(asString(message.stop_reason) ?? "");
    const id = asString(message.id) ?? `${at}`;
    for (const raw of asArray(message.content)) {
      const block = asRecord(raw);
      const step = block ? claudeStep(block, at, max) : null;
      if (step) {
        steps.set(`${id}:${asString(block!.id) ?? `${step.kind}:${step.text}`}`, step);
      }
    }
  }
  return [...steps.values()];
}

function claudeStep(block: Record<string, unknown>, at: string | null, max: number): ActivityStep | null {
  switch (asString(block.type)) {
    case "thinking": {
      const text = asString(block.thinking)?.trim();
      return text ? { kind: "thinking", text: clip(text, max), at } : null;
    }
    case "text": {
      const text = asString(block.text)?.trim();
      return text ? { kind: "note", text: clip(text, max), at } : null;
    }
    case "tool_use":
      return {
        kind: "tool",
        text: describeClaudeTool(asString(block.name) ?? "tool", asRecord(block.input) ?? {}),
        at,
      };
    default:
      return null;
  }
}

/** A tool call as a person would say it, never its raw input. */
export function describeClaudeTool(name: string, input: Record<string, unknown>): string {
  const file = asString(input.file_path) ?? asString(input.notebook_path);
  const base = file ? path.basename(file) : null;
  switch (name) {
    case "Bash": {
      const description = asString(input.description);
      const command = firstLine(asString(input.command) ?? "");
      const label = description ?? (command ? `Run ${command}` : "Run a command");
      return clip(input.run_in_background === true ? `${label} (in the background)` : label, 120);
    }
    case "Read":
      return base ? `Read ${base}` : "Read a file";
    case "Edit":
    case "MultiEdit":
      return base ? `Edit ${base}` : "Edit a file";
    case "Write":
      return base ? `Write ${base}` : "Write a file";
    case "NotebookEdit":
      return base ? `Edit ${base}` : "Edit a notebook";
    case "Grep":
      return clip(`Search for ${quote(asString(input.pattern))}`, 120);
    case "Glob":
      return clip(`Find ${asString(input.pattern) ?? "files"}`, 120);
    case "Agent":
    case "Task": {
      const description = asString(input.description) ?? "a subagent";
      return clip(`Start ${description}${input.run_in_background === true ? " in the background" : ""}`, 120);
    }
    case "WebFetch":
      return `Fetch ${hostOf(asString(input.url)) ?? "a page"}`;
    case "WebSearch":
      return clip(`Search the web for ${quote(asString(input.query))}`, 120);
    case "TodoWrite":
      return "Update the plan";
    case "Skill":
      return clip(`Use the ${asString(input.skill) ?? "a"} skill`, 120);
    default:
      // MCP tools arrive as mcp__server__tool.
      return clip(name.startsWith("mcp__") ? `Use ${name.split("__").slice(1).join(" ")}` : `Use ${name}`, 120);
  }
}

export function codexSteps(entries: Record<string, unknown>[], max: number): ActivityStep[] {
  let steps: ActivityStep[] = [];
  // Between task_started and task_complete a turn is running. Its first real
  // user message starts it; one sent after the agent has begun answering is a
  // steer into it. Codex writes AGENTS.md and the host's prompt as user
  // messages before the agent says anything, so those still start the turn.
  let inTask = false;
  let agentBegan = false;
  for (const entry of entries) {
    const at = asString(entry.timestamp);
    const payload = asRecord(entry.payload);
    const kind = asString(payload?.type);
    if (asString(entry.type) === "event_msg") {
      if (kind === "task_started") {
        inTask = true;
        agentBegan = false;
      } else if (kind === "task_complete" || kind === "turn_aborted") {
        inTask = false;
      }
      continue;
    }
    if (asString(entry.type) !== "response_item" || !payload) {
      continue;
    }
    if (kind === "message") {
      const text = asArray(payload.content)
        .map((block) => asString(asRecord(block)?.text) ?? "")
        .join("\n")
        .trim();
      if (asString(payload.role) === "user") {
        // Codex injects its own context as user messages wrapped in tags.
        if (text && !text.startsWith("<")) {
          if (inTask && agentBegan) {
            steps.push({ kind: "you", text: clip(text, max), at });
          } else {
            steps = [];
            agentBegan = false;
          }
        }
        continue;
      }
      if (asString(payload.role) === "assistant") {
        agentBegan = true;
        if (text) {
          steps.push({ kind: "note", text: clip(text, max), at });
        }
      }
    } else if (kind === "reasoning") {
      agentBegan = true;
      const text = asArray(payload.summary)
        .map((part) => asString(asRecord(part)?.text) ?? "")
        .join("\n")
        .trim();
      if (text) {
        steps.push({ kind: "thinking", text: clip(text, max), at });
      }
    } else if (kind === "function_call" || kind === "custom_tool_call" || kind === "local_shell_call") {
      agentBegan = true;
      steps.push({ kind: "tool", text: describeCodexTool(payload), at });
    }
  }
  return steps;
}

export function describeCodexTool(payload: Record<string, unknown>): string {
  const name = asString(payload.name) ?? "tool";
  const raw = asString(payload.arguments) ?? asString(payload.input) ?? "";
  const collaboration = describeCodexCollaboration(name, raw);
  if (collaboration) return collaboration;
  // Codex's `exec` tool runs a little script that calls `tools.exec_command({cmd: "…"})`, `tools.apply_patch(…)`
  // and the like; what the script does is what a person would name, not "exec".
  const inner = /tools\.([A-Za-z0-9_]+)/.exec(raw)?.[1];
  const tool = name === "exec" && inner ? inner : name;
  // Shell calls carry the command as `cmd` (a JSON key, or a JS key in the exec script).
  const cmd = /\bcmd"?\s*:\s*(\[[^\]]*\]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)/.exec(raw)?.[1];
  if (cmd) {
    try {
      const parsed = (
        cmd.startsWith("'") || cmd.startsWith("`") ? cmd.slice(1, -1) : (JSON.parse(cmd) as unknown)
      ) as unknown;
      const command = Array.isArray(parsed) ? parsed.map(String).join(" ") : String(parsed);
      return clip(`Run ${firstLine(command.replace(/^(bash|zsh|sh) -lc /, ""))}`, 120);
    } catch {
      // Fall through to the tool's name.
    }
  }
  if (tool === "apply_patch" || raw.includes("*** Begin Patch")) {
    const file = /\*\*\* (?:Update|Add) File: ([^\n\\"]+)/.exec(raw)?.[1];
    return file ? `Edit ${path.basename(file.trim())}` : "Edit files";
  }
  if (tool === "view_image") {
    const file = /(?:path|image_path)"?\s*:\s*["'`]([^"'`]+)["'`]/.exec(raw)?.[1];
    return file ? `View ${path.basename(file)}` : "View an image";
  }
  if (tool === "write_stdin") return "Send input to a running command";
  if (tool.startsWith("web__") || tool === "web_search") return "Search the web";
  if (tool.startsWith("image_gen")) return "Generate an image";
  if (tool.startsWith("mcp__")) return clip(`Use ${tool.split("__").slice(1).join(" ")}`, 120);
  if ((name === "exec" && !inner) || name === "js") return "Run a script";
  return clip(`Use ${tool}`, 120);
}

/** Codex's subagent tools: the task's name is plain, its message is encrypted. */
function describeCodexCollaboration(name: string, raw: string): string | null {
  const field = (key: string): string | null => {
    try {
      const parsed = JSON.parse(raw) as unknown;
      const value = asString(asRecord(parsed)?.[key]);
      return value ? value.replace(/^\/root\//, "") : null;
    } catch {
      return null;
    }
  };
  switch (name) {
    case "spawn_agent": {
      const task = field("task_name");
      return task ? clip(`Start subagent ${task.replace(/_/g, " ")}`, 120) : "Start a subagent";
    }
    case "send_message": {
      const target = field("target");
      if (target === "root" || target === "/root") return "Report to the main agent";
      return target ? clip(`Message ${target.replace(/_/g, " ")}`, 120) : "Message a subagent";
    }
    case "followup_task": {
      const target = field("target");
      return target ? clip(`Follow up with ${target.replace(/_/g, " ")}`, 120) : "Follow up with a subagent";
    }
    case "wait_agent":
    case "wait":
      return "Wait for subagents";
    case "list_agents":
      return "List subagents";
    case "close_agent": {
      const target = field("target");
      return target ? clip(`Close ${target.replace(/_/g, " ")}`, 120) : "Close a subagent";
    }
    default:
      return null;
  }
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

function quote(value: string | null): string {
  return value ? `“${value}”` : "something";
}

function hostOf(url: string | null): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function clip(text: string, max = MAX_STEP_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}
