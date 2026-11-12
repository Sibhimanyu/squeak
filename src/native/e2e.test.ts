/* eslint-disable @typescript-eslint/no-explicit-any */
// End-to-end tests of native Claude chats at the host level: a real SessionHost + NativeServer + NativeStore (a file
// database) + ClaudeRunner + the real Agent SDK, driving a fake `claude` CLI (fixtures/fake-claude.mjs) over
// stream-json. Nothing here touches the live host or the real CLI.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ClaudeRunner } from "./claude-runner.js";
import { SessionHost } from "./host.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import type { RunnerHooks, SessionRow } from "./types.js";
import { WorkspaceManager } from "./workspaces.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

interface Stack {
  dir: string;
  fake: string;
  cwd: string;
  base: string;
  token: string;
  store: NativeStore;
  host: SessionHost;
  server: NativeServer;
  /** Stops host and server without closing the database (a crash): a new stack over the same dir recovers. */
  crash: () => Promise<void>;
}

const stacks: Stack[] = [];
afterEach(async () => {
  while (stacks.length) await stacks.pop()!.crash();
});

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

async function boot(dir: string, extraEnv: Record<string, string> = {}): Promise<Stack> {
  const fake = path.join(dir, "fake");
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(fake, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const store = new NativeStore(path.join(dir, "native.db"));
  const host = new SessionHost({
    store,
    warmRecentMs: 0,
    runnerFactory: (s: SessionRow, hooks: RunnerHooks) =>
      new ClaudeRunner({
        cwd: s.cwd,
        model: s.model,
        permissionMode: s.permissionMode,
        resume: s.agentSessionId,
        hooks,
        executable: FAKE,
        env: { ...process.env, FAKE_CLAUDE_DIR: fake, ...extraEnv },
        graceMs: 50,
        settleMs: 2000,
        interruptMs: 2000,
      }),
  });
  host.start();
  const tokenPath = path.join(dir, "hook-token");
  const server = new NativeServer({
    host,
    store,
    workspaces: new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") }),
    tokenPath,
    port: 0,
    heartbeatMs: 50,
  });
  const port = await server.start();
  const stack: Stack = {
    dir,
    fake,
    cwd,
    base: `http://127.0.0.1:${port}`,
    token: fs.readFileSync(tokenPath, "utf8").trim(),
    store,
    host,
    server,
    crash: async () => {
      await server.stop();
      await host.stop();
      store.close();
    },
  };
  stacks.push(stack);
  return stack;
}

const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "native-e2e-"));

