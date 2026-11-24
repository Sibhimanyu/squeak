import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NativeHostError } from "../native/client.js";
import type { RoomMoments } from "../native/room-moments.js";
import { defaultNotifySettings, shouldPushRoomMomentTo, type NotifySettings } from "./notify-settings.js";
import {
  renderApprovalCard,
  renderAskCard,
  renderBlockedCard,
  RoomMomentNotifier,
  type RoomMomentPort,
  type RoomMomentSink,
} from "./room-moments.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-moments-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const quiet = (): RoomMoments => ({ pond: "Shop", latestSeq: 5, asks: [], blocked: [], approvals: [] });
const NOW = Date.now();

function setup(settings: NotifySettings = defaultNotifySettings(), now = NOW) {
  const state = { moments: quiet(), seenSince: [] as number[] };
  const act = vi.fn<RoomMomentPort["actTask"]>(async () => undefined);
  const port: RoomMomentPort = {
    listProjects: async () => [{ id: "p1", name: "Shop" }],
    roomMoments: async (_id, since) => {
      state.seenSince.push(since);
      // The host only reports posts after the cursor.
      return { ...state.moments, asks: state.moments.asks.filter((a) => a.seq > since) };
    },
    actTask: act,
  };
  const pushed: Array<{ channel: string; text: string; buttons: Array<{ label: string; handle: number }> }> = [];
  const sink = (channel: "telegram" | "cliq"): RoomMomentSink => ({
    channel,
    allowed: (kind) => shouldPushRoomMomentTo(channel, kind, settings, now),
    push: async (card) => void pushed.push({ channel, ...card }),
  });
  const make = () =>
    new RoomMomentNotifier({
      port,
      sinks: [sink("telegram"), sink("cliq")],
      file: path.join(dir, "room-moments.json"),
      now: () => now,
    });
  return { state, act, pushed, make };
}

describe("room moment cards", () => {
  it("are short and plain: Pond, who, one line", () => {
    expect(renderAskCard("Shop", { duck: "Maple", text: "Which database?" })).toBe(
      "**Shop** · Maple asks\nWhich database?",
    );
    expect(renderAskCard("Shop", { duck: "Maple", to: "Aarav", text: "Check the copy?" })).toBe(
      "**Shop** · Maple asks Aarav\nCheck the copy?",
    );
    expect(renderBlockedCard("Shop", { title: "Fix header", duck: "Maple" })).toBe(
      "**Shop** · Task blocked\nMaple: Fix header",
    );
    expect(renderApprovalCard("Shop", { title: "Add dark mode", by: "Aarav" })).toBe(
      "**Shop** · Aarav's task needs your OK\nAdd dark mode",
    );
  });
});

