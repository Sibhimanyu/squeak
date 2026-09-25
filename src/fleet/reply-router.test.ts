import { describe, expect, it } from "vitest";

import { FleetReplyRouter, replyTargetFor } from "./reply-router.js";
import type { ReplyOutcome } from "./session-reply.js";
import type { TerminalReplier } from "./terminal-reply.js";
import type { FleetSession } from "./types.js";

function session(overrides: Partial<FleetSession>): FleetSession {
  return {
    key: "claude-transcript:t1",
    conductorSessionId: null,
    origin: "terminal",
    ...overrides,
  } as FleetSession;
}

function harness(sessions: FleetSession[], terminalAnswers = true) {
  const calls: string[] = [];
  const conductor = {
    lastTurnText: (id: string) => `conductor text for ${id}`,
    send: async (id: string, text: string): Promise<ReplyOutcome> => {
      calls.push(`conductor ${id} ${text}`);
      return { status: "started", via: "conductor" };
    },
  };
  const terminal = {
    canReply: () => terminalAnswers,
    lastTurnText: (target: FleetSession) => `terminal text for ${target.key}`,
    send: async (target: FleetSession, text: string): Promise<ReplyOutcome> => {
      calls.push(`terminal ${target.key} ${text}`);
      return { status: "started", via: "terminal" };
    },
  } as unknown as TerminalReplier;
  return { calls, router: new FleetReplyRouter({ conductor, terminal, sessions: () => sessions }) };
}

describe("replyTargetFor", () => {
  it("addresses a Conductor chat by its id and anything else by its fleet key", () => {
    expect(replyTargetFor(session({ conductorSessionId: "c1", key: "claude-transcript:t1" }))).toBe("c1");
    expect(replyTargetFor(session({}))).toBe("claude-transcript:t1");
  });
});

describe("FleetReplyRouter", () => {
  it("sends a Conductor id to Conductor, as every stored reply target before this did", async () => {
    const { router, calls } = harness([]);
    await router.send("c1", "B", () => undefined);
    expect(calls).toEqual(["conductor c1 B"]);
    expect(router.lastTurnText("c1")).toBe("conductor text for c1");
  });

  it("sends a fleet key to the terminal", async () => {
    const { router, calls } = harness([session({})]);
    expect(await router.send("claude-transcript:t1", "yes", () => undefined)).toEqual({
      status: "started",
      via: "terminal",
    });
    expect(calls).toEqual(["terminal claude-transcript:t1 yes"]);
    expect(router.lastTurnText("claude-transcript:t1")).toBe("terminal text for claude-transcript:t1");
  });

  it("follows a session Conductor has adopted since its card was sent", async () => {
    const { router, calls } = harness([session({ conductorSessionId: "c9" })]);
    await router.send("claude-transcript:t1", "yes", () => undefined);
    expect(calls).toEqual(["conductor c9 yes"]);
  });

  it("refuses a key it no longer tracks, or one the terminal cannot answer", async () => {
    expect((await harness([]).router.send("claude-transcript:gone", "x", () => undefined)).status).toBe("refused");
    const { router, calls } = harness([session({})], false);
    expect((await router.send("claude-transcript:t1", "x", () => undefined)).status).toBe("refused");
    expect(router.lastTurnText("claude-transcript:t1")).toBeNull();
    expect(calls).toEqual([]);
  });
});
