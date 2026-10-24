import { describe, expect, it } from "vitest";

import { agentMessageFor, checkWorkSplit, describeSplit, splitBrief } from "./work-split.js";

describe("checkWorkSplit", () => {
  it("takes nothing, and an empty split, as one model doing it all", () => {
    expect(checkWorkSplit("claude", undefined)).toEqual({ ok: true });
    expect(checkWorkSplit("claude", {})).toEqual({ ok: true });
    expect(checkWorkSplit("claude", { planFirst: false })).toEqual({ ok: true });
  });

  it("keeps the workers it offers and plan first", () => {
    expect(checkWorkSplit("claude", { code: "sonnet", run: "haiku", planFirst: true })).toEqual({
      ok: true,
      split: { code: "sonnet", run: "haiku", planFirst: true },
    });
  });

  it("refuses an unknown worker, a stray field, a non-boolean plan first, and workers for a Codex chat", () => {
    expect(checkWorkSplit("claude", { code: "gpt-5.5" })).toMatchObject({ ok: false });
    expect(checkWorkSplit("claude", { code: "sonnet", explore: "haiku" })).toMatchObject({ ok: false });
    expect(checkWorkSplit("claude", { planFirst: "yes" })).toMatchObject({ ok: false });
    expect(checkWorkSplit("claude", ["sonnet"])).toMatchObject({ ok: false });
    expect(checkWorkSplit("codex", { run: "haiku" })).toMatchObject({ ok: false });
  });

  it("lets a Codex chat plan first", () => {
    expect(checkWorkSplit("codex", { planFirst: true })).toEqual({ ok: true, split: { planFirst: true } });
  });
});

describe("splitBrief", () => {
  it("is nothing when nothing is split, so the agent gets the message as written", () => {
    expect(splitBrief(undefined)).toBeNull();
    expect(splitBrief({})).toBeNull();
    expect(agentMessageFor("Add a timer", undefined)).toBeUndefined();
  });

  it("names the Agent tool's model for each worker, and only the roles chosen", () => {
    const brief = splitBrief({ code: "sonnet" })!;
    expect(brief).toContain('model "sonnet"');
    expect(brief).toContain("planner");
    expect(brief).not.toContain("Run:");
    expect(brief).not.toContain("Plan first");
  });

  it("puts the brief in front of the message, and stays short", () => {
    const message = agentMessageFor("Add a timer", { code: "sonnet", run: "haiku", planFirst: true })!;
    expect(message.endsWith("\n\nAdd a timer")).toBe(true);
    expect(message).toContain('model "haiku"');
    expect(message).toContain("Plan first");
    // Paid for on every turn of the chat: keep it near 150 words.
    expect(message.split(/\s+/).length).toBeLessThan(160);
  });

  it("plan first alone says nothing about workers", () => {
    const brief = splitBrief({ planFirst: true })!;
    expect(brief).toContain("Plan first");
    expect(brief).not.toContain("subagent");
  });
});

describe("describeSplit", () => {
  it("reads as a log line", () => {
    expect(describeSplit({ code: "sonnet", run: "haiku", planFirst: true })).toBe(
      "Sonnet codes · Haiku runs · plan first",
    );
    expect(describeSplit(undefined)).toBe("");
  });
});
