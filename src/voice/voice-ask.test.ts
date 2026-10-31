import { describe, expect, it } from "vitest";

import {
  ChatQuestioner,
  clipSpoken,
  questionContext,
  redactSecrets,
  spokenAnswer,
  statusReadout,
} from "./chat-brief.js";
import type { ChatBriefInputs } from "./chat-brief.js";
import { session } from "./fixtures.js";
import {
  ASK_FAILED,
  handleIncoming,
  inboundPrompts,
  readBackSentence,
  type InboundDependencies,
} from "./inbound-flow.js";
import { MAX_ANSWER_CHARS, readDirectory, readDown, readUp, sealDirectory, sealDown, sealUp } from "./memo-protocol.js";
import type { DirectoryDoc, DownMessage, UpMessage } from "./memo-protocol.js";
import type { IncomingCall, PhoneCall } from "./phone.js";
import { generateChannel } from "../remote/remote-crypto.js";

class FakeCall implements PhoneCall {
  open = true;
  readonly peer = "35210";
  readonly closed = new Promise<void>(() => undefined);
  said: string[] = [];
  hungUp = false;
  constructor(
    private keys: Array<string | null>,
    private records: Array<{ durationMs: number } | null> = [
      { durationMs: 3000 },
      { durationMs: 3000 },
      { durationMs: 3000 },
    ],
  ) {}
  async say(text: string): Promise<void> {
    this.said.push(text);
  }
  async key(): Promise<string | null> {
    const next = this.keys.shift();
    return next === undefined ? null : next;
  }
  async beep(): Promise<void> {}
  async record(): Promise<{ file: string; durationMs: number; ended: "key" } | null> {
    const next = this.records.shift();
    return next ? { file: "/tmp/m.wav", durationMs: next.durationMs, ended: "key" } : null;
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
  ask: true,
  items: [
    { n: 1, label: "squeak voice" },
    { n: 2, label: "blume hub" },
  ],
};

function setup(call: FakeCall, uplink: Partial<InboundDependencies["uplink"]> = {}, dir: DirectoryDoc = directory) {
  const log = { memos: 0, sends: [] as string[], asks: [] as string[], statuses: [] as Array<[number, string]> };
  const incoming: IncomingCall = {
    peer: "35210",
    uri: "sip:35210@pbx",
    answer: async () => call,
    reject: async () => undefined,
  };
  const deps: InboundDependencies = {
    pin: () => null,
    directory: async () => dir,
    encode: async () => Buffer.from("opus"),
    uplink: {
      memo: async (memoId): Promise<DownMessage | null> => {
        log.memos += 1;
        return { v: 1, id: memoId, at: 0, status: "transcript", text: "is the build passing", label: "blume hub" };
      },
      send: async (memoId): Promise<DownMessage | null> => {
        log.sends.push(memoId);
        return { v: 1, id: "x", at: 0, status: "sent" };
      },
      ask: async (memoId): Promise<DownMessage | null> => {
        log.asks.push(memoId);
        return { v: 1, id: "x", at: 0, status: "answer", text: "Yes, the build is passing." };
      },
      status: async (choice, version): Promise<DownMessage | null> => {
        log.statuses.push([choice, version]);
        return { v: 1, id: "x", at: 0, status: "answer", text: "Blume hub is working." };
      },
      ...uplink,
    },
  };
  return { incoming, deps, log };
}

// pin() is null: the first menu is the chat list ("2" picks blume hub), then the action menu.
const run = async (
  keys: Array<string | null>,
  uplink: Partial<InboundDependencies["uplink"]> = {},
  records?: Array<{ durationMs: number } | null>,
  dir?: DirectoryDoc,
) => {
  const call = new FakeCall(keys, records);
  const t = setup(call, uplink, dir);
  await handleIncoming(t.incoming, t.deps);
  return { call, ...t };
};

describe("calling in with a Mac that answers questions", () => {
  it("1 at the action menu records; 1 after the read-back sends and ends the call", async () => {
    const t = await run(["2", "1", "1"]);
    expect(t.log.sends).toHaveLength(1);
    expect(t.log.asks).toEqual([]);
    expect(t.call.said.join(" | ")).toContain(
      "Press 9 to say a message or ask a question, or 0 to hear where it stands.",
    );
    expect(t.call.said).toContain(readBackSentence("is the build passing", "blume hub", true));
    expect(t.call.said.at(-1)).toBe("Done. Your message was sent to blume hub. Goodbye.");
    expect(t.call.hungUp).toBe(true);
  });

  it("2 after the read-back asks it as a question: reads the answer, sends nothing", async () => {
    const t = await run(["2", "1", "2", "#"]);
    expect(t.log.asks).toHaveLength(1);
    expect(t.log.sends).toEqual([]);
    expect(t.call.said).toContain("Yes, the build is passing.");
    expect(t.call.said).toContain(
      "Press star to hear this again, 1 for something else about this chat, or hash to hang up.",
    );
    expect(t.call.said.at(-1)).toBe("Goodbye.");
  });

  it("3 at the action menu reads the status with no recording, and sends nothing", async () => {
    const t = await run(["2", "3", "#"]);
    expect(t.log.statuses).toEqual([[2, "v1"]]);
    expect(t.log.memos).toBe(0);
    expect(t.log.sends).toEqual([]);
    expect(t.call.said).toContain("Blume hub is working.");
  });

  it("3 after the read-back records again", async () => {
    const t = await run(["2", "1", "3", "#"]);
    expect(t.log.memos).toBe(2);
    expect(t.log.sends).toEqual([]);
    expect(t.log.asks).toEqual([]);
  });

  it("star hears the answer again; 1 after an answer goes back to the action menu", async () => {
    const t = await run(["2", "3", "*", "1", "3", "#"]);
    expect(t.call.said.filter((s) => s === "Blume hub is working.")).toHaveLength(3);
    expect(
      t.call.said.filter((s) => s.startsWith("Blume hub. Press 9 to say")).length +
        t.call.said.filter((s) => s.includes("Press 9 to say a message")).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("allows three answers a call, then says goodbye", async () => {
    const t = await run(["2", "3", "1", "3", "1", "3", "1"]);
    expect(t.log.statuses).toHaveLength(3);
    expect(t.call.said.at(-1)).toBe("That is as many answers as I can give on one call. Goodbye.");
    expect(t.call.hungUp).toBe(true);
  });

  it("a question that fails is said, offered again from the read-back, and gives up after two", async () => {
    let calls = 0;
    const t = await run(["2", "1", "2", "2"], {
      ask: async () => {
        calls += 1;
        return calls === 1 ? null : { v: 1, id: "x", at: 0, status: "refused", reason: ASK_FAILED };
      },
    });
    expect(calls).toBe(2);
    expect(t.call.said.filter((s) => s === ASK_FAILED)).toHaveLength(2);
    expect(t.call.said.filter((s) => s.startsWith("I heard:"))).toHaveLength(2);
    expect(t.log.sends).toEqual([]);
    expect(t.call.said.at(-1)).toBe("Goodbye.");
  });

  it("a status the Mac refuses is said, and the action menu comes back", async () => {
    const t = await run(["2", "3", "#"], {
      status: async () => ({
        v: 1,
        id: "x",
        at: 0,
        status: "refused",
        reason: "That list is out of date. Call again.",
      }),
    });
    expect(t.call.said).toContain("That list is out of date. Call again.");
  });

  it("says so when the Mac is silent on a status", async () => {
    const t = await run(["2", "3"], { status: async () => null });
    expect(t.call.said.at(-1)).toBe("I could not reach your Mac. Goodbye.");
  });

  it("invalid keys at the action menu are ignored twice, then the call ends; hash hangs up", async () => {
    const a = await run(["2", "7", "8"]);
    expect(a.log.memos).toBe(0);
    expect(a.call.said.at(-1)).toBe("Goodbye.");
    const b = await run(["2", "#"]);
    expect(b.call.said.at(-1)).toBe("Goodbye.");
  });

  it("silence at the read-back cancels without asking or sending", async () => {
    const t = await run(["2", "1", null]);
    expect(t.log.asks).toEqual([]);
    expect(t.log.sends).toEqual([]);
    expect(t.call.said.at(-1)).toBe("Cancelled. Goodbye.");
  });

  it("an older Mac (no ask flag) goes exactly as before: 2 records again, nothing new is offered", async () => {
    const { ask: _ask, ...old } = directory;
    void _ask;
    const t = await run(["2", "2", "#"], {}, [{ durationMs: 3000 }, { durationMs: 3000 }], old);
    expect(t.log.memos).toBe(2);
    expect(t.log.asks).toEqual([]);
    expect(t.call.said.join(" ")).not.toContain("hear where it stands");
  });

  it("has every fixed sentence made ahead of time; only answers and the read-back are made on the spot", async () => {
    const t = await run(["2", "3", "1", "1", "2", "#"]);
    const ready = new Set(inboundPrompts(directory, false));
    const late = t.call.said.filter((text) => !ready.has(text));
    expect(late.sort()).toEqual(
      [
        "Blume hub is working.",
        "Yes, the build is passing.",
        readBackSentence("is the build passing", "blume hub", true),
      ].sort(),
    );
  });
});

describe("the ask protocol", () => {
  const { key } = generateChannel();
  it("seals and reads ask, status and answer, and the directory flag", () => {
    const up = (message: UpMessage) => readUp(key, message.id, sealUp(key, message), message.at + 1);
    expect(up({ v: 1, id: "a1", at: 1, expiresAt: 100, kind: "ask", memoId: "m" })).toMatchObject({
      ok: true,
      message: { kind: "ask", memoId: "m" },
    });
    expect(up({ v: 1, id: "a2", at: 1, expiresAt: 100, kind: "status", dirVersion: "v", choice: 2 })).toMatchObject({
      ok: true,
    });
    expect(up({ v: 1, id: "a3", at: 1, expiresAt: 100, kind: "status", dirVersion: "v", choice: 0 })).toMatchObject({
      ok: false,
    });
    const down: DownMessage = { v: 1, id: "d1", at: 1, status: "answer", text: "x".repeat(MAX_ANSWER_CHARS + 50) };
    const read = readDown(key, "d1", sealDown(key, down));
    expect(read?.status === "answer" && read.text.length).toBe(MAX_ANSWER_CHARS);
    expect(readDown(key, "d2", sealDown(key, { v: 1, id: "d2", at: 1, status: "answer", text: " " }))).toBeNull();
    const dir = readDirectory(key, sealDirectory(key, { ...directory, at: 5 }), 5);
    expect(dir?.ask).toBe(true);
    expect(
      readDirectory(key, sealDirectory(key, (({ ask: _a, ...rest }) => (void _a, { ...rest, at: 5 }))(directory)), 5)
        ?.ask,
    ).toBeUndefined();
  });
});

const inputs = (overrides: Partial<ChatBriefInputs> = {}): ChatBriefInputs => ({
  session: session({ state: "working", lastActivityAt: "2026-10-28T11:55:00.000Z" }),
  label: "squeak voice",
  lastTurnText: null,
  activity: { total: 1, steps: [{ kind: "tool", text: "Run tests in /Users/me/code/app/src", at: null }] },
  background: [],
  nowMs: Date.parse("2026-10-28T12:00:00.000Z"),
  ...overrides,
});

describe("the status read-out", () => {
  it("says state, what it is doing, changes, background work and the age, with no paths", () => {
    const text = statusReadout(
      inputs({
        session: session({
          state: "working",
          lastActivityAt: "2026-10-28T11:55:00.000Z",
          git: {
            branch: "voice",
            filesChanged: 3,
            insertions: 40,
            deletions: 5,
            untracked: 1,
            ahead: 0,
            behind: 0,
            hasUpstream: false,
            aheadOfBase: 2,
          } as never,
        }),
        background: [{ id: "t", kind: "agent", label: "x", background: true, status: "running", startedAt: null }],
      }),
    );
    expect(text).toContain("squeak voice is working.");
    expect(text).toContain("Right now: Run tests in");
    expect(text).toContain("4 files changed, 40 lines added and 5 removed, not pushed yet.");
    expect(text).toContain("1 helper agent still running.");
    expect(text).toContain("Last activity 5 minutes ago.");
    expect(text).not.toContain("/Users");
    expect(text.length).toBeLessThanOrEqual(MAX_ANSWER_CHARS);
  });

  it("says a finished chat's last message and that it is waiting when it asks", () => {
    const text = statusReadout(
      inputs({
        session: session({ state: "finished", asks: "Merge now?" }),
        lastTurnText: "## Done\nI merged the branch and ran **all** tests. Want a PR?",
        activity: null,
      }),
    );
    expect(text).toContain("finished and is asking you something.");
    expect(text).toContain("Its last message: I merged the branch");
    expect(text).not.toContain("**");
  });

  it("says approval, error and stuck states in plain words", () => {
    expect(statusReadout(inputs({ session: session({ state: "awaiting_approval" }) }))).toContain(
      "waiting for you to approve",
    );
    expect(statusReadout(inputs({ session: session({ state: "error" }) }))).toContain("stopped on an error");
    const stuck = session({
      state: "working",
      waitingOn: "model",
      waitingSince: "2026-10-28T11:30:00.000Z",
      lastActivityAt: "2026-10-28T11:30:00.000Z",
    });
    expect(statusReadout(inputs({ session: stuck }))).toContain("looks stuck");
  });
});

describe("a spoken answer", () => {
  it("is plain, whole sentences, at most 600 characters, with no markdown, paths, links or secrets", () => {
    const long = `${"The build passes. ".repeat(60)}`;
    const out = spokenAnswer(long);
    expect(out.length).toBeLessThanOrEqual(MAX_ANSWER_CHARS);
    expect(out.endsWith(".")).toBe(true);
    const messy = spokenAnswer(
      "**Yes.** See `src/app.ts` at https://x.dev/a and /Users/me/x.txt. token=abc123def456 and sk-abcdefghijklmnop1234",
    );
    expect(messy).not.toMatch(/\*|`|https|\/Users|abc123|sk-/);
    expect(messy).toContain("Yes.");
    expect(clipSpoken("a".repeat(900), 100).length).toBeLessThanOrEqual(100);
    expect(redactSecrets("Bearer abcdefghijklmnopqrstuvwxyz")).toBe("a secret");
  });

  it("is asked of a model with no tools through the runner, from the chat's own facts only", async () => {
    let seen: { system: string; user: string } | null = null;
    const questioner = new ChatQuestioner(async (prompt) => {
      seen = prompt;
      return { answer: "It is **passing**. See src/a.ts." };
    });
    const answer = await questioner.ask(
      "is the build passing",
      inputs({ lastTurnText: "Tests pass. password: hunter2hunter2" }),
    );
    expect(answer).toBe("It is passing. See");
    expect(seen!.user).toContain("is the build passing");
    expect(seen!.user).not.toContain("hunter2");
    expect(seen!.system).toContain("you cannot change the chat");
    expect(questionContext(inputs())).not.toContain("/Users/me");
  });

  it("fails with a sentence fit to say when the model errors, times out or says nothing", async () => {
    for (const run of [
      async () => Promise.reject(new Error("took too long")),
      async () => ({ answer: "  " }),
      async () => null,
    ]) {
      await expect(new ChatQuestioner(run).ask("q", inputs())).rejects.toThrow("I could not get an answer.");
    }
  });
});
