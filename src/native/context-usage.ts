import type { AgentKind } from "./types.js";

/** How full a chat's context window is. Absent when unknown: never a fake 0%. */
export interface ContextUsage {
  used: number;
  limit: number;
  percent: number;
}

/** 1M for `[1m]` / `-1m` models, else 200k. Aliases (`opus-5-5-1m`) and CLI ids (`claude-opus-5-5[1m]`) both. */
export function claudeContextLimit(model: string): number {
  return /(\[1m\]|-1m$|1m$)/i.test(model.trim()) ? 1_000_000 : 200_000;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function make(used: number, limit: number): ContextUsage | null {
  if (!(used > 0) || !(limit > 0)) return null;
  return { used, limit, percent: Math.min(100, Math.round((used / limit) * 1000) / 10) };
}

/**
 * What one stored agent message does to a chat's context: a new reading (`ContextUsage`), a reset after a
 * compaction (`null`), or nothing (`undefined`). Only top-level assistant messages count: a subagent's
 * (`parent_tool_use_id` set, or `isSidechain`) has its own window.
 */
export function claudeContextStep(kind: string, payload: unknown, model: string): ContextUsage | null | undefined {
  const msg = payload as Record<string, unknown> | null;
  if (!msg || typeof msg !== "object") return undefined;
  if (kind === "system/compact_boundary") return null;
  if (kind !== "assistant") return undefined;
  if (typeof msg.parent_tool_use_id === "string" || msg.isSidechain === true) return undefined;
  const usage = (msg.message as { usage?: Record<string, unknown> } | undefined)?.usage;
  if (!usage) return undefined;
  const used =
    num(usage.input_tokens) +
    num(usage.cache_creation_input_tokens) +
    num(usage.cache_read_input_tokens) +
    num(usage.output_tokens);
  return make(used, claudeContextLimit(model)) ?? undefined;
}

/** Codex's `thread/tokenUsage/updated`: `tokenUsage.last.totalTokens` against `modelContextWindow`. */
export function codexContextFrom(params: unknown): ContextUsage | null {
  const tu = (params as { tokenUsage?: Record<string, unknown> } | null)?.tokenUsage;
  if (!tu) return null;
  const last = tu.last as Record<string, unknown> | undefined;
  return make(num(last?.totalTokens), num(tu.modelContextWindow));
}

/** Replays the newest stored messages (oldest first) for a chat the host has not heard from yet. */
export function contextFromMessages(
  agent: AgentKind,
  model: string,
  messages: { kind: string; payload: unknown }[],
): ContextUsage | null {
  if (agent !== "claude") return null;
  let current: ContextUsage | null = null;
  for (const m of messages) {
    const step = claudeContextStep(m.kind, m.payload, model);
    if (step !== undefined) current = step;
  }
  return current;
}