async function api<T = any>(s: Stack, method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(s.base + "/native" + url, {
    method,
    headers: { "x-squeak-token": s.token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

const session = async (s: Stack, id: string) => (await api(s, "GET", `/sessions/${id}`)).session;
const messages = async (s: Stack, id: string) => (await api(s, "GET", `/sessions/${id}/messages`)).messages as any[];
const kinds = async (s: Stack, id: string) =>
  (await messages(s, id)).map((m) => m.kind as string).filter((k) => k !== "command_lifecycle");
const release = (s: Stack, gate: string) => fs.writeFileSync(path.join(s.fake, `release-${gate}`), "");
const atGate = (s: Stack, gate: string) =>
  until(`the fake at gate ${gate}`, () => fs.existsSync(path.join(s.fake, `waiting-${gate}`)));
const fakeLog = (s: Stack): any[] => {
  const f = path.join(s.fake, "log.jsonl");
  return fs.existsSync(f)
    ? fs
        .readFileSync(f, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
};
const idle = (s: Stack, id: string) => until("idle", async () => (await session(s, id)).status === "idle");

async function create(s: Stack, text: string): Promise<string> {
  const { session: made } = await api(s, "POST", "/sessions", {
    agent: "claude",
    model: "claude-opus-5-5",
    cwd: s.cwd,
    permissionMode: "bypassPermissions",
    text,
  });
  return made.id as string;
}

describe("native chat e2e (fake claude CLI)", () => {
  it("1. send -> steps -> result -> idle", async () => {
    const s = await boot(newDir());
    const id = await create(s, "hi there @@plain");
    expect((await session(s, id)).status).toBe("working");
    await idle(s, id);
    const ks = await kinds(s, id);
    expect(ks[0]).toBe("user/text");
    expect(ks).toContain("system/init");
    expect(ks).toContain("assistant");
    expect(ks.at(-1)).toBe("result/success");
    const got = await session(s, id);
    expect(got.agentSessionId).toBeTruthy();
    expect(got.pending).toEqual([]);
    expect(got.queue).toEqual([]);
    const turns = (await api(s, "GET", `/sessions/${id}/turns`)).turns;
    expect(turns).toHaveLength(1);
    expect(turns[0].working).toBe(false);
    const assistant = (await messages(s, id))
      .filter((m) => m.kind === "assistant")
      .map((m) => m.payload.message.content[0].type);
    expect(assistant).toEqual(["thinking", "text"]);
  });

  it("2a. a steer during a long Bash is a steering card until the CLI starts it, then consumed", async () => {
    const s = await boot(newDir());
    const id = await create(s, "run it @@bash");
    await atGate(s, "bash");
    const sent = await api(s, "POST", `/sessions/${id}/messages`, { text: "also say banana", mode: "steer" });
    expect(sent.queued).toBe(false);
    // the card stays until command_lifecycle `started`, which the fake sends only after the tool returns
    await until("steering card", async () => (await api(s, "GET", `/sessions/${id}/pending`)).pending.length === 1);
    const card = (await api(s, "GET", `/sessions/${id}/pending`)).pending[0];
    expect(card.state).toBe("steering");
    expect(card.text).toBe("also say banana");
    expect((await session(s, id)).status).toBe("working");
    release(s, "bash");
    await until("card consumed", async () => (await api(s, "GET", `/sessions/${id}/pending`)).pending.length === 0);
    await idle(s, id);
    const ms = await messages(s, id);
    expect(ms.filter((m) => m.kind === "user/text").map((m) => m.payload.text)).toEqual([
      "run it @@bash",
      "also say banana",
    ]);
    expect(ms.find((m) => m.kind === "user/text" && m.payload.steered)).toBeTruthy();
    const result = ms.filter((m) => m.kind === "result/success").at(-1)!;
    expect(result.payload.user_message_uuids).toHaveLength(2);
    expect(result.payload.result).toContain("banana");
    expect(fakeLog(s).filter((e) => e.event === "user")).toHaveLength(2);
  });

  it("2b. a steer while a FOREGROUND Agent helper runs says it waits on the helper, consumed when the helper ends", async () => {
    const s = await boot(newDir());
    const id = await create(s, "scan @@agent");
    await atGate(s, "helper");
    await api(s, "POST", `/sessions/${id}/messages`, { text: "and be brief", mode: "steer" });
    await until("steering card", async () => (await api(s, "GET", `/sessions/${id}/pending`)).pending.length === 1);
    const waiting = (await api(s, "GET", `/sessions/${id}/pending`)).pending[0];
    expect(waiting.state).toBe("steering");
    expect(waiting.waitingFor).toBe("helper");
    expect((await session(s, id)).pending[0].waitingFor).toBe("helper");
    release(s, "helper");
    await until("card consumed", async () => (await api(s, "GET", `/sessions/${id}/pending`)).pending.length === 0);
    await idle(s, id);
    const result = (await messages(s, id)).filter((m) => m.kind === "result/success").at(-1)!;
    expect(result.payload.result).toContain("and be brief");
    expect((await session(s, id)).background).toBeUndefined();
  });

  it("3. Stop with an async helper running: idle, helper gone, process closed, the next send resumes", async () => {
    const s = await boot(newDir(), { FAKE_CLAUDE_STOP_REPORTS: "0" });
    const id = await create(s, "start a helper @@asyncagent");
    // the turn ends but a helper is alive: still working, with a background count
    await until("turn text", async () => (await kinds(s, id)).includes("result/success"));
    await until("background 1", async () => (await session(s, id)).background?.count === 1);
    expect((await session(s, id)).status).toBe("working");
    await api(s, "POST", `/sessions/${id}/interrupt`);
    await until("idle", async () => (await session(s, id)).status === "idle");
    const got = await session(s, id);
    expect(got.background).toBeUndefined();
    expect(got.busy).not.toBe(true);
    const ms = await messages(s, id);
    expect(ms.at(-1)!.kind).toBe("error");
    expect(ms.at(-1)!.payload.content).toBe("aborted by user");
    // the process was closed (killed), not left running with the helper
    await until("process closed", () => fakeLog(s).some((e) => e.event === "killed" || e.event === "exit"));
    const agentId = got.agentSessionId;
    await api(s, "POST", `/sessions/${id}/messages`, { text: "carry on @@plain" });
    await idle(s, id);
    const spawns = fakeLog(s).filter((e) => e.event === "spawn");
    expect(spawns).toHaveLength(2);
    expect(spawns[1].argv).toContain(`--resume=${agentId}`);
    expect(spawns[1].sessionId).toBe(agentId);
    expect((await kinds(s, id)).at(-1)).toBe("result/success");
  });

  it("3b. Stop mid-turn with a helper the CLI reports as stopped: idle, nothing left", async () => {
    const s = await boot(newDir());
    const id = await create(s, "scan @@agent");
    await atGate(s, "helper");
    await api(s, "POST", `/sessions/${id}/interrupt`);
    await idle(s, id);
    const got = await session(s, id);
    expect(got.background).toBeUndefined();
    expect(got.pending).toEqual([]);
    expect((await messages(s, id)).some((m) => m.kind === "error" && m.payload.content === "aborted by user")).toBe(
      true,
    );
  });

  it("4. a lettered question, answered A: the new turn's steps (with an Agent tool_use) are recorded and readable", async () => {
    const s = await boot(newDir());
    const id = await create(s, "what now @@question");
    await idle(s, id);
    const last = (await messages(s, id)).filter((m) => m.kind === "assistant").at(-1)!;
    expect(last.payload.message.content[0].text).toContain("A) Fast (recommended)");
    const after = (await messages(s, id)).at(-1)!.seq;
    await api(s, "POST", `/sessions/${id}/messages`, { text: "A" });
    await idle(s, id);
    const live = (await api(s, "GET", `/sessions/${id}/messages?after=${after}`)).messages as any[];
    expect(live[0].kind).toBe("user/text");
    expect(live[0].payload.text).toBe("A");
    const tools = live
      .filter((m) => m.kind === "assistant")
      .flatMap((m) => m.payload.message.content.map((b: any) => b.name ?? b.type));
    expect(tools).toEqual(["thinking", "Agent", "text"]);
    expect(live.map((m) => m.kind)).toContain("system/task_started");
    expect(live.map((m) => m.kind)).toContain("system/task_notification");
    expect((await api(s, "GET", `/sessions/${id}/turns`)).turns).toHaveLength(2);
  });

  it("5. a host restart mid-turn recovers: nothing stuck working or steering, and the chat carries on", async () => {
    const dir = newDir();
    const s = await boot(dir);
    const id = await create(s, "long @@bash");
    await atGate(s, "bash");
    await api(s, "POST", `/sessions/${id}/messages`, { text: "steer me", mode: "steer" });
    await until("steering", async () => (await api(s, "GET", `/sessions/${id}/pending`)).pending.length === 1);
    await api(s, "POST", `/sessions/${id}/messages`, { text: "later @@plain" });
    await s.crash();
    stacks.pop();
    fs.rmSync(path.join(s.fake, "waiting-bash"), { force: true });
    const s2 = await boot(dir);
    const got = await session(s2, id);
    // the stopped turn is closed; the message queued behind it was not stranded: it starts at once
    expect(got.pending.filter((p: any) => p.state === "steering")).toEqual([]);
    expect(await kinds(s2, id)).toContain("system/restart");
    await until(
      "queued message delivered after restart",
      async () => (await api(s2, "GET", `/sessions/${id}/queue`)).queue.length === 0,
    );
    await idle(s2, id);
    expect((await api(s2, "GET", `/sessions/${id}/turns`)).turns.every((t: any) => !t.working)).toBe(true);
    expect((await messages(s2, id)).filter((m) => m.kind === "user/text").map((m) => m.payload.text)).toEqual([
      "long @@bash",
      "steer me",
      "later @@plain",
    ]);
    await api(s2, "POST", `/sessions/${id}/messages`, { text: "again @@plain" });
    await idle(s2, id);
    const spawns = fakeLog(s2).filter((e) => e.event === "spawn");
    expect(spawns.at(-1).resumed).toBe(true);
  });

  it("6. a queued follow-up (not a steer) is delivered after the turn ends", async () => {
    const s = await boot(newDir());
    const id = await create(s, "first @@bash");
    await atGate(s, "bash");
    const sent = await api(s, "POST", `/sessions/${id}/messages`, { text: "second @@plain" });
    expect(sent.queued).toBe(true);
    expect((await api(s, "GET", `/sessions/${id}/queue`)).queue).toHaveLength(1);
    expect((await api(s, "GET", `/sessions/${id}/pending`)).pending[0].state).toBe("queued");
    // it was not handed to the agent mid-turn
    expect(fakeLog(s).filter((e) => e.event === "user")).toHaveLength(1);
    release(s, "bash");
    await until("both turns done", async () => (await kinds(s, id)).filter((k) => k === "result/success").length === 2);
    await idle(s, id);
    expect((await api(s, "GET", `/sessions/${id}/queue`)).queue).toEqual([]);
    const users = fakeLog(s).filter((e) => e.event === "user");
    expect(users.map((u) => u.midTurn)).toEqual([false, false]);
    expect((await api(s, "GET", `/sessions/${id}/turns`)).turns).toHaveLength(2);
  });
});
