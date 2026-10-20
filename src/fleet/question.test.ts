import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseQuestions } from "./pending-question.js";
import { readPendingAsk, readPendingQuestion } from "./question.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function transcript(entries: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "question-"));
  dirs.push(dir);
  const file = path.join(dir, "t.jsonl");
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return file;
}

const ask = {
  questions: [
    {
      question: "Where should the switch go?",
      header: "Where",
      multiSelect: true,
      options: [
        { label: "Menu bar", description: "Toggle before you walk away" },
        { label: "iPhone app", description: "From the phone" },
      ],
    },
    { question: "Battery too?", options: ["Yes", "No"] },
  ],
};

const call = (id: string, name = "AskUserQuestion", input: unknown = ask) => ({
  type: "assistant",
  message: { id: `m-${id}`, role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});

describe("parseQuestions", () => {
  it("keeps every question and option, with descriptions and multi-select", () => {
    expect(parseQuestions("AskUserQuestion", ask)).toEqual([
      {
        question: "Where should the switch go?",
        header: "Where",
        multiSelect: true,
        options: [
          { label: "Menu bar", description: "Toggle before you walk away" },
          { label: "iPhone app", description: "From the phone" },
        ],
      },
      {
        question: "Battery too?",
        header: null,
        multiSelect: false,
        options: [
          { label: "Yes", description: null },
          { label: "No", description: null },
        ],
      },
    ]);
  });

  it("is null for a plan review or another tool, and clips what an agent wrote", () => {
    expect(parseQuestions("ExitPlanMode", { plan: "x" })).toBeNull();
    expect(parseQuestions("Bash", ask)).toBeNull();
    const long = parseQuestions("AskUserQuestion", { questions: [{ question: "q".repeat(5_000), options: [] }] });
    expect(long![0]!.question.length).toBe(1_000);
  });
});

describe("readPendingQuestion", () => {
  it("reads the unanswered question from a transcript", () => {
    const file = transcript([{ type: "user", message: { content: "set it up" } }, call("toolu_1")]);
    expect(readPendingQuestion(file)).toMatchObject({ toolUseId: "toolu_1", questions: [{ header: "Where" }, {}] });
  });

  it("is null once it has been answered", () => {
    const file = transcript([
      { type: "user", message: { content: "set it up" } },
      call("toolu_1"),
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Menu bar" }] } },
    ]);
    expect(readPendingQuestion(file)).toBeNull();
  });
});

describe("readPendingAsk", () => {
  it("reads a question and a plan, whole", () => {
    const q = transcript([{ type: "user", message: { content: "go" } }, call("toolu_q")]);
    expect(readPendingAsk(q)).toMatchObject({ toolUseId: "toolu_q", kind: "question", plan: null });
    const p = transcript([
      { type: "user", message: { content: "go" } },
      call("toolu_p", "ExitPlanMode", { plan: "1. Add it\n2. Test it" }),
    ]);
    expect(readPendingAsk(p)).toEqual({
      toolUseId: "toolu_p",
      kind: "plan",
      questions: [],
      plan: "1. Add it\n2. Test it",
    });
    expect(readPendingQuestion(p)).toBeNull();
  });

  it("is null once answered", () => {
    const file = transcript([
      call("toolu_q"),
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_q", content: "ok" }] } },
    ]);
    expect(readPendingAsk(file)).toBeNull();
  });
});
