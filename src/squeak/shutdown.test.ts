import { describe, expect, it, vi } from "vitest";

import { runStopSteps } from "./shutdown.js";

describe("runStopSteps", () => {
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
    const log = { warn: vi.fn() };
    const ran: string[] = [];
    const failed = await runStopSteps(
      [
        { name: "hang", run: () => new Promise(() => undefined) },
        { name: "after", run: () => ran.push("after") },
      ],
      { stepMs: 20, log },
    );
    expect(ran).toEqual(["after"]);
    expect(failed).toEqual(["hang"]);
  });

  it("bounds the total: steps after the budget are skipped and logged", async () => {
    const log = { warn: vi.fn() };
    const ran: string[] = [];
    const failed = await runStopSteps(
      [
        { name: "slow", run: () => new Promise(() => undefined) },
        { name: "late", run: () => ran.push("late") },
      ],
      { stepMs: 1000, totalMs: 30, log },
    );
    expect(ran).toEqual([]);
    expect(failed).toEqual(["slow", "late"]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('skipped "late"'));
  });
});
