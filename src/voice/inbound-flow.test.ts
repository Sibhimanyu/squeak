import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { incomingGate, PinKeeper } from "./pin-keeper.js";
import { handleIncoming, inboundPrompts, readBackSentence, type InboundDependencies } from "./inbound-flow.js";
import type { DirectoryDoc, DownMessage } from "./memo-protocol.js";
import type { IncomingCall, PhoneCall } from "./phone.js";

class FakeCall implements PhoneCall {
  open = true;
  readonly peer = "35210";
  readonly closed = new Promise<void>(() => undefined);
  said: string[] = [];
  hungUp = false;
  redactKeys = false;
  records: Array<{ durationMs: number; ended?: "key" | "limit" | "silence" | "no-speech" } | null>;
  constructor(
    private keys: Array<string | null>,
    records: Array<{ durationMs: number; ended?: "key" | "limit" | "silence" | "no-speech" } | null> = [
      { durationMs: 3000 },
    ],
  ) {
    this.records = records;
  }
  async say(text: string): Promise<void> {
    this.said.push(text);
  }
  async key(): Promise<string | null> {
    const next = this.keys.shift();
    return next === undefined ? null : next;
  }
  async beep(): Promise<void> {
    this.said.push("<beep>");
  }
  recordOptions: unknown[] = [];
  async record(options: unknown): Promise<{
    file: string;
    durationMs: number;
    ended: "key" | "limit" | "silence" | "no-speech";
  } | null> {
    this.recordOptions.push(options);
    const next = this.records.shift();
    return next ? { file: "/tmp/memo.wav", durationMs: next.durationMs, ended: next.ended ?? "key" } : null;
  }
  async hangup(): Promise<void> {
    this.hungUp = true;
    this.open = false;
  }
}

const directory: DirectoryDoc = {
  v: 1,
  at: Date.now(),
  version: "v1",
  caller: "35210",
  items: [
    { n: 1, label: "squeak · voice" },
    { n: 2, label: "blume · hub" },
  ],
};

function setup(call: FakeCall, overrides: Partial<InboundDependencies> = {}, peer = "35210") {
  const memos: Array<{ memoId: string; choice: number; dirVersion: string; bytes: number }> = [];
  const sends: string[] = [];
  const state = { rejected: false, answered: false };
  const incoming: IncomingCall = {
    peer,
    uri: `sip:${peer}@pbx`,
    answer: async () => {
      state.answered = true;
      return call;
    },
    reject: async () => {
      state.rejected = true;
    },
  };
  const deps: InboundDependencies = {
    pin: () => "4821",
    directory: async () => directory,
    encode: async () => Buffer.from("opus"),
    uplink: {
      memo: async (memoId, choice, dirVersion, audio): Promise<DownMessage | null> => {
        memos.push({ memoId, choice, dirVersion, bytes: audio.length });
        return { v: 1, id: memoId, at: 0, status: "transcript", text: "go with option B", label: "blume · hub" };
      },
      send: async (memoId): Promise<DownMessage | null> => {
        sends.push(memoId);
        return { v: 1, id: "x", at: 0, status: "sent" };
      },
      ask: async () => null,
      status: async () => null,
    },
    ...overrides,
  };
  return { incoming, deps, memos, sends, state };
}

const keys = (text: string): string[] => text.split("");

