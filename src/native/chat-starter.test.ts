import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionHost } from "./host.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import type { Runner, RunnerHooks, SessionRow } from "./types.js";
import { WorkspaceManager } from "./workspaces.js";

// Every git launch can stall ~3 s on this Mac (endpoint security), so these get room.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const before = process.env.SQUEAK_DUCKS_OWN_BRANCH;
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (stops.length) await stops.pop()!();
  if (before === undefined) delete process.env.SQUEAK_DUCKS_OWN_BRANCH;
  else process.env.SQUEAK_DUCKS_OWN_BRANCH = before;
});
const flagOn = (on: boolean) => {
  if (on) process.env.SQUEAK_DUCKS_OWN_BRANCH = "on";
  else process.env.SQUEAK_DUCKS_OWN_BRANCH = "off";
};

async function start() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-starter-")));
  const repo = path.join(dir, "app");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  const notes = path.join(dir, "notes");
  fs.mkdirSync(notes);
  const store = new NativeStore(":memory:");
  const host = new SessionHost({
    store,
    runnerFactory: (_s: SessionRow, h: RunnerHooks): Runner => ({
      canSteer: false,
      send: async () => h.onStatus("working"),
      steer: async () => false,
      interrupt: async () => {},
      setPermissionMode: async () => {},
      close: async () => {},
    }),
  });
  const workspaces = new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") });
  const tokenPath = path.join(dir, "hook-token");
  const server = new NativeServer({ host, store, workspaces, tokenPath, port: 0, routines: false });
  const port = await server.start();
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  stops.push(async () => {
    await server.stop();
    await host.stop();
  });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { "x-squeak-token": token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const pond = workspaces.addProject(repo);
  const folderPond = workspaces.addProject(notes);
  const tool = async (sessionId: string, name: string, args: Record<string, unknown> = {}) => {
    const endpoint = server.mcpEndpoint(sessionId)!;
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    return ((await res.json()) as { result: { content: { text: string }[]; isError?: boolean } }).result;
  };
  return { store, host, server, workspaces, call, tool, pond, folderPond };
}

const sessionIn = (h: Awaited<ReturnType<typeof start>>, cwd: string, workspaceId: string | null = null) =>
  h.host.create({ cwd, agent: "claude", model: "m", permissionMode: "default", workspaceId });

describe("one way to start a duck: the Duck link on every path", () => {
  // The non-route paths used to skip the Duck link; each of them must leave the new chat with its duck.
  const paths: [string, (h: Awaited<ReturnType<typeof start>>) => Promise<string>][] = [
    [
      "an agent's start_chat tool",
      async (h) => {
        const parent = await sessionIn(h, h.folderPond.rootPath);
        const r = await h.tool(parent.id, "start_chat", { message: "Write tests" });
        return /chat (\S+)/.exec(r.content[0]!.text)![1]!;
      },
    ],
    [
      "a room job's new thread",
      async (h) => {
        await sessionIn(h, h.folderPond.rootPath);
        return (await h.server.starter.jobThread(h.folderPond.id, "Fix the bug", "Fix")).id;
      },
    ],
    [
      "a Planner backlog start",
      async (h) => {
        await sessionIn(h, h.folderPond.rootPath);
        const item = h.server.planner.addBacklog(h.folderPond.id, { prompt: "do it" });
        const started = await h.server.planner.startBacklog(item.id, {
          agent: "claude",
          model: "m",
          newWorkspace: false,
        });
        return started.id;
      },
    ],
  ];

  for (const [name, startIt] of paths) {
    it(`gives ${name} a duck when ducks own their branch, and none when the flag is off`, async () => {
      for (const on of [true, false]) {
        flagOn(on);
        const h = await start();
        const id = await startIt(h);
        const duck = h.store.duckBySession(id);
        if (on) expect(duck, name).toBeTruthy();
        else expect(duck, name).toBeNull();
      }
    });
  }
});

describe("one way to start a duck: placement through the host route", () => {
  const cases: [string, boolean, "git" | "folder", Record<string, unknown>, "own-branch" | "root" | "error"][] = [
    ["no place in a git pond (flag on)", true, "git", {}, "own-branch"],
    ["main alias in a git pond (flag on)", true, "git", { main: true }, "own-branch"],
    ["place main in a git pond (flag on)", true, "git", { place: { kind: "main" } }, "own-branch"],
    ["place new in a git pond (flag on)", true, "git", { place: { kind: "new" } }, "own-branch"],
    ["no place in a folder pond", true, "folder", {}, "root"],
    ["main alias in a git pond (flag off)", false, "git", { main: true }, "root"],
    ["place with the flag off", false, "git", { place: { kind: "new" } }, "error"],
    ["place and an alias together", true, "git", { place: { kind: "new" }, main: true }, "error"],
    ["main together with newWorkspace", false, "git", { main: true, newWorkspace: true }, "error"],
  ];
  for (const [name, on, kind, extra, want] of cases) {
    it(name, async () => {
      flagOn(on);
      const h = await start();
      const pond = kind === "git" ? h.pond : h.folderPond;
      const r = await h.call("POST", "/native/sessions", {
        projectId: pond.id,
        agent: "claude",
        model: "m",
        text: "hello",
        ...extra,
      });
      if (want === "error") return expect(r.status).toBe(400);
      expect(r.status).toBe(201);
      const s = r.json.session as SessionRow;
      if (want === "root") {
        expect(s.cwd).toBe(pond.rootPath);
        expect(s.workspaceId).toBeNull();
      } else {
        expect(s.workspaceId).toBeTruthy();
        expect(s.cwd).not.toBe(pond.rootPath);
      }
      expect(Boolean(h.store.duckBySession(s.id))).toBe(on);
    });
  }

  it("joins an existing stream by workspaceId and refuses an archived one", async () => {
    flagOn(false);
    const h = await start();
    const ws = h.workspaces.createWorkspace(h.pond.id);
    const body = { projectId: h.pond.id, agent: "claude", model: "m", workspaceId: ws.id };
    const ok = await h.call("POST", "/native/sessions", body);
    expect(ok.status).toBe(201);
    expect(ok.json.session.cwd).toBe(ws.path);
    expect((await h.call("POST", "/native/sessions", { ...body, workspaceId: "nope" })).status).toBe(404);
  });
});
