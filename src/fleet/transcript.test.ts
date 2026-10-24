import { describe, expect, it } from "vitest";

import type { SessionMessageRecord } from "../types.js";
import { buildTranscript, parseCursor, readTranscript, type TranscriptRowSource } from "./transcript.js";

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

describe("readTranscript (paging by rowid)", () => {
  const toolRow = (n: number): SessionMessageRecord => ({
    role: "assistant",
    content: JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] },
    }),
    sentAt: null,
    turnId: "t",
    model: null,
    id: `tool-${n}`,
  });
  const text = (role: "user" | "assistant", body: string): SessionMessageRecord =>
    role === "user"
      ? { role, content: body, sentAt: null, turnId: "t", model: null }
      : assistant("x", "t", [{ type: "text", text: body }]);

  /** Oldest first; rowids are 1-based positions. */
  function source(all: SessionMessageRecord[]): TranscriptRowSource & { reads: number[] } {
    const reads: number[] = [];
    return {
      reads,
      listSessionMessagesPage(_session, before, limit) {
        reads.push(limit);
        const upto = before === null ? all.length : before - 1;
        const out: SessionMessageRecord[] = [];
        for (let rowid = upto; rowid >= 1 && out.length < limit; rowid -= 1) {
          out.push({ ...all[rowid - 1]!, cursor: String(rowid) });
        }
        return out;
      },
    };
  }

  const longTurn = () => [
    text("user", "first prompt"),
    text("assistant", "first answer"),
    text("user", "the long task"),
    ...Array.from({ length: 700 }, (_, n) => toolRow(n)),
    text("assistant", "done at last"),
  ];

  it("reaches the prompt of a 700-row turn that a fixed 600-row window hides", () => {
    const result = readTranscript(source(longTurn()), "s", { limit: 3 });
    expect(result.messages.map((message) => message.text)).toEqual(["first answer", "the long task", "done at last"]);
    expect(result.messages[1]!.workBefore).toBeUndefined();
    expect(result.messages[2]!.workBefore).toBe(700);
    expect(result.nextBefore).toBe("2");
    expect(result.complete).toBe(false);
  });

  it("pages back with the cursor without repeating or skipping a message, then says complete", () => {
    const src = source(longTurn());
    const first = readTranscript(src, "s", { limit: 2 });
    expect(first.messages.map((m) => m.text)).toEqual(["the long task", "done at last"]);
    const second = readTranscript(src, "s", { limit: 2, before: Number(first.nextBefore) });
    expect(second.messages.map((m) => m.text)).toEqual(["first prompt", "first answer"]);
    expect(second.complete).toBe(true);
    expect(second.nextBefore).toBeNull();
  });

  it("is complete when the whole chat fits the page", () => {
    const result = readTranscript(source([text("user", "hi"), text("assistant", "hello")]), "s", { limit: 40 });
    expect(result).toMatchObject({ complete: true, nextBefore: null });
    expect(result.messages).toHaveLength(2);
    expect(readTranscript(source([]), "s", { limit: 5 })).toEqual({ messages: [], complete: true, nextBefore: null });
  });

  it("reads a small first chunk, then bigger ones, and stops once it has enough", () => {
    const src = source(longTurn());
    readTranscript(src, "s", { limit: 3 });
    expect(src.reads[0]).toBe(200);
    expect(src.reads.slice(1).every((size) => size === 2000)).toBe(true);
    expect(src.reads.length).toBe(2);
  });

  it("validates a cursor strictly", () => {
    expect(parseCursor(null)).toBeNull();
    expect(parseCursor("")).toBeNull();
    expect(parseCursor("42")).toBe(42);
    for (const bad of ["0", "-1", "1.5", "12a", " 1", "1e3", "0x10", "99999999999999999"]) {
      expect(parseCursor(bad)).toBe("invalid");
    }
  });
});
