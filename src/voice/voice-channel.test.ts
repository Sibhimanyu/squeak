import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AttentionItem } from "../fleet/types.js";
import type { CallResult } from "./baresip-line.js";
import { item, QUESTION } from "./fixtures.js";
import { CallPolicy } from "./policy.js";
import { CallHistory } from "./call-history.js";
import { VoiceChannel } from "./voice-channel.js";

function setup(
  options: {
    result?: CallResult;
    pin?: string | null;
    keys?: () => boolean;
    text?: () => string | null;
    attention?: AttentionItem[];
    history?: Pick<CallHistory, "record">;
    send?: () => Promise<unknown>;
    paused?: () => boolean;
    results?: CallResult[];
    busyWaitMs?: number;
  } = {},
) {
  const waiting = item("asked_question");
  const notes: string[] = [];
  const sent: string[] = [];
  let pushed: ((items: AttentionItem[]) => void) | null = null;
  const dialogs: boolean[] = [];
  const traces: string[] = [];
  const sleeps: number[] = [];
  const text = options.text ?? (() => QUESTION);
  const channel = new VoiceChannel({
    monitor: {
      onPush: (listener) => {
        pushed = listener;
        return () => undefined;
      },
      snapshot: { attention: options.attention ?? [waiting] } as never,
      refresh: vi.fn().mockResolvedValue(undefined),
    },
    replier: {
      lastTurnText: () => text(),
      send: async (_target, message) => {
        if (options.send) return options.send() as never;
        sent.push(message);
        return { status: "started", via: "conductor", delivery: "sent" } as never;
      },
    },
    line: {
      call: async (_script, answerable) => {
        dialogs.push(answerable);
        return options.results?.shift() ?? options.result ?? { status: "answered", letter: "B" };
      },
    },
    canTakeKeys: options.keys ?? (options.pin === undefined ? true : options.pin !== null),
    policy: new CallPolicy({ minGapMs: 0, quiet: null }),
    graceMs: 10,
    ...(options.paused ? { paused: options.paused } : {}),
    ...(options.history ? { history: options.history } : {}),
    note: (message) => notes.push(message),
    trace: (_kind, text) => traces.push(text),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...(options.busyWaitMs !== undefined ? { busyWaitMs: options.busyWaitMs } : {}),
  });
  return { channel, waiting, notes, sent, dialogs, traces, sleeps, push: (items: AttentionItem[]) => pushed?.(items) };
}

describe("VoiceChannel.ring", () => {
  it("places no call while paused, and rings again once resumed", async () => {
    let paused = true;
    const { channel, waiting, dialogs } = setup({ paused: () => paused, result: { status: "unanswered" } });
    await channel.ring(waiting);
    expect(dialogs).toEqual([]);
    paused = false;
    await channel.ring(waiting);
    expect(dialogs).toEqual([true]);
  });

  it("re-reads whether keys can answer at each call, since an app can change the pin", async () => {
    let answerable = false;
    const { channel, waiting, dialogs } = setup({ keys: () => answerable, result: { status: "unanswered" } });
    await channel.ring(waiting);
    answerable = true;
    await channel.ring(waiting, "second-episode");
    expect(dialogs).toEqual([false, true]);
  });

  it("sends the pressed letter to the chat that was read out", async () => {
    const { channel, waiting, sent, notes } = setup();
    await channel.ring(waiting);
    expect(sent).toEqual(["B"]);
    expect(notes).toEqual(["Answered by phone: sent B to squeak · voice."]);
  });

  it("sends nothing when the chat moved on during the call", async () => {
    let calls = 0;
    const { channel, waiting, sent, notes } = setup({ text: () => (calls++ === 0 ? QUESTION : "a new question?") });
    await channel.ring(waiting);
    expect(sent).toEqual([]);
    expect(notes[0]).toContain("moved on since the call");
  });

  it("does not ring for something already answered", async () => {
    const { channel, waiting, dialogs } = setup({ attention: [] });
    await channel.ring(waiting);
    expect(dialogs).toEqual([]);
  });

  it("rings an episode only once", async () => {
    const { channel, waiting, dialogs } = setup({ result: { status: "unanswered" } });
    await channel.ring(waiting);
    await channel.ring(waiting);
    expect(dialogs).toHaveLength(1);
  });

  it("says why a call failed, once", async () => {
    const { channel, waiting, notes } = setup({ result: { status: "failed", reason: "PBX refused" } });
    await channel.ring(waiting);
    await channel.ring({ ...waiting, since: "2026-10-28T13:00:00.000Z" });
    expect(notes).toEqual(["Squeak could not call you: PBX refused"]);
  });

  it("takes no answer without a PIN: nothing is sent even if a key arrives", async () => {
    const { channel, waiting, sent } = setup({ pin: null, result: { status: "answered", letter: null } });
    await channel.ring(waiting);
    expect(sent).toEqual([]);
  });
});

