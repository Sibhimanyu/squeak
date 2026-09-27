import { describe, expect, it, vi } from "vitest";

import type { CodexUsage } from "../fleet/codex-usage.js";
import type { AttentionItem, FleetSession } from "../fleet/types.js";
import { CliqNotifier } from "./notifier.js";

const now = Date.parse("2026-09-20T12:00:00.000Z");

function item(overrides: Partial<FleetSession> = {}): AttentionItem {
  return {
    session: {
      key: "conductor:abc",
      source: "conductor",
      agent: "claude",
      origin: "conductor",
      sourceId: "abc",
      agentSessionId: "abc",
      conductorSessionId: "abc",
      cwd: "/Users/someone/repo",
      repoName: "squeak",
      branch: "main",
      title: "Fix the parser",
      state: "awaiting_approval",
      detail: null,
      lastActivityAt: "2026-09-20T11:58:00.000Z",
      transcriptPath: null,
      pid: null,
      alive: true,
      stateSource: "hook",
      contextPercent: null,
      retired: false,
      baseRef: null,
      costUsd: null,
      git: null,
      ...overrides,
    },
    kind: "blocked_approval",
    score: 1000,
    since: "2026-09-20T11:50:00.000Z",
  };
}

function fakeMonitor() {
  let push: ((items: AttentionItem[]) => void) | null = null;
  let quota: ((usage: CodexUsage, window: "primary" | "secondary") => void) | null = null;
  return {
    onPush: vi.fn((listener: typeof push) => {
      push = listener;
      return () => (push = null);
    }),
    onQuotaAlert: vi.fn((listener: typeof quota) => {
      quota = listener;
      return () => (quota = null);
    }),
    push: (items: AttentionItem[]) => push?.(items),
    quota: (usage: CodexUsage, window: "primary" | "secondary") => quota?.(usage, window),
    subscribed: () => push !== null,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("CliqNotifier", () => {
  it("posts one card per pushed item, rendered like the Telegram card", async () => {
    const monitor = fakeMonitor();
    const post = vi.fn().mockResolvedValue(undefined);
    new CliqNotifier({ webhook: { post }, monitor, now: () => now }).start();

    monitor.push([item(), item({ key: "conductor:def", branch: "other" })]);
    await flush();

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]![0]).toContain("**squeak · main**");
    expect(post.mock.calls[1]![0]).toContain("other");
  });

  it("keeps going when one card fails", async () => {
    const monitor = fakeMonitor();
    const post = vi.fn().mockRejectedValueOnce(new Error("Cliq returned 500")).mockResolvedValue(undefined);
    new CliqNotifier({ webhook: { post }, monitor, now: () => now }).start();

    monitor.push([item(), item({ key: "conductor:def" })]);
    await flush();

    expect(post).toHaveBeenCalledTimes(2);
  });

  it("forwards the Codex quota alert", async () => {
    const monitor = fakeMonitor();
    const post = vi.fn().mockResolvedValue(undefined);
    new CliqNotifier({ webhook: { post }, monitor, now: () => now }).start();

    monitor.quota(
      {
        planType: null,
        primary: { usedPercent: 91, windowMinutes: 300, resetsAt: "2026-09-20T13:00:00.000Z" },
        secondary: null,
        hasCredits: false,
        creditBalance: null,
        observedAt: "2026-09-20T12:00:00.000Z",
      },
      "primary",
    );
    await flush();

    expect(post.mock.calls[0]![0]).toContain("91% used");
  });

  it("unsubscribes on stop", () => {
    const monitor = fakeMonitor();
    const notifier = new CliqNotifier({ webhook: { post: vi.fn() }, monitor, now: () => now });
    notifier.start();
    notifier.stop();
    expect(monitor.subscribed()).toBe(false);
  });
});
