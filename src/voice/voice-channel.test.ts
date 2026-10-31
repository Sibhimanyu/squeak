import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AttentionItem } from "../fleet/types.js";
import type { CallResult } from "./baresip-line.js";
import { item, QUESTION } from "./fixtures.js";
import { CallPolicy } from "./policy.js";
import { CallHistory } from "./call-history.js";
import { CallbackRequests } from "./callbacks.js";
import type { CallScript } from "./dialog.js";
import { session } from "./fixtures.js";
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

describe("VoiceChannel call backs", () => {
  function callbackSetup(
    options: {
      state?: "working" | "finished" | "error" | "idle";
      attention?: AttentionItem[];
      result?: CallResult;
      paused?: () => boolean;
      voice?: boolean;
      gap?: number;
      now?: () => number;
    } = {},
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-voice-callbacks-"));
    const now = options.now ?? (() => 1_000_000);
    const callbacks = new CallbackRequests(path.join(dir, "cb.json"), now);
    const chat = { current: session({ state: options.state ?? "working", title: "Fix the parser" }) };
    const snapshot = { sessions: [chat.current], attention: options.attention ?? [] };
    const notes: string[] = [];
    const scripts: Array<{ script: CallScript; answerable: boolean; follow: unknown }> = [];
    const written: Array<{ reason?: string; outcome: string }> = [];
    let changed: (() => void) | null = null;
    const channel = new VoiceChannel({
      monitor: {
        onPush: () => () => undefined,
        onSnapshot: (listener: (snapshot: never) => void) => {
          changed = () => listener(snapshot as never);
          return () => undefined;
        },
        snapshot: snapshot as never,
        refresh: vi.fn().mockResolvedValue(undefined),
      },
      replier: { lastTurnText: () => "I fixed the parser. All tests pass.", send: async () => ({}) as never },
      line: {
        call: async (script, answerable, follow) => {
          scripts.push({ script, answerable, follow });
          return options.result ?? { status: "answered", letter: undefined as never };
        },
      },
      canTakeKeys: true,
      policy: new CallPolicy({ minGapMs: options.gap ?? 0, quiet: null }),
      callbacks,
      callbackVoice: () => options.voice ?? true,
      ...(options.paused ? { paused: options.paused } : {}),
      history: { record: (call) => (written.push(call), null) },
      note: (text) => notes.push(text),
      now,
      sleep: async () => undefined,
    });
    const settle = (state: "working" | "finished" | "error" | "idle"): void => {
      chat.current.state = state;
      snapshot.sessions = [chat.current];
      changed?.();
    };
    return { channel, callbacks, chat, snapshot, notes, scripts, written, settle };
  }
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

  it("rings once when the chat stops after working, then forgets the request", async () => {
    const t = callbackSetup();
    const target = "c1";
    t.callbacks.add(target, "squeak", "the parser", true);
    t.channel.start();
    await flush();
    expect(t.scripts).toEqual([]);
    t.settle("finished");
    await flush();
    expect(t.scripts).toHaveLength(1);
    expect(t.scripts[0]!.script.greeting).toContain("Fix the parser is done, as you asked.");
    expect(t.scripts[0]!.script).toMatchObject({ voice: true, options: [] });
    expect(t.scripts[0]!.follow).toMatchObject({ target, script: { options: [] } });
    expect(t.callbacks.list()).toEqual([]);
    expect(t.written).toMatchObject([{ reason: "callback", outcome: "answered" }]);
    t.settle("finished");
    await flush();
    expect(t.scripts).toHaveLength(1);
    t.channel.stop();
  });

  it("does not ring while the chat is still working", async () => {
    const t = callbackSetup();
    t.callbacks.add("c1", "squeak", "", true);
    t.channel.start();
    t.settle("working");
    await flush();
    expect(t.scripts).toEqual([]);
    expect(t.callbacks.list()).toHaveLength(1);
    t.channel.stop();
  });

  it("marks a chat that started working after a send, then rings when it stops", async () => {
    const t = callbackSetup({ state: "finished" });
    t.callbacks.add("c1", "squeak", "", false);
    t.channel.start();
    await flush();
    expect(t.scripts).toEqual([]);
    t.settle("working");
    await flush();
    t.settle("finished");
    await flush();
    expect(t.scripts).toHaveLength(1);
    t.channel.stop();
  });

  it("leaves it to the ordinary call when the chat stopped to ask a question", async () => {
    const asking = item("asked_question", { title: "Fix the parser" });
    const t = callbackSetup({ attention: [{ ...asking, session: { ...asking.session, key: "conductor:1" } }] });
    t.callbacks.add("c1", "squeak", "", true);
    t.channel.start();
    t.settle("finished");
    await flush();
    expect(t.scripts).toEqual([]);
    expect(t.callbacks.list()).toEqual([]);
    t.channel.stop();
  });

  it("holds the call while paused or in a gap after another call, and keeps the request", async () => {
    let paused = true;
    const t = callbackSetup({ paused: () => paused });
    const request = t.callbacks.add("c1", "squeak", "", true)!;
    await t.channel.ringCallback(request, t.chat.current);
    expect(t.scripts).toEqual([]);
    expect(t.callbacks.list()).toHaveLength(1);
    paused = false;
    await t.channel.ringCallback(request, t.chat.current);
    expect(t.scripts).toHaveLength(1);
  });

  it("tells the person in a text when nobody picks up, and does not ring twice", async () => {
    const t = callbackSetup({ result: { status: "unanswered" } });
    const request = t.callbacks.add("c1", "squeak", "", true)!;
    await t.channel.ringCallback(request, t.chat.current);
    expect(t.notes[0]).toContain("nobody picked up");
    expect(t.notes[0]).toContain("I fixed the parser. All tests pass.");
    expect(t.written).toMatchObject([{ reason: "callback", outcome: "unanswered" }]);
    expect(t.callbacks.list()).toEqual([]);
  });

  it("says in a text why a call back could not be placed", async () => {
    const t = callbackSetup({ result: { status: "failed", reason: "The gateway did not answer." } });
    const request = t.callbacks.add("c1", "squeak", "", true)!;
    await t.channel.ringCallback(request, t.chat.current);
    expect(t.notes[0]).toContain("could not call you back");
    expect(t.notes[0]).toContain("The gateway did not answer.");
  });

  it("only tells (no talking) when the add-on cannot talk a call back through", async () => {
    const t = callbackSetup({ voice: false });
    const request = t.callbacks.add("c1", "squeak", "", true)!;
    await t.channel.ringCallback(request, t.chat.current);
    expect(t.scripts[0]!.script.voice).toBeUndefined();
    expect(t.scripts[0]!.follow).toBeUndefined();
  });

  it("drops a request whose chat is gone", async () => {
    const t = callbackSetup();
    t.callbacks.add("gone", "other", "", true);
    t.channel.start();
    await flush();
    expect(t.callbacks.list()).toEqual([]);
    t.channel.stop();
  });
});
