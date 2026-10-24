import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { ConductorRegistryAdapter } from "../adapters/conductor-registry.js";
import type { ConductorSessionRef, SessionMessageRecord, SessionStatus } from "../types.js";
import type { ConductorUiSender, UiSendResult } from "./conductor-ui.js";
import { busyReason, ConductorReplier, type ConductorRelaySender, type ReplyAgentAdapter } from "./session-reply.js";

class FakeAdapter extends EventEmitter implements ReplyAgentAdapter {
  readonly turns: Array<{ threadId: string; input: string; cwd?: string | null; model?: string | null }> = [];
  started = 0;
  failStart: Error | null = null;

  async start(): Promise<void> {
    this.started += 1;
  }
  async stop(): Promise<void> {}
  async resumeThread(): Promise<void> {}
  async startTurn(options: { threadId: string; input: string; cwd?: string | null; model?: string | null }) {
    if (this.failStart) {
      throw this.failStart;
    }
    this.turns.push(options);
    return { turnId: `turn-${this.turns.length}` };
  }

  complete(threadId: string, status: "completed" | "failed", text?: string, error?: string): void {
    if (text) {
      this.emit("notification", {
        method: "item/completed",
        params: { threadId, turnId: "turn-1", item: { type: "agentMessage", text } },
      });
    }
    this.emit("notification", {
      method: "turn/completed",
      params: { threadId, turn: { id: "turn-1", status, error: error ? { message: error } : null } },
    });
  }
}

function session(overrides: Partial<ConductorSessionRef> = {}): ConductorSessionRef {
  return {
    id: "s1",
    workspaceId: "w1",
    status: "idle",
    agentType: "claude",
    model: "opus-5-1m",
    permissionMode: "default",
    title: "Farm",
    claudeSessionId: "thread-1",
    updatedAt: "2026-09-23T00:00:00Z",
    lastUserMessageAt: null,
    ...overrides,
  } as ConductorSessionRef;
}

function assistantRow(turnId: string, blocks: unknown[], type = "assistant"): SessionMessageRecord {
  return {
    role: "assistant",
    content: JSON.stringify({ type, message: { role: "assistant", content: blocks } }),
    sentAt: "2026-09-23T00:00:00Z",
    turnId,
    model: null,
  } as SessionMessageRecord;
}

function fixture(
  current: ConductorSessionRef = session(),
  messages: SessionMessageRecord[] = [],
  ui: ConductorUiSender | null = null,
  relay: ConductorRelaySender | null = null,
) {
  const appended: Array<{ role: string; content: string }> = [];
  const statuses: string[] = [];
  const registry = {
    getSessionById: vi.fn(() => current),
    resolveWorkspacePath: vi.fn(() => "/work/farm"),
    listSessionMessages: vi.fn(() => messages),
    appendSessionMessage: vi.fn((params: { role: string; content: string }) => {
      appended.push({ role: params.role, content: params.content });
      return "id";
    }),
    updateSessionStatus: vi.fn((_id: string, status: string) => statuses.push(status)),
    updateSessionLastUserMessageAt: vi.fn(),
  } as unknown as ConductorRegistryAdapter;
  const claude = new FakeAdapter();
  const codex = new FakeAdapter();
  const replier = new ConductorReplier({
    registry,
    claude,
    codex,
    ui,
    relay,
    confirmTimeoutMs: 0,
    sleep: async () => {},
  });
  return { replier, claude, codex, appended, statuses };
}

