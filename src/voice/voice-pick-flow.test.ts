import { describe, expect, it } from "vitest";

import {
  handleIncoming,
  inboundPrompts,
  uploadPrompts,
  voiceMenuPrompt,
  type InboundDependencies,
} from "./inbound-flow.js";
import type { DirectoryDoc, DownMessage } from "./memo-protocol.js";
import type { IncomingCall, PhoneCall, RecordEnd } from "./phone.js";

interface Take {
  durationMs?: number;
  ended?: RecordEnd;
  /** A key pressed while this listening ran: it ends it and stays queued. */
  pressed?: string;
}

/** A call whose keys behave like the line's: a short look for a key finds only one pressed just now. */
class FakeCall implements PhoneCall {
  open = true;
  readonly peer = "35210";
  readonly closed = new Promise<void>(() => undefined);
  said: string[] = [];
  options: Array<Record<string, unknown>> = [];
  private queue: string[] = [];
  private fresh = false;
  constructor(
    private readonly typed: string[],
    private readonly takes: Take[] = [],
    /** One entry per line said: a key pressed while it was being said, or null. */
    private readonly pressDuring: Array<string | null> = [],
  ) {}
  async say(text: string): Promise<void> {
    this.said.push(text);
    const key = this.pressDuring.shift();
    if (key) {
      this.queue.push(key);
      this.fresh = true;
    }
  }
  async key(timeoutMs: number): Promise<string | null> {
    if (this.queue.length === 0 && timeoutMs > 250) {
      const next = this.typed.shift();
      if (next !== undefined) this.queue.push(next);
    }
    if (this.queue.length === 0) return null;
    if (timeoutMs <= 250 && !this.fresh) return null;
    this.fresh = false;
    return this.queue.shift() ?? null;
  }
  async beep(): Promise<void> {
    this.said.push("<beep>");
  }
  async record(
    options: Record<string, unknown>,
  ): Promise<{ file: string; durationMs: number; ended: RecordEnd } | null> {
    this.options.push(options);
    const take = this.takes.shift();
    if (!take) return null;
    if (take.pressed) {
      this.queue.push(take.pressed);
      this.fresh = true;
    }
    return { file: "/tmp/pick.wav", durationMs: take.durationMs ?? 1500, ended: take.ended ?? "silence" };
  }
  async hangup(): Promise<void> {
    this.open = false;
  }
}

const without = (doc: DirectoryDoc, ...keys: Array<"terse" | "pickByVoice">): DirectoryDoc => {
  const copy = { ...doc };
  for (const key of keys) delete copy[key];
  return copy;
};

const directory: DirectoryDoc = {
  v: 1,
  at: 0,
  version: "v1",
  caller: "35210",
  items: [{ n: 1, label: "loose chat", choice: 5 }],
  ask: true,
  talk: true,
  terse: true,
  pickByVoice: true,
  workspaces: [
    {
      n: 1,
      label: "squeak",
      newChat: 1,
      chats: [
        { n: 1, label: "voice", choice: 1 },
        { n: 2, label: "ui planning", choice: 2 },
      ],
    },
    {
      n: 2,
      label: "blume",
      chats: [
        { n: 1, label: "hub", choice: 3 },
        { n: 2, label: "site", choice: 4 },
      ],
    },
  ],
};

type Answer = Extract<DownMessage, { status: "pick" }>;
const pickOf = (body: Partial<Answer>): DownMessage => ({ v: 1, id: "p", at: 0, status: "pick", heard: "", ...body });

function setup(call: FakeCall, answers: Array<DownMessage | null>, doc: DirectoryDoc = directory) {
  const picks: Array<{ dirVersion: string; menu: string }> = [];
  const traces: string[] = [];
  const talks: Array<{ label: string; choice: number }> = [];
  const sent: string[] = [];
  const incoming: IncomingCall = {
    peer: "35210",
    uri: "sip:35210@pbx",
    answer: async () => call,
    reject: async () => undefined,
  };
  const deps: InboundDependencies = {
    pin: () => null,
    allowed: () => true,
    directory: async () => doc,
    encode: async () => Buffer.from("opus"),
    trace: (line) => traces.push(line),
    uplink: {
      memo: async () => {
        sent.push("memo");
        return null;
      },
      send: async () => {
        sent.push("send");
        return null;
      },
      ask: async () => null,
      status: async () => null,
      pick: async (_id, dirVersion, menu) => {
        picks.push({ dirVersion, menu });
        return answers.shift() ?? null;
      },
    },
    talk: async (_call, info) => {
      talks.push({ label: info.label, choice: info.from.choice });
      return "ended";
    },
  };
  return { incoming, deps, picks, traces, talks, sent };
}

