import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CodexRunner, SKIP_APPROVALS, codexPolicyFor, type CodexClient } from "./codex-runner.js";
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
  steerTurn = vi.fn(async (o: unknown) => {
    this.calls.push({ method: "steerTurn", arg: o });
  });
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
    messages: [] as { role?: string; kind: string; payload: unknown }[],
    ends: [] as string[],
    details: [] as (string | undefined)[],
    requests: [] as { kind: RequestKind; payload: Record<string, unknown> }[],
    ids: [] as string[],
    deltas: [] as unknown[],
  };
  const hooks: RunnerHooks = {
    onAgentSessionId: (id) => log.ids.push(id),
    onMessage: (role, kind, payload) => log.messages.push({ role, kind, payload }),
    onDelta: (d) => log.deltas.push(d),
    onStatus: (s) => log.statuses.push(s),
    onRequest: async (kind, payload) => {
      log.requests.push({ kind, payload: payload as Record<string, unknown> });
      return answer(kind);
    },
    onTurnEnd: (o, d) => {
      log.ends.push(o);
      log.details.push(d);
    },
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
      approvalPolicy: SKIP_APPROVALS,
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

  it("a read-only root (Main of a git pond for a duck) holds Codex in the read-only sandbox in every mode with the approval policy of the chosen mode; none leaves the mode alone", async () => {
    for (const mode of ["default", "acceptEdits", "bypassPermissions"]) {
      const client = new FakeClient();
      const hooks = {
        onAgentSessionId() {},
        onMessage() {},
        onDelta() {},
        onStatus() {},
        onRequest: async () => ({ decision: "allow" }),
        onTurnEnd() {},
        onExit() {},
      };
      const guarded = new CodexRunner({
        cwd: "/w",
        model: "m",
        permissionMode: mode,
        hooks: hooks as never,
        client: client as unknown as CodexClient,
        readOnlyRoot: "/w",
      });
      await guarded.send("go");
      expect(client.startThread).toHaveBeenCalledWith(
        expect.objectContaining({ sandbox: "read-only", approvalPolicy: codexPolicyFor(mode).approvalPolicy }),
      );
      expect(client.calls.find((c) => c.method === "startTurn")!.arg).toMatchObject({
        sandboxPolicy: { type: "readOnly" },
      });
      const open = new CodexRunner({
        cwd: "/w",
        model: "m",
        permissionMode: mode,
        hooks: hooks as never,
        client: new FakeClient() as unknown as CodexClient,
        readOnlyRoot: null,
      });
      const c2 = (open as unknown as { options: { client: FakeClient } }).options.client;
      await open.send("go");
      expect(c2.startThread).toHaveBeenCalledWith(expect.objectContaining({ sandbox: codexPolicyFor(mode).sandbox }));
    }
  });

  it("a read-only Main with joined Streams: writable roots for them, Main not the workspace, none when it has none", async () => {
    const client = new FakeClient();
    const hooks = {
      onAgentSessionId() {},
      onMessage() {},
      onDelta() {},
      onStatus() {},
      onRequest: async () => ({ decision: "allow" }),
      onTurnEnd() {},
      onExit() {},
    };
    let streams: string[] = [];
    const runner = new CodexRunner({
      cwd: "/main",
      model: "m",
      permissionMode: "bypassPermissions",
      hooks: hooks as never,
      client: client as unknown as CodexClient,
      readOnlyRoot: "/main",
      streamDirs: () => streams,
    });
    await runner.send("a");
    expect(client.startTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ cwd: "/main", sandboxPolicy: { type: "readOnly" } }),
    );
    streams = ["/ws/a", "/ws/b"];
    await runner.send("b");
    expect(client.startTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cwd: "/ws/a",
        approvalPolicy: SKIP_APPROVALS,
        sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/ws/a", "/ws/b"] },
      }),
    );
    // Accept edits and Ask follow their own approval policy; Plan stays read-only
    for (const [mode, policy, sandbox] of [
      ["acceptEdits", "on-request", { type: "workspaceWrite", writableRoots: ["/ws/a", "/ws/b"] }],
      ["default", "untrusted", { type: "workspaceWrite", writableRoots: ["/ws/a", "/ws/b"] }],
      ["plan", "untrusted", { type: "readOnly" }],
    ] as const) {
      await runner.setPermissionMode(mode);
      await runner.send(mode);
      expect(client.startTurn).toHaveBeenLastCalledWith(
        expect.objectContaining({ approvalPolicy: policy, sandboxPolicy: sandbox }),
      );
    }
    await runner.setPermissionMode("bypassPermissions");
    streams = [];
    await runner.send("c");
    expect(client.startTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ cwd: "/main", sandboxPolicy: { type: "readOnly" } }),
    );
  });

  it("a resumed thread asks for the chat's new folder (a thread resumes by id; the folder is only an override)", async () => {
    const client = new FakeClient();
    const hooks = {
      onAgentSessionId() {},
      onMessage() {},
      onDelta() {},
      onStatus() {},
      onRequest: async () => ({ decision: "allow" }),
      onTurnEnd() {},
      onExit() {},
    };
    const runner = new CodexRunner({
      cwd: "/main",
      model: "m",
      permissionMode: "default",
      resume: "thread-old",
      hooks: hooks as never,
      client: client as unknown as CodexClient,
    });
    await runner.send("a");
    expect(client.resumeThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread-old", cwd: "/main" }));
  });

  it("compacts the thread through the client's thread/compact/start", async () => {
    const { client, runner } = setup();
    const compactThread = vi.fn(async () => {});
    (client as unknown as { compactThread: typeof compactThread }).compactThread = compactThread;
    await runner.compact();
    expect(compactThread).toHaveBeenCalledTimes(1);
    expect(compactThread).toHaveBeenCalledWith({ threadId: expect.any(String) });
  });

  it("resumes a known thread, and a changed mode reaches the next turn", async () => {
    const { client, runner } = setup(undefined, "default", "thread-1");
    await runner.send("a");
    expect(client.resumeThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thread-1" }));
    expect(client.startThread).not.toHaveBeenCalled();
    await runner.setPermissionMode("bypassPermissions");
    await runner.send("b");
    expect(client.startTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ approvalPolicy: SKIP_APPROVALS, sandboxPolicy: { type: "dangerFullAccess" } }),
    );
  });

  it("uses Codex's own session decision when offered, plain accept when not", async () => {
    const { client, runner } = setup(() => ({ decision: "allow", scope: "session" }));
    await runner.send("go");
    client.emit("server-request", {
      id: 0,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", command: "ls", availableDecisions: ["accept", "acceptForSession", "cancel"] },
    });
    client.emit("server-request", {
      id: 1,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", command: "ls", availableDecisions: ["accept", "cancel"] },
    });
    await tick();
    expect(client.responses).toEqual([
      { id: 0, result: { decision: "acceptForSession" } },
      { id: 1, result: { decision: "accept" } },
    ]);
  });

  it("answers from the chat's rules without a request", async () => {
    const { client, log, runner } = setup();
    (runner as unknown as { options: { hooks: RunnerHooks } }).options.hooks.tryAutoAllow = (k, p) =>
      k === "command" && (p as { command: string }).command === "npm test";
    await runner.send("go");
    client.emit("server-request", {
      id: 0,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", command: "npm test" },
    });
    await tick();
    expect(client.responses).toEqual([{ id: 0, result: { decision: "accept" } }]);
    expect(log.requests).toEqual([]);
    expect(log.statuses).not.toContain("awaiting_approval");
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
    expect(log.statuses).toContain("awaiting_approval");
  });

  it("declines a patch that touches a file another Duck holds (folder Pond lock), without asking anyone", async () => {
    const { client, log, runner } = setup(() => ({ decision: "allow" }));
    (runner as unknown as { options: { hooks: RunnerHooks } }).options.hooks.guardEdit = (files) =>
      files.includes("a.txt") ? "a.txt is locked: Sage is editing it" : null;
    await runner.send("go");
    note(client, "item/started", { item: { type: "fileChange", id: "fc-1", changes: [{ path: "a.txt" }] } });
    client.emit("server-request", {
      id: 1,
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread-1", itemId: "fc-1" },
    });
    await tick();
    expect(client.responses).toEqual([{ id: 1, result: { decision: "decline" } }]);
    expect(log.requests).toEqual([]);
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
    expect(log.details[2]).toBe("failed");
  });

  it("skip approvals asks Codex only for MCP tool calls and accepts them itself; other modes and real forms are not accepted", async () => {
    expect(SKIP_APPROVALS).toEqual({
      granular: {
        mcp_elicitations: true,
        rules: false,
        sandbox_approval: false,
        request_permissions: false,
        skill_approval: false,
      },
    });
    const approval = (id: number) => ({
      id,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread-1",
        serverName: "codex_apps",
        mode: "form",
        message: "Allow?",
        requestedSchema: {},
        _meta: { codex_approval_kind: "mcp_tool_call" },
      },
    });
    const skip = setup(undefined, "bypassPermissions");
    await skip.runner.send("go");
    skip.client.emit("server-request", approval(1));
    skip.client.emit("server-request", { ...approval(2), params: { ...approval(2).params, _meta: {} } });
    await new Promise((r) => setTimeout(r, 0));
    expect(skip.client.responses).toEqual([
      expect.objectContaining({ id: 1, result: { action: "accept", content: {} } }),
      expect.objectContaining({ id: 2, error: expect.objectContaining({ code: -32601 }) }),
    ]);
    const ask = setup(undefined, "default");
    await ask.runner.send("go");
    ask.client.emit("server-request", approval(3));
    await new Promise((r) => setTimeout(r, 0));
    expect(ask.client.responses).toEqual([
      expect.objectContaining({ id: 3, error: expect.objectContaining({ code: -32601 }) }),
    ]);
  });

  it("a background command finishing after the turn ended is a note, never an agent row that opens a turn", async () => {
    const { client, log, runner } = setup();
    await runner.send("go");
    note(client, "turn/completed", { turn: { id: "turn-1", status: "completed" } });
    note(client, "item/completed", {
      item: { type: "commandExecution", id: "x", command: "npx playwright install", exitCode: 0 },
    });
    expect(log.messages.map((m) => [m.role, m.kind])).toEqual([
      ["agent", "turn/completed"],
      ["system", "system/note"],
    ]);
    expect(JSON.stringify(log.messages[1]!.payload)).toContain("npx playwright install (exit 0)");
    // The next turn's items are agent rows again.
    await runner.send("again");
    note(client, "item/completed", { item: { type: "agentMessage", id: "b", text: "ok" } });
    expect(log.messages.at(-1)).toMatchObject({ role: "agent", kind: "item/agentMessage" });
  });

  it("a failed turn carries Codex's own reason", async () => {
    const { client, log, runner } = setup();
    await runner.send("go");
    note(client, "turn/completed", {
      turn: { id: "turn-1", status: "failed", error: { message: "Your workspace is out of credits." } },
    });
    expect(log.details).toEqual(["Your workspace is out of credits."]);
  });

  it("steers and interrupts the live turn only", async () => {
    const { client, log, runner } = setup();
    expect(await runner.steer("x")).toBe(false);
    await runner.send("go");
    expect(await runner.steer("nudge")).toBe(true);
    expect(client.steerTurn).toHaveBeenCalledWith({ threadId: "thread-1", expectedTurnId: "turn-1", input: "nudge" });
    await runner.interrupt();
    expect(client.interruptTurn).toHaveBeenCalledWith({ threadId: "thread-1", turnId: "turn-1" });
    expect(log.statuses).toContain("stopping");
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

describe("Codex images and compaction", () => {
  function inStream() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-img-"));
    const chat = path.join(dir, "chat");
    const stream = path.join(dir, "stream");
    fs.mkdirSync(path.join(chat, ".context", "attachments", "ab12"), { recursive: true });
    fs.mkdirSync(stream);
    const image = path.join(chat, ".context", "attachments", "ab12", "image-1.png");
    fs.writeFileSync(image, "png");
    fs.writeFileSync(path.join(chat, ".context", "attachments", "ab12", "notes.txt"), "x");
    const client = new FakeClient();
    const log = {
      statuses: [] as string[],
      messages: [] as { kind: string; payload: unknown }[],
      context: [] as unknown[],
    };
    const hooks = {
      onAgentSessionId() {},
      onMessage: (_r: string, kind: string, payload: unknown) => log.messages.push({ kind, payload }),
      onDelta() {},
      onStatus: (s: string) => log.statuses.push(s),
      onContext: (c: unknown) => log.context.push(c),
      onRequest: async () => ({ decision: "allow" }),
      onTurnEnd() {},
      onExit() {},
    };
    const runner = new CodexRunner({
      cwd: chat,
      model: "m",
      permissionMode: "bypassPermissions",
      hooks: hooks as never,
      client: client as unknown as CodexClient,
      readOnlyRoot: chat,
      streamDirs: () => [stream],
    });
    return { dir, chat, stream, image, client, log, runner };
  }
  const token = "@⟦image-1.png⟧(.context%2Fattachments%2Fab12%2Fimage-1.png)";

  it("an image token becomes a localImage at the folder the attachment was saved in, not the Stream the turn runs in", async () => {
    const { dir, stream, image, client, runner } = inStream();
    try {
      await runner.send(`See the attached image.\n\n${token}`);
      const call = client.startTurn.mock.calls.at(-1)?.[0] as { cwd: string; input: unknown[] };
      expect(call.cwd).toBe(stream);
      expect(call.input).toEqual([
        { type: "text", text: `See the attached image.\n\n${token}`, text_elements: [] },
        { type: "localImage", path: image },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a steer carries the image too, and an attached file's path is absolute", async () => {
    const { dir, chat, image, client, runner } = inStream();
    try {
      await runner.send("go");
      await runner.steer(`look\n\n${token}\nAttached file: .context/attachments/ab12/notes.txt`);
      const arg = client.steerTurn.mock.calls.at(-1)?.[0] as unknown as { input: { type: string; text?: string }[] };
      expect(arg.input[1]).toEqual({ type: "localImage", path: image });
      expect(arg.input[0]?.text).toContain(`Attached file: ${path.join(chat, ".context/attachments/ab12/notes.txt")}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing image file is not sent as an image (Codex would fail the turn on it)", async () => {
    const { dir, client, runner } = inStream();
    try {
      const text = "@⟦image-2.png⟧(.context%2Fattachments%2Fab12%2Fimage-2.png)";
      await runner.send(text);
      const call = client.startTurn.mock.calls.at(-1)?.[0] as { input: unknown };
      expect(call.input).toBe(text);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compacting shows Working, then a note and a reset context ring when Codex's compaction item completes", async () => {
    const { dir, client, log, runner } = inStream();
    try {
      const compactThread = vi.fn(async () => {});
      (client as unknown as { compactThread: typeof compactThread }).compactThread = compactThread;
      await runner.compact();
      expect(compactThread).toHaveBeenCalledWith({ threadId: "thread-1" });
      expect(log.statuses.at(-1)).toBe("working");
      note(client, "turn/started", { turn: { id: "t2" } });
      note(client, "item/completed", { item: { type: "contextCompaction", id: "c1" } });
      expect(log.context).toEqual([null]);
      expect(log.messages).toEqual([{ kind: "system/note", payload: { text: "Compacted the conversation." } }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a compaction Codex refuses to start leaves the chat idle and reports the error", async () => {
    const { dir, client, log, runner } = inStream();
    try {
      (client as unknown as { compactThread: () => Promise<void> }).compactThread = async () => {
        throw new Error("no thread");
      };
      await expect(runner.compact()).rejects.toThrow("no thread");
      expect(log.statuses.at(-1)).toBe("idle");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
