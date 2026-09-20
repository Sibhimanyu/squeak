import { describe, expect, it } from "vitest";

import { classifyNotification, isSessionEndEvent, normalizeHookPayload, stateFromHookEvent } from "./hook-protocol.js";
import type { HookEvent } from "./types.js";

const receivedAt = "2026-09-20T12:00:00.000Z";

describe("normalizeHookPayload", () => {
  it("reads Claude Code's payload shape", () => {
    const event = normalizeHookPayload(
      "claude",
      {
        hook_event_name: "Notification",
        session_id: "abc",
        transcript_path: "/tmp/abc.jsonl",
        cwd: "/Users/someone/repo",
        message: "Claude needs your permission to use Bash",
      },
      receivedAt,
    );

    expect(event?.event).toBe("Notification");
    expect(event?.sessionId).toBe("abc");
    expect(event?.transcriptPath).toBe("/tmp/abc.jsonl");
  });

  it("tolerates the camelCase and thread-id spellings", () => {
    const event = normalizeHookPayload("codex", { hookEventName: "Stop", threadId: "t-1" }, receivedAt);

    expect(event?.event).toBe("Stop");
    expect(event?.sessionId).toBe("t-1");
  });

  it("rejects a payload with no event name", () => {
    expect(normalizeHookPayload("claude", { session_id: "abc" }, receivedAt)).toBeNull();
  });
});

describe("classifyNotification", () => {
  it("separates a permission prompt from an idle wait", () => {
    expect(classifyNotification("Claude needs your permission to use Bash")).toBe("awaiting_approval");
    expect(classifyNotification("Claude is waiting for your input")).toBe("awaiting_input");
  });

  it("treats an unfamiliar notification as something needing an answer", () => {
    // Over-surfacing a stuck agent beats silently dropping it.
    expect(classifyNotification("something new we have not seen")).toBe("awaiting_input");
    expect(classifyNotification(null)).toBe("awaiting_input");
  });
});

function event(overrides: Partial<HookEvent>): HookEvent {
  return {
    agent: "claude",
    event: "Stop",
    sessionId: "abc",
    cwd: null,
    transcriptPath: null,
    message: null,
    toolName: null,
    receivedAt,
    ...overrides,
  };
}

describe("stateFromHookEvent", () => {
  it("maps lifecycle events onto fleet states", () => {
    expect(stateFromHookEvent(event({ event: "Stop" }))).toBe("finished");
    expect(stateFromHookEvent(event({ event: "UserPromptSubmit" }))).toBe("working");
    expect(stateFromHookEvent(event({ event: "SessionStart" }))).toBe("working");
    expect(stateFromHookEvent(event({ event: "Interrupt" }))).toBe("idle");
    expect(stateFromHookEvent(event({ event: "SessionEnd" }))).toBe("idle");
  });

  it("ignores events that say nothing about state", () => {
    expect(stateFromHookEvent(event({ event: "PostToolUse" }))).toBeNull();
  });

  it("recognises the end of a session", () => {
    expect(isSessionEndEvent(event({ event: "SessionEnd" }))).toBe(true);
    expect(isSessionEndEvent(event({ event: "Stop" }))).toBe(false);
  });
});
