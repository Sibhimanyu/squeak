import { describe, expect, it, vi } from "vitest";

import type { AttentionItem } from "../fleet/types.js";
import type { CallResult } from "./baresip-line.js";
import { item, QUESTION } from "./fixtures.js";
import { CallPolicy } from "./policy.js";
import { VoiceChannel } from "./voice-channel.js";

function setup(
  options: { result?: CallResult; pin?: string | null; text?: () => string | null; attention?: AttentionItem[] } = {},
) {
  const waiting = item("asked_question");
  const notes: string[] = [];
  const sent: string[] = [];
  let pushed: ((items: AttentionItem[]) => void) | null = null;
  const dialogs: boolean[] = [];
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
        sent.push(message);
        return { status: "started", via: "conductor", delivery: "sent" } as never;
      },
    },
    line: {
      call: async (_script, answerable) => {
        dialogs.push(answerable);
        return options.result ?? { status: "answered", letter: "B" };
      },
    },
    canTakeKeys: options.pin === undefined ? true : options.pin !== null,
    policy: new CallPolicy({ minGapMs: 0, quiet: null }),
    graceMs: 10,
    note: (message) => notes.push(message),
  });
  return { channel, waiting, notes, sent, dialogs, push: (items: AttentionItem[]) => pushed?.(items) };
}

describe("VoiceChannel.ring", () => {
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
