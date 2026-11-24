import { describe, expect, it } from "vitest";

import { CAP_PRESETS, effectiveCaps, readCapsPatch, threadWriteDecision } from "./permissions.js";

describe("per-member capabilities", () => {
  it("role defaults, presets and muted", () => {
    // A Member does not start by default (their Tasks wait for the Owner); the Collaborator preset does.
    expect(effectiveCaps("member")).toMatchObject({ message: true, answer: true, start: false });
    expect(effectiveCaps("member", CAP_PRESETS.collaborator.caps)).toMatchObject({ start: true });
    expect(effectiveCaps("viewer")).toEqual({ see: true, diffs: true, message: false, answer: false, start: false });
    expect(effectiveCaps("viewer", { message: true })).toMatchObject({ message: false });
    const m = CAP_PRESETS.member;
    expect(effectiveCaps(m.role, m.caps)).toMatchObject({ message: true, start: false });
    expect(effectiveCaps("member", { muted: true })).toMatchObject({
      message: false,
      answer: false,
      start: false,
      see: true,
    });
    expect(effectiveCaps("member", { see: false })).toEqual({
      see: false,
      diffs: false,
      message: false,
      answer: false,
      start: false,
    });
    expect(effectiveCaps("owner", { message: false }).message).toBe(true);
  });
  it("reads only booleans", () => {
    expect(readCapsPatch({ message: "no", start: false, x: true })).toEqual({ start: false });
    expect(readCapsPatch(null)).toBeUndefined();
  });
  it("thread overrides: starter always, deny beats allow, lock needs allow", () => {
    expect(threadWriteDecision("s", "s", { locked: true, deny: ["s"] }).ok).toBe(true);
    expect(threadWriteDecision("a", "s", { locked: true }).ok).toBe(false);
    expect(threadWriteDecision("a", "s", { locked: true, allow: ["a"] }).ok).toBe(true);
    expect(threadWriteDecision("a", "s", { locked: true, allow: ["a"], deny: ["a"] }).ok).toBe(false);
    expect(threadWriteDecision("a", "s", undefined).ok).toBe(true);
  });
});
