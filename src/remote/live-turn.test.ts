import { afterEach, describe, expect, it, vi } from "vitest";

import type { Activity } from "../fleet/activity.js";
import type { QueueItem } from "../fleet/session-reply.js";
import {
  condenseHistory,
  LIVE_QUEUE_TEXT_CHARS,
  LIVE_STEP_CHARS,
  LIVE_STEPS,
  liveHandle,
  LiveTurnPublisher,
  type LiveTurn,
} from "./live-turn.js";

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

describe("condenseHistory", () => {
  const m = (role: "user" | "assistant", text: string, i: number) => ({
    id: `m${i}`,
    role,
    text,
    at: null,
    turnId: null,
  });

  it("keeps every user message and only the last agent message of each run", () => {
    const history = condenseHistory([
      m("user", "Fix the splitter", 0),
      m("assistant", "Looking at it", 1),
      m("assistant", "Fixed: the splitter keeps tags balanced.", 2),
      m("user", "Add tests", 3),
      m("assistant", "Added three.", 4),
    ]);
    expect(history.map((h) => [h.role, h.text])).toEqual([
      ["user", "Fix the splitter"],
      ["assistant", "Fixed: the splitter keeps tags balanced."],
      ["user", "Add tests"],
      ["assistant", "Added three."],
    ]);
  });

  it("keeps the newest few and clips each", () => {
    const many = Array.from({ length: 20 }, (_, i) => m(i % 2 ? "assistant" : "user", `${i}`, i));
    expect(condenseHistory(many, 4).map((h) => h.text)).toEqual(["16", "17", "18", "19"]);
    expect(condenseHistory([m("user", "y".repeat(50), 0)], 8, 10)[0]!.text).toBe(`${"y".repeat(9)}…`);
  });
});

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

  describe("the chat's queue", () => {
    function withQueue(read: (key: string) => Promise<QueueItem[] | null>) {
      const docs = new Map<string, LiveTurn>();
      const write = vi.fn(async (handle: string, turn: LiveTurn) => {
        docs.set(handle, turn);
      });
      const activity: Activity = { total: 1, steps: [{ kind: "you", text: "use the fake clock", at: "t1" }] };
      const publisher = new LiveTurnPublisher({
        read: () => ({ activity, working: true }),
        write,
        clear: async () => undefined,
        queue: read,
      });
      return { publisher, docs, write };
    }

    it("is published with the turn, each text capped, and a change in it alone writes", async () => {
      vi.useFakeTimers();
      let queue: QueueItem[] = [{ id: "q1", text: "z".repeat(3_000), mode: "queue", position: 0 }];
      const t = withQueue(async () => queue);
      t.publisher.watch("s1");
      await vi.advanceTimersByTimeAsync(0);
      const turn = t.docs.get(liveHandle("s1"))!;
      expect(turn.steps).toEqual([{ kind: "you", text: "use the fake clock", at: "t1" }]);
      expect(turn.queue).toHaveLength(1);
      expect(turn.queue![0]!.text.length).toBe(LIVE_QUEUE_TEXT_CHARS);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(t.write).toHaveBeenCalledTimes(1);
      queue = [];
      await vi.advanceTimersByTimeAsync(1_000);
      expect(t.write).toHaveBeenCalledTimes(2);
      expect(t.docs.get(liveHandle("s1"))!.queue).toEqual([]);
      t.publisher.stop();
    });

    it("is left out when it can't be read: an error, null, or a read that hangs", async () => {
      vi.useFakeTimers();
      for (const read of [
        async () => {
          throw new Error("relay down");
        },
        async () => null,
        () => new Promise<null>(() => undefined),
      ]) {
        const t = withQueue(read);
        t.publisher.watch("s1");
        await vi.advanceTimersByTimeAsync(2_100);
        const turn = t.docs.get(liveHandle("s1"));
        expect(turn).toBeDefined();
        expect(turn).not.toHaveProperty("queue");
        t.publisher.stop();
      }
    });
  });
});
