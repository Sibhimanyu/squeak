import { describe, expect, it, vi } from "vitest";

import type { ClaudeLimits } from "./claude-limits.js";
import { CLAUDE_REFRESH_MIN_INTERVAL_MS, ClaudeLimitsRefresher } from "./claude-limits-refresh.js";

function limits(observedAt: string): ClaudeLimits {
  return { fiveHour: { utilization: 0.4, resetsAt: "2026-10-19T12:00:00.000Z" }, sevenDay: null, observedAt };
}

function harness(probe: (record: (l: ClaudeLimits) => void) => Promise<void>) {
  let latest: ClaudeLimits | null = limits("2026-10-16T00:00:00.000Z");
  let now = 1_000_000;
  const run = vi.fn(() => probe((l) => (latest = l)));
  const refresher = new ClaudeLimitsRefresher({ latest: () => latest }, run, () => now);
  return { refresher, run, advance: (ms: number) => (now += ms) };
}

describe("ClaudeLimitsRefresher", () => {
  it("runs one call and returns the newer reading", async () => {
    const h = harness(async (record) => record(limits("2026-10-19T09:00:00.000Z")));
    const result = await h.refresher.refresh();
    expect(result).toMatchObject({ throttled: false, refreshed: true });
    expect(result.claudeLimits?.observedAt).toBe("2026-10-19T09:00:00.000Z");
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it("answers a second press within a minute from the cache, without a call", async () => {
    const h = harness(async (record) => record(limits("2026-10-19T09:00:00.000Z")));
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

  it("shares one call between presses that overlap", async () => {
    let release: () => void = () => undefined;
    const h = harness(
      (record) =>
        new Promise<void>((resolve) => {
          release = () => {
            record(limits("2026-10-19T09:00:00.000Z"));
            resolve();
          };
        }),
    );
    const first = h.refresher.refresh();
    const second = h.refresher.refresh();
    release();
    expect(await first).toBe(await second);
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it("says so, in plain words, when the call fails and nothing new arrived", async () => {
    const h = harness(async () => {
      throw new Error("claude exited 1");
    });
    const result = await h.refresher.refresh();
    expect(result).toMatchObject({ refreshed: false, error: "claude exited 1" });
    expect(result.claudeLimits?.observedAt).toBe("2026-10-16T00:00:00.000Z");
  });

  it("keeps a reading that arrived even though the answer failed", async () => {
    const h = harness(async (record) => {
      record(limits("2026-10-19T09:00:00.000Z"));
      throw new Error("bad answer");
    });
    expect(await h.refresher.refresh()).toMatchObject({ refreshed: true });
  });
});