describe("VoiceChannel.start", () => {
  it("rings after the grace for a push that is still waiting, and never for a finish", async () => {
    const { channel, waiting, dialogs, push } = setup({ result: { status: "unanswered" } });
    channel.start();
    push([item("finished_unreviewed"), waiting]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(dialogs).toHaveLength(1);
    channel.stop();
  });
});

describe("VoiceChannel call history", () => {
  function recorder() {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      history: { record: (c: never) => (calls.push(c), null) } as unknown as Pick<CallHistory, "record">,
    };
  }

  it("records an answered call whose letter was sent", async () => {
    const { calls, history } = recorder();
    const { channel, waiting } = setup({ history });
    await channel.ring(waiting);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: "agent",
      reason: "asked_question",
      label: "squeak · voice",
      outcome: "answered",
      letter: "B",
      sent: true,
    });
    expect(typeof calls[0]!.durationMs).toBe("number");
  });

  it("records an unanswered call and a failed one", async () => {
    const a = recorder();
    const one = setup({ history: a.history, result: { status: "unanswered" } });
    await one.channel.ring(one.waiting);
    expect(a.calls[0]).toMatchObject({ outcome: "unanswered" });
    expect(a.calls[0]).not.toHaveProperty("letter");
    const b = recorder();
    const two = setup({ history: b.history, result: { status: "failed", reason: "no route" } });
    await two.channel.ring(two.waiting);
    expect(b.calls[0]).toMatchObject({ outcome: "failed", failure: "no route" });
  });

  it("records moved_on and a refused send as not sent", async () => {
    let reads = 0;
    const a = recorder();
    const one = setup({ history: a.history, text: () => (reads++ === 0 ? QUESTION : "something else?") });
    await one.channel.ring(one.waiting);
    expect(a.calls[0]).toMatchObject({ outcome: "moved_on", letter: "B", sent: false });
    const b = recorder();
    const two = setup({ history: b.history, send: async () => ({ status: "refused", reason: "busy" }) });
    await two.channel.ring(two.waiting);
    expect(b.calls[0]).toMatchObject({ outcome: "answered", letter: "B", sent: false });
  });

  it("never stores the question, a PIN or a digit (canary)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "calls-canary-"));
    const f = path.join(dir, "voice-calls.json");
    try {
      const history = new CallHistory(f);
      const { channel, waiting } = setup({
        history,
        result: { status: "answered", letter: "B", pin: "424242" } as never,
      });
      await channel.ring(waiting);
      const raw = fs.readFileSync(f, "utf8");
      expect(raw).not.toContain("424242");
      expect(raw).not.toContain(QUESTION.slice(0, 30));
      expect(Object.keys(history.list()[0]!).sort()).toEqual(
        ["at", "durationMs", "id", "kind", "label", "letter", "outcome", "reason", "sent", "summary"].sort(),
      );
      expect(history.list()[0]!.letter).toBe("B");
      expect(history.list()).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("VoiceChannel when the line is busy (a call in, usually)", () => {
  const busy: CallResult = { status: "failed", reason: "The line is busy with another call." };

  it("waits, then rings once the line is free, and carries on as a normal call", async () => {
    const { channel, waiting, dialogs, traces, sleeps, sent, notes } = setup({
      results: [busy, busy, { status: "answered", letter: "B" }],
    });
    await channel.ring(waiting);
    expect(dialogs).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(traces).toContain("Line busy, will ring when the call ends");
    expect(traces.some((t) => t.startsWith("Line free after"))).toBe(true);
    expect(sent).toEqual(["B"]);
    expect(notes.join(" ")).not.toContain("could not call you");
  });

  it("gives up after the cap with a clear trace, and the question stays where it was", async () => {
    const { channel, waiting, dialogs, traces, notes } = setup({ result: busy, busyWaitMs: 30_000 });
    await channel.ring(waiting);
    expect(dialogs.length).toBe(4); // the first try, then one after each of three 10 s looks
    expect(traces.some((t) => t.startsWith("Line still busy after 30 s, gave up"))).toBe(true);
    expect(notes[0]).toContain("busy");
  });

  it("does not ring afterwards if the question was answered meanwhile", async () => {
    const attention: AttentionItem[] = [item("asked_question")];
    const t = setup({ result: busy, attention });
    // The question goes away during the wait.
    const original = t.sleeps.push.bind(t.sleeps);
    t.sleeps.push = (...args: number[]) => {
      attention.length = 0;
      return original(...args);
    };
    await t.channel.ring(t.waiting);
    expect(t.dialogs).toHaveLength(1);
    expect(t.traces.some((x) => x.startsWith("No longer waiting"))).toBe(true);
  });
});
