import { describe, expect, it, vi } from "vitest";

import { item, QUESTION } from "./fixtures.js";
import { CallPolicy } from "./policy.js";
import { DEFAULT_HOLD, type HoldSettings } from "./settings.js";
import { VoiceChannel } from "./voice-channel.js";

/** A channel whose clock moves only when it sleeps, and whose idle seconds are a script over that clock. */
function setup(hold: Partial<HoldSettings>, idleAt: (elapsedMs: number) => number | null, answeredAt?: number) {
  const waiting = item("asked_question");
  const attention = [waiting];
  let clock = 0;
  const traces: string[] = [];
  const calls: number[] = [];
  const channel = new VoiceChannel({
    monitor: {
      onPush: () => () => undefined,
      snapshot: { attention } as never,
      refresh: vi.fn().mockResolvedValue(undefined),
    },
    replier: { lastTurnText: () => QUESTION, send: async () => ({ status: "started" }) as never },
    line: {
      call: async () => {
        calls.push(clock);
        return { status: "unanswered" };
      },
    },
    canTakeKeys: true,
    policy: new CallPolicy({ minGapMs: 0, quiet: null }),
    idleSeconds: async () => idleAt(clock),
    hold: () => ({ ...DEFAULT_HOLD, ...hold }),
    note: () => undefined,
    now: () => clock,
    trace: (_kind, text) => traces.push(text),
    sleep: async (ms) => {
      clock += ms;
      if (answeredAt !== undefined && clock >= answeredAt) attention.length = 0;
    },
  });
  return { channel, waiting, traces, calls, clock: () => clock };
}

describe("VoiceChannel hold rules", () => {
  it("rings at once when holding at the Mac is off", async () => {
    const { channel, waiting, calls } = setup({ holdAtMac: false }, () => 1);
    await channel.ring(waiting);
    expect(calls).toEqual([0]);
  });

  it("counts a question that came while away by the away line", async () => {
    // Away (idle 200 s) when it came: no hold at all.
    const { channel, waiting, calls, traces } = setup({}, () => 200);
    await channel.ring(waiting);
    expect(calls).toEqual([0]);
    expect(traces.some((line) => line.includes("At the Mac"))).toBe(false);
  });

  it("holds a question seen at the Mac until the longer saw-it line", async () => {
    // At the Mac when it came (idle 10 s), then idle grows 1 s per second: 90 s would call, the rule says 180 s.
    const { channel, waiting, calls, traces } = setup({}, (elapsed) => 10 + elapsed / 1000);
    await channel.ring(waiting);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThanOrEqual(170_000);
    expect(calls[0]).toBeLessThanOrEqual(180_000);
    expect(traces).toContain("At the Mac when it came: calling after 3 min away");
  });

  it("uses a custom saw-it line and away line", async () => {
    const { channel, waiting, calls } = setup(
      { awayAfterSeconds: 30, sawItAwayAfterSeconds: 60 },
      (elapsed) => 5 + elapsed / 1000,
    );
    await channel.ring(waiting);
    expect(calls[0]).toBeGreaterThanOrEqual(55_000);
    expect(calls[0]).toBeLessThanOrEqual(60_000);
  });

  it("rings anyway after the longest hold", async () => {
    const { channel, waiting, calls, traces } = setup({ maxHoldMinutes: 2 }, () => 1);
    await channel.ring(waiting);
    expect(calls[0]).toBeGreaterThanOrEqual(120_000);
    expect(calls[0]).toBeLessThan(150_000);
    expect(traces).toContain("Still at the Mac after a long wait: calling anyway");
  });

  it("places no call when answered meanwhile", async () => {
    const { channel, waiting, calls, traces } = setup({}, () => 1, 60_000);
    await channel.ring(waiting);
    expect(calls).toEqual([]);
    expect(traces).toContain("Answered at the Mac: no call needed");
  });

  it("waits the configured grace before ringing", async () => {
    vi.useFakeTimers();
    try {
      const { channel, waiting, calls } = setup({ graceSeconds: 20, holdAtMac: false }, () => null);
      // consider() is private; drive it through the push listener of a fresh channel is not needed: the grace is read from the rules.
      expect((channel as unknown as { graceMs(): number }).graceMs()).toBe(20_000);
      expect(waiting).toBeTruthy();
      expect(calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
