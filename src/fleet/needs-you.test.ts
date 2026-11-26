import { describe, expect, it } from "vitest";

import { FAILED_COUNTS_FOR_MS, failureCounts, needsYouReason } from "./needs-you.js";

const now = Date.parse("2026-11-26T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

describe("needsYouReason: the one rule", () => {
  it("names the waiting kinds", () => {
    expect(needsYouReason({ state: "awaiting_approval" }, now)).toBe("approval");
    expect(needsYouReason({ state: "awaiting_input" }, now)).toBe("question");
    expect(needsYouReason({ state: "finished", asks: "Open a PR?" }, now)).toBe("question");
  });

  it("names a stalled turn when the caller measured one", () => {
    expect(needsYouReason({ state: "working", stalled: true }, now)).toBe("stalled");
    expect(needsYouReason({ state: "working" }, now)).toBeNull();
  });

  it("counts a failure the person has not seen", () => {
    expect(needsYouReason({ state: "error", updatedAt: ago(60_000) }, now)).toBe("failed");
  });

  it("stops counting a failure once it is opened or dismissed", () => {
    expect(needsYouReason({ state: "error", updatedAt: ago(60_000), errorSeenAt: ago(1000) }, now)).toBeNull();
  });

  it("stops counting a failure nobody touched for a day, never one a minute older than the window", () => {
    expect(needsYouReason({ state: "error", updatedAt: ago(FAILED_COUNTS_FOR_MS - 60_000) }, now)).toBe("failed");
    expect(needsYouReason({ state: "error", updatedAt: ago(FAILED_COUNTS_FOR_MS + 60_000) }, now)).toBeNull();
  });

  it("does not hide a failure that has no date, nor count a retired chat's", () => {
    expect(failureCounts({}, now)).toBe(true);
    expect(failureCounts({ retired: true }, now)).toBe(false);
  });

  it("finished, working and idle chats need nothing", () => {
    for (const state of ["finished", "working", "idle"] as const) expect(needsYouReason({ state }, now)).toBeNull();
  });
});
