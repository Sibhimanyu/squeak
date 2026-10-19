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
 */

export type ActivityKind = "thinking" | "note" | "tool" | "background";

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

function claudeSteps(entries: Record<string, unknown>[], max: number): ActivityStep[] {
  // Claude Code writes each block of a message as its own entry, all under
  // one message id, and may write a block again as it streams; a block is
  // keyed by what it is, so repeats collapse and distinct blocks stay.
  let steps = new Map<string, ActivityStep>();
  for (const entry of entries) {
    if (entry.isSidechain === true) {
      continue;
    }
    const type = asString(entry.type);
    const at = asString(entry.timestamp);
    const message = asRecord(entry.message);
    if (type === "user" && message) {
      if (typeof message.content === "string") {
        // A worker reporting in is part of the work; anything else the user
        // typed starts a new turn.
        const finished = /<task-notification>[\s\S]*?<summary>([^<]*)<\/summary>/.exec(message.content);
        if (finished) {
          steps.set(`bg:${steps.size}`, { kind: "background", text: clip(finished[1]!.trim(), max), at });
        } else if (!message.content.startsWith("<")) {
          steps = new Map();
        }
      } else if (asArray(message.content).some((block) => asString(asRecord(block)?.type) === "text")) {
        steps = new Map();
      }
      continue;
    }
    if (type !== "assistant" || !message) {
      continue;
    }
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

function codexSteps(entries: Record<string, unknown>[], max: number): ActivityStep[] {
  let steps: ActivityStep[] = [];
  for (const entry of entries) {
    const at = asString(entry.timestamp);
    const payload = asRecord(entry.payload);
    const kind = asString(payload?.type);
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
          steps = [];
        }
      } else if (asString(payload.role) === "assistant" && text) {
        steps.push({ kind: "note", text: clip(text, max), at });
      }
    } else if (kind === "reasoning") {
      const text = asArray(payload.summary)
        .map((part) => asString(asRecord(part)?.text) ?? "")
        .join("\n")
        .trim();
      if (text) {
        steps.push({ kind: "thinking", text: clip(text, max), at });
      }
    } else if (kind === "function_call" || kind === "custom_tool_call" || kind === "local_shell_call") {
      steps.push({ kind: "tool", text: describeCodexTool(payload), at });
    }
  }
  return steps;
}

export function describeCodexTool(payload: Record<string, unknown>): string {
  const name = asString(payload.name) ?? "tool";
  const raw = asString(payload.arguments) ?? asString(payload.input) ?? "";
  // Shell calls carry the command as `cmd` (JSON arguments) or inside the
  // exec tool's script; either way the command is what a person would name.
  const cmd = /"cmd"\s*:\s*(\[[^\]]*\]|"(?:[^"\\]|\\.)*")/.exec(raw)?.[1];
  if (cmd) {
    try {
      const parsed = JSON.parse(cmd) as unknown;
      const command = Array.isArray(parsed) ? parsed.map(String).join(" ") : String(parsed);
      return clip(`Run ${firstLine(command.replace(/^(bash|zsh|sh) -lc /, ""))}`, 120);
    } catch {
      // Fall through to the tool's name.
    }
  }
  if (name === "apply_patch" || raw.includes("*** Begin Patch")) {
    const file = /\*\*\* (?:Update|Add) File: (.+)/.exec(raw)?.[1];
    return file ? `Edit ${path.basename(file.trim())}` : "Edit files";
  }
  return clip(`Use ${name}`, 120);
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
