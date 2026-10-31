import { describe, expect, it } from "vitest";

import type { DownMessage, TalkPhase } from "./memo-protocol.js";
import type { PhoneCall } from "./phone.js";
import { talkFlow } from "./talk-flow.js";

type Take = { durationMs: number; ended?: "key" | "limit" | "silence" | "no-speech" } | null;

function fakeCall(takes: Take[], keys: Array<string | null> = []): PhoneCall & { said: string[] } {
  const call = {
    peer: "35210",
    open: true,
    said: [] as string[],
    closed: new Promise<void>(() => undefined),
    async say(text: string) {
      call.said.push(text);
    },
    async key() {
      return keys.shift() ?? null;
    },
    async beep() {},
    async record() {
      const next = takes.shift();
      return next
        ? { file: "/tmp/x.wav", durationMs: next.durationMs, ended: next.ended ?? ("silence" as const) }
        : null;
    },
    async hangup() {
      call.open = false;
    },
  };
  return call;
}

const talk = (text: string, next: "listen" | "confirm" | "end" | "hold"): DownMessage => ({
  v: 1,
  id: "i",
  at: 1,
  status: "talk",
  text,
  next,
});

function setup(replies: Array<DownMessage | null>) {
  const asked: Array<{ callId: string; phase: TalkPhase }> = [];
  const lines: string[] = [];
  return {
    asked,
    lines,
    deps: {
      uplink: {
        talk: async (callId: string, phase: TalkPhase) => {
          asked.push({ callId, phase });
          return replies.shift() ?? null;
        },
      },
      encode: async () => Buffer.from("opus"),
      trace: (line: string) => lines.push(line),
    },
  };
}

const info = { callId: "call-1", label: "squeak" };

describe("talkFlow", () => {
  it("answers a question, then reads a message back, and ends once the yes is sent", async () => {
    const t = setup([
      talk("It is passing.", "listen"),
      talk("I'll tell it: go with B. Say yes to send.", "confirm"),
      talk("Sent. Goodbye.", "end"),
    ]);
    const call = fakeCall([{ durationMs: 2000 }, { durationMs: 2000 }, { durationMs: 900 }]);
    expect(await talkFlow(call, t.deps, info)).toBe("ended");
    expect(t.asked).toEqual([
      { callId: "call-1", phase: "say" },
      { callId: "call-1", phase: "say" },
      { callId: "call-1", phase: "confirm" },
    ]);
    expect(call.said).toEqual(["It is passing.", "I'll tell it: go with B. Say yes to send.", "Sent. Goodbye."]);
    expect(t.lines).toContain("said: Sent. Goodbye.");
  });

  it("prompts once for silence, then leaves it with the person", async () => {
    const t = setup([]);
    // The second take is too short to be speech (a click), so it counts as silence too.
    const call = fakeCall([{ durationMs: 100, ended: "no-speech" }, { durationMs: 300 }]);
    expect(await talkFlow(call, t.deps, info)).toBe("ended");
    expect(call.said).toEqual([
      "I didn't hear anything. Tell me what to do, or ask me anything.",
      "I'll leave it with you. Goodbye.",
    ]);
    expect(t.asked).toEqual([]);
  });

  it("ends when the person hangs up mid-turn", async () => {
    expect(await talkFlow(fakeCall([]), setup([]).deps, info)).toBe("ended");
  });

  it("hands over to the keypad when the Mac cannot be reached or refuses", async () => {
    const unreachable = fakeCall([{ durationMs: 2000 }]);
    expect(await talkFlow(unreachable, setup([null]).deps, info)).toBe("keys");
    expect(unreachable.said).toEqual(["I could not reach your Mac. You can use the keypad."]);
    const refused = fakeCall([{ durationMs: 2000 }]);
    const reply: DownMessage = { v: 1, id: "i", at: 1, status: "refused", reason: "That call is no longer open." };
    expect(await talkFlow(refused, setup([reply]).deps, info)).toBe("keys");
    expect(refused.said).toEqual(["That call is no longer open."]);
  });

  describe("on hold", () => {
    it("waits through silent check-ins, speaks what the Mac says, and listens again when the work is done", async () => {
      const t = setup([
        talk("Sent. Want me to stay on the line while it works? Say yes to hold, or no to hang up.", "confirm"),
        talk("Okay, I'll stay on the line. Press 1 any time to hear what it's thinking, or hash to hang up.", "hold"),
        talk("", "hold"),
        talk("", "hold"),
        talk("squeak is done. All 40 tests pass. Ask me anything about it, or tell me what to do next.", "listen"),
        talk("Okay. Goodbye.", "end"),
      ]);
      const call = fakeCall([{ durationMs: 2000 }, { durationMs: 900 }, { durationMs: 1500 }]);
      expect(await talkFlow(call, t.deps, info)).toBe("ended");
      expect(t.asked.map((a) => a.phase)).toEqual(["say", "confirm", "hold", "hold", "hold", "say"]);
      expect(call.said).toEqual([
        "Sent. Want me to stay on the line while it works? Say yes to hold, or no to hang up.",
        "Okay, I'll stay on the line. Press 1 any time to hear what it's thinking, or hash to hang up.",
        "squeak is done. All 40 tests pass. Ask me anything about it, or tell me what to do next.",
        "Okay. Goodbye.",
      ]);
    });

    it("asks what the agent is thinking when 1 is pressed, with no recording, then carries on holding", async () => {
      const phases: Array<{ phase: TalkPhase; bytes: number }> = [];
      const replies = [
        talk("I'll stay.", "hold"),
        talk("Right now: reading the config.", "hold"),
        talk("It is done.", "end"),
      ];
      const deps = {
        uplink: {
          talk: async (_callId: string, phase: TalkPhase, audio: Buffer) => {
            phases.push({ phase, bytes: audio.length });
            return replies.shift() ?? null;
          },
        },
        encode: async () => Buffer.from("opus"),
      };
      const call = fakeCall([{ durationMs: 2000 }], ["1", null]);
      expect(await talkFlow(call, deps, info)).toBe("ended");
      expect(phases).toEqual([
        { phase: "say", bytes: 4 },
        { phase: "peek", bytes: 0 },
        { phase: "hold", bytes: 0 },
      ]);
      expect(call.said).toContain("Right now: reading the config.");
    });

    it("hangs up on hash without asking the Mac", async () => {
      const t = setup([talk("I'll stay.", "hold")]);
      const call = fakeCall([{ durationMs: 2000 }], ["#"]);
      expect(await talkFlow(call, t.deps, info)).toBe("ended");
      expect(t.asked.map((a) => a.phase)).toEqual(["say"]);
      expect(call.said.at(-1)).toBe("Goodbye.");
    });

    it("falls back to the keypad when the Mac stops answering during the hold", async () => {
      const t = setup([talk("I'll stay.", "hold"), null]);
      const call = fakeCall([{ durationMs: 2000 }]);
      expect(await talkFlow(call, t.deps, info)).toBe("keys");
      expect(call.said.at(-1)).toBe("I could not reach your Mac. You can use the keypad.");
    });
  });
});
