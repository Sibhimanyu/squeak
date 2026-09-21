import type { AgentKind, FleetState, HookEvent } from "./types.js";

function pick(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * Claude Code and Codex hand their hooks a JSON object on stdin, but they do
 * not agree on field names and neither promises stability. Read every spelling
 * we have seen and tolerate the rest being absent — a hook event with only an
 * event name still tells us more than polling would.
 */
export function normalizeHookPayload(
  agent: AgentKind,
  payload: Record<string, unknown>,
  receivedAt: string,
): HookEvent | null {
  const event = pick(payload, ["hook_event_name", "hookEventName", "event", "event_name"]);
  if (!event) {
    return null;
  }

  return {
    agent,
    event,
    sessionId: pick(payload, ["session_id", "sessionId", "thread_id", "threadId", "conversation_id"]),
    cwd: pick(payload, ["cwd", "workspace_dir", "workingDirectory", "working_dir"]),
    transcriptPath: pick(payload, ["transcript_path", "transcriptPath", "rollout_path"]),
    message: pick(payload, ["message", "notification", "text", "last_agent_message"]),
    toolName: pick(payload, ["tool_name", "toolName", "tool"]),
    receivedAt,
  };
}

/**
 * The payoff for installing hooks: `Notification` is the agent itself saying
 * it is stuck, which is the one thing a transcript never records. Everything
 * else here is state we could have inferred, just sooner and for certain.
 *
 * Returns null when the event says nothing about state.
 */
export function stateFromHookEvent(event: HookEvent): FleetState | null {
  switch (event.event) {
    // Unambiguous: the agent is asking to be allowed to do something.
    case "PermissionRequest":
      return "awaiting_approval";
    case "Notification":
      return classifyNotification(event.message);
    case "Stop":
      return "finished";
    case "UserPromptSubmit":
    case "SessionStart":
    case "PreToolUse":
      return "working";
    case "Interrupt":
    case "SessionEnd":
      return "idle";
    default:
      return null;
  }
}

/**
 * Claude Code sends free text here — "Claude needs your permission to use
 * Bash", "Claude is waiting for your input". Treat an unrecognised
 * notification as a question rather than ignoring it: over-surfacing a stuck
 * agent is cheaper than leaving one stuck.
 */
export function classifyNotification(message: string | null): FleetState {
  if (!message) {
    return "awaiting_input";
  }
  const text = message.toLowerCase();
  if (text.includes("permission") || text.includes("approve") || text.includes("approval")) {
    return "awaiting_approval";
  }
  return "awaiting_input";
}

/** Hook events that describe a session ending rather than changing state. */
export function isSessionEndEvent(event: HookEvent): boolean {
  return event.event === "SessionEnd";
}