describe("a menu answered by voice", () => {
  it("asks as a question, listens (no beep, a pause of a second, six seconds at most) and takes the pick", async () => {
    const call = new FakeCall([], [{}, {}]);
    const t = setup(call, [pickOf({ choice: 1, heard: "squeak" }), pickOf({ choice: 2, heard: "the second one" })]);
    await handleIncoming(t.incoming, t.deps);
    expect(call.said[0]).toBe("Which workspace? squeak, blume, or other chats? You can also press a number.");
    expect(call.said[1]).toBe("Which chat in squeak? voice, ui planning, or a new chat?");
    expect(t.picks).toEqual([
      { dirVersion: "v1", menu: "workspaces" },
      { dirVersion: "v1", menu: "workspace:1" },
    ]);
    expect(call.options[0]).toMatchObject({
      maxMs: 6000,
      beep: false,
      endOnSilence: true,
      endSilenceMs: 1000,
      endOnAnyKey: true,
    });
    expect(t.talks).toEqual([{ label: "ui planning", choice: 2 }]);
    expect(t.traces).toEqual(
      expect.arrayContaining(["step: Picked squeak by voice", "step: Picked ui planning by voice"]),
    );
    // A pick only selects: nothing was sent or recorded as a message.
    expect(t.sent).toEqual([]);
  });

  it("says the hint once, on the first menu only, and greets there when the persona is friendly", async () => {
    const call = new FakeCall([], [{}, {}]);
    const t = setup(call, [pickOf({ choice: 1 }), pickOf({ choice: 1 })], without(directory, "terse"));
    await handleIncoming(t.incoming, t.deps);
    expect(call.said[0]).toBe(
      "Hello, this is Squeak. Which workspace? squeak, blume, or other chats? You can also press a number.",
    );
    expect(call.said[1]).not.toContain("press a number");
  });

  it("takes a key pressed while listening at once, and the keypad still works", async () => {
    const call = new FakeCall(
      [],
      [
        { ended: "key", pressed: "2" },
        { ended: "key", pressed: "1" },
      ],
    );
    const t = setup(call, []);
    await handleIncoming(t.incoming, t.deps);
    expect(t.picks).toEqual([]);
    expect(t.talks).toEqual([{ label: "hub", choice: 3 }]);
    expect(t.traces).toEqual(expect.arrayContaining(["key: 2 (workspace blume)", "key: 1 (hub)"]));
  });

  it("takes a key pressed while the question is still being said", async () => {
    const call = new FakeCall([], [{ ended: "key", pressed: "1" }], ["2"]);
    const t = setup(call, []);
    await handleIncoming(t.incoming, t.deps);
    expect(call.options).toHaveLength(1);
    expect(t.talks).toEqual([{ label: "hub", choice: 3 }]);
  });

  it("says 'Sorry, which one?' after a miss, then goes to the keypad's wording after two", async () => {
    const call = new FakeCall(["2", "2"], [{}, {}, {}, {}]);
    const t = setup(call, [pickOf({ heard: "um" }), pickOf({ heard: "banana" })]);
    await handleIncoming(t.incoming, t.deps);
    expect(call.said[1]).toBe("Sorry, which one? squeak, blume, or other chats?");
    expect(call.said[2]).toBe(
      "Which workspace? Press 1 for squeak. Press 2 for blume. Press 0 for other chats. Press star to hear this again, or hash to hang up.",
    );
    expect(t.traces.filter((line) => line === "step: Pick not understood")).toHaveLength(2);
    // Two answers were sent, then the keys took over (2 is blume); the recordings that follow are the chat menu's.
    expect(t.picks.map((pick) => pick.menu)).toEqual(["workspaces", "workspaces", "workspace:2"]);
  });

  it("counts a recording of nothing as a miss", async () => {
    const call = new FakeCall(["1", "1"], [{ ended: "no-speech" }, { durationMs: 100 }]);
    const t = setup(call, []);
    await handleIncoming(t.incoming, t.deps);
    expect(t.picks).toEqual([]);
    expect(call.said[1]).toBe("Sorry, which one? squeak, blume, or other chats?");
    expect(call.said[2]).toContain("Press 1 for squeak.");
  });

  it("falls back to the keypad at once when the Mac does not answer", async () => {
    const call = new FakeCall(["2", "1"], [{}]);
    const t = setup(call, [null]);
    await handleIncoming(t.incoming, t.deps);
    expect(call.said[1]).toContain("Press 1 for squeak.");
    expect(t.traces).toContain("step: Menu answers by voice are not available, using the keypad");
  });

  it("understands the menu's extras: other chats, go back, hang up", async () => {
    const call = new FakeCall([], [{}, {}, {}, {}, {}]);
    const t = setup(call, [
      pickOf({ action: "other", heard: "another chat" }),
      pickOf({ action: "back", heard: "go back" }),
      pickOf({ choice: 1, heard: "squeak" }),
      pickOf({ action: "hangup", heard: "bye" }),
    ]);
    await handleIncoming(t.incoming, t.deps);
    expect(t.picks.map((pick) => pick.menu)).toEqual(["workspaces", "chats", "workspaces", "workspace:1"]);
    expect(t.talks).toEqual([]);
    expect(call.said.at(-1)).toBe("Goodbye.");
  });

  it("repeats the menu without the hint when asked to", async () => {
    const call = new FakeCall([], [{}, {}]);
    const t = setup(call, [pickOf({ action: "repeat" }), pickOf({ choice: 2 })]);
    await handleIncoming(t.incoming, t.deps);
    expect(call.said[0]).toContain("press a number");
    expect(call.said[1]).toBe("Which workspace? squeak, blume, or other chats?");
    expect(call.said[2]).toBe("Which chat in blume? hub or site?");
  });

  it("a new chat picked by voice goes the same way as key 0, and starts nothing by itself", async () => {
    const call = new FakeCall([], [{}, {}]);
    const t = setup(call, [pickOf({ choice: 1 }), pickOf({ action: "new", heard: "a new chat" })]);
    const started: string[] = [];
    t.deps.uplink.newChat = async () => {
      started.push("newchat");
      return null;
    };
    t.deps.uplink.start = async () => {
      started.push("start");
      return null;
    };
    await handleIncoming(t.incoming, t.deps);
    expect(call.said).toContain("New chat in squeak. Go ahead: say what you want it to do.");
    expect(t.traces).toContain("step: Picked a new chat in squeak by voice");
    // The call is hung up at the recording of what the chat should do; nothing reached the Mac.
    expect(started).toEqual([]);
  });

  it("is the keypad exactly as before for a Mac that does not say it, or an uplink that cannot carry it", async () => {
    for (const [doc, strip] of [
      [without(directory, "pickByVoice"), false],
      [directory, true],
    ] as const) {
      const call = new FakeCall(["2", "1"], [{}]);
      const t = setup(call, [pickOf({ choice: 1 })], doc as DirectoryDoc);
      if (strip) delete t.deps.uplink.pick;
      await handleIncoming(t.incoming, t.deps);
      expect(call.said[0]).toBe(
        "Which workspace? Press 1 for squeak. Press 2 for blume. Press 0 for other chats. Press star to hear this again, or hash to hang up.",
      );
      expect(call.options).toEqual([]);
      expect(t.picks).toEqual([]);
    }
  });
});

