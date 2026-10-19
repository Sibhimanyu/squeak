import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CAFFEINATE_GRACE_MS, Caffeinator } from "./caffeinate.js";

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const children: Array<EventEmitter & { kill: ReturnType<typeof vi.fn>; pid: number }> = [];
  const spawn = vi.fn<(command: string, args: string[]) => EventEmitter>(() => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(), pid: 4242 });
    children.push(child);
    return child;
  });
  // A fake child: only `on`, `kill` and `pid` are used.
  const caffeinator = new Caffeinator(spawn as never, 777);
  const snapshot = (...states: string[]) => ({ active: states.map((state) => ({ state })) }) as never;
  return { caffeinator, spawn, children, snapshot };
}

describe("Caffeinator", () => {
  it("holds the Mac awake while an agent works, tied to Squeak's own process", () => {
    const t = setup();
    t.caffeinator.update(t.snapshot("working", "finished"));
    expect(t.spawn).toHaveBeenCalledWith("/usr/bin/caffeinate", ["-i", "-w", "777"]);
    expect(t.caffeinator.active).toBe(true);
    t.caffeinator.update(t.snapshot("working"));
    expect(t.spawn).toHaveBeenCalledTimes(1);
  });

  it("does nothing for sessions that only wait on you", () => {
    const t = setup();
    t.caffeinator.update(t.snapshot("awaiting_input", "awaiting_approval", "finished", "idle"));
    expect(t.spawn).not.toHaveBeenCalled();
  });

  it("lets go only after the grace period, and a new turn inside it keeps the same hold", () => {
    vi.useFakeTimers();
    const t = setup();
    t.caffeinator.update(t.snapshot("working"));
    t.caffeinator.update(t.snapshot("finished"));
    vi.advanceTimersByTime(CAFFEINATE_GRACE_MS - 1_000);
    t.caffeinator.update(t.snapshot("working"));
    vi.advanceTimersByTime(CAFFEINATE_GRACE_MS * 2);
    expect(t.children[0]!.kill).not.toHaveBeenCalled();
    t.caffeinator.update(t.snapshot());
    vi.advanceTimersByTime(CAFFEINATE_GRACE_MS);
    expect(t.children[0]!.kill).toHaveBeenCalledTimes(1);
    expect(t.caffeinator.active).toBe(false);
    expect(t.spawn).toHaveBeenCalledTimes(1);
  });

  it("holds again if caffeinate exits on its own", () => {
    const t = setup();
    t.caffeinator.update(t.snapshot("working"));
    t.children[0]!.emit("exit", 0);
    expect(t.caffeinator.active).toBe(false);
    t.caffeinator.update(t.snapshot("working"));
    expect(t.spawn).toHaveBeenCalledTimes(2);
  });

  it("stop releases at once", () => {
    const t = setup();
    t.caffeinator.update(t.snapshot("working"));
    t.caffeinator.stop();
    expect(t.children[0]!.kill).toHaveBeenCalled();
  });
});