describe("call-in conversation (a Mac that talks)", () => {
  const talking: DirectoryDoc = { ...directory, ask: true, talk: true };

  it("goes from the chat's key straight into the conversation, with no say/ask/status keys", async () => {
    const call = new FakeCall([...keys("4821#"), "2"]);
    const talks: Array<{ label: string; callId: string; from: { dirVersion: string; choice: number } }> = [];
    const t = setup(call, {
      directory: async () => talking,
      talk: async (_call, info) => {
        talks.push(info);
        return "ended";
      },
    });
    await handleIncoming(t.incoming, t.deps);
    expect(talks).toHaveLength(1);
    expect(talks[0]).toMatchObject({ label: "blume · hub", from: { dirVersion: "v1", choice: 2 } });
    expect(talks[0]!.callId).toMatch(/^[A-Za-z0-9_-]{4,64}$/);
    expect(call.said.join(" | ")).toContain("blume · hub. Go ahead: ask me about it, or tell me what to do.");
    expect(call.said.join(" | ")).not.toContain("Press 9");
    expect(t.memos).toEqual([]);
  });

  it("falls back to the keys when the conversation cannot reach the Mac", async () => {
    const call = new FakeCall([...keys("4821#"), "2", "#"]);
    const t = setup(call, { directory: async () => talking, talk: async () => "keys" });
    await handleIncoming(t.incoming, t.deps);
    expect(call.said.join(" | ")).toContain("Press 9 to say a message or ask a question");
  });

  it("keeps the keys for a Mac that does not talk, or an add-on with no talk flow", async () => {
    for (const overrides of [
      { directory: async () => ({ ...directory, ask: true }) as DirectoryDoc, talk: async () => "ended" as const },
      { directory: async () => talking },
    ]) {
      const call = new FakeCall([...keys("4821#"), "2", "#"]);
      const t = setup(call, overrides);
      await handleIncoming(t.incoming, t.deps);
      expect(call.said.join(" | ")).toContain("Press 9 to say a message or ask a question");
      expect(call.said.join(" | ")).not.toContain("Go ahead: ask me about it");
    }
  });

  it("makes the conversation's opening ahead of time for each chat", () => {
    const prompts = inboundPrompts(talking, true);
    expect(prompts).toContain("squeak · voice. Go ahead: ask me about it, or tell me what to do.");
    expect(inboundPrompts({ ...directory, ask: true }, true).join(" ")).not.toContain("Go ahead: ask me about it");
  });
});

