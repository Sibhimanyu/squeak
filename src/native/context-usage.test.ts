import { describe, expect, it } from "vitest";
import { claudeContextLimit, claudeContextStep, codexContextFrom, contextFromMessages } from "./context-usage.js";

const assistant = (usage: Record<string, number>, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  message: { usage },
  ...extra,
});

describe("context usage", () => {
  it("picks 1M for 1m models and 200k otherwise", () => {
    expect(claudeContextLimit("opus-5-5-1m")).toBe(1_000_000);
    expect(claudeContextLimit("claude-opus-5-5[1m]")).toBe(1_000_000);
    expect(claudeContextLimit("haiku-4-5")).toBe(200_000);
  });

  it("sums the message's input, cache and output tokens", () => {
    const c = claudeContextStep(
      "assistant",
      assistant({
        input_tokens: 10,
        cache_creation_input_tokens: 40_000,
        cache_read_input_tokens: 100_000,
        output_tokens: 1_990,
      }),
      "opus-5-5-1m",
    );
    expect(c).toEqual({ used: 142_000, limit: 1_000_000, percent: 14.2 });
  });

  it("ignores subagent messages", () => {
    const u = { input_tokens: 5000 };
    expect(claudeContextStep("assistant", assistant(u, { parent_tool_use_id: "toolu_1" }), "m")).toBeUndefined();
    expect(claudeContextStep("assistant", assistant(u, { isSidechain: true }), "m")).toBeUndefined();
  });

  it("resets after a compaction and never reports a fake 0%", () => {
    expect(claudeContextStep("system/compact_boundary", { type: "system" }, "m")).toBeNull();
    expect(claudeContextStep("assistant", assistant({}), "m")).toBeUndefined();
    const replay = contextFromMessages("claude", "haiku-4-5", [
      { kind: "assistant", payload: assistant({ input_tokens: 150_000 }) },
      { kind: "system/compact_boundary", payload: {} },
    ]);
    expect(replay).toBeNull();
    const after = contextFromMessages("claude", "haiku-4-5", [
      { kind: "assistant", payload: assistant({ input_tokens: 150_000 }) },
      { kind: "system/compact_boundary", payload: {} },
      { kind: "assistant", payload: assistant({ input_tokens: 20_000 }) },
    ]);
    expect(after?.used).toBe(20_000);
    expect(after?.percent).toBe(10);
  });

  it("reads Codex token usage", () => {
    expect(codexContextFrom({ tokenUsage: { last: { totalTokens: 50_000 }, modelContextWindow: 200_000 } })).toEqual({
      used: 50_000,
      limit: 200_000,
      percent: 25,
    });
    expect(codexContextFrom({ tokenUsage: { last: { totalTokens: 5 } } })).toBeNull();
  });
});