describe("ConductorReplier.send", () => {
  it("resumes the agent's own session in the workspace and mirrors the prompt", async () => {
    const { replier, claude, appended, statuses } = fixture();
    const outcome = await replier.send("s1", "  A  ", () => undefined);

    expect(outcome).toEqual({ status: "started", via: "background", fallbackReason: null, delivery: "sent" });
    expect(claude.turns).toEqual([{ threadId: "thread-1", input: "A", cwd: "/work/farm", model: "opus-5-1m" }]);
    expect(appended).toEqual([{ role: "user", content: "A" }]);
    expect(statuses).toEqual(["working"]);
  });

  it("mirrors the answer in Conductor's envelope and puts the chat back to idle", async () => {
    const { replier, claude, appended, statuses } = fixture();
    await replier.send("s1", "A", () => undefined);
    claude.complete("thread-1", "completed", "Armed.");

    const assistant = appended.find((row) => row.role === "assistant");
    expect(JSON.parse(assistant!.content).message.content).toEqual([{ type: "text", text: "Armed." }]);
    expect(statuses).toEqual(["working", "idle"]);
    expect(replier.isReplying("s1")).toBe(false);
  });

  it("reports a failed turn once and marks the chat as errored", async () => {
    const { replier, claude, statuses } = fixture();
    const onFailed = vi.fn();
    await replier.send("s1", "A", onFailed);
    claude.complete("thread-1", "failed", undefined, "claude exited unexpectedly (1, null)");

    expect(onFailed).toHaveBeenCalledWith("claude exited unexpectedly (1, null)");
    expect(statuses).toEqual(["working", "error"]);
  });

  it("refuses a second reply while the first is still running", async () => {
    const { replier, claude } = fixture();
    await replier.send("s1", "A", () => undefined);
    const second = await replier.send("s1", "B", () => undefined);

    expect(second.status).toBe("refused");
    expect(claude.turns).toHaveLength(1);
  });

  it("refuses a chat that Conductor itself is busy with", async () => {
    const { replier, claude } = fixture(session({ status: "working" }));
    const outcome = await replier.send("s1", "A", () => undefined);

    expect(outcome.status).toBe("refused");
    expect(claude.turns).toHaveLength(0);
  });

  it("names the cause when Codex's writer lock is held by an open Conductor chat", async () => {
    const { replier, codex } = fixture(session({ agentType: "codex" }));
    codex.failStart = new Error("thread thread-1 already has an active writer");
    const outcome = await replier.send("s1", "A", () => undefined);

    expect(outcome).toEqual({ status: "refused", reason: expect.stringContaining("open in Conductor") });
    expect(codex.started).toBe(1);
    expect(replier.isReplying("s1")).toBe(false);
  });

  it("refuses agents it cannot drive", async () => {
    const { replier } = fixture(session({ agentType: "acp" }));
    expect((await replier.send("s1", "A", () => undefined)).status).toBe("refused");
  });
});

describe("ConductorReplier.lastTurnText", () => {
  it("returns the last text of the newest turn, skipping tool and result rows", () => {
    // Newest first, as listSessionMessages returns them.
    const { replier } = fixture(session(), [
      assistantRow("t2", [], "result"),
      assistantRow("t2", [{ type: "text", text: "Pick one:\nA) x\nB) y" }]),
      assistantRow("t2", [{ type: "tool_use", name: "Bash" }]),
      assistantRow("t2", [{ type: "text", text: "Looking…" }]),
      { role: "user", content: "go", sentAt: null, turnId: "t2", model: null } as unknown as SessionMessageRecord,
      assistantRow("t1", [{ type: "text", text: "Older turn" }]),
    ]);
    expect(replier.lastTurnText("s1")).toBe("Pick one:\nA) x\nB) y");
  });

  it("does not resurface an older turn's question once a new turn has begun", () => {
    const { replier } = fixture(session(), [
      assistantRow("t2", [{ type: "tool_use", name: "Bash" }]),
      { role: "user", content: "A", sentAt: null, turnId: "t2", model: null } as unknown as SessionMessageRecord,
      assistantRow("t1", [{ type: "text", text: "A) x\nB) y" }]),
    ]);
    expect(replier.lastTurnText("s1")).toBeNull();
  });
});

describe("busyReason", () => {
  it("only lets idle and errored chats take a message", () => {
    expect(busyReason("idle")).toBeNull();
    expect(busyReason("error")).toBeNull();
    for (const status of ["working", "cancelling", "needs_user_input", "needs_plan_response"]) {
      expect(busyReason(status)).not.toBeNull();
    }
  });
});

function fakeUi(result: UiSendResult): ConductorUiSender & { requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    send: async (request) => {
      requests.push(request);
      return result;
    },
  };
}

