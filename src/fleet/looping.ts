import { describeClaudeTool, describeCodexTool } from "./activity.js";
import { asArray, asRecord, asString } from "./observers/tail.js";
import type { LoopingStep } from "./types.js";

/**
 * "Repeating a failing step": the same tool call (name plus normalised input) failing LOOP_AFTER or more times
 * in a row in the current turn, with nothing different succeeding between. One long command that loops inside
 * itself is a single call and never counts. Pure functions over transcript entries the observers already read;
 * the entries are the agent's own output, so labels are the tool's plain description, never raw output.
 */
export const LOOP_AFTER = 3;

interface Streak {
  key: string;
  label: string;
  count: number;
  since: string;
}

/** A person's refusal is not the agent retrying blindly. */
const REFUSED = /^(?:The user doesn't want|\[Request interrupted|User rejected|The user rejected)/i;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Stable, whitespace-collapsed rendering of a tool input (keys sorted). */
function normalise(value: unknown): string {
  if (typeof value === "string") return collapse(value);
  if (Array.isArray(value)) return `[${value.map(normalise).join(",")}]`;
  const record = asRecord(value);
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${key}:${normalise(record[key])}`)
      .join(",")}}`;
  }
  return String(value);
}

function textOf(content: unknown): string {
  return typeof content === "string"
    ? content
    : asArray(content)
        .map((part) => asString(asRecord(part)?.text) ?? "")
        .join("\n");
}

function isTaskNotification(content: unknown): boolean {
  return /^\s*<task-notification>/.test(textOf(content));
}

function finish(streaks: Iterable<Streak>, duckling: boolean): LoopingStep | null {
  let worst: Streak | null = null;
  for (const streak of streaks) {
    if (streak.count >= LOOP_AFTER && (!worst || streak.count > worst.count)) worst = streak;
  }
  return worst ? { ...worst, ...(duckling ? { duckling: true } : {}) } : null;
}

/**
 * Claude transcript entries, oldest first. The main chat and each sidechain agent keep their own run, so a
 * duckling's retries are found even when its entries interleave into the parent's file.
 */
export function detectClaudeLoop(
  entries: Record<string, unknown>[],
  options: { duckling?: boolean } = {},
): LoopingStep | null {
  const calls = new Map<string, { key: string; label: string }>();
  const streaks = new Map<string, Streak>();
  for (const entry of entries) {
    const type = asString(entry.type);
    if (type !== "user" && type !== "assistant") continue;
    const lane = entry.isSidechain === true ? `side:${asString(entry.agentId) ?? ""}` : "main";
    const message = asRecord(entry.message);
    const content = message?.content;
    const at = asString(entry.timestamp) ?? "";
    if (type === "assistant") {
      for (const raw of asArray(content)) {
        const block = asRecord(raw);
        if (!block || asString(block.type) !== "tool_use") continue;
        const id = asString(block.id);
        const name = asString(block.name) ?? "tool";
        const input = asRecord(block.input) ?? {};
        if (id) calls.set(id, { key: `${name}:${normalise(input)}`, label: describeClaudeTool(name, input) });
      }
      const stop = message ? asString(message.stop_reason) : null;
      if (stop === "end_turn" || stop === "stop_sequence") streaks.delete(lane);
      continue;
    }
    const blocks = asArray(content).map(asRecord);
    const results = blocks.filter((block) => block && asString(block.type) === "tool_result");
    if (results.length === 0) {
      // A person's prompt starts a new turn; a worker's report is part of the current one.
      if (!isTaskNotification(content)) {
        if (lane === "main") streaks.clear();
        else streaks.delete(lane);
      }
      continue;
    }
    for (const block of results) {
      const call = calls.get(asString(block?.tool_use_id) ?? "");
      if (!call) continue;
      const failed = block?.is_error === true && !REFUSED.test(textOf(block.content).trim());
      const streak = streaks.get(lane);
      if (!failed) {
        streaks.delete(lane);
      } else if (streak && streak.key === call.key) {
        streak.count += 1;
      } else {
        streaks.set(lane, { key: call.key, label: call.label, count: 1, since: at });
      }
    }
  }
  return finish(streaks.values(), options.duckling === true);
}

/** A failing exit in Codex's tool output: "Process exited with code 1", "exit_code": 2, "Exit code: 1". */
function codexFailed(output: string): boolean {
  const match =
    /(?:exited with code|exit[_ ]code"?)\s*[:=]?\s*(-?\d+)/i.exec(output) ?? /"exit_code"\s*:\s*(-?\d+)/.exec(output);
  return match !== null && Number(match[1]) !== 0;
}

/** Codex rollout entries, oldest first: function calls and their outputs, one run per turn. */
export function detectCodexLoop(entries: Record<string, unknown>[]): LoopingStep | null {
  const calls = new Map<string, { key: string; label: string }>();
  let streak: Streak | null = null;
  for (const entry of entries) {
    const type = asString(entry.type);
    const payload = asRecord(entry.payload);
    if (!payload) continue;
    const at = asString(entry.timestamp) ?? "";
    const kind = asString(payload.type);
    if (type === "event_msg") {
      if (kind === "task_started" || kind === "task_complete" || kind === "turn_aborted") streak = null;
      continue;
    }
    if (type !== "response_item") continue;
    if (kind === "message") {
      if (asString(payload.role) === "user") streak = null;
    } else if (kind === "function_call" || kind === "custom_tool_call" || kind === "local_shell_call") {
      const id = asString(payload.call_id) ?? asString(payload.id);
      const name = asString(payload.name) ?? "tool";
      const raw = collapse(asString(payload.arguments) ?? asString(payload.input) ?? normalise(payload.action));
      if (id) calls.set(id, { key: `${name}:${raw}`, label: describeCodexTool(payload) });
    } else if (kind === "function_call_output" || kind === "custom_tool_call_output") {
      const call = calls.get(asString(payload.call_id) ?? "");
      if (!call) continue;
      const out = payload.output;
      const text = typeof out === "string" ? out : textOf(asRecord(out)?.content ?? out);
      if (!codexFailed(text)) streak = null;
      else if (streak && streak.key === call.key) streak.count += 1;
      else streak = { key: call.key, label: call.label, count: 1, since: at };
    }
  }
  return streak ? finish([streak], false) : null;
}

/** "Repeating a failing step: Run npm test ×4", for a radar row, a card and the Mac app. */
export function loopingText(step: LoopingStep): string {
  return `Repeating a failing step: ${step.duckling ? "a duckling ran " : ""}${step.label} ×${step.count}`;
}

/** The steer the agent is sent: plain, and says what to do instead. */
export function loopingSteer(step: LoopingStep): string {
  return `You've hit the same error ${step.count} times running ${step.label}. Stop retrying; explain what's blocking and what you need.`;
}
