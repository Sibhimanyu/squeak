import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import type { ConductorRegistryAdapter } from "../adapters/conductor-registry.js";
import type { ConductorSessionRef, SessionMessageRecord } from "../types.js";
import { busyReason, ConductorReplier, type ReplyAgentAdapter } from "./session-reply.js";

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

function fixture(current: ConductorSessionRef = session(), messages: SessionMessageRecord[] = []) {
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
  const replier = new ConductorReplier({ registry, claude, codex });
  return { replier, claude, codex, appended, statuses };
}

describe("ConductorReplier.send", () => {
  it("resumes the agent's own session in the workspace and mirrors the prompt", async () => {
    const { replier, claude, appended, statuses } = fixture();
    const outcome = await replier.send("s1", "  A  ", () => undefined);

    expect(outcome).toEqual({ status: "started" });
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
