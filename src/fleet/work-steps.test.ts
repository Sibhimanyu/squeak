import { describe, expect, it } from "vitest";

import type { SessionMessageRecord } from "../types.js";
import { readWorkBetween, WORK_STEPS_MAX } from "./work-steps.js";

const envelope = (blocks: unknown[]) => JSON.stringify({ type: "assistant", message: { content: blocks } });
const row = (n: number, role: "user" | "assistant", content: string): SessionMessageRecord => ({
  id: `m${n}`,
  cursor: String(n),
  role,
  content,
  sentAt: null,
  turnId: "t",
  model: null,
});
const text = (n: number, t: string) => row(n, "assistant", envelope([{ type: "text", text: t }]));
const tools = (n: number, ...blocks: unknown[]) => row(n, "assistant", envelope(blocks));
const source = (rows: SessionMessageRecord[]) => ({
  listSessionMessagesPage: (_s: string, before: number | null, limit: number) =>
    rows
      .filter((r) => before === null || Number(r.cursor) < before)
      .sort((a, b) => Number(b.cursor) - Number(a.cursor))
      .slice(0, limit),
});

describe("readWorkBetween", () => {
  const rows = [
    row(1, "user", "go"),
    text(2, "On it"),
    tools(
      3,
      { type: "thinking", thinking: "plan it" },
      { type: "tool_use", name: "Read", input: { file_path: "/a/b.ts", secret: "x" } },
    ),
    tools(4, { type: "tool_use", name: "Bash", input: { command: "rm -rf secret", description: "Clean up" } }),
    text(5, "Done"),
    tools(6, { type: "tool_use", name: "Edit", input: { file_path: "/z.ts" } }),
  ];

  it("lists the labelled tool calls between the previous message and this one, oldest first", () => {
    const work = readWorkBetween(source(rows), "s", "5");
    expect(work).toEqual({
      steps: [
        { kind: "thinking", text: "plan it" },
        { kind: "tool", text: "Read b.ts" },
        { kind: "tool", text: "Clean up" },
      ],
      more: 0,
    });
  });

  it("is null for an unknown id and empty when nothing happened between", () => {
    expect(readWorkBetween(source(rows), "s", "nope")).toBeNull();
    expect(readWorkBetween(source(rows), "s", "2")).toEqual({ steps: [], more: 0 });
  });

  it("caps the steps and says how many were left out", () => {
    const many = Array.from({ length: WORK_STEPS_MAX + 7 }, (_, i) =>
      tools(10 + i, { type: "tool_use", name: "Read", input: { file_path: `/f${i}.ts` } }),
    );
    const work = readWorkBetween(source([text(1, "a"), ...many, text(500, "b")]), "s", "500");
    expect(work?.steps).toHaveLength(WORK_STEPS_MAX);
    expect(work?.more).toBe(7);
  });
});