describe("the three moments", () => {
  it("a Duck asking a person goes to both channels, once", async () => {
    const t = setup();
    const n = t.make();
    await n.pollOnce();
    t.state.moments = { ...quiet(), latestSeq: 6, asks: [{ seq: 6, id: "x", duck: "Maple", text: "Which database?" }] };
    await n.pollOnce();
    await n.pollOnce();
    expect(t.pushed.map((p) => [p.channel, p.text])).toEqual([
      ["telegram", "**Shop** · Maple asks\nWhich database?"],
      ["cliq", "**Shop** · Maple asks\nWhich database?"],
    ]);
    // The cursor moved past the post it showed, and the first look never announces history.
    expect(t.state.seenSince).toEqual([Number.MAX_SAFE_INTEGER, 5, 6]);
  });

  it("a blocked Task is announced once, again if it blocks again, never when it was old news", async () => {
    const t = setup();
    const n = t.make();
    t.state.moments = {
      ...quiet(),
      blocked: [
        { id: "t1", title: "Ship it", duck: "Maple", updatedAt: NOW - 60_000 },
        { id: "old", title: "Ancient", updatedAt: NOW - 3 * 3_600_000 },
      ],
    };
    await n.pollOnce();
    await n.pollOnce();
    expect(t.pushed.filter((p) => p.channel === "telegram").map((p) => p.text)).toEqual([
      "**Shop** · Task blocked\nMaple: Ship it",
    ]);
    // Unblocked, then blocked again.
    t.state.moments = quiet();
    await n.pollOnce();
    t.state.moments = { ...quiet(), blocked: [{ id: "t1", title: "Ship it", duck: "Maple", updatedAt: NOW }] };
    await n.pollOnce();
    expect(t.pushed.filter((p) => p.channel === "telegram")).toHaveLength(2);
  });

  it("a Member's Task waiting for approval carries Approve and Drop wired to the Task actions", async () => {
    const t = setup();
    const n = t.make();
    t.state.moments = {
      ...quiet(),
      approvals: [{ id: "t9", title: "Add dark mode", by: "Aarav", updatedAt: NOW }],
    };
    await n.pollOnce();
    const card = t.pushed.find((p) => p.channel === "telegram")!;
    expect(card.text).toBe("**Shop** · Aarav's task needs your OK\nAdd dark mode");
    expect(card.buttons.map((b) => b.label)).toEqual(["Approve", "Drop"]);
    const handle = card.buttons[0]!.handle;
    expect(`fleet:room:a:${handle}`.length).toBeLessThan(64);

    expect(await n.decide(handle, true)).toBe("Approved: Add dark mode");
    expect(t.act).toHaveBeenLastCalledWith("p1", "t9", "approve");
    expect(await n.decide(handle, false)).toBe("Dropped: Add dark mode");
    expect(t.act).toHaveBeenLastCalledWith("p1", "t9", "drop");
  });

  it("a button for a Task that is no longer waiting says so, and an unknown handle too", async () => {
    const t = setup();
    const n = t.make();
    t.state.moments = { ...quiet(), approvals: [{ id: "t9", title: "Add", by: "A", updatedAt: NOW }] };
    await n.pollOnce();
    t.act.mockRejectedValueOnce(new NativeHostError("conflict", "http", 409));
    expect(await n.decide(1, true)).toBe("That task is no longer waiting.");
    expect(await n.decide(99, true)).toBe("That task is no longer waiting.");
    t.act.mockRejectedValueOnce(new NativeHostError("down", "down"));
    expect(await n.decide(1, true)).toMatch(/could not reach/);
  });

  it("ordinary Room traffic sends nothing", async () => {
    const t = setup();
    const n = t.make();
    await n.pollOnce();
    // The host reports no moment for working, done, plain messages and other Tasks' states.
    t.state.moments = { ...quiet(), latestSeq: 40 };
    await n.pollOnce();
    await n.pollOnce();
    expect(t.pushed).toEqual([]);
  });
});

describe("push rules", () => {
  const momentsAt = (at: number): RoomMoments => ({
    ...quiet(),
    asks: [{ seq: 6, id: "x", duck: "Maple", text: "Which?" }],
    blocked: [{ id: "b", title: "Ship", updatedAt: at }],
    approvals: [{ id: "a", title: "Add", by: "Aarav", updatedAt: at }],
  });
  const moments = momentsAt(NOW);
  const run = async (settings: NotifySettings, now = NOW): Promise<string[]> => {
    const t = setup(settings, now);
    const n = t.make();
    await n.pollOnce();
    t.state.moments = momentsAt(now);
    await n.pollOnce();
    return t.pushed.filter((p) => p.channel === "telegram").map((p) => p.text.split("\n")[0]!);
  };

  it("muted sends nothing, and each channel is judged on its own", async () => {
    const settings = defaultNotifySettings();
    settings.telegram.muted = true;
    const t = setup(settings);
    const n = t.make();
    await n.pollOnce();
    t.state.moments = moments;
    await n.pollOnce();
    expect(t.pushed.map((p) => p.channel)).toEqual(["cliq", "cliq", "cliq"]);
  });

  it("the question, stalled and approval switches gate ask, blocked and approval", async () => {
    const s = defaultNotifySettings();
    s.telegram.question = false;
    expect(await run(s)).toEqual(["**Shop** · Task blocked", "**Shop** · Aarav's task needs your OK"]);
    const s2 = defaultNotifySettings();
    s2.telegram.stalled = false;
    expect(await run(s2)).toEqual(["**Shop** · Maple asks", "**Shop** · Aarav's task needs your OK"]);
    const s3 = defaultNotifySettings();
    s3.telegram.approval = false;
    expect(await run(s3)).toEqual(["**Shop** · Maple asks", "**Shop** · Task blocked"]);
  });

  it("quiet hours hold an ask and a blocked Task but not an approval waiting on the Owner", async () => {
    const s = defaultNotifySettings();
    const now = new Date();
    now.setHours(23, 0, 0, 0);
    s.telegram.quiet = { from: "22:00", to: "07:00" };
    expect(await run(s, now.getTime())).toEqual(["**Shop** · Aarav's task needs your OK"]);
    now.setHours(12, 0, 0, 0);
    expect(await run(s, now.getTime())).toHaveLength(3);
  });
});