describe("ConductorReplier.send through Conductor's window", () => {
  it("types into Conductor and leaves the chat to Conductor, with no mirroring", async () => {
    const ui = fakeUi({ ok: true });
    const { replier, claude, appended, statuses } = fixture(session(), [], ui);

    expect(await replier.send("s1", "A", () => undefined)).toEqual({
      status: "started",
      via: "conductor",
      delivery: "sent",
    });
    expect(ui.requests).toEqual([{ workspaceId: "w1", sessionId: "s1", sessionTitle: "Farm", text: "A" }]);
    expect(claude.turns).toHaveLength(0);
    expect(appended).toEqual([]);
    expect(statuses).toEqual([]);
  });

  it("goes through the window even while Conductor is working, since Conductor queues it itself", async () => {
    const ui = fakeUi({ ok: true });
    const { replier } = fixture(session({ status: "working" }), [], ui);
    expect((await replier.send("s1", "A", () => undefined)).status).toBe("started");
  });

  it("falls back to the background, with the reason, when nothing was typed", async () => {
    const ui = fakeUi({ ok: false, error: "locked" });
    const { replier, claude } = fixture(session(), [], ui);

    expect(await replier.send("s1", "A", () => undefined)).toEqual({
      status: "started",
      via: "background",
      fallbackReason: "the Mac is locked",
      delivery: "sent",
    });
    expect(claude.turns).toHaveLength(1);
  });

  it("never sends a second time when the window may already have sent it", async () => {
    const ui = fakeUi({ ok: false, error: "unconfirmed" });
    const { replier, claude } = fixture(session(), [], ui);

    const outcome = await replier.send("s1", "A", () => undefined);
    expect(outcome.status).toBe("unconfirmed");
    expect(claude.turns).toHaveLength(0);
  });

  it("counts an unconfirmed send as sent once Conductor has recorded it", async () => {
    const ui = fakeUi({ ok: false, error: "unconfirmed" });
    const recorded = {
      role: "user",
      content: "A",
      sentAt: "2999-01-01T00:00:00.000Z",
      turnId: "t9",
      model: null,
    } as unknown as SessionMessageRecord;
    const { replier, claude } = fixture(session(), [recorded], ui);

    expect(await replier.send("s1", "A", () => undefined)).toEqual({
      status: "started",
      via: "conductor",
      delivery: "sent",
    });
    expect(claude.turns).toHaveLength(0);
  });

  it("still refuses a question held open inside Conductor, without touching the window", async () => {
    const ui = fakeUi({ ok: true });
    const { replier } = fixture(session({ status: "needs_user_input" }), [], ui);

    expect((await replier.send("s1", "A", () => undefined)).status).toBe("refused");
    expect(ui.requests).toEqual([]);
  });
});

describe("ConductorReplier.send queue and steer", () => {
  /**
   * `proof`: what Conductor shows after the relay's 2xx. `auto` is what a healthy one does: a working chat
   * lists the message in its queue, a resting one records it as a user message.
   */
  function relayFixture(
    status: ConductorSessionRef["status"],
    ok = true,
    proof: "auto" | "none" | "queue-idle" = "auto",
  ) {
    const sent: Array<{ text: string; mode?: string }> = [];
    const rows: SessionMessageRecord[] = [];
    const relay: ConductorRelaySender = {
      isReady: () => true,
      send: async ({ text, mode }) => {
        sent.push({ text, ...(mode ? { mode } : {}) });
        if (ok && proof === "auto" && status === "idle") {
          rows.push({ role: "user", content: text, sentAt: new Date().toISOString() } as SessionMessageRecord);
        }
        return ok ? { ok: true } : { ok: false, reason: "down" };
      },
      queue: async () => ({
        ok: true,
        items:
          proof === "none" || (proof === "auto" && status === "idle")
            ? []
            : sent.map((message, position) => ({
                id: `q${position}`,
                text: message.text,
                mode: "queue" as const,
                position,
              })),
      }),
    };
    return { ...fixture(session({ status }), rows, null, relay), sent };
  }

  it("never says sent when Conductor accepted a message and nothing shows it", async () => {
    const { replier } = relayFixture("idle", true, "none");
    const outcome = await replier.send("s1", "hi", () => undefined);
    expect(outcome.status).toBe("unconfirmed");
  });

  it("says nothing started when the message sits in the queue of a chat that is not running", async () => {
    const { replier } = relayFixture("idle", true, "queue-idle");
    const outcome = await replier.send("s1", "hi", () => undefined);
    expect(outcome).toMatchObject({ status: "unconfirmed", reason: expect.stringMatching(/not started/) });
  });

  it("does not take a queued message that is not there for one that is mid-turn", async () => {
    const { replier } = relayFixture("working", true, "none");
    expect((await replier.send("s1", "next", () => undefined)).status).toBe("unconfirmed");
  });

  it("reports queued when the agent is mid-turn and the message was queued", async () => {
    const { replier, sent } = relayFixture("working");
    const outcome = await replier.send("s1", "next", () => undefined, { mode: "queue" });
    expect(outcome).toEqual({ status: "started", via: "conductor", delivery: "queued" });
    expect(sent).toEqual([{ text: "next", mode: "queue" }]);
  });

  it("defaults to queue and treats a background-working chat as mid-turn", async () => {
    const { replier, sent } = relayFixture("waiting");
    const outcome = await replier.send("s1", "next", () => undefined);
    expect(outcome).toMatchObject({ delivery: "queued" });
    expect(sent[0]?.mode).toBe("queue");
  });

  it("steers through the relay while the agent works", async () => {
    const { replier, sent } = relayFixture("working");
    const outcome = await replier.send("s1", "change course", () => undefined, { mode: "steer" });
    expect(outcome).toEqual({ status: "started", via: "conductor", delivery: "steered" });
    expect(sent).toEqual([{ text: "change course", mode: "steer" }]);
  });

  it("just sends to an idle chat, even if steer was asked for", async () => {
    const { replier, sent } = relayFixture("idle");
    const outcome = await replier.send("s1", "hi", () => undefined, { mode: "steer" });
    expect(outcome).toEqual({ status: "started", via: "conductor", delivery: "sent" });
    expect(sent[0]?.mode).toBe("queue");
  });

  it("queues instead, and says so, when steer lands on a route that cannot steer", async () => {
    const ui: ConductorUiSender = { send: async () => ({ ok: true }) as UiSendResult };
    const { replier } = fixture(session({ status: "working" }), [], ui);
    const outcome = await replier.send("s1", "change course", () => undefined, { mode: "steer" });
    expect(outcome).toMatchObject({ status: "started", via: "conductor", delivery: "queued" });
    expect(outcome.status === "started" && outcome.note).toMatch(/queued instead/);
  });
});

