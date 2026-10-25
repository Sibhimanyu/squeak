import { describe, expect, it, vi } from "vitest";

import type { FleetSnapshot } from "../fleet/fleet-monitor.js";
import type { AssistantAnswer } from "../fleet/assistant.js";
import type { AttentionItem, FleetSession } from "../fleet/types.js";
import { CliqChannel, turnStamp, type CliqInbound } from "./channel.js";
import type { NotifyFilter } from "../fleet/notify-settings.js";
import type { CliqButton } from "./client.js";
import type { CliqInboxRecord } from "./inbox.js";

const now = Date.parse("2026-09-20T12:00:00.000Z");
const OWNER = "60073992757";
const TURN = "Which one?\n\nA) Keep it\nB) Drop it\n\nRecommendation: A";

function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    key: "conductor:abc",
    source: "conductor",
    agent: "claude",
    origin: "conductor",
    sourceId: "abc",
    agentSessionId: "abc",
    conductorSessionId: "abc",
    cwd: null,
    repoName: "squeak",
    branch: "main",
    title: "Fix the parser",
    state: "idle",
    detail: "Done. Which one?",
    lastActivityAt: "2026-09-20T11:58:00.000Z",
    transcriptPath: null,
    pid: null,
    alive: true,
    stateSource: "conductor",
    contextPercent: null,
    retired: false,
    baseRef: null,
    costUsd: null,
    git: null,
    ...overrides,
  };
}

function finished(overrides: Partial<FleetSession> = {}): AttentionItem {
  return { session: session(overrides), kind: "finished_unreviewed", score: 500, since: "2026-09-20T11:58:00.000Z" };
}

function record(overrides: Partial<CliqInboxRecord> = {}): CliqInboxRecord {
  return {
    id: "r1",
    kind: "message",
    arg: "",
    msgid: null,
    body: "",
    userId: OWNER,
    sentAt: now - 1_000,
    ...overrides,
  };
}