describe("call-in flow", () => {
  it("skips the PIN when the gateway is set to, and goes straight to the chats", async () => {
    const call = new FakeCall(["2", "1"]);
    const t = setup(call, { pin: () => null });
    await handleIncoming(t.incoming, t.deps);
    expect(call.said[0]).toContain("Which chat?");
    expect(call.said.join(" ")).not.toContain("PIN");
    expect(t.sends).toHaveLength(1);
  });

  it("asks nothing and takes a message when the pin is turned off (pin() is null, calling in allowed)", async () => {
    const call = new FakeCall(["1", "1"]);
    const t = setup(call, { pin: () => null, allowed: () => true });
    await handleIncoming(t.incoming, t.deps);
    expect(call.said.join(" ")).not.toMatch(/pin/i);
    expect(t.sends).toHaveLength(1);
  });

  it("accepts a call in without a pin when the keeper's incoming policy is skip, even with no pin set", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbound-pol-"));
    const keeper = new PinKeeper(null, path.join(dir, "voice-pin.json"));
    keeper.setPolicy({ outgoing: "ask", incoming: "skip" });
    const call = new FakeCall(["1", "1"]);
    const t = setup(call, incomingGate(keeper));
    await handleIncoming(t.incoming, t.deps);
    expect(t.state.answered).toBe(true);
    expect(call.said.join(" ")).not.toMatch(/pin/i);
    expect(t.sends).toHaveLength(1);
    // And with ask and no pin it stays refused.
    keeper.setPolicy({ outgoing: "ask", incoming: "ask" });
    const refused = setup(new FakeCall(["1", "1"]), incomingGate(keeper));
    await handleIncoming(refused.incoming, refused.deps);
    expect(refused.state).toEqual({ rejected: true, answered: false });
  });

  it("refuses a call in, unanswered, when no pin was ever set", async () => {
    const call = new FakeCall(["1", "1"]);
    const t = setup(call, { pin: () => null, allowed: () => false });
    await handleIncoming(t.incoming, t.deps);
    expect(t.state).toEqual({ rejected: true, answered: false });
    expect(t.memos).toEqual([]);
  });

  it("makes no pin prompts ahead of time when the pin is off", () => {
    expect(inboundPrompts(directory, false).join(" ")).not.toMatch(/enter your PIN/i);
    expect(inboundPrompts(directory, true).join(" ")).toMatch(/enter your PIN/i);
  });

  it("still refuses another caller when the PIN is skipped", async () => {
    const t = setup(new FakeCall([]), { pin: () => null }, "99999");
    await handleIncoming(t.incoming, t.deps);
    expect(t.state).toEqual({ rejected: true, answered: false });
  });

  it("refuses a caller that is not the one extension allowed, without answering", async () => {
    const call = new FakeCall([]);
    const t = setup(call, {}, "99999");
    await handleIncoming(t.incoming, t.deps);
    expect(t.state).toEqual({ rejected: true, answered: false });
  });

  it("refuses everyone when the Mac names no caller, or cannot be read", async () => {
    for (const directoryRead of [async () => ({ ...directory, caller: null }), async () => null]) {
      const t = setup(new FakeCall([]), { directory: directoryRead });
      await handleIncoming(t.incoming, t.deps);
      expect(t.state.rejected).toBe(true);
    }
  });

  it("takes a PIN, a chat, a message, reads it back and sends on 1", async () => {
    const call = new FakeCall([...keys("4821#"), "2", "1"]);
    const t = setup(call);
    await handleIncoming(t.incoming, t.deps);
    expect(t.memos).toEqual([{ memoId: expect.any(String), choice: 2, dirVersion: "v1", bytes: 4 }]);
    // "Send it" names the memo, never text.
    expect(t.sends).toEqual([t.memos[0]!.memoId]);
    expect(call.said.join(" | ")).toContain("Press 1 for squeak · voice. Press 2 for blume · hub.");
    expect(call.said.join(" | ")).toContain("I heard: go with option B. Press 1 to send it to blume · hub");
    expect(call.said.at(-1)).toBe("Done. Your message was sent to blume · hub. Goodbye.");
    expect(call.hungUp).toBe(true);
  });

  it("hangs up after two wrong PINs and never reaches the Mac", async () => {
    const call = new FakeCall([...keys("1111#"), ...keys("2222#")]);
    const t = setup(call);
    await handleIncoming(t.incoming, t.deps);
    expect(call.said.at(-1)).toBe("That PIN is not right. Goodbye.");
    expect(t.memos).toEqual([]);
  });

  it("records again on 2, and sends nothing on hash", async () => {
    const call = new FakeCall([...keys("4821#"), "1", "2", "#"], [{ durationMs: 3000 }, { durationMs: 4000 }]);
    const t = setup(call);
    await handleIncoming(t.incoming, t.deps);
    expect(t.memos).toHaveLength(2);
    expect(t.sends).toEqual([]);
    expect(call.said.at(-1)).toBe("Cancelled. Goodbye.");
  });

  it("does not upload a recording with nothing in it", async () => {
    const call = new FakeCall([...keys("4821#"), "1"], [{ durationMs: 200 }, { durationMs: 100 }, { durationMs: 50 }]);
    const t = setup(call);
    await handleIncoming(t.incoming, t.deps);
    expect(t.memos).toEqual([]);
    expect(call.said.filter((s) => s === "I did not hear anything. Let's try again.")).toHaveLength(3);
  });

  it("says so when the Mac does not answer, and when there is no chat", async () => {
    const quiet = new FakeCall([...keys("4821#"), "1"]);
    const a = setup(quiet, {
      uplink: { memo: async () => null, send: async () => null, ask: async () => null, status: async () => null },
    });
    await handleIncoming(a.incoming, a.deps);
    expect(quiet.said.at(-1)).toBe("I could not reach your Mac. Goodbye.");

    const empty = new FakeCall(keys("4821#"));
    const b = setup(empty, { directory: async () => ({ ...directory, items: [] }) });
    await handleIncoming(b.incoming, b.deps);
    expect(empty.said.at(-1)).toBe("No chat can take a message right now. Goodbye.");
  });

  it("says when it cannot be sure a send arrived", async () => {
    const call = new FakeCall([...keys("4821#"), "1", "1"]);
    const t = setup(call);
    t.deps.uplink.send = async () => null;
    await handleIncoming(t.incoming, t.deps);
    expect(call.said.at(-1)).toContain("not sure it was sent");
  });

  it("relays the Mac's reason when it refuses the send", async () => {
    const call = new FakeCall([...keys("4821#"), "1", "1"]);
    const t = setup(call);
    t.deps.uplink.send = async () => ({
      v: 1,
      id: "x",
      at: 0,
      status: "refused",
      reason: "blume · hub is busy right now. Send it from the app.",
    });
    await handleIncoming(t.incoming, t.deps);
    expect(call.said.at(-1)).toContain("is busy right now");
  });

  it("has every fixed thing it says made ahead of time: only the read-back is made on the spot", async () => {
    for (const askPin of [true, false]) {
      const call = new FakeCall([...(askPin ? keys("4821#") : []), "2", "1"]);
      const t = setup(call, { pin: () => (askPin ? "4821" : null) });
      await handleIncoming(t.incoming, t.deps);
      const ready = new Set(inboundPrompts(directory, askPin));
      const late = call.said.filter((text) => text !== "<beep>" && !ready.has(text));
      expect(late).toHaveLength(1);
      expect(late[0]).toBe(readBackSentence("go with option B", "blume · hub"));
    }
  });

  it("also readies the wrong-PIN and failure sentences", async () => {
    const call = new FakeCall([...keys("1111#"), ...keys("2222#")]);
    const t = setup(call);
    await handleIncoming(t.incoming, t.deps);
    expect(call.said.every((text) => inboundPrompts(directory, true).includes(text))).toBe(true);
  });

  it("star repeats every menu and the read-back without counting as an attempt", async () => {
    const call = new FakeCall([...keys("4821#"), "*", "*", "2", "*", "1"]);
    const t = setup(call);
    await handleIncoming(t.incoming, t.deps);
    const menus = call.said.filter((s) => s.includes("Which chat?"));
    expect(menus).toHaveLength(3);
    expect(menus[0]).toContain("Press star to hear this again, or hash to hang up.");
    expect(call.said.filter((s) => s.startsWith("I heard:"))).toHaveLength(2);
    expect(t.memos).toHaveLength(1);
    expect(t.sends).toHaveLength(1);
  });

  it("gives up on a menu after five repeats", async () => {
    const call = new FakeCall([...keys("4821#"), ...Array(8).fill("*")]);
    const t = setup(call);
    await handleIncoming(t.incoming, t.deps);
    expect(call.said.filter((s) => s.includes("Which chat?"))).toHaveLength(6);
    expect(call.said.at(-1)).toBe("Goodbye.");
  });

  it("walks workspaces, chats and the 0 menu with star, saying only listed texts", async () => {
    const dir: DirectoryDoc = {
      ...directory,
      workspaces: [
        {
          n: 1,
          label: "Blume",
          chats: [
            { n: 1, label: "hub" },
            { n: 2, label: "api" },
          ],
        },
        { n: 2, label: "Empty", chats: [] },
      ],
    } as DirectoryDoc;
    const call = new FakeCall([...keys("4821#"), "*", "2", "1", "*", "2", "1"]);
    const t = setup(call, { directory: async () => dir });
    await handleIncoming(t.incoming, t.deps);
    const ready = new Set(inboundPrompts(dir, true));
    const late = call.said.filter((s) => s !== "<beep>" && !ready.has(s));
    expect(late).toEqual([readBackSentence("go with option B", "blume · hub")]);
    expect(call.said).toContain("Nothing in Empty can take a message right now.");
    expect(call.said).toContain(
      "Blume. Which chat? Press 1 for hub. Press 2 for api. Press star to hear this again, or hash to go back.",
    );
    expect(call.said[0]).toBe(
      "Hello, this is Squeak. Please enter your PIN, then press hash. Press star to start over.",
    );
    expect(call.said.some((s) => s.startsWith("api. Speak your message after the beep"))).toBe(true);
    const other = new FakeCall([...keys("4821#"), "0", "*", "1", "1"]);
    const u = setup(other, { directory: async () => dir });
    await handleIncoming(u.incoming, u.deps);
    const late2 = other.said.filter((s) => s !== "<beep>" && !ready.has(s));
    expect(late2).toEqual([readBackSentence("go with option B", "blume · hub")]);
    expect(other.said.filter((s) => s.startsWith("Which chat?"))).toHaveLength(2);
  });

  it("says Still working on it once when the Mac is slow", async () => {
    vi.useFakeTimers();
    try {
      const call = new FakeCall([...keys("4821#"), "1", "#"]);
      const t = setup(call);
      t.deps.uplink.memo = () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ v: 1, id: "x", at: 0, status: "transcript", text: "hi", label: "squeak · voice" }),
            15_000,
          ),
        );
      const done = handleIncoming(t.incoming, t.deps);
      await vi.advanceTimersByTimeAsync(20_000);
      await done;
      expect(call.said.filter((s) => s === "Still working on it.")).toHaveLength(1);
      expect(call.said).toContain("One moment.");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("recording ends", () => {
  it("asks to end on silence, and caps a memo at 60 s", async () => {
    const call = new FakeCall(["2", "1"]);
    const t = setup(call, { pin: () => null });
    await handleIncoming(t.incoming, t.deps);
    expect(call.recordOptions[0]).toMatchObject({ maxMs: 60_000, endOnSilence: true });
  });

  it("offers another try when nothing was heard, instead of processing silence", async () => {
    const call = new FakeCall(["2", "1", "1"], [{ durationMs: 8000, ended: "no-speech" }, { durationMs: 3000 }]);
    const t = setup(call, { pin: () => null });
    await handleIncoming(t.incoming, t.deps);
    expect(call.said).toContain("I didn't hear anything. Press 1 to try again, or hash to hang up.");
    expect(t.memos).toHaveLength(1);
    expect(t.sends).toHaveLength(1);
  });

  it("hangs up on hash after nothing was heard, sending nothing", async () => {
    const call = new FakeCall(["2", "#"], [{ durationMs: 8000, ended: "no-speech" }]);
    const t = setup(call, { pin: () => null });
    await handleIncoming(t.incoming, t.deps);
    expect(t.memos).toHaveLength(0);
    expect(t.sends).toHaveLength(0);
    expect(call.said.at(-1)).toBe("Goodbye.");
  });

  it("says it has to stop at the cap, then carries on with what was recorded", async () => {
    const call = new FakeCall(["2", "1"], [{ durationMs: 60_000, ended: "limit" }]);
    const t = setup(call, { pin: () => null });
    await handleIncoming(t.incoming, t.deps);
    const stop = call.said.indexOf("I have to stop there.");
    expect(stop).toBeGreaterThan(-1);
    expect(call.said.indexOf("One moment.")).toBeGreaterThan(stop);
    expect(t.memos).toHaveLength(1);
  });

  it("logs the digits the flow reads for a PIN as hidden: redaction is on only while the PIN is typed", async () => {
    const seen: boolean[] = [];
    const call = new FakeCall(["4", "8", "2", "1", "#"]);
    const original = call.key.bind(call);
    call.key = async () => {
      seen.push(call.redactKeys === true);
      return original();
    };
    const t = setup(call, { pin: () => "4821" });
    await handleIncoming(t.incoming, t.deps);
    expect(seen.slice(0, 5)).toEqual([true, true, true, true, true]);
    expect(call.redactKeys).toBe(false);
  });

  it("says 'Still working on it' at most once every 10 s while the Mac takes a long time", async () => {
    vi.useFakeTimers();
    try {
      const call = new FakeCall(["2", "1"]);
      const t = setup(call, {
        pin: () => null,
        uplink: {
          memo: () =>
            new Promise((resolve) =>
              setTimeout(
                () => resolve({ v: 1, id: "x", at: 0, status: "transcript", text: "go on", label: "blume · hub" }),
                36_000,
              ),
            ),
          send: async () => ({ v: 1, id: "x", at: 0, status: "sent" }),
          ask: async () => null,
          status: async () => null,
        },
      });
      const done = handleIncoming(t.incoming, t.deps);
      await vi.advanceTimersByTimeAsync(40_000);
      await done;
      const stills = call.said.filter((l) => l === "Still working on it.").length;
      // first at 6 s, then no more often than every 10 s: 6, 16, 26, 36 at most.
      expect(stills).toBeGreaterThanOrEqual(2);
      expect(stills).toBeLessThanOrEqual(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the chat used last", () => {
  const withLast: DirectoryDoc = { ...directory, last: { choice: 2, label: "blume · hub" } };
  const lastLine = "Press 1 for blume · hub, the last one you used. Press 2 for another chat.";

  it("offers it first, with the greeting when there is no PIN, and key 1 goes straight to the message", async () => {
    const call = new FakeCall(["1", "1"]);
    const t = setup(call, { pin: () => null, directory: async () => withLast });
    await handleIncoming(t.incoming, t.deps);
    expect(call.said[0]).toContain("Hello, this is Squeak. Press 1 for blume · hub, the last one you used.");
    expect(call.said.join(" ")).not.toContain("Which chat?");
    expect(t.memos).toEqual([{ memoId: expect.any(String), choice: 2, dirVersion: "v1", bytes: 4 }]);
    expect(t.sends).toHaveLength(1);
  });

  it("says the offer after the PIN prompt, without a second greeting", async () => {
    const call = new FakeCall([...keys("4821#"), "1", "1"]);
    const t = setup(call, { directory: async () => withLast });
    await handleIncoming(t.incoming, t.deps);
    expect(call.said[0]).toContain("Please enter your PIN");
    const offer = call.said.find((s) => s.includes(lastLine));
    expect(offer).toBeDefined();
    expect(offer).not.toContain("Hello");
  });

  it("goes to the existing menus on 2", async () => {
    const call = new FakeCall(["2", "1", "1"]);
    const t = setup(call, { pin: () => null, directory: async () => withLast });
    await handleIncoming(t.incoming, t.deps);
    expect(call.said.some((s) => s.startsWith("Which chat?"))).toBe(true);
    expect(t.memos[0]?.choice).toBe(1);
  });

  it("hangs up on hash, and after two wrong keys, sending nothing", async () => {
    for (const pressed of [["#"], ["5", "7"], [null]]) {
      const call = new FakeCall(pressed);
      const t = setup(call, { pin: () => null, directory: async () => withLast });
      await handleIncoming(t.incoming, t.deps);
      expect(t.memos).toHaveLength(0);
      expect(call.said.at(-1)).toBe("Goodbye.");
    }
  });

  it("repeats the offer on star without counting it", async () => {
    const call = new FakeCall(["*", "*", "1", "1"]);
    const t = setup(call, { pin: () => null, directory: async () => withLast });
    await handleIncoming(t.incoming, t.deps);
    expect(call.said.filter((s) => s.includes(lastLine))).toHaveLength(3);
    expect(t.sends).toHaveLength(1);
  });

  it("goes with key 1 to the action step with a Mac that answers", async () => {
    const call = new FakeCall(["1", "1", "3"]);
    const t = setup(call, { pin: () => null, directory: async () => ({ ...withLast, ask: true }) });
    await handleIncoming(t.incoming, t.deps);
    expect(call.said.some((s) => s.startsWith("blume · hub. Press 9 to say a message or ask a question"))).toBe(true);
  });

  it("leaves a directory without it unchanged", async () => {
    const call = new FakeCall(["2", "1"]);
    const t = setup(call, { pin: () => null });
    await handleIncoming(t.incoming, t.deps);
    expect(call.said[0]).toBe(
      inboundPrompts(directory, false).find((s) => s.startsWith("Hello, this is Squeak. Which")),
    );
    expect(call.said.join(" ")).not.toContain("last one you used");
  });

  it("has its sentences made ahead of time, for both greetings, and says nothing else unlisted", async () => {
    for (const askPin of [true, false]) {
      const ready = inboundPrompts({ ...withLast, ask: true }, askPin);
      expect(ready.some((s) => s.includes(lastLine))).toBe(true);
      expect(ready).toContain("I didn't hear anything. Press 3 to record again, or hash to cancel.");
      const call = new FakeCall([...(askPin ? keys("4821#") : []), "2", "2", "1", "1"]);
      const t = setup(call, { pin: () => (askPin ? "4821" : null), directory: async () => withLast });
      await handleIncoming(t.incoming, t.deps);
      const late = call.said.filter((s) => s !== "<beep>" && !inboundPrompts(withLast, askPin).includes(s));
      expect(late).toEqual([readBackSentence("go with option B", "blume · hub")]);
    }
    expect(inboundPrompts(directory, false)).toContain(
      "I didn't hear anything. Press 2 to record again, or hash to cancel.",
    );
  });
});

describe("an unclear recording", () => {
  const heardAs =
    (text: string, count = { n: 0 }) =>
    async (memoId: string): Promise<DownMessage> => {
      count.n++;
      return { v: 1, id: memoId, at: 0, status: "transcript", text, label: "blume · hub" };
    };
  const uplinkFor = (memo: ReturnType<typeof heardAs>, sends: string[]) => ({
    memo,
    send: async (memoId: string): Promise<DownMessage | null> => {
      sends.push(memoId);
      return { v: 1, id: "x", at: 0, status: "sent" } as DownMessage;
    },
    ask: async () => null,
    status: async () => null,
  });

  it("never auto-sends a very short transcript: offers 3 first with a Mac that answers, and sends only on 1", async () => {
    const sends: string[] = [];
    const call = new FakeCall(["1", "1", "1"]);
    const t = setup(call, {
      pin: () => null,
      directory: async () => ({ ...directory, ask: true }),
      uplink: uplinkFor(heardAs("uh"), sends),
    });
    await handleIncoming(t.incoming, t.deps);
    expect(call.said).toContain(
      "I only heard: uh. Press 3 to record again, 1 to send it anyway, star to hear it again, or hash to cancel.",
    );
    expect(call.said.join(" ")).not.toContain("I heard:");
    expect(sends).toHaveLength(1);
  });

  it("records again on the record-again key, and sends nothing on hash", async () => {
    const sends: string[] = [];
    const count = { n: 0 };
    const call = new FakeCall(["1", "2", "#"], [{ durationMs: 3000 }, { durationMs: 3000 }]);
    const t = setup(call, { pin: () => null, uplink: uplinkFor(heardAs("um", count), sends) });
    await handleIncoming(t.incoming, t.deps);
    expect(count.n).toBe(2);
    expect(sends).toHaveLength(0);
    expect(call.said.at(-1)).toBe("Cancelled. Goodbye.");
  });

  it("treats a recording under 1.5 s as unclear even with real words", async () => {
    const sends: string[] = [];
    const call = new FakeCall(["1", "#"], [{ durationMs: 1200 }]);
    const t = setup(call, { pin: () => null, uplink: uplinkFor(heardAs("go with option B"), sends) });
    await handleIncoming(t.incoming, t.deps);
    expect(call.said.some((s) => s.startsWith("I only heard: go with option B."))).toBe(true);
    expect(sends).toHaveLength(0);
  });

  it("says nothing was heard for Whisper's silence strings, and offers to record again", async () => {
    for (const text of ["you", "Thank you.", "."]) {
      const sends: string[] = [];
      const call = new FakeCall(["1", "1", "#"]);
      const t = setup(call, {
        pin: () => null,
        directory: async () => ({ ...directory, ask: true }),
        uplink: uplinkFor(heardAs(text), sends),
      });
      await handleIncoming(t.incoming, t.deps);
      expect(call.said).toContain("I didn't hear anything. Press 3 to record again, or hash to cancel.");
      expect(sends).toHaveLength(0);
    }
  });

  it("repeats the unclear offer on star", async () => {
    const call = new FakeCall(["1", "*", "#"]);
    const t = setup(call, { pin: () => null, uplink: uplinkFor(heardAs("uh"), []) });
    await handleIncoming(t.incoming, t.deps);
    expect(call.said.filter((s) => s.startsWith("I only heard: uh.")).length).toBe(2);
  });
});
