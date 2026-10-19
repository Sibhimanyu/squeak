import { afterEach, describe, expect, it, vi } from "vitest";

import type { Activity } from "../fleet/activity.js";
import { LIVE_STEP_CHARS, LIVE_STEPS, liveHandle, LiveTurnPublisher, type LiveTurn } from "./live-turn.js";

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  let activity: Activity | null = { total: 1, steps: [{ kind: "thinking", text: "Reading the splitter.", at: "t1" }] };
  const docs = new Map<string, LiveTurn>();
  const write = vi.fn(async (handle: string, turn: LiveTurn) => {
    docs.set(handle, turn);
  });
  const clear = vi.fn(async (handle: string) => {
    docs.delete(handle);
  });
  const publisher = new LiveTurnPublisher({
    read: (key) => (key === "gone" ? null : { activity, working: true }),
    write,
    clear,
  });
  return {
    publisher,
    docs,
    write,
    clear,
    setActivity: (next: Activity | null) => (activity = next),
  };
}

describe("liveHandle", () => {
  it("is a fixed-length id the rules accept, and does not spell out the session key", () => {
    const handle = liveHandle("claude-transcript:5f0c/abc");
    expect(handle).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(handle).not.toContain("claude");
    expect(liveHandle("claude-transcript:5f0c/abc")).toBe(handle);
  });
});

describe("LiveTurnPublisher", () => {
  it("writes the watched session's turn at once, then only when it changes", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.publisher.watch("s1");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.docs.get(liveHandle("s1"))).toMatchObject({ v: 1, key: "s1", working: true, total: 1 });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.write).toHaveBeenCalledTimes(1);

    t.setActivity({
      total: 2,
      steps: [
        { kind: "thinking", text: "Reading the splitter.", at: "t1" },
        { kind: "tool", text: "Run npm test", at: "t2" },
      ],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.write).toHaveBeenCalledTimes(2);
    expect(t.docs.get(liveHandle("s1"))!.steps).toHaveLength(2);
    t.publisher.stop();
  });

  it("deletes the document when nobody is watching, so thinking does not linger", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.publisher.watch("s1");
    await vi.advanceTimersByTimeAsync(0);
    t.publisher.watch(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.docs.size).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.write).toHaveBeenCalledTimes(1);
  });

  it("moving to another session clears the first", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.publisher.watch("s1");
    await vi.advanceTimersByTimeAsync(0);
    t.publisher.watch("s2");
    await vi.advanceTimersByTimeAsync(0);
    expect([...t.docs.keys()]).toEqual([liveHandle("s2")]);
    t.publisher.stop();
  });

  it("keeps the newest steps, each capped", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.setActivity({
      total: 80,
      steps: Array.from({ length: 80 }, (_, i) => ({ kind: "note", text: `${i} ${"x".repeat(5_000)}`, at: null })),
    });
    t.publisher.watch("s1");
    await vi.advanceTimersByTimeAsync(0);
    const turn = t.docs.get(liveHandle("s1"))!;
    expect(turn.total).toBe(80);
    expect(turn.steps).toHaveLength(LIVE_STEPS);
    expect(turn.steps[0]!.text.startsWith("30 ")).toBe(true);
    expect(turn.steps[0]!.text.length).toBe(LIVE_STEP_CHARS);
    t.publisher.stop();
  });

  it("a session that has gone is published as an empty, finished turn", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.publisher.watch("gone");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.docs.get(liveHandle("gone"))).toMatchObject({ working: false, total: 0, steps: [] });
    t.publisher.stop();
  });

  it("a write that loses the race with a new watch is cleaned up", async () => {
    vi.useFakeTimers();
    const t = setup();
    let release!: () => void;
    t.write.mockImplementationOnce(async (handle, turn) => {
      await new Promise<void>((resolve) => (release = resolve));
      t.docs.set(handle, turn);
    });
    t.publisher.watch("s1");
    await vi.advanceTimersByTimeAsync(0);
    t.publisher.watch(null);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.docs.size).toBe(0);
  });
});
