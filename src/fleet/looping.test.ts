import { describe, expect, it } from "vitest";

import { isLooping } from "./attention.js";
import { detectClaudeLoop, detectCodexLoop, loopingSteer, loopingText } from "./looping.js";
import type { FleetSession } from "./types.js";

let n = 0;
const at = () => `2026-11-12T10:00:${String(n++).padStart(2, "0")}.000Z`;
const prompt = (text = "fix the build") => ({
  type: "user",
  timestamp: at(),
  message: { role: "user", content: text },
});
const call = (id: string, command: string, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  timestamp: at(),
  ...extra,
  message: {
    role: "assistant",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
  },
});
const result = (id: string, isError: boolean, extra: Record<string, unknown> = {}) => ({
  type: "user",
  timestamp: at(),
  ...extra,
  message: {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: id, is_error: isError, content: isError ? "Exit code 1\nboom" : "ok" },
    ],
  },
});

describe("detectClaudeLoop", () => {
  it("flags the same failing Bash command three times in a row, whitespace aside", () => {
    const entries = [
      prompt(),
      call("a", "npm test"),
      result("a", true),
      call("b", "npm   test "),
      result("b", true),
      call("c", "npm test"),
      result("c", true),
    ];
    const found = detectClaudeLoop(entries);
    expect(found).toMatchObject({ count: 3, label: "Run npm test" });
    expect(loopingText(found!)).toBe("Repeating a failing step: Run npm test ×3");
    expect(loopingSteer(found!)).toContain("same error 3 times running Run npm test");
  });

  it("does not flag two failures, or a success between them", () => {
    expect(
      detectClaudeLoop([prompt(), call("a", "make"), result("a", true), call("b", "make"), result("b", true)]),
    ).toBeNull();
    expect(
      detectClaudeLoop([
        prompt(),
        call("a", "make"),
        result("a", true),
        call("b", "ls"),
        result("b", false),
        call("c", "make"),
        result("c", true),
        call("d", "make"),
        result("d", true),
      ]),
    ).toBeNull();
  });

  it("does not flag different commands, one long command, or a previous turn", () => {
    expect(
      detectClaudeLoop([
        prompt(),
        call("a", "make a"),
        result("a", true),
        call("b", "make b"),
        result("b", true),
        call("c", "make c"),
        result("c", true),
      ]),
    ).toBeNull();
    expect(detectClaudeLoop([prompt(), call("a", "for i in 1 2 3; do false; done"), result("a", true)])).toBeNull();
    const old = [
      call("a", "x"),
      result("a", true),
      call("b", "x"),
      result("b", true),
      call("c", "x"),
      result("c", true),
      prompt("next"),
    ];
    expect(detectClaudeLoop(old)).toBeNull();
  });

  it("ignores a person's refusal and a turn that ended", () => {
    const refused = (id: string) => ({
      type: "user",
      timestamp: at(),
      message: {
        content: [
          { type: "tool_result", tool_use_id: id, is_error: true, content: "The user doesn't want to proceed" },
        ],
      },
    });
    expect(
      detectClaudeLoop([
        prompt(),
        call("a", "rm x"),
        refused("a"),
        call("b", "rm x"),
        refused("b"),
        call("c", "rm x"),
        refused("c"),
      ]),
    ).toBeNull();
    const ended = [
      prompt(),
      call("a", "x"),
      result("a", true),
      call("b", "x"),
      result("b", true),
      call("c", "x"),
      result("c", true),
      {
        type: "assistant",
        timestamp: at(),
        message: { stop_reason: "end_turn", content: [{ type: "text", text: "Blocked." }] },
      },
    ];
    expect(detectClaudeLoop(ended)).toBeNull();
  });

  it("finds a duckling's own loop and keeps lanes apart", () => {
    const side = { isSidechain: true, agentId: "abc123def456" };
    const entries = [
      prompt(),
      call("m", "ls"),
      call("a", "pytest", side),
      result("a", true, side),
      call("b", "pytest", side),
      result("b", true, side),
      result("m", false),
      call("c", "pytest", side),
      result("c", true, side),
    ];
    expect(detectClaudeLoop(entries, { duckling: true })).toMatchObject({ count: 3, duckling: true });
    expect(loopingText(detectClaudeLoop(entries, { duckling: true })!)).toContain("a duckling ran");
  });
});

const cx = (payload: Record<string, unknown>, type = "response_item") => ({ type, timestamp: at(), payload });
const cxCall = (id: string, cmd: string) =>
  cx({ type: "function_call", name: "exec_command", call_id: id, arguments: JSON.stringify({ cmd }) });
const cxOut = (id: string, output: string) => cx({ type: "function_call_output", call_id: id, output });

describe("detectCodexLoop", () => {
  it("flags a command that exits non-zero three times running", () => {
    const entries = [
      cx({ type: "task_started" }, "event_msg"),
      cxCall("1", "cargo build"),
      cxOut("1", "error\nProcess exited with code 101"),
      cxCall("2", "cargo  build"),
      cxOut("2", "error\nProcess exited with code 101"),
      cxCall("3", "cargo build"),
      cxOut("3", "error\nProcess exited with code 101"),
    ];
    expect(detectCodexLoop(entries)?.count).toBe(3);
  });

  it("does not flag successes, exit 0, or a new turn", () => {
    const ok = [
      cxCall("1", "ls"),
      cxOut("1", "Process exited with code 0"),
      cxCall("2", "ls"),
      cxOut("2", "Process exited with code 0"),
    ];
    expect(detectCodexLoop(ok)).toBeNull();
    const fail = (i: string) => [cxCall(i, "x"), cxOut(i, "Process exited with code 2")];
    expect(
      detectCodexLoop([...fail("1"), ...fail("2"), ...fail("3"), cx({ type: "task_started" }, "event_msg")]),
    ).toBeNull();
    expect(detectCodexLoop([...fail("1"), ...fail("2")])).toBeNull();
  });
});

describe("isLooping", () => {
  const base = {
    state: "working",
    retired: false,
    looping: { key: "k", label: "Run x", count: 3, since: "t" },
  } as unknown as FleetSession;
  it("needs a working, live session", () => {
    expect(isLooping(base)).toBe(true);
    expect(isLooping({ ...base, state: "finished" } as FleetSession)).toBe(false);
    expect(isLooping({ ...base, retired: true } as FleetSession)).toBe(false);
  });
});