describe("ConductorReplier queued messages", () => {
  const item = {
    id: "0f4c8a52-3c1e-4b9e-9a57-6f0e2d1c7b31",
    text: "Then add tests",
    mode: "queue" as const,
    position: 0,
  };

  function queueFixture(overrides: Partial<ConductorRelaySender> = {}) {
    const calls: unknown[][] = [];
    const relay: ConductorRelaySender = {
      isReady: () => true,
      send: async (args) => {
        calls.push(["send", args]);
        return { ok: true };
      },
      queue: async (workspaceId, sessionId) => {
        calls.push(["queue", workspaceId, sessionId]);
        return { ok: true, items: [item] };
      },
      promote: async (workspaceId, sessionId, messageId) => {
        calls.push(["promote", workspaceId, sessionId, messageId]);
        return { ok: true };
      },
      cancel: async (workspaceId, sessionId, messageId) => {
        calls.push(["cancel", workspaceId, sessionId, messageId]);
        return { ok: true };
      },
      stopTurn: async (workspaceId, sessionId) => {
        calls.push(["stop", workspaceId, sessionId]);
        return { ok: true };
      },
      ...overrides,
    };
    return { ...fixture(session({ status: "working" }), [], null, relay), calls };
  }

  it("passes the caller's message id to the relay, and only there", async () => {
    const { replier, calls } = queueFixture();
    await replier.send("s1", "next", () => undefined, { messageId: item.id });
    expect(calls[0]).toEqual([
      "send",
      { workspaceId: "w1", sessionId: "s1", text: "next", mode: "queue", messageId: item.id },
    ]);
    // Every other call is the read that proves it arrived.
    expect(calls.slice(1).every((call) => call[0] === "queue")).toBe(true);
  });

  it("reads the queue through the relay, in the chat's workspace", async () => {
    const { replier, calls } = queueFixture();
    expect(await replier.queue("s1")).toEqual([item]);
    expect(calls).toEqual([["queue", "w1", "s1"]]);
  });

  it("cannot read the queue without a connected relay", async () => {
    const { replier } = queueFixture({ isReady: () => false });
    expect(await replier.queue("s1")).toBeNull();
    const { replier: failing } = queueFixture({ queue: async () => ({ ok: false, reason: "relay HTTP 500" }) });
    expect(await failing.queue("s1")).toBeNull();
  });

  it("promotes and cancels through the relay", async () => {
    const { replier, calls } = queueFixture();
    expect(await replier.queueAction("s1", item.id, "promote")).toEqual({ ok: true });
    expect(await replier.queueAction("s1", item.id, "cancel")).toEqual({ ok: true });
    expect(calls).toEqual([
      ["promote", "w1", "s1", item.id],
      ["cancel", "w1", "s1", item.id],
    ]);
  });

  it("says a message already went when the relay no longer finds it, and why otherwise", async () => {
    const gone = queueFixture({ promote: async () => ({ ok: false, reason: "not in the queue" }) });
    expect(await gone.replier.queueAction("s1", item.id, "promote")).toEqual({
      ok: false,
      reason: "That message already went to the agent.",
    });
    const refused = queueFixture({ cancel: async () => ({ ok: false, reason: "relay HTTP 409" }) });
    expect(await refused.replier.queueAction("s1", item.id, "cancel")).toEqual({
      ok: false,
      reason: "Conductor didn't take that change (relay HTTP 409).",
    });
    const down = queueFixture({ isReady: () => false });
    expect(await down.replier.queueAction("s1", item.id, "cancel")).toMatchObject({ ok: false });
  });
});

