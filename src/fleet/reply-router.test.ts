import { describe, expect, it } from "vitest";

import { FleetReplyRouter, replyTargetFor } from "./reply-router.js";
import type { ReplyOutcome } from "./reply-types.js";
import type { TerminalReplier } from "./terminal-reply.js";
import { NativeReplier } from "./native-reply.js";
import { NativeHostError } from "../native/client.js";
import type { AddonReplier } from "../addons.js";
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
  const conductor: AddonReplier = {
    hostId: "conductor",
    canHandle: (s) => Boolean(s.hostId),
    ownsTarget: (target) => !target.includes(":"),
    lastTurnText: (id: string) => `conductor text for ${id}`,
    transcript: () => ({ messages: [], complete: true }),
    send: async (id: string, text: string, _onFailed: unknown, options?: { mode?: string }): Promise<ReplyOutcome> => {
      calls.push(`conductor ${id} ${text}${options?.mode ? ` [${options.mode}]` : ""}`);
      return { status: "started", via: "conductor" };
    },
  };
  const terminal = {
    canReply: () => terminalAnswers,
    lastTurnText: (target: FleetSession) => `terminal text for ${target.key}`,
    lastTurnId: (target: FleetSession) => `terminal turn for ${target.key}`,
    send: async (target: FleetSession, text: string): Promise<ReplyOutcome> => {
      calls.push(`terminal ${target.key} ${text}`);
      return { status: "started", via: "terminal" };
    },
  } as unknown as TerminalReplier;
  return { calls, router: new FleetReplyRouter({ hosts: () => [conductor], terminal, sessions: () => sessions }) };
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

  it("names the newest turn for a terminal agent, so a stale answer can be refused", () => {
    const { router } = harness([session({})]);
    expect(router.lastTurnId("claude-transcript:t1")).toBe("terminal turn for claude-transcript:t1");
    expect(router.lastTurnId("claude-transcript:gone")).toBeNull();
  });

  it("sends a fleet key to the terminal", async () => {
    const { router, calls } = harness([session({})]);
    expect(await router.send("claude-transcript:t1", "yes", () => undefined)).toEqual({
      status: "started",
      via: "terminal",
      delivery: "sent",
    });
    expect(calls).toEqual(["terminal claude-transcript:t1 yes"]);
    expect(router.lastTurnText("claude-transcript:t1")).toBe("terminal text for claude-transcript:t1");
  });

  it("follows a session Conductor has adopted since its card was sent", async () => {
    const { router, calls } = harness([session({ conductorSessionId: "c9", hostId: "conductor" })]);
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

describe("FleetReplyRouter without an enabled host", () => {
  it("refuses a host chat's id with a plain sentence instead of guessing", async () => {
    const router = new FleetReplyRouter({ hosts: () => [], sessions: () => [] });
    expect(await router.send("c1", "x", () => undefined)).toMatchObject({ status: "refused" });
    expect(router.lastTurnText("c1")).toBeNull();
    expect(router.canReply(session({ hostId: "conductor", conductorSessionId: "c1" }))).toBe(false);
    expect(await router.queue("c1")).toBeNull();
  });
});

describe("FleetReplyRouter modes", () => {
  it("hands the mode to Conductor's replier", async () => {
    const { router, calls } = harness([]);
    await router.send("c1", "go", () => undefined, { mode: "steer" });
    expect(calls).toEqual(["conductor c1 go [steer]"]);
  });

  it("tells the truth when a terminal agent was asked to steer", async () => {
    const { router } = harness([session({})]);
    const outcome = await router.send("claude-transcript:t1", "go", () => undefined, { mode: "steer" });
    expect(outcome).toMatchObject({ status: "started", via: "terminal", delivery: "sent" });
    expect(outcome.status === "started" && outcome.note).toMatch(/queued instead|Steer/);
  });
});

describe("FleetReplyRouter with native chats", () => {
  const native = session({ key: "squeak-native:n1", origin: "squeak", state: "awaiting_approval" });
  function nativeHarness(send: () => Promise<{ queued: boolean }>) {
    const sent: Array<[string, string, string | undefined]> = [];
    const replier = new NativeReplier({
      client: {
        send: async (id: string, text: string, mode?: "queue" | "steer") => {
          sent.push([id, text, mode]);
          return send();
        },
      },
      lastMessage: () => "last words",
    });
    const router = new FleetReplyRouter({
      hosts: () => [],
      native: replier,
      sessions: () => [native],
    });
    return { sent, router };
  }

  it("answers any native chat, even a blocked one, by queueing through the host", async () => {
    const { router, sent } = nativeHarness(async () => ({ queued: true }));
    expect(router.canReply(native)).toBe(true);
    expect(replyTargetFor(native)).toBe("squeak-native:n1");
    expect(router.lastTurnText("squeak-native:n1")).toBe("last words");
    const outcome = await router.send("squeak-native:n1", "go on", () => undefined, { mode: "steer" });
    expect(outcome).toMatchObject({ status: "started", via: "native", delivery: "queued" });
    expect(sent).toEqual([["n1", "go on", "queue"]]);
  });

  it("says the host is not running instead of throwing", async () => {
    const { router } = nativeHarness(async () => {
      throw new NativeHostError("x", "down");
    });
    const outcome = await router.send("squeak-native:n1", "hi", () => undefined);
    expect(outcome).toEqual({ status: "refused", reason: "Squeak's session host is not running." });
  });

  it("does not guess when the host did not answer in time", async () => {
    const { router } = nativeHarness(async () => {
      throw new NativeHostError("x", "timeout");
    });
    expect((await router.send("squeak-native:n1", "hi", () => undefined)).status).toBe("unconfirmed");
  });
});
