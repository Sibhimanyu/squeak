import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { CodexRunner, codexPolicyFor, type CodexClient } from "./codex-runner.js";
import type { RequestKind, Resolution, RunnerHooks, SessionStatus } from "./types.js";

class FakeClient extends EventEmitter {
  calls: { method: string; arg: unknown }[] = [];
  responses: { id: unknown; result?: unknown; error?: unknown }[] = [];
  start = vi.fn(async () => {});
  stop = vi.fn(async () => {});
  startThread = vi.fn(async (o: unknown) => {
    this.calls.push({ method: "startThread", arg: o });
    return "thread-1";
  });
  resumeThread = vi.fn(async (o: unknown) => {
    this.calls.push({ method: "resumeThread", arg: o });
  });
  startTurn = vi.fn(async (o: unknown) => {
    this.calls.push({ method: "startTurn", arg: o });
    return { turnId: "turn-1" };
  });
  steerTurn = vi.fn(async () => {});
  interruptTurn = vi.fn(async () => {});
  respond = vi.fn(async (id: unknown, result: unknown) => {
    this.responses.push({ id, result });
  });
  respondError = vi.fn(async (id: unknown, error: unknown) => {
    this.responses.push({ id, error });
  });
}

function setup(
  answer: (kind: RequestKind) => Resolution = () => ({ decision: "allow" }),
  mode = "default",
  resume?: string,
) {
  const client = new FakeClient();
  const log = {
    statuses: [] as SessionStatus[],
    messages: [] as { kind: string; payload: unknown }[],
    ends: [] as string[],
    requests: [] as { kind: RequestKind; payload: Record<string, unknown> }[],
    ids: [] as string[],
    deltas: [] as unknown[],
  };
  const hooks: RunnerHooks = {
    onAgentSessionId: (id) => log.ids.push(id),
    onMessage: (_r, kind, payload) => log.messages.push({ kind, payload }),
    onDelta: (d) => log.deltas.push(d),
    onStatus: (s) => log.statuses.push(s),
    onRequest: async (kind, payload) => {
      log.requests.push({ kind, payload: payload as Record<string, unknown> });
      return answer(kind);
    },
    onTurnEnd: (o) => log.ends.push(o),
    onExit: () => {},
  };
  const runner = new CodexRunner({
    cwd: "/w",
    model: "gpt-6.1-terra",
    effort: "low",
    permissionMode: mode,
    resume: resume ?? null,
    hooks,
    client: client as unknown as CodexClient,
  });
  return { client, log, runner };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const note = (c: FakeClient, method: string, params: Record<string, unknown>) =>
  c.emit("notification", { method, params: { threadId: "thread-1", ...params } });

describe("codexPolicyFor", () => {
  it("maps Squeak's modes", () => {
    expect(codexPolicyFor("default")).toMatchObject({ approvalPolicy: "untrusted", sandbox: "workspace-write" });
    expect(codexPolicyFor("acceptEdits")).toMatchObject({ approvalPolicy: "on-request", sandbox: "workspace-write" });
    expect(codexPolicyFor("bypassPermissions")).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    expect(codexPolicyFor("plan")).toMatchObject({ approvalPolicy: "untrusted", sandboxPolicy: { type: "readOnly" } });
  });
});

describe("CodexRunner", () => {
  it("starts a thread with the mapped policy and sends the policy, model and effort on every turn", async () => {
    const { client, log, runner } = setup();
    await runner.send("one");
    await runner.send("two");
    expect(client.start).toHaveBeenCalledTimes(1);
    expect(client.startThread).toHaveBeenCalledWith({
      cwd: "/w",
      model: "gpt-6.1-terra",
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
    });
    const turns = client.calls.filter((c) => c.method === "startTurn").map((c) => c.arg);
    for (const t of turns) {
      expect(t).toMatchObject({
        threadId: "thread-1",
        model: "gpt-6.1-terra",
        effort: "low",
        approvalPolicy: "untrusted",
        sandboxPolicy: { type: "workspaceWrite" },
      });
    }
    expect(log.ids).toEqual(["thread-1"]);
  });

  it("resumes a known thread, and a changed mode reaches the next turn", async () => {
    const { client, runner } = setup(undefined, "default", "thread-1");
    await runner.send("a");
    expect(client.resumeThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread-1" }));
    expect(client.startThread).not.toHaveBeenCalled();
    await runner.setPermissionMode("bypassPermissions");
    await runner.send("b");
    expect(client.startTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }),
    );
  });

  it("maps a command approval to accept and a file change to decline, with the changes attached", async () => {
    const { client, log, runner } = setup((kind) =>
      kind === "command" ? { decision: "allow" } : { decision: "deny" },
    );
    await runner.send("go");
    client.emit("server-request", {
      id: 0,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", itemId: "exec-1", command: "touch x" },
    });
    note(client, "item/started", { item: { type: "fileChange", id: "fc-1", changes: [{ path: "a.txt" }] } });
    client.emit("server-request", {
      id: 1,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", itemId: "fc-1" },
    });
    await tick();
    expect(client.responses).toEqual([
      { id: 0, result: { decision: "accept" } },
      { id: 1, result: { decision: "decline" } },
    ]);
    expect(log.requests.map((r) => r.kind)).toEqual(["command", "file_change"]);
    expect(log.requests[1]!.payload.item).toMatchObject({ id: "fc-1", changes: [{ path: "a.txt" }] });
    expect(log.statuses).toContain("needs_user_permission");
  });

  it("answers a request it does not handle with method-not-found", async () => {
    const { client, runner } = setup();
    await runner.send("go");
    client.emit("server-request", { id: 7, method: "item/tool/call", params: {} });
    await tick();
    expect(client.responses[0]).toMatchObject({ id: 7, error: { code: -32601 } });
  });

  it("stores completed items (not the echoed user message), streams deltas, and ends turns", async () => {
    const { client, log, runner } = setup();
    await runner.send("go");
    note(client, "item/completed", { item: { type: "userMessage", id: "u" } });
    note(client, "item/completed", { item: { type: "agentMessage", id: "a", text: "hi" } });
    note(client, "item/agentMessage/delta", { itemId: "a", delta: "h" });
    client.emit("notification", {
      method: "item/completed",
      params: { threadId: "other", item: { type: "agentMessage" } },
    });
    note(client, "turn/completed", { turn: { id: "turn-1", status: "completed" } });
    note(client, "turn/completed", { turn: { id: "turn-2", status: "interrupted" } });
    note(client, "turn/completed", { turn: { id: "turn-3", status: "failed" } });
    expect(log.messages.map((m) => m.kind)).toEqual([
      "item/agentMessage",
      "turn/completed",
      "turn/completed",
      "turn/completed",
    ]);
    expect(log.deltas).toHaveLength(1);
    expect(log.ends).toEqual(["idle", "idle", "error"]);
  });

  it("steers and interrupts the live turn only", async () => {
    const { client, log, runner } = setup();
    expect(await runner.steer("x")).toBe(false);
    await runner.send("go");
    expect(await runner.steer("nudge")).toBe(true);
    expect(client.steerTurn).toHaveBeenCalledWith({ threadId: "thread-1", expectedTurnId: "turn-1", input: "nudge" });
    await runner.interrupt();
    expect(client.interruptTurn).toHaveBeenCalledWith({ threadId: "thread-1", turnId: "turn-1" });
    expect(log.statuses).toContain("cancelling");
    note(client, "turn/completed", { turn: { id: "turn-1", status: "interrupted" } });
    expect(await runner.steer("late")).toBe(false);
  });

  it("setModel applies to the next turn", async () => {
    const { client, runner } = setup();
    await runner.setModel("gpt-next", "high");
    await runner.send("go");
    expect(client.calls.find((c) => c.method === "startTurn")!.arg).toMatchObject({
      model: "gpt-next",
      effort: "high",
    });
  });
});