describe("ConductorReplier stop", () => {
  function stopFixture(status: SessionStatus, overrides: Partial<ConductorRelaySender> = {}) {
    const calls: unknown[][] = [];
    const relay: ConductorRelaySender = {
      isReady: () => true,
      send: async () => ({ ok: true }),
      stopTurn: async (workspaceId, sessionId) => {
        calls.push(["stop", workspaceId, sessionId]);
        return { ok: true };
      },
      ...overrides,
    };
    return { ...fixture(session({ status }), [], null, relay), calls };
  }

  it("stops a working chat through Conductor's own Stop, in its workspace", async () => {
    const { replier, calls } = stopFixture("working");
    expect(await replier.stopTurn("s1")).toEqual({ ok: true });
    expect(calls).toEqual([["stop", "w1", "s1"]]);
  });

  it("refuses a chat that is not working, and touches nothing", async () => {
    const { replier, calls } = stopFixture("idle");
    expect(await replier.stopTurn("s1")).toEqual({ ok: false, reason: "The agent isn't working any more." });
    expect(calls).toEqual([]);
  });

  it("refuses without the relay, and says why Conductor refused", async () => {
    const down = stopFixture("working", { isReady: () => false });
    expect(await down.replier.stopTurn("s1")).toMatchObject({ ok: false, reason: /relay isn't connected/ });
    const refused = stopFixture("working", { stopTurn: async () => ({ ok: false, reason: "relay HTTP 500" }) });
    expect(await refused.replier.stopTurn("s1")).toEqual({
      ok: false,
      reason: "Conductor didn't stop it (relay HTTP 500).",
    });
  });
});

describe("ConductorReplier setSetup", () => {
  function setupFixture(status: SessionStatus, overrides: Partial<ConductorRelaySender> = {}) {
    const calls: unknown[][] = [];
    const relay: ConductorRelaySender = {
      isReady: () => true,
      send: async () => ({ ok: true }),
      setSetup: async (workspaceId, sessionId, setup) => {
        calls.push([workspaceId, sessionId, setup]);
        return { ok: true };
      },
      ...overrides,
    };
    return { ...fixture(session({ status }), [], null, relay), calls };
  }
  const change = { model: "opus-5-5", thinkingLevel: "high", fastMode: false };

  it("changes a resting chat through Conductor's picker route, naming its agent", async () => {
    const { replier, calls } = setupFixture("idle");
    expect(await replier.setSetup("s1", change)).toEqual({ ok: true });
    expect(calls).toEqual([["w1", "s1", { agent: "claude", ...change }]]);
  });

  it("refuses while a turn runs, and without the relay", async () => {
    const busy = setupFixture("working");
    expect(await busy.replier.setSetup("s1", change)).toMatchObject({ ok: false, reason: /mid-turn/ });
    expect(busy.calls).toEqual([]);
    const down = setupFixture("idle", { isReady: () => false });
    expect(await down.replier.setSetup("s1", change)).toMatchObject({ ok: false, reason: /relay isn't connected/ });
  });
});

describe("ConductorReplier.lastTurnError", () => {
  const row = (content: object) =>
    ({
      role: "assistant",
      content: JSON.stringify(content),
      sentAt: null,
      turnId: "t2",
      model: null,
    }) as unknown as SessionMessageRecord;
  const user = {
    role: "user",
    content: "go",
    sentAt: null,
    turnId: "t2",
    model: null,
  } as unknown as SessionMessageRecord;

  it("reads the agent's error row, skipping ones it retried", () => {
    const { replier } = fixture(session(), [
      row({ type: "error", content: "Your workspace is out of credits.", willRetry: false }),
      row({ type: "error", content: "Reconnecting... 5/5", willRetry: true }),
      user,
    ]);
    expect(replier.lastTurnError("s1")).toBe("Your workspace is out of credits.");
  });

  it("reads a result row that is an error", () => {
    const { replier } = fixture(session(), [
      row({ type: "result", is_error: true, result: "You've hit your session limit · resets 7:20pm" }),
      user,
    ]);
    expect(replier.lastTurnError("s1")).toBe("You've hit your session limit · resets 7:20pm");
  });

  it("ignores stop, success, and an earlier turn's error", () => {
    const { replier } = fixture(session(), [
      row({ type: "error", content: "aborted by user" }),
      row({ type: "result", is_error: false, result: "fine" }),
      user,
      row({ type: "error", content: "Old failure" }),
    ]);
    expect(replier.lastTurnError("s1")).toBeNull();
  });
});
