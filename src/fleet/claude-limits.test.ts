import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ClaudeLimitsStore, parseRateLimitEvent } from "./claude-limits.js";

// Captured from Claude Code 2.1.280's stream-json output on a real machine.
const REAL_EVENT = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    resetsAt: 1790689800,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "org_level_disabled",
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.14, resetsAt: 1790689800 },
      seven_day: { utilization: 0.05, resetsAt: 1791201600 },
    },
  },
  uuid: "de331376-e97b-4af5-9282-f48690982946",
  session_id: "2be656c8-bd61-47bf-9ab9-2b19827ba00f",
};

describe("parseRateLimitEvent", () => {
  it("reads both windows from a real event", () => {
    const now = Date.parse("2026-09-29T09:00:00.000Z");
    expect(parseRateLimitEvent(REAL_EVENT, now)).toEqual({
      fiveHour: { utilization: 0.14, resetsAt: new Date(1790689800 * 1000).toISOString() },
      sevenDay: { utilization: 0.05, resetsAt: new Date(1791201600 * 1000).toISOString() },
      observedAt: "2026-09-29T09:00:00.000Z",
    });
  });

  it("ignores every other stream event, and one with no windows", () => {
    expect(parseRateLimitEvent({ type: "result", result: "ok" }, 0)).toBeNull();
    expect(parseRateLimitEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }, 0)).toBeNull();
    expect(parseRateLimitEvent(null, 0)).toBeNull();
  });
});

describe("ClaudeLimitsStore", () => {
  it("keeps the latest reading across a restart", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "squeak-limits-")), "claude-limits.json");
    const limits = parseRateLimitEvent(REAL_EVENT, 0)!;
    expect(new ClaudeLimitsStore(file).latest()).toBeNull();
    new ClaudeLimitsStore(file).record(limits);
    expect(new ClaudeLimitsStore(file).latest()).toEqual(limits);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
