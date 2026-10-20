import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { ClaudeLimits } from "./claude-limits.js";
import { CLAUDE_REFRESH_MIN_INTERVAL_MS, ClaudeLimitsRefresher } from "./claude-limits-refresh.js";
import type { ClaudeUsageOutcome } from "./claude-usage-api.js";

const OLD = "2026-10-16T00:00:00.000Z";
const RESET = "2026-10-19T12:00:00.000Z";

function oldLimits(): ClaudeLimits {
  return { fiveHour: { utilization: 0.4, resetsAt: RESET }, sevenDay: null, observedAt: OLD };
}

function harness(fetchUsage: () => Promise<ClaudeUsageOutcome>) {
  let latest: ClaudeLimits | null = oldLimits();
  let now = Date.parse("2026-10-19T09:00:00.000Z");
  const record = vi.fn((l: ClaudeLimits) => {
    latest = l;
  });
  const run = vi.fn(fetchUsage);
  const refresher = new ClaudeLimitsRefresher({ latest: () => latest, record }, run, () => now);
  return { refresher, run, record, advance: (ms: number) => (now += ms) };
}

const good: ClaudeUsageOutcome = {
  ok: true,
  fiveHour: { utilization: 0.37, resetsAt: RESET },
  sevenDay: null,
};

describe("ClaudeLimitsRefresher", () => {
  it("records a successful reading, keeping a missing window null", async () => {
    const h = harness(async () => good);
    const result = await h.refresher.refresh();
    expect(result).toMatchObject({ throttled: false, refreshed: true });
    expect(result.error).toBeUndefined();
    expect(h.record).toHaveBeenCalledWith({
      fiveHour: { utilization: 0.37, resetsAt: RESET },
      sevenDay: null,
      observedAt: "2026-10-19T09:00:00.000Z",
    });
    expect(result.claudeLimits?.observedAt).toBe("2026-10-19T09:00:00.000Z");
  });

  it("answers a second press within a minute from the cache, without a fetch", async () => {
    const h = harness(async () => good);
    await h.refresher.refresh();
    h.advance(CLAUDE_REFRESH_MIN_INTERVAL_MS - 1);
    const again = await h.refresher.refresh();
    expect(again).toMatchObject({ throttled: true, refreshed: false });
    expect(again.claudeLimits?.observedAt).toBe("2026-10-19T09:00:00.000Z");
    expect(h.run).toHaveBeenCalledTimes(1);
    h.advance(2);
    await h.refresher.refresh();
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it("shares one fetch between presses that overlap", async () => {
    let release: (o: ClaudeUsageOutcome) => void = () => undefined;
    const h = harness(() => new Promise<ClaudeUsageOutcome>((resolve) => (release = resolve)));
    const first = h.refresher.refresh();
    const second = h.refresher.refresh();
    release(good);
    expect(await first).toBe(await second);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.record).toHaveBeenCalledTimes(1);
  });

  it("says so, and keeps the old reading and its timestamp, when the fetch fails", async () => {
    const h = harness(async () => ({ ok: false, error: "Claude Code is not signed in on this Mac." }));
    const result = await h.refresher.refresh();
    expect(result).toMatchObject({ refreshed: false, error: "Claude Code is not signed in on this Mac." });
    expect(result.claudeLimits?.observedAt).toBe(OLD);
    expect(h.record).not.toHaveBeenCalled();
  });

  it("repeats a failure's error inside the minute, with the old reading, and does not fetch again", async () => {
    const h = harness(async () => ({ ok: false, error: "Claude Code's sign-in has expired." }));
    await h.refresher.refresh();
    h.advance(1_000);
    const again = await h.refresher.refresh();
    expect(again).toMatchObject({ throttled: true, refreshed: false, error: "Claude Code's sign-in has expired." });
    expect(again.claudeLimits?.observedAt).toBe(OLD);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.record).not.toHaveBeenCalled();
  });

  it("drops the remembered error after a success", async () => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      return calls === 1 ? { ok: false, error: "nope" } : good;
    });
    await h.refresher.refresh();
    h.advance(CLAUDE_REFRESH_MIN_INTERVAL_MS + 1);
    await h.refresher.refresh();
    h.advance(1_000);
    const again = await h.refresher.refresh();
    expect(again).toMatchObject({ throttled: true, refreshed: false });
    expect(again.error).toBeUndefined();
  });

  it("turns a throw into a plain sentence, with nothing from the throw in it", async () => {
    const h = harness(async () => {
      throw new Error("Bearer sk-ant-oat-secret");
    });
    const result = await h.refresher.refresh();
    expect(result.refreshed).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sk-ant");
    expect(result.claudeLimits?.observedAt).toBe(OLD);
  });

  it("waits out a 429's Retry-After even when it is longer than a minute", async () => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      return calls === 1 ? { ok: false, error: "Claude asked Squeak to slow down.", retryAfterMs: 5 * 60_000 } : good;
    });
    expect(await h.refresher.refresh()).toMatchObject({ refreshed: false, throttled: false });
    h.advance(4 * 60_000);
    const blocked = await h.refresher.refresh();
    expect(blocked).toMatchObject({ throttled: true, refreshed: false, error: "Claude asked Squeak to slow down." });
    expect(blocked.claudeLimits?.observedAt).toBe(OLD);
    expect(h.run).toHaveBeenCalledTimes(1);
    h.advance(60_001);
    expect(await h.refresher.refresh()).toMatchObject({ refreshed: true });
  });

  it("waits at least a minute after a 429 with a shorter hint", async () => {
    const h = harness(async () => ({ ok: false, error: "slow", retryAfterMs: 0 }));
    await h.refresher.refresh();
    h.advance(CLAUDE_REFRESH_MIN_INTERVAL_MS - 1);
    expect(await h.refresher.refresh()).toMatchObject({ throttled: true });
    h.advance(2);
    await h.refresher.refresh();
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it("no longer wires a paid probe into the app", () => {
    const app = fs.readFileSync(path.join(import.meta.dirname, "../squeak/app.ts"), "utf8");
    expect(app).not.toMatch(/CLAUDE_PROBE/);
    expect(app).toContain("fetchClaudeUsage");
    const refresher = fs.readFileSync(path.join(import.meta.dirname, "claude-limits-refresh.ts"), "utf8");
    expect(refresher).not.toMatch(/CLAUDE_PROBE|claudeRunner|execFile|spawn/);
  });
});
