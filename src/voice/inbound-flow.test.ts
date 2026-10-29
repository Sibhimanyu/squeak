import { describe, expect, it } from "vitest";

import { handleIncoming, inboundPrompts, type InboundDependencies } from "./inbound-flow.js";
import type { DirectoryDoc, DownMessage } from "./memo-protocol.js";
import type { IncomingCall, PhoneCall } from "./phone.js";

class FakeCall implements PhoneCall {
  open = true;
  readonly peer = "35210";
  readonly closed = new Promise<void>(() => undefined);
  said: string[] = [];
  hungUp = false;
  records: Array<{ durationMs: number } | null>;
  constructor(
    private keys: Array<string | null>,
    records: Array<{ durationMs: number } | null> = [{ durationMs: 3000 }],
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
  async record(): Promise<{ file: string; durationMs: number; ended: "key" } | null> {
    const next = this.records.shift();
    return next ? { file: "/tmp/memo.wav", durationMs: next.durationMs, ended: "key" } : null;
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
    },
    ...overrides,
  };
  return { incoming, deps, memos, sends, state };
}

const keys = (text: string): string[] => text.split("");

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

  it("refuses a call in, unanswered, when no pin was ever set", async () => {
    const call = new FakeCall(["1", "1"]);
    const t = setup(call, { pin: () => null, allowed: () => false });
    await handleIncoming(t.incoming, t.deps);
    expect(t.state).toEqual({ rejected: true, answered: false });
    expect(t.memos).toEqual([]);
  });

  it("makes no pin prompts ahead of time when the pin is off", () => {
    expect(inboundPrompts(directory, false).join(" ")).not.toMatch(/enter your pin/i);
    expect(inboundPrompts(directory, true).join(" ")).toMatch(/enter your pin/i);
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
    expect(call.said.at(-1)).toBe("Sent. Goodbye.");
    expect(call.hungUp).toBe(true);
  });

  it("hangs up after two wrong PINs and never reaches the Mac", async () => {
    const call = new FakeCall([...keys("1111#"), ...keys("2222#")]);
    const t = setup(call);
    await handleIncoming(t.incoming, t.deps);
    expect(call.said.at(-1)).toBe("That pin is not right. Goodbye.");
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
    expect(call.said.filter((s) => s === "I did not hear anything.")).toHaveLength(3);
  });

  it("says so when the Mac does not answer, and when there is no chat", async () => {
    const quiet = new FakeCall([...keys("4821#"), "1"]);
    const a = setup(quiet, { uplink: { memo: async () => null, send: async () => null } });
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
      expect(late[0]).toMatch(/^I heard: /);
    }
  });

  it("also readies the wrong-PIN and failure sentences", async () => {
    const call = new FakeCall([...keys("1111#"), ...keys("2222#")]);
    const t = setup(call);
    await handleIncoming(t.incoming, t.deps);
    expect(call.said.every((text) => inboundPrompts(directory, true).includes(text))).toBe(true);
  });
});
