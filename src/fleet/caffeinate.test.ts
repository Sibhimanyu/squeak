import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

  it("holds the Mac awake on power for Squeak's whole life, and stop lets go", () => {
    const t = setup();
    t.caffeinator.holdOnPower();
    t.caffeinator.holdOnPower();
    expect(t.spawn).toHaveBeenCalledTimes(1);
    expect(t.spawn).toHaveBeenCalledWith("/usr/bin/caffeinate", ["-s", "-w", "777"]);
    t.caffeinator.update(t.snapshot("working"));
    t.caffeinator.update(t.snapshot());
    expect(t.children[0]!.kill).not.toHaveBeenCalled();
    t.caffeinator.stop();
    expect(t.children[0]!.kill).toHaveBeenCalled();
    expect(t.children[1]!.kill).toHaveBeenCalled();
  });

  it("the keep-awake switch holds caffeinate -i until turned off, and survives a restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-awake-"));
    const file = path.join(dir, "keep-awake.json");
    const t = setup();
    const caffeinator = new Caffeinator(t.spawn as never, 777, file);
    caffeinator.setKeepAwake(true);
    caffeinator.setKeepAwake(true);
    expect(t.spawn).toHaveBeenCalledTimes(1);
    expect(t.spawn).toHaveBeenCalledWith("/usr/bin/caffeinate", ["-i", "-w", "777"]);
    expect(caffeinator.keepAwake).toBe(true);
    // No working agent does not release it.
    caffeinator.update(t.snapshot());
    expect(t.children[0]!.kill).not.toHaveBeenCalled();

    const restarted = new Caffeinator(t.spawn as never, 778, file);
    restarted.restoreSwitch();
    expect(restarted.keepAwake).toBe(true);
    expect(t.spawn).toHaveBeenLastCalledWith("/usr/bin/caffeinate", ["-i", "-w", "778"]);

    caffeinator.setKeepAwake(false);
    expect(t.children[0]!.kill).toHaveBeenCalled();
    expect(caffeinator.keepAwake).toBe(false);
    const again = new Caffeinator(t.spawn as never, 779, file);
    again.restoreSwitch();
    expect(again.keepAwake).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });
});
