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
  else delete process.env.SQUEAK_DUCKS_OWN_BRANCH;
};

async function start() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ducks-branch-")));
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
  const sent: { session: string; text: string }[] = [];
  const host = new SessionHost({
    store,
    runnerFactory: (s: SessionRow, h: RunnerHooks): Runner => ({
      canSteer: false,
      send: async (t) => {
        sent.push({ session: s.id, text: t });
        h.onStatus("working");
      },
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
  const rpc = async <T>(sessionId: string, body: unknown): Promise<T> => {
    const endpoint = server.mcpEndpoint(sessionId)!;
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
      body: JSON.stringify(body),
    });
    return ((await res.json()) as { result: T }).result;
  };
  const tool = (sessionId: string, name: string, args: Record<string, unknown> = {}) =>
    rpc<{ content: { text: string }[]; isError?: boolean }>(sessionId, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
  return { dir, repo, store, host, workspaces, call, pond, folderPond, sent, rpc, tool };
}

const body = (h: { pond: { id: string } }, extra: Record<string, unknown>) => ({
  agent: "claude",
  model: "claude-sonnet-4-5",
  projectId: h.pond.id,
  text: "go",
  ...extra,
});

describe("POST /native/sessions place (flag off)", () => {
  it("refuses place, and the old fields work as before (Main needs main: true, a bare projectId is still 400)", async () => {
    flagOn(false);
    const h = await start();
    const refused = await h.call("POST", "/native/sessions", body(h, { place: { kind: "main" } }));
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatch(/ducksOwnBranch/);
    expect((await h.call("POST", "/native/sessions", body(h, {}))).status).toBe(400);
    const main = await h.call("POST", "/native/sessions", body(h, { main: true }));
    expect(main.status).toBe(201);
    expect(main.json.session.cwd).toBe(h.pond.rootPath);
    const fresh = await h.call("POST", "/native/sessions", body(h, { newWorkspace: true }));
    expect(fresh.status).toBe(201);
    expect(fresh.json.session.workspaceId).toBeTruthy();
    expect(fresh.json.session.branch).toBeTruthy();
  });
});

describe("POST /native/sessions place (flag on)", () => {
  it("main, new (typed branch), join by branch and by duck", async () => {
    flagOn(true);
    const h = await start();
    const main = await h.call("POST", "/native/sessions", body(h, { place: { kind: "main" } }));
    expect(main.status).toBe(201);
    expect(main.json.session).toMatchObject({ cwd: h.pond.rootPath, workspaceId: null });
    const made = await h.call("POST", "/native/sessions", body(h, { place: { kind: "new", branch: "feat/login" } }));
    expect(made.status).toBe(201);
    expect(made.json.session).toMatchObject({ branch: "feat/login" });
    const ws = made.json.session.workspaceId as string;
    const byBranch = await h.call(
      "POST",
      "/native/sessions",
      body(h, { place: { kind: "join", branch: "feat/login" } }),
    );
    expect(byBranch.json.session).toMatchObject({ workspaceId: ws, cwd: made.json.session.cwd, branch: "feat/login" });
    const duck = h.store.duckForSession(made.json.session.id, h.pond.id)!;
    const byDuck = await h.call(
      "POST",
      "/native/sessions",
      // The duck alone names the pond.
      { agent: "claude", model: "m", text: "go", place: { kind: "join", duckId: duck.id } },
    );
    expect(byDuck.json.session.workspaceId).toBe(ws);
    expect(h.store.listWorkspaces(h.pond.id)).toHaveLength(1);
  });

  it("a bare projectId starts in Main (read-only) in a git pond; a folder pond gets its folder", async () => {
    flagOn(true);
    const h = await start();
    const bare = await h.call("POST", "/native/sessions", body(h, {}));
    expect(bare.status).toBe(201);
    expect(bare.json.session).toMatchObject({ cwd: h.pond.rootPath, workspaceId: null });
    const folder = await h.call("POST", "/native/sessions", body({ pond: h.folderPond }, {}));
    expect(folder.json.session.cwd).toBe(h.folderPond.rootPath);
  });

  it("the aliases still work, and mixing them with place is refused", async () => {
    flagOn(true);
    const h = await start();
    expect((await h.call("POST", "/native/sessions", body(h, { main: true }))).status).toBe(201);
    const fresh = await h.call("POST", "/native/sessions", body(h, { newWorkspace: true, branch: "feat/alias" }));
    expect(fresh.json.session.branch).toBe("feat/alias");
    const byWs = await h.call("POST", "/native/sessions", body(h, { workspaceId: fresh.json.session.workspaceId }));
    expect(byWs.json.session.workspaceId).toBe(fresh.json.session.workspaceId);
    for (const mix of [{ main: true }, { newWorkspace: true }, { workspaceId: "x" }, { cwd: "/tmp" }]) {
      const res = await h.call("POST", "/native/sessions", body(h, { place: { kind: "main" }, ...mix }));
      expect(res.status).toBe(400);
    }
  });

  it("refuses bad places with the right status", async () => {
    flagOn(true);
    const h = await start();
    for (const place of [{ kind: "stream" }, { kind: "join" }, "main", { kind: "main", x: 1 }]) {
      expect((await h.call("POST", "/native/sessions", body(h, { place }))).status).toBe(400);
    }
    expect(
      (await h.call("POST", "/native/sessions", body(h, { place: { kind: "join", branch: "ghost" } }))).status,
    ).toBe(404);
    expect(
      (await h.call("POST", "/native/sessions", body(h, { place: { kind: "join", duckId: "nope" } }))).status,
    ).toBe(404);
    expect(
      (await h.call("POST", "/native/sessions", { agent: "claude", model: "m", place: { kind: "main" } })).status,
    ).toBe(400);
    expect(
      (await h.call("POST", "/native/sessions", body({ pond: h.folderPond }, { place: { kind: "new" } }))).status,
    ).toBe(400);
    expect(
      (await h.call("POST", "/native/sessions", body({ pond: { id: "nope" } }, { place: { kind: "main" } }))).status,
    ).toBe(404);
  });
});

describe("POST /native/ducks/<id>/place", () => {
  it("refuses with the flag off", async () => {
    flagOn(false);
    const h = await start();
    const s = (await h.call("POST", "/native/sessions", body(h, { main: true }))).json.session as SessionRow;
    const duck = h.store.duckForSession(s.id, h.pond.id)!;
    const res = await h.call("POST", `/native/ducks/${duck.id}/place`, { place: { kind: "main" } });
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/ducksOwnBranch/);
  });

  it("moves the duck to a new branch, joins, returns to Main; 404, 400 and 409 (working) are answered", async () => {
    flagOn(true);
    const h = await start();
    const first = (await h.call("POST", "/native/sessions", body(h, { place: { kind: "main" } }))).json
      .session as SessionRow;
    const duck = h.store.duckForSession(first.id, h.pond.id)!;
    const url = `/native/ducks/${duck.id}/place`;
    // The first chat is working (the stub runner reports it): the duck cannot move.
    h.store.setStatus(first.id, "working");
    const busy = await h.call("POST", url, { place: { kind: "main" } });
    expect(busy.status).toBe(409);
    h.store.setStatus(first.id, "idle");

    const off = await h.call("POST", url, { place: { kind: "new", branch: "feat/place" }, message: "Start here" });
    expect(off.status).toBe(200);
    const second = h.store.getSession(off.json.sessionId)!;
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ branch: "feat/place" });
    expect(h.store.duckRow(duck.id)).toMatchObject({ branch: "feat/place", currentSessionId: second.id });
    expect(h.sent.find((x) => x.session === second.id)!.text).toContain("Start here");

    h.store.setStatus(second.id, "idle");
    const same = await h.call("POST", url, { place: { kind: "join", branch: "feat/place" } });
    expect(same.json.sessionId).toBe(second.id);
    const back = await h.call("POST", url, { place: { kind: "main" } });
    expect(h.store.getSession(back.json.sessionId)).toMatchObject({ cwd: h.pond.rootPath, workspaceId: null });

    expect((await h.call("POST", "/native/ducks/nope/place", { place: { kind: "main" } })).status).toBe(404);
    expect((await h.call("POST", url, { place: { kind: "stream" } })).status).toBe(400);
    expect((await h.call("POST", url, { place: { kind: "main" }, x: 1 })).status).toBe(400);
    h.store.setStatus(back.json.sessionId, "idle");
    expect((await h.call("POST", url, { place: { kind: "join", branch: "ghost" } })).status).toBe(404);
  });
});

