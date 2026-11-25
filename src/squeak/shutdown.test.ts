import { afterEach, describe, expect, it, vi } from "vitest";

import { runStopSteps } from "./shutdown.js";

describe("runStopSteps", () => {
  afterEach(() => vi.useRealTimers());

  it("logs a failing step by name and still runs the rest, in order", async () => {
    const order: string[] = [];
    const log = { warn: vi.fn() };
    const failed = await runStopSteps(
      [
        { name: "heat", run: () => order.push("heat") },
        {
          name: "lid-actions",
          run: async () => {
            order.push("lid-actions");
            throw new Error("pmset refused");
          },
        },
        {
          name: "sync-throw",
          run: () => {
            throw new Error("sync");
          },
        },
        { name: "awake", run: async () => order.push("awake") },
      ],
      { log },
    );
    expect(order).toEqual(["heat", "lid-actions", "awake"]);
    expect(failed).toEqual(["lid-actions", "sync-throw"]);
    expect(log.warn).toHaveBeenCalledWith('shutdown: "lid-actions" failed', { error: "pmset refused" });
  });

  it("moves on from a hung step after stepMs", async () => {
    vi.useFakeTimers();
    const log = { warn: vi.fn() };
    const ran: string[] = [];
    const stopping = runStopSteps(
      [
        { name: "hang", run: () => new Promise(() => undefined) },
        { name: "after", run: () => ran.push("after") },
      ],
      { stepMs: 20, log },
    );
    await vi.advanceTimersByTimeAsync(19);
    expect(ran).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await stopping).toEqual(["hang"]);
    expect(ran).toEqual(["after"]);
  });

  it("bounds the total: steps after the budget are skipped and logged", async () => {
    vi.useFakeTimers();
    const log = { warn: vi.fn() };
    const ran: string[] = [];
    const stopping = runStopSteps(
      [
        { name: "slow", run: () => new Promise(() => undefined) },
        { name: "late", run: () => ran.push("late") },
      ],
      { stepMs: 1000, totalMs: 30, log },
    );
    await vi.advanceTimersByTimeAsync(30);
    expect(ran).toEqual([]);
    expect(await stopping).toEqual(["slow", "late"]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('skipped "late"'));
  });
});
