import { describe, expect, it } from "vitest";

import type { SessionMessageRecord } from "../types.js";
import { buildTranscript } from "./transcript.js";

function assistant(id: string, turnId: string, blocks: unknown[], type = "assistant"): SessionMessageRecord {
  return {
    id,
    role: "assistant",
    content: JSON.stringify({ type, message: { role: "assistant", content: blocks } }),
    sentAt: "2026-09-22 04:11:37",
    turnId,
    model: null,
  };
}

// Newest first, as the registry returns them.
const rows: SessionMessageRecord[] = [
  {
    id: "r",
    role: "assistant",
    content: JSON.stringify({ type: "result", result: "done" }),
    sentAt: null,
    turnId: "t2",
    model: null,
  },
  assistant("a3", "t2", [{ type: "text", text: "Final answer" }]),
  assistant("a2", "t2", [{ type: "tool_use", name: "Bash", input: { command: "secret" } }]),
  assistant("a1", "t2", [
    { type: "thinking", thinking: "hmm" },
    { type: "text", text: "Looking" },
  ]),
  { id: "u2", role: "user", content: "go", sentAt: "2026-09-22T04:11:00Z", turnId: "t2", model: null },
  {
    id: "tr",
    role: "user",
    content: JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: "out" }] },
    }),
    sentAt: null,
    turnId: "t1",
    model: null,
  },
  {
    id: "sys",
    role: "assistant",
    content: JSON.stringify({ type: "system", subtype: "init" }),
    sentAt: null,
    turnId: "t1",
    model: null,
  },
  { id: "u1", role: "user", content: "hello", sentAt: null, turnId: "t1", model: null },
];

describe("buildTranscript", () => {
  it("keeps user text and assistant prose, oldest first, and drops tools, thinking and events", () => {
    const result = buildTranscript(rows, { limit: 40, scanRows: 600 });
    expect(result.complete).toBe(true);
    expect(result.messages.map((m) => [m.id, m.role, m.text])).toEqual([
      ["u1", "user", "hello"],
      ["u2", "user", "go"],
      ["a1", "assistant", "Looking"],
      ["a3", "assistant", "Final answer"],
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("hmm");
    expect(result.messages[3]).toMatchObject({ turnId: "t2", at: "2026-09-22T04:11:37Z" });
    expect(result.messages[0]?.at).toBeNull();
  });

  it("counts the tool calls between messages onto the next message, and never carries a command", () => {
    const result = buildTranscript(rows, { limit: 40, scanRows: 600 });
    // The one Bash call came after "Looking" and before "Final answer".
    expect(result.messages.map((m) => [m.id, m.workBefore])).toEqual([
      ["u1", undefined],
      ["u2", undefined],
      ["a1", undefined],
      ["a3", 1],
    ]);
    // Work with no message after it (an agent that ended on tools) is counted onto the next thing said.
    const silent = buildTranscript(
      [
        { id: "u2", role: "user", content: "again", sentAt: null, turnId: "t2", model: null },
        assistant("a2", "t1", [
          { type: "tool_use", name: "Read", input: {} },
          { type: "tool_use", name: "Edit", input: {} },
        ]),
        { id: "u1", role: "user", content: "first", sentAt: null, turnId: "t1", model: null },
      ],
      { limit: 40, scanRows: 600 },
    );
    expect(silent.messages.map((m) => [m.id, m.workBefore])).toEqual([
      ["u1", undefined],
      ["u2", 2],
    ]);
    expect(JSON.stringify(silent)).not.toContain("Edit");
  });

  it("returns the newest messages when the limit bites, and says it is incomplete", () => {
    const result = buildTranscript(rows, { limit: 2, scanRows: 600 });
    expect(result.messages.map((m) => m.id)).toEqual(["a1", "a3"]);
    expect(result.complete).toBe(false);
  });

  it("is incomplete when the scan hit its cap", () => {
    expect(buildTranscript(rows, { limit: 40, scanRows: rows.length }).complete).toBe(false);
  });
});