describe("agent tools: branch_off, join_branch, move_to_main", () => {
  it("are hidden and refused with the flag off", async () => {
    flagOn(false);
    const h = await start();
    const main = await h.call("POST", "/native/sessions", body(h, { main: true }));
    const id = main.json.session.id as string;
    const list = await h.rpc<{ tools: { name: string }[] }>(id, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = list.tools.map((t: { name: string }) => t.name);
    for (const n of ["branch_off", "join_branch", "move_to_main"]) expect(names).not.toContain(n);
    const res = await h.tool(id, "branch_off", { name: "x" });
    expect(res.isError).toBe(true);
    expect(h.store.listWorkspaces(h.pond.id)).toHaveLength(0);
  });

  it("flag on: listed; a duck in Main branches off, joins and returns, carrying its duck and message", async () => {
    flagOn(true);
    const h = await start();
    const main = await h.call("POST", "/native/sessions", body(h, { place: { kind: "main" } }));
    const first = main.json.session as SessionRow;
    const duck = h.store.duckForSession(first.id, h.pond.id)!;
    const list = await h.rpc<{ tools: { name: string }[] }>(first.id, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = list.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["branch_off", "join_branch", "move_to_main"]));

    const off = await h.tool(first.id, "branch_off", { name: "Login form", message: "Build the form" });
    expect(off.isError).toBeUndefined();
    const second = h.store.getSession(h.store.duckRow(duck.id)!.currentSessionId!)!;
    expect(second.id).not.toBe(first.id);
    expect(second.workspaceId).toBeTruthy();
    expect(second.branch).toMatch(/login-form/);
    expect(h.store.duckRow(duck.id)).toMatchObject({ workspaceId: second.workspaceId, branch: second.branch });
    expect(h.sent.find((x) => x.session === second.id)!.text).toContain("Build the form");

    // Another duck joins it by the first duck's name.
    h.store.updateDuck(duck.id, { name: "Quiet Creek" });
    const other = (await h.call("POST", "/native/sessions", body(h, { place: { kind: "main" } }))).json
      .session as SessionRow;
    const joined = await h.tool(other.id, "join_branch", { duck: "quiet creek" });
    expect(joined.isError).toBeUndefined();
    const otherDuck = h.store.duckBySession(other.id)!;
    expect(h.store.duckRow(otherDuck.id)!.workspaceId).toBe(second.workspaceId);
    expect(h.store.listWorkspaces(h.pond.id)).toHaveLength(1);

    // Back to Main: a chat there, read-only, same duck.
    const back = await h.tool(second.id, "move_to_main");
    expect(back.isError).toBeUndefined();
    const third = h.store.getSession(h.store.duckRow(duck.id)!.currentSessionId!)!;
    expect(third).toMatchObject({ cwd: h.pond.rootPath, workspaceId: null });
    const again = await h.tool(third.id, "move_to_main");
    expect(again.content[0]!.text).toMatch(/already in Main/);
  });

  it("branch_off from a branch cuts from that branch; join_branch by name of a branch; unknown duck is an error", async () => {
    flagOn(true);
    const h = await start();
    const a = (await h.call("POST", "/native/sessions", body(h, { place: { kind: "new", branch: "feat/a" } }))).json
      .session as SessionRow;
    fs.writeFileSync(path.join(a.cwd, "only-a.txt"), "x\n");
    git(a.cwd, "add", ".");
    git(a.cwd, "-c", "user.name=T", "-c", "user.email=t@e.com", "commit", "-q", "-m", "a");
    const duck = h.store.duckForSession(a.id, h.pond.id)!;
    const off = await h.tool(a.id, "branch_off", { name: "Part two" });
    expect(off.isError).toBeUndefined();
    const next = h.store.getSession(h.store.duckRow(duck.id)!.currentSessionId!)!;
    expect(fs.existsSync(path.join(next.cwd, "only-a.txt"))).toBe(true);
    expect(next.branch).not.toBe("feat/a");
    const joinA = await h.tool(next.id, "join_branch", { branch: "feat/a" });
    expect(joinA.isError).toBeUndefined();
    expect(h.store.getSession(h.store.duckRow(duck.id)!.currentSessionId!)!.workspaceId).toBe(a.workspaceId);
    const ghost = await h.tool(a.id, "join_branch", { duck: "nobody" });
    expect(ghost.isError).toBe(true);
    expect((await h.tool(a.id, "join_branch", {})).isError).toBe(true);
  });

  it("a plain-folder pond has no branches to move to", async () => {
    flagOn(true);
    const h = await start();
    const folder = (await h.call("POST", "/native/sessions", body({ pond: h.folderPond }, {}))).json
      .session as SessionRow;
    const res = await h.tool(folder.id, "branch_off");
    expect(res.isError).toBe(true);
  });
});