function setup(
  options: {
    turn?: string | null;
    inbound?: boolean;
    ask?: (question: string) => Promise<AssistantAnswer>;
    notify?: NotifyFilter;
  } = {},
) {
  let push: ((items: AttentionItem[]) => void) | null = null;
  let quota: (() => void) | null = null;
  const cards = new Map<string, { target: string; label: string; turn: string }>();
  const pending = new Map<string, string>();
  let postCount = 0;
  const webhook = {
    post: vi.fn<(text: string, options?: { buttons?: CliqButton[] }) => Promise<string | null>>(
      async () => `m${++postCount}`,
    ),
  };
  const monitor = {
    onPush: vi.fn((listener: (items: AttentionItem[]) => void) => {
      push = listener;
      return () => (push = null);
    }),
    onQuotaAlert: vi.fn((listener: () => void) => {
      quota = listener;
      return () => undefined;
    }),
    refresh: vi.fn(
      async () =>
        ({
          generatedAt: new Date(now).toISOString(),
          sessions: [],
          active: [],
          attention: [],
        }) as unknown as FleetSnapshot,
    ),
  };
  const store = {
    setCliqCard: vi.fn((id: string, card: { target: string; label: string; turn: string }) => cards.set(id, card)),
    getCliqCard: vi.fn((id: string) => cards.get(id) ?? null),
    setCliqPending: vi.fn((id: string, text: string) => pending.set(id, text)),
    takeCliqPending: vi.fn((id: string) => {
      const text = pending.get(id) ?? null;
      pending.delete(id);
      return text;
    }),
    setMute: vi.fn(),
    clearMute: vi.fn(),
  };
  const records: CliqInboxRecord[] = [];
  const inbox = {
    list: vi.fn(async () => records.splice(0)),
    delete: vi.fn(async () => undefined),
  };
  let turn = options.turn === undefined ? TURN : options.turn;
  const replier = {
    lastTurnText: vi.fn(() => turn),
    send: vi.fn(async () => ({ status: "started" as const, via: "conductor" as const })),
  };
  const inbound: CliqInbound = {
    inbox,
    replier,
    ownerId: OWNER,
    ownerEmail: "owner@example.com",
    hookStatus: () => "**Hooks: installed**",
    ask: options.ask ?? null,
    sessions: () => [session()],
  };
  const channel = new CliqChannel({
    webhook,
    monitor,
    store,
    inbound: options.inbound === false ? null : inbound,
    notify: options.notify ?? null,
    now: () => now,
  });
  channel.listen();
  return {
    channel,
    webhook,
    store,
    inbox,
    replier,
    records,
    cards,
    monitor,
    quota: async () => {
      quota?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    setTurn: (next: string | null) => (turn = next),
    push: async (items: AttentionItem[]) => {
      push?.(items);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

function lastPost(webhook: { post: ReturnType<typeof vi.fn> }): string {
  return String(webhook.post.mock.calls.at(-1)?.[0] ?? "");
}

describe("CliqChannel cards", () => {
  it("puts letters, Reply and Full message on a finished card and remembers its turn", async () => {
    const t = setup();
    await t.push([finished()]);

    const [text, options] = t.webhook.post.mock.calls[0]!;
    expect(text).toContain("squeak · main");
    expect(options!.buttons!.map((b) => b.key)).toEqual(["pick:A", "pick:B", "reply", "full"]);
    expect(options!.buttons![0]!.label).toBe("A ★");
    expect(t.cards.get("m1")).toEqual({ target: "abc", label: "squeak · main", turn: turnStamp(TURN) });
  });

  it("sends no buttons when one-way, or when the turn cannot be read", async () => {
    const oneWay = setup({ inbound: false });
    await oneWay.push([finished()]);
    expect(oneWay.webhook.post.mock.calls[0]![1]).toEqual({ buttons: [] });

    const unknown = setup({ turn: null });
    await unknown.push([finished()]);
    expect(unknown.webhook.post.mock.calls[0]![1]).toEqual({ buttons: [] });
    expect(unknown.cards.size).toBe(0);
  });

  it("gives a blocked Conductor chat no buttons: Conductor's own process holds it", async () => {
    const t = setup();
    await t.push([{ ...finished({ state: "awaiting_approval" }), kind: "blocked_approval" }]);
    expect(t.webhook.post.mock.calls[0]![1]).toEqual({ buttons: [] });
  });
});

describe("CliqChannel inbox", () => {
  it("sends the tapped letter to the card's chat", async () => {
    const t = setup();
    await t.push([finished()]);
    t.records.push(record({ kind: "button", arg: "pick:B", msgid: "m1" }));
    await t.channel.pollOnce();

    expect(t.replier.send).toHaveBeenCalledWith("abc", "B", expect.any(Function));
    expect(lastPost(t.webhook)).toContain("Sent **B** to **squeak · main** in Conductor");
  });

  it("sends a reply form's text and a swipe-reply's text", async () => {
    const t = setup();
    await t.push([finished()]);
    t.records.push(record({ id: "r1", kind: "reply", body: "Keep it, and add a test", msgid: "m1" }));
    t.records.push(record({ id: "r2", kind: "message", body: "also rename it", msgid: "m1" }));
    await t.channel.pollOnce();

    expect(t.replier.send.mock.calls.map((call) => (call as unknown[])[1])).toEqual([
      "Keep it, and add a test",
      "also rename it",
    ]);
  });

  it("refuses a tap on a card whose chat has moved on to a new turn", async () => {
    const t = setup();
    await t.push([finished()]);
    t.setTurn("A different question now.\n\nA) Yes\nB) No");
    t.records.push(record({ kind: "button", arg: "pick:A", msgid: "m1" }));
    await t.channel.pollOnce();

    expect(t.replier.send).not.toHaveBeenCalled();
    expect(lastPost(t.webhook)).toContain("has moved on since that card");
  });

  it("ignores a record written for anyone but the owner", async () => {
    const t = setup();
    await t.push([finished()]);
    t.records.push(record({ kind: "button", arg: "pick:A", msgid: "m1", userId: "someone-else" }));
    await t.channel.pollOnce();

    expect(t.replier.send).not.toHaveBeenCalled();
  });

  it("does not act on a record older than ten minutes, or with no time at all", async () => {
    const t = setup();
    await t.push([finished()]);
    t.records.push(record({ id: "old", kind: "button", arg: "pick:A", msgid: "m1", sentAt: now - 11 * 60_000 }));
    t.records.push(record({ id: "none", kind: "button", arg: "pick:A", msgid: "m1", sentAt: null }));
    await t.channel.pollOnce();

    expect(t.replier.send).not.toHaveBeenCalled();
    expect(lastPost(t.webhook)).toContain("did not act on it");
  });

  it("deletes a record before acting on it, and skips one it could not delete", async () => {
    const t = setup();
    await t.push([finished()]);
    t.inbox.delete.mockRejectedValueOnce(new Error("Cliq returned 500"));
    t.records.push(record({ id: "r1", kind: "button", arg: "pick:A", msgid: "m1" }));
    await t.channel.pollOnce();
    expect(t.replier.send).not.toHaveBeenCalled();

    t.records.push(record({ id: "r1", kind: "button", arg: "pick:A", msgid: "m1" }));
    await t.channel.pollOnce();
    expect(t.inbox.delete).toHaveBeenLastCalledWith("r1");
    expect(t.replier.send).toHaveBeenCalledOnce();
  });

  it("says why when the replier refuses", async () => {
    const t = setup();
    await t.push([finished()]);
    t.replier.send.mockResolvedValueOnce({ status: "refused", reason: "That chat is working." } as never);
    t.records.push(record({ kind: "reply", body: "go", msgid: "m1" }));
    await t.channel.pollOnce();

    expect(lastPost(t.webhook)).toBe("That chat is working.");
  });

  it("answers loose text with commands, never by guessing a chat", async () => {
    const t = setup();
    t.records.push(record({ id: "a", body: "radar" }));
    t.records.push(record({ id: "b", body: "/snooze" }));
    t.records.push(record({ id: "c", body: "unmute" }));
    t.records.push(record({ id: "u", body: "usage" }));
    t.records.push(record({ id: "d", body: "please keep it" }));
    await t.channel.pollOnce();

    expect(t.monitor.refresh).toHaveBeenCalled();
    expect(t.store.setMute).toHaveBeenCalledWith("*", new Date(now + 60 * 60_000).toISOString());
    expect(t.store.clearMute).toHaveBeenCalledWith("*");
    expect(t.webhook.post.mock.calls.some(([text]) => text.startsWith("**Usage**"))).toBe(true);
    expect(t.replier.send).not.toHaveBeenCalled();
    expect(lastPost(t.webhook)).toContain("reply to its card or tap Reply");
  });

  it("refuses a reply to a message that is not one of its cards", async () => {
    const t = setup();
    t.records.push(record({ body: "keep it", msgid: "not-a-card" }));
    await t.channel.pollOnce();

    expect(t.replier.send).not.toHaveBeenCalled();
    expect(lastPost(t.webhook)).toContain("not one I can answer through");
  });

  it("shows the full message as a new card bound to the same turn", async () => {
    const t = setup();
    await t.push([finished()]);
    t.records.push(record({ kind: "button", arg: "full", msgid: "m1" }));
    await t.channel.pollOnce();

    expect(lastPost(t.webhook)).toContain("Recommendation: A");
    expect(t.cards.get("m2")?.turn).toBe(turnStamp(TURN));
  });
});

describe("CliqChannel conversation", () => {
  it("answers a question in plain words", async () => {
    const ask = vi.fn(async () => ({ reply: "One chat is done: squeak · main.", action: { type: "none" as const } }));
    const t = setup({ ask });
    t.records.push(record({ body: "anything need me?" }));
    await t.channel.pollOnce();

    expect(ask).toHaveBeenCalledWith("anything need me?");
    expect(lastPost(t.webhook)).toBe("One chat is done: squeak · main.");
  });

  it("mutes when asked to", async () => {
    const t = setup({ ask: async () => ({ reply: "Muted for two hours.", action: { type: "mute", minutes: 120 } }) });
    t.records.push(record({ body: "quiet for 2h please" }));
    await t.channel.pollOnce();

    expect(t.store.setMute).toHaveBeenCalledWith("*", new Date(now + 120 * 60_000).toISOString());
  });

  it("turns an instruction into a Send card, and types nothing until Send", async () => {
    const t = setup({
      ask: async () => ({
        reply: "I'll tell it to go with B.",
        action: { type: "send", sessionKey: "conductor:abc", text: "Go with B." },
      }),
    });
    t.records.push(record({ id: "q", body: "tell the squeak chat to go with B" }));
    await t.channel.pollOnce();

    expect(t.replier.send).not.toHaveBeenCalled();
    const [text, options] = t.webhook.post.mock.calls.at(-1)!;
    expect(text).toContain("Send to **squeak · main**:\n> Go with B.");
    expect(options!.buttons!.map((b) => b.key)).toEqual(["confirm", "cancel"]);

    t.records.push(record({ id: "c", kind: "button", arg: "confirm", msgid: "m1" }));
    await t.channel.pollOnce();
    expect(t.replier.send).toHaveBeenCalledWith("abc", "Go with B.", expect.any(Function));

    // A second tap on the same Send finds nothing left to send.
    t.records.push(record({ id: "c2", kind: "button", arg: "confirm", msgid: "m1" }));
    await t.channel.pollOnce();
    expect(t.replier.send).toHaveBeenCalledOnce();
    expect(lastPost(t.webhook)).toContain("already sent or cancelled");
  });

  it("sends nothing after Cancel", async () => {
    const t = setup({
      ask: async () => ({ reply: "Sending.", action: { type: "send", sessionKey: "conductor:abc", text: "Go." } }),
    });
    t.records.push(record({ id: "q", body: "tell it go" }));
    await t.channel.pollOnce();
    t.records.push(record({ id: "x", kind: "button", arg: "cancel", msgid: "m1" }));
    t.records.push(record({ id: "c", kind: "button", arg: "confirm", msgid: "m1" }));
    await t.channel.pollOnce();

    expect(t.replier.send).not.toHaveBeenCalled();
  });

  it("refuses a Send once the chat has moved on", async () => {
    const t = setup({
      ask: async () => ({ reply: "Sending.", action: { type: "send", sessionKey: "conductor:abc", text: "Go." } }),
    });
    t.records.push(record({ id: "q", body: "tell it go" }));
    await t.channel.pollOnce();
    t.setTurn("Something newer.");
    t.records.push(record({ id: "c", kind: "button", arg: "confirm", msgid: "m1" }));
    await t.channel.pollOnce();

    expect(t.replier.send).not.toHaveBeenCalled();
    expect(lastPost(t.webhook)).toContain("has moved on");
  });

  it("says so when the assistant fails", async () => {
    const t = setup({
      ask: async () => {
        throw new Error("the assistant took too long");
      },
    });
    t.records.push(record({ body: "what's up" }));
    await t.channel.pollOnce();

    expect(lastPost(t.webhook)).toContain("the assistant took too long");
  });
});

describe("CliqChannel with a streamed inbox", () => {
  it("runs a pass as soon as a record lands, not on the next poll", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      let wake: (() => void) | null = null;
      const inbox = t.inbox as typeof t.inbox & { watch: (onChange: () => void) => () => void };
      inbox.watch = (onChange) => {
        wake = onChange;
        return () => (wake = null);
      };
      t.channel.start();
      await vi.advanceTimersByTimeAsync(0);
      const passes = t.inbox.list.mock.calls.length;
      wake!();
      await vi.advanceTimersByTimeAsync(100);
      expect(t.inbox.list.mock.calls.length).toBe(passes + 1);
      // Streamed, the safety poll is a minute, not five seconds.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(t.inbox.list.mock.calls.length).toBe(passes + 1);
      t.channel.stop();
      expect(wake).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CliqChannel notification settings", () => {
  it("holds back a card and a quota alert the settings refuse", async () => {
    const t = setup({ notify: { item: (item) => item.kind === "blocked_approval", quota: () => false } });
    await t.push([finished()]);
    expect(t.webhook.post).not.toHaveBeenCalled();
    await t.push([{ ...finished(), kind: "blocked_approval" }]);
    expect(t.webhook.post).toHaveBeenCalledTimes(1);
    await t.quota();
    expect(t.webhook.post).toHaveBeenCalledTimes(1);
  });
});
