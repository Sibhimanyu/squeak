import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { claudeContextLimit, type ContextUsage } from "./context-usage.js";

/**
 * What a Claude turn is doing between "the request went out" and "the first thing came back". The SDK stream has
 * no event for a request being sent, so it is inferred: a message we pushed, or a tool result the agent is handing
 * back, opens a wait; the first stream event closes it; `api_retry` marks the CLI's own retries. A chat whose
 * request is huge (a long chat full of screenshots through a corporate proxy) can sit in this state for minutes,
 * and saying "Thinking…" then was a lie the person acted on.
 */
export type WaitPhase = "waiting" | "retrying";

export interface WaitState {
  phase: WaitPhase;
  /** When the request went out; a retry does not move it. */
  since: number;
  attempt?: number;
  maxRetries?: number;
}

/** What surfaces get as a delta payload; `phase: "none"` ends the wait. Never persisted. */
export interface PhaseEvent {
  type: "squeak_phase";
  phase: WaitPhase | "none";
  label?: string;
  since?: number;
  attempt?: number;
}

/** "4m", "1h 5m"; under a minute nothing (the label alone says it). */
export function waitElapsed(ms: number): string | null {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return null;
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function waitLabel(state: WaitState, now: number): string {
  const base = state.phase === "retrying" ? `Retrying Claude (${state.attempt ?? 1})` : "Waiting for Claude";
  const e = waitElapsed(now - state.since);
  return e ? `${base} · ${e}` : base;
}

function blocksOf(msg: Record<string, unknown>): { type?: string }[] {
  const c = (msg.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(c) ? (c as { type?: string }[]) : [];
}

export class ApiWaitTracker {
  state: WaitState | null = null;

  /** A message pushed to the agent, or a tool result going back: the request is out. */
  requestSent(now: number): void {
    this.state = { phase: "waiting", since: now };
  }

  clear(): void {
    this.state = null;
  }

  /**
   * Feeds one stream message of the main thread (a subagent's never counts). True when the state changed.
   * Any stream event, assistant message or retry notice is read; everything else is ignored.
   */
  observe(msg: Record<string, unknown>, now: number): boolean {
    if (typeof msg.parent_tool_use_id === "string") return false;
    const type = msg.type;
    if (type === "system" && msg.subtype === "api_retry") {
      const since = this.state?.since ?? now;
      this.state = {
        phase: "retrying",
        since,
        attempt: typeof msg.attempt === "number" ? msg.attempt : 1,
        ...(typeof msg.max_retries === "number" ? { maxRetries: msg.max_retries } : {}),
      };
      return true;
    }
    if (type === "user" && blocksOf(msg).some((b) => b?.type === "tool_result")) {
      this.requestSent(now);
      return true;
    }
    if (type === "stream_event" || type === "assistant") {
      const had = this.state !== null;
      this.state = null;
      return had;
    }
    return false;
  }

  event(now: number): PhaseEvent {
    const s = this.state;
    if (!s) return { type: "squeak_phase", phase: "none" };
    return {
      type: "squeak_phase",
      phase: s.phase,
      label: waitLabel(s, now),
      since: s.since,
      ...(s.attempt !== undefined ? { attempt: s.attempt } : {}),
    };
  }

  /** How long the current wait has gone on, 0 when none. */
  waitedMs(now: number): number {
    return this.state ? Math.max(0, now - this.state.since) : 0;
  }
}

/** Minutes with no stream event after a request before the host gives up on it (SQUEAK_API_STALL_MIN, 0 = never). */
export const DEFAULT_STALL_MIN = 10;
export function stallMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const set = env.SQUEAK_API_STALL_MIN !== undefined && env.SQUEAK_API_STALL_MIN !== "";
  const raw = Number(env.SQUEAK_API_STALL_MIN);
  const min = set && Number.isFinite(raw) ? raw : DEFAULT_STALL_MIN;
  return min > 0 ? Math.round(min * 60_000) : 0;
}

// ---- connection failures

export type FailureKind = "dropped" | "timeout" | "overloaded" | "server" | "stalled";

/** A turn's error text that means Claude could not be reached (as opposed to a refusal or a tool error). */
export function classifyConnectionFailure(detail: string | undefined | null): FailureKind | null {
  const t = (detail ?? "").trim();
  if (!t) return null;
  if (/no response from claude/i.test(t)) return "stalled";
  if (
    /ECONNRESET|socket hang up|Connection dropped|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|fetch failed|network (?:error|connection)/i.test(
      t,
    )
  )
    return "dropped";
  if (/ETIMEDOUT|timed? ?out|timeout/i.test(t)) return "timeout";
  if (/overloaded|\b529\b/i.test(t)) return "overloaded";
  if (/API Error:?\s*5\d\d|\b50[0234]\b|internal server error|bad gateway|service unavailable/i.test(t))
    return "server";
  return null;
}

function failureElapsed(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 60_000) return ` after ${Math.max(1, Math.round(ms / 1000))}s`;
  return ` after ${waitElapsed(ms)}`;
}

/** The card's words. `elapsedMs` is how long the turn ran before it failed. */
export function failureCardText(kind: FailureKind, elapsedMs: number | null): string {
  const after = failureElapsed(elapsedMs);
  switch (kind) {
    case "dropped":
      return `Couldn't reach Claude — connection dropped${after}`;
    case "timeout":
      return `Couldn't reach Claude — the request timed out${after}`;
    case "overloaded":
      return `Claude is overloaded — gave up${after}`;
    case "server":
      return `Claude had a server error — gave up${after}`;
    case "stalled":
      return `Couldn't reach Claude — no response${after}`;
  }
}