describe("the thread context places the duck", () => {
  const note = (h: Awaited<ReturnType<typeof start>>, s: SessionRow): string =>
    (h.host as unknown as { contextNote(s: SessionRow): string }).contextNote(s);

  it("flag on, in Main: read-only, the active branches and the three tools", async () => {
    flagOn(true);
    const h = await start();
    const a = (await h.call("POST", "/native/sessions", body(h, { place: { kind: "new", branch: "feat/a" } }))).json
      .session as SessionRow;
    h.store.setTitle(a.id, "Login");
    const main = (await h.call("POST", "/native/sessions", body(h, { place: { kind: "main" } }))).json
      .session as SessionRow;
    const text = note(h, main);
    expect(text).toContain("Main is read-only for ducks");
    expect(text).toContain("pond app");
    expect(text).toMatch(/- feat\/a: .*ducks: Login/);
    for (const t of ["branch_off", "join_branch", "move_to_main"]) expect(text).toContain(t);
  });

  it("flag on, on a branch: shares the working copy; flag off: no placement lines at all; folder pond: none", async () => {
    flagOn(true);
    const h = await start();
    const a = (await h.call("POST", "/native/sessions", body(h, { place: { kind: "new", branch: "feat/a" } }))).json
      .session as SessionRow;
    expect(note(h, a)).toContain("work on branch feat/a");
    expect(note(h, a)).toContain("may edit at the same time");
    const folder = (await h.call("POST", "/native/sessions", body({ pond: h.folderPond }, {}))).json
      .session as SessionRow;
    expect(note(h, folder)).not.toContain("branch_off");
    flagOn(false);
    const main = h.store.createSession({
      cwd: h.pond.rootPath,
      agent: "claude",
      model: "m",
      permissionMode: "default",
    });
    expect(note(h, main)).not.toContain("read-only");
    expect(note(h, a)).not.toContain("branch_off");
  });
});