describe("the prompts of a menu answered by voice", () => {
  it("are the questions, with the keypad's wording last", () => {
    const list = uploadPrompts(directory);
    expect(list).toEqual(
      expect.arrayContaining([
        "Which workspace? squeak, blume, or other chats? You can also press a number.",
        "Which workspace? squeak, blume, or other chats?",
        "Which chat in squeak? voice, ui planning, or a new chat?",
        "Which chat in blume? hub or site?",
        "Which chat? loose chat?",
        "Sorry, which one? squeak, blume, or other chats?",
      ]),
    );
    const question = list.indexOf("Which workspace? squeak, blume, or other chats? You can also press a number.");
    const keypad = list.findIndex((text) => text.startsWith("Which workspace? Press 1 for squeak"));
    expect(question).toBeGreaterThanOrEqual(0);
    expect(keypad).toBeGreaterThan(question);
    expect(voiceMenuPrompt(directory, "chats", false, false)).toBe("Which chat? loose chat?");
  });

  it("leave the keypad's menus where they were for a Mac that does not say it", () => {
    const old = inboundPrompts(without(directory, "pickByVoice"), false);
    expect(old).toContain(
      "Which workspace? Press 1 for squeak. Press 2 for blume. Press 0 for other chats. Press star to hear this again, or hash to hang up.",
    );
    expect(old.join(" ")).not.toContain("Sorry, which one?");
    expect(old.join(" ")).not.toContain("press a number");
  });
});
