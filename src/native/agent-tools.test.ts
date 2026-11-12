/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-RPC replies are read loosely in tests */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentTools,
  isReadOnlySqueakTool,
  isSqueakTool,
  LIMITS,
  mcpTokenFor,
  mcpTokenValid,
  TOOLS,
} from "./agent-tools.js";
import { codexMcpConfig } from "./codex-runner.js";
import { SessionHost } from "./host.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import type { Runner, RunnerHooks, SessionRow } from "./types.js";
import { WorkspaceManager } from "./workspaces.js";

interface Harness {
  base: string;
  store: NativeStore;
  host: SessionHost;
  server: NativeServer;
  sent: { session: string; text: string }[];
  dir: string;
}

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

async function start(): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-"));
  const store = new NativeStore(":memory:");
  const sent: { session: string; text: string }[] = [];
  const host = new SessionHost({
    store,
    runnerFactory: (s: SessionRow, h: RunnerHooks): Runner => ({
      canSteer: false,
      send: async (text) => {
        sent.push({ session: s.id, text });
        h.onStatus("working");
      },
      steer: async () => false,
      interrupt: async () => {},
      setPermissionMode: async () => {},
      close: async () => {},
    }),
  });
  const server = new NativeServer({
    host,
    store,
    workspaces: new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") }),
    tokenPath: path.join(dir, "hook-token"),
    port: 0,
  });
  const port = await server.start();
  open.push(async () => {
    await server.stop();
    await host.stop();
  });
  return { base: `http://127.0.0.1:${port}`, store, host, server, sent, dir };
}

const chat = (h: Harness, cwd: string, title: string): SessionRow =>
  h.store.createSession({ cwd, agent: "claude", model: "sonnet", permissionMode: "default", title });

