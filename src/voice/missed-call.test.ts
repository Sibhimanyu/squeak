import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultNotifySettings, type NotifyChannel, type NotifySettings } from "../fleet/notify-settings.js";
import type { AttentionItem } from "../fleet/types.js";
import type { CallResult } from "./baresip-line.js";
import { item, QUESTION } from "./fixtures.js";
import { LINE_BUSY_REASON } from "./phone.js";
import { CallPolicy } from "./policy.js";
import { VoiceChannel } from "./voice-channel.js";

const NOON = new Date("2026-10-28T12:00:00").getTime();

function setup(options: {
  results: CallResult[];
  settings?: NotifySettings;
  attention?: () => AttentionItem[];
  quiet?: boolean;
}) {
  const waiting = item("asked_question");
  const settings = options.settings ?? defaultNotifySettings();
  const pushes: Array<[NotifyChannel, string]> = [];
  const calls: number[] = [];
  let pushed: ((items: AttentionItem[]) => void) | null = null;
  const channel = new VoiceChannel({
    monitor: {
      onPush: (listener) => {
        pushed = listener;
        return () => undefined;
      },
      get snapshot() {
        return { attention: options.attention ? options.attention() : [waiting] } as never;
      },
      refresh: vi.fn().mockResolvedValue(undefined),
    },
    replier: { lastTurnText: () => QUESTION, send: async () => ({ status: "started" }) as never },
    line: {
      call: async () => {
        calls.push(Date.now());
        return options.results.shift() ?? { status: "unanswered" };
      },
    },
    canTakeKeys: true,
    policy: new CallPolicy({
      minGapMs: 5 * 60_000,
      quiet: options.quiet ? { from: "12:01", to: "13:00" } : null,
    }),
    graceMs: 10,
    note: () => undefined,
    sleep: async () => undefined,
    busyWaitMs: 0,
    notify: { settings: () => settings, push: (c, t) => pushes.push([c, t]) },
  });
  return { channel, waiting, pushes, calls, push: (items: AttentionItem[]) => pushed?.(items) };
}

describe("a missed call", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOON });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is retried once after two minutes, then given up quietly", async () => {
    const { channel, waiting, calls } = setup({ results: [{ status: "unanswered" }, { status: "unanswered" }] });
    await channel.ring(waiting);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(calls).toHaveLength(2);
  });

  it("is retried after a failure, but not when the line was busy", async () => {
    const failing = setup({
      results: [
        { status: "failed", reason: "no answer from the PBX" },
        { status: "answered", letter: null },
      ],
    });
    await failing.channel.ring(failing.waiting);
    await vi.advanceTimersByTimeAsync(121_000);
    expect(failing.calls).toHaveLength(2);

    const busy = setup({ results: [{ status: "failed", reason: LINE_BUSY_REASON }] });
    await busy.channel.ring(busy.waiting);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(busy.calls).toHaveLength(1);
    expect(busy.pushes).toEqual([]);
  });

  it("is not retried once the question was answered or moved on", async () => {
    let attention: AttentionItem[] | null = null;
    const { channel, waiting, calls } = setup({
      results: [{ status: "unanswered" }, { status: "unanswered" }],
      attention: () => attention ?? [waiting],
    });
    await channel.ring(waiting);
    attention = [];
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toHaveLength(1);
  });

  it("is not retried into quiet hours", async () => {
    const quiet = setup({ results: [{ status: "unanswered" }, { status: "unanswered" }], quiet: true });
    await quiet.channel.ring(quiet.waiting);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(quiet.calls).toHaveLength(1); // the first call only: the retry lands in quiet hours
  });

  it("is not retried when the person paused calls, and a stopped channel retries nothing", async () => {
    const { channel, waiting, calls } = setup({ results: [{ status: "unanswered" }, { status: "unanswered" }] });
    await channel.ring(waiting);
    channel.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toHaveLength(1);
  });

  it("pushes the question to a channel that allows it and has not had it, once", async () => {
    const { channel, waiting, pushes } = setup({ results: [{ status: "unanswered" }, { status: "unanswered" }] });
    await channel.ring(waiting);
    expect(pushes.map(([c]) => c).sort()).toEqual(["cliq", "telegram"]);
    expect(pushes[0]![1]).toContain("still waiting for you");
    expect(pushes[0]![1]).toContain("Which one?");
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(pushes).toHaveLength(2); // the retry's miss sends nothing more
  });

  it("never duplicates a card the monitor already pushed", async () => {
    const { channel, waiting, pushes, push } = setup({ results: [{ status: "unanswered" }] });
    channel.start();
    push([waiting]);
    channel.stop();
    await channel.ring(waiting);
    expect(pushes).toEqual([]);
  });

  it("makes up only for the channel that did not get it, and respects muted and the question setting", async () => {
    const settings = defaultNotifySettings();
    settings.telegram.muted = true;
    settings.cliq.question = false;
    const { channel, waiting, pushes } = setup({ results: [{ status: "unanswered" }], settings });
    await channel.ring(waiting);
    expect(pushes).toEqual([]);

    const open = defaultNotifySettings();
    open.cliq.question = false;
    const second = setup({ results: [{ status: "unanswered" }], settings: open });
    await second.channel.ring(second.waiting);
    expect(second.pushes.map(([c]) => c)).toEqual(["telegram"]);
  });

  it("holds the question text in a channel's quiet hours", async () => {
    const settings = defaultNotifySettings();
    settings.telegram.quiet = { from: "11:00", to: "13:00" };
    settings.cliq.muted = true;
    const { channel, waiting, pushes } = setup({ results: [{ status: "unanswered" }], settings });
    await channel.ring(waiting);
    expect(pushes).toEqual([]);
  });
});