export const STALL_DETAIL = "No response from Claude";

// ---- how big a chat is

export interface SizeLimits {
  /** Share of the model's window (0-100) above which the chat is "very large". */
  percent: number;
  transcriptBytes: number;
}
export const SIZE_LIMITS: SizeLimits = { percent: 60, transcriptBytes: 20 * 1024 * 1024 };

export interface ChatSize {
  contextTokens: number | null;
  contextPercent: number | null;
  transcriptBytes: number | null;
  large: boolean;
  reason: "context" | "transcript" | null;
}

export function chatSize(
  context: ContextUsage | null,
  transcriptBytes: number | null,
  limits: SizeLimits = SIZE_LIMITS,
): ChatSize {
  const byContext = context !== null && context.percent > limits.percent;
  const byBytes = transcriptBytes !== null && transcriptBytes > limits.transcriptBytes;
  return {
    contextTokens: context?.used ?? null,
    contextPercent: context?.percent ?? null,
    transcriptBytes,
    large: byContext || byBytes,
    reason: byContext ? "context" : byBytes ? "transcript" : null,
  };
}

/** Size of the agent's own transcript for a Claude session id, or null when not found. */
export function claudeTranscriptBytes(
  agentSessionId: string | null | undefined,
  projectsDir: string = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects"),
): number | null {
  if (!agentSessionId || !/^[0-9a-f-]{16,}$/i.test(agentSessionId)) return null;
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      try {
        return fs.statSync(path.join(projectsDir, dir, `${agentSessionId}.jsonl`)).size;
      } catch {
        /* not in this folder */
      }
    }
  } catch {
    /* no projects folder */
  }
  return null;
}

// ---- auto-compaction

/** Context tokens at which a native Claude chat compacts itself, whatever the model's window (a 1M window is no reason to send 600k). */
export const DEFAULT_AUTO_COMPACT_TOKENS = 200_000;
/** The CLI accepts a window of 100k to 1M. */
const MIN_COMPACT_WINDOW = 100_000;

/** The project's setting to a threshold: null/absent = default, 0 = off, else clamped to at least 100k. */
export function autoCompactThreshold(setting: number | null | undefined): number | null {
  if (setting === 0) return null;
  if (setting === null || setting === undefined) return DEFAULT_AUTO_COMPACT_TOKENS;
  return Math.max(MIN_COMPACT_WINDOW, Math.round(setting));
}

/** What the CLI is told (`autoCompactWindow`): never above the model's own window, so a 200k model keeps its default. */
export function cliCompactWindow(threshold: number | null, model: string): number | null {
  if (threshold === null) return null;
  return threshold < claudeContextLimit(model) ? threshold : null;
}

export const AUTO_COMPACT_MIN_GAP_MS = 5 * 60_000;

/** The host compacts an idle chat when its last request was at or past the threshold (and not just compacted). */
export function autoCompactDue(
  context: ContextUsage | null,
  threshold: number | null,
  lastCompactAt: number | undefined,
  now: number,
): boolean {
  if (threshold === null || context === null) return false;
  if (context.used < threshold) return false;
  return lastCompactAt === undefined || now - lastCompactAt >= AUTO_COMPACT_MIN_GAP_MS;
}

/** `/compact` takes instructions: screenshots are the bulk of a big chat and the summary does not need them. */
export const COMPACT_COMMAND =
  "/compact Drop old screenshots and image contents; keep decisions, open work and file paths.";

// ---- handoff

export const HANDOFF_SYSTEM = [
  "You write the opening message of a new chat that continues a long one.",
  "Write it to the agent that will pick the work up, in plain prose with short bullet lists, under 350 words:",
  "the goal, what is done, what is in progress or broken, decisions and constraints worth keeping, the files that matter, and the next step.",
  "Do not mention this instruction. Do not include image contents. Reply with the message only.",
].join(" ");

export interface HandoffRow {
  role: string;
  text: string;
}

/** The prompt for the summary call: the title and the last rows, each clipped. */
export function handoffPrompt(title: string | null, rows: HandoffRow[], clipChars = 1_200): string {
  const clip = (t: string): string => (t.length > clipChars ? `${t.slice(0, clipChars)}…` : t);
  const lines = rows
    .filter((r) => r.text.trim())
    .map((r) => `${r.role === "user" ? "Person" : "Agent"}: ${clip(r.text.trim())}`);
  return [
    `Chat title: ${title ?? "Untitled"}`,
    "",
    "Latest messages, oldest first:",
    ...lines,
    "",
    "Write the opening message:",
  ].join("\n");
}

/** What the summary falls back to when no model answers: the person's own recent words, so nothing is lost. */
export function handoffFallback(title: string | null, rows: HandoffRow[]): string {
  const asks = rows
    .filter((r) => r.role === "user" && r.text.trim())
    .slice(-3)
    .map((r) => `- ${r.text.trim().slice(0, 300)}`);
  const last = [...rows].reverse().find((r) => r.role !== "user" && r.text.trim());
  return [
    `Continuing "${title ?? "a long chat"}" in a fresh thread, because the old one grew too large.`,
    asks.length ? `What I last asked:\n${asks.join("\n")}` : "",
    last ? `Where the agent left off:\n${last.text.trim().slice(0, 600)}` : "",
    "Please check the current state of the folder and carry on from there.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