async function rpc(
  h: Harness,
  sessionId: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, any> }> {
  const endpoint = h.server.mcpEndpoint(sessionId)!;
  const res = await fetch(endpoint.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token ?? endpoint.token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const callTool = async (h: Harness, sessionId: string, name: string, args: Record<string, unknown> = {}) =>
  (await rpc(h, sessionId, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })).json
    .result as { content: { text: string }[]; isError?: boolean };

describe("agent tools over MCP", () => {
  it("speaks the MCP handshake and lists Squeak's tools", async () => {
    const h = await start();
    const a = chat(h, h.dir, "A");
    const init = await rpc(h, a.id, {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    expect(init.json.result.serverInfo.name).toBe("squeak");
    expect((await rpc(h, a.id, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const list = await rpc(h, a.id, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = list.json.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["workspace_diff", "notify_user", "send_to_chat", "start_chat"]));
  });

  it("refuses another chat's token, the control token and unknown chats", async () => {
    const h = await start();
    const a = chat(h, h.dir, "A");
    const b = chat(h, h.dir, "B");
    const bToken = h.server.mcpEndpoint(b.id)!.token;
    expect((await rpc(h, a.id, { jsonrpc: "2.0", id: 1, method: "tools/list" }, bToken)).status).toBe(401);
    const control = fs.readFileSync(path.join(h.dir, "hook-token"), "utf8").trim();
    expect((await rpc(h, a.id, { jsonrpc: "2.0", id: 1, method: "tools/list" }, control)).status).toBe(401);
    expect(mcpTokenValid(control, a.id, mcpTokenFor(control, a.id))).toBe(true);
    // The control routes still need the control token, not a chat's.
    const res = await fetch(`${h.base}/native/sessions`, { headers: { "x-squeak-token": bToken } });
    expect(res.status).toBe(401);
  });

  it("agents talk to each other: list, send (marked, limited), read", async () => {
    const h = await start();
    const a = chat(h, h.dir, "Planner");
    const b = chat(h, h.dir, "Builder");
    expect((await callTool(h, a.id, "list_chats")).content[0]!.text).toContain(b.id);
    expect((await callTool(h, a.id, "send_to_chat", { chatId: a.id, message: "hi" })).isError).toBe(true);
    const r = await callTool(h, a.id, "send_to_chat", { chatId: b.id, message: "Build the parser" });
    expect(r.isError).toBeFalsy();
    expect(h.sent.at(-1)!.session).toBe(b.id);
    expect(h.sent.at(-1)!.text).toContain(`(${a.id})`);
    expect(h.sent.at(-1)!.text).toContain("Build the parser");
    const notes = h.store.messagesAfter(a.id).map((m) => m.kind);
    expect(notes).toContain("squeak/agent-message");
    h.host["store"].appendMessage(b.id, "agent", "assistant", {
      message: { content: [{ type: "text", text: "Parser done" }] },
    });
    expect((await callTool(h, a.id, "read_chat", { chatId: b.id })).content[0]!.text).toContain("Parser done");
    for (let i = 1; i < LIMITS.perTargetPerHour; i++)
      await callTool(h, a.id, "send_to_chat", { chatId: b.id, message: `m${i}` });
    const over = await callTool(h, a.id, "send_to_chat", { chatId: b.id, message: "one more" });
    expect(over.isError).toBe(true);
    expect(over.content[0]!.text).toMatch(/Too many/);
  });

  it("start_chat opens a chat in the same folder that never has wider permissions", async () => {
    const h = await start();
    const a = h.store.createSession({
      cwd: h.dir,
      agent: "claude",
      model: "opus",
      permissionMode: "acceptEdits",
      title: "A",
    });
    const r = await callTool(h, a.id, "start_chat", { message: "Write tests", agent: "codex", model: "gpt-5.6-terra" });
    expect(r.isError).toBeFalsy();
    const child = h.store.listSessions().find((s) => s.id !== a.id)!;
    expect(child.cwd).toBe(h.dir);
    expect(child.agent).toBe("codex");
    expect(child.permissionMode).toBe("default");
    expect(h.sent.at(-1)!.text).toContain("Write tests");
  });

  it("start_chat with another agent and no model uses a model that agent already runs, never 'default'", async () => {
    const h = await start();
    const a = chat(h, h.dir, "A");
    const refused = await callTool(h, a.id, "start_chat", { message: "x", agent: "codex" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toMatch(/pass model/);
    expect(h.store.listSessions()).toHaveLength(1);
    h.store.createSession({ cwd: h.dir, agent: "codex", model: "gpt-5.6-terra", permissionMode: "default" });
    const ok = await callTool(h, a.id, "start_chat", { message: "x", agent: "codex" });
    expect(ok.isError).toBeFalsy();
    const models = h.store.listSessions().map((s) => s.model);
    expect(models).not.toContain("default");
    expect(models.filter((m) => m === "gpt-5.6-terra")).toHaveLength(2);
  });

  it("terminal_output reads the run and setup scripts and refuses a chat without a workspace", async () => {
    const h = await start();
    const a = chat(h, h.dir, "A");
    const none = await callTool(h, a.id, "terminal_output");
    expect(none.isError).toBe(true);
    expect(none.content[0]!.text).toMatch(/not in a Squeak stream/);

    const tools = new AgentTools({
      store: h.store,
      send: async () => ({ queued: false }),
      create: async () => a,
      post: () => {},
      workspaces: {
        runStatus: () => ({ running: true, logTail: "one\ntwo\nthree\n" }),
        getLog: () => ({ state: "ready", log: "npm ci done\n" }),
      },
    });
    const w = h.store.createSession({
      cwd: h.dir,
      agent: "claude",
      model: "sonnet",
      permissionMode: "default",
      workspaceId: "w1",
    });
    expect(await tools.call(w.id, "terminal_output", { maxLines: 2 })).toBe("Run script (running):\ntwo\nthree");
    expect(await tools.call(w.id, "terminal_output", { source: "setup" })).toContain("npm ci done");
    await expect(tools.call(w.id, "terminal_output", { source: "terminal" })).rejects.toThrow(/run_script, setup/);
    expect(TOOLS.find((t) => t.name === "terminal_output")!.description).toMatch(/does NOT cover/);
  });

  it("notes, progress and review comments land in the chat and the store", async () => {
    const h = await start();
    const a = chat(h, h.dir, "A");
    await callTool(h, a.id, "notify_user", { message: "PR is ready" });
    await callTool(h, a.id, "update_progress", { steps: ["Plan", "Build", "Test"], current: 1, status: "building" });
    const add = await callTool(h, a.id, "add_review_comment", { file: "src/x.ts", line: 3, comment: "rename this" });
    expect(add.isError).toBeFalsy();
    const listed = (await callTool(h, a.id, "review_comments")).content[0]!.text;
    expect(listed).toContain("src/x.ts:3");
    const id = /\[([0-9a-f-]+)\]/.exec(listed)![1]!;
    expect((await callTool(h, a.id, "resolve_review_comment", { id })).isError).toBeFalsy();
    expect((await callTool(h, a.id, "review_comments")).content[0]!.text).toBe("No open review comments.");
    const kinds = h.store.messagesAfter(a.id).map((m) => m.kind);
    expect(kinds).toEqual(expect.arrayContaining(["squeak/notify", "squeak/progress", "squeak/review-comment"]));
  });
});

describe("show_image", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  it("posts an image card for a file in the chat's folder, with a caption", async () => {
    const h = await start();
    const a = chat(h, h.dir, "A");
    fs.mkdirSync(path.join(h.dir, "docs"));
    fs.writeFileSync(path.join(h.dir, "docs", "chart.png"), png);
    const r = await callTool(h, a.id, "show_image", { path: "docs/chart.png", caption: "Q3 revenue" });
    expect(r.isError).toBeFalsy();
    const card = h.store.messagesAfter(a.id).find((m) => m.kind === "squeak/image");
    const payload = card!.payload as { path: string; name: string; caption: string | null };
    expect(payload.path).toBe(fs.realpathSync(path.join(h.dir, "docs", "chart.png")));
    expect(payload.name).toBe("chart.png");
    expect(payload.caption).toBe("Q3 revenue");
  });

  it("refuses a missing file, a non-image, a symlink out of the allowed folders and a path-less call", async () => {
    const h = await start();
    const a = chat(h, h.dir, "A");
    fs.writeFileSync(path.join(h.dir, "notes.txt"), "x");
    fs.symlinkSync("/etc/hosts", path.join(h.dir, "link.png"));
    expect((await callTool(h, a.id, "show_image", { path: "nope.png" })).content[0]!.text).toMatch(/No such file/);
    expect((await callTool(h, a.id, "show_image", { path: "notes.txt" })).content[0]!.text).toMatch(/PNG, JPEG/);
    expect((await callTool(h, a.id, "show_image", { path: "link.png" })).content[0]!.text).toMatch(/outside/);
    expect((await callTool(h, a.id, "show_image", {})).isError).toBe(true);
    expect(h.store.messagesAfter(a.id).some((m) => m.kind === "squeak/image")).toBe(false);
    expect(TOOLS.find((t) => t.name === "show_image")).toBeTruthy();
  });
});

describe("workspace_diff", () => {
  it("includes commits, uncommitted and untracked work against the target branch", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-repo-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "work");
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    fs.writeFileSync(path.join(repo, "new.txt"), "fresh\n");
    const store = new NativeStore(":memory:");
    const s = store.createSession({ cwd: repo, agent: "claude", model: "m", permissionMode: "default" });
    const tools = new AgentTools({
      store,
      send: async () => ({ queued: false }),
      create: async () => s,
      post: () => {},
    });
    const out = await tools.call(s.id, "workspace_diff", {});
    expect(out).toContain("+two");
    expect(out).toContain("+fresh");
    expect(await tools.call(s.id, "workspace_diff", { stat: true })).toContain("new.txt");
  });
});

describe("tool names", () => {
  it("only Squeak's own tools are auto-allowed", () => {
    expect(isSqueakTool("mcp__squeak__notify_user")).toBe(true);
    expect(isSqueakTool("mcp__squeak__rm_rf")).toBe(false);
    expect(isSqueakTool("mcp__other__notify_user")).toBe(false);
    expect(isReadOnlySqueakTool("mcp__squeak__workspace_diff")).toBe(true);
    expect(isReadOnlySqueakTool("mcp__squeak__send_to_chat")).toBe(false);
  });

  it("Codex gets the server as dotted config overrides", () => {
    expect(codexMcpConfig({ url: "http://127.0.0.1:1/mcp/x", token: "t" })).toEqual({
      "mcp_servers.squeak.url": "http://127.0.0.1:1/mcp/x",
      "mcp_servers.squeak.http_headers": { Authorization: "Bearer t" },
    });
  });
});
