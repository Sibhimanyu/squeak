import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { READ_ONLY_ROOT_REASON, readOnlyDenial } from "./claude-runner.js";
import { SessionHost } from "./host.js";
import { mainReadOnlyRoot, Placement } from "./placement.js";
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

/** A chat sitting in the pond's Main (what an older chat looks like; a new chat can no longer start there). */
async function mainChat(h: Awaited<ReturnType<typeof start>>): Promise<SessionRow> {
  const s = await h.host.create({
    cwd: h.pond.rootPath,
    agent: "claude",
    model: "m",
    permissionMode: "default",
    workspaceId: null,
    text: "go",
  });
  h.store.duckForSession(s.id, h.pond.id);
  return h.store.getSession(s.id)!;
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
    // Main is where a Duck starts in a git pond: the Pond's folder, no Stream (it picks its own with open_stream).
    const main = await h.call("POST", "/native/sessions", body(h, { place: { kind: "main" } }));
    expect(main.status).toBe(201);
    expect(main.json.session.cwd).toBe(h.pond.rootPath);
    expect(main.json.session.workspaceId).toBeNull();
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

  it("a bare projectId, or main: true, starts Pond-wide in the Pond's folder; a folder pond gets its folder", async () => {
    flagOn(true);
    const h = await start();
    for (const extra of [{}, { main: true }]) {
      const res = await h.call("POST", "/native/sessions", body(h, { text: "Fix the login form", ...extra }));
      expect(res.status).toBe(201);
      const s = res.json.session as SessionRow;
      expect(s.workspaceId).toBeNull();
      expect(s.cwd).toBe(h.pond.rootPath);
      expect(mainReadOnlyRoot(h.store, s)).toBe(h.pond.rootPath);
      expect(h.store.duckBySession(s.id)).toBeTruthy();
      expect(h.store.duckStreams(h.store.duckBySession(s.id)!.id)).toEqual([]);
    }
    expect(h.store.listWorkspaces(h.pond.id)).toHaveLength(0);
    // An explicit join still joins.
    const first = (await h.call("POST", "/native/sessions", body(h, { place: { kind: "new", branch: "feat/x" } }))).json
      .session as SessionRow;
    const joined = await h.call("POST", "/native/sessions", body(h, { place: { kind: "join", branch: "feat/x" } }));
    expect(joined.json.session.workspaceId).toBe(first.workspaceId);
    const folder = await h.call("POST", "/native/sessions", body({ pond: h.folderPond }, {}));
    expect(folder.json.session.cwd).toBe(h.folderPond.rootPath);
  });

  it("the aliases still work, and mixing them with place is refused", async () => {
    flagOn(true);
    const h = await start();
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
    const first = await mainChat(h);
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

describe("a message to a chat sitting in Main", () => {
  it("goes to that chat (no move); an edit aimed at Main is still refused", async () => {
    flagOn(true);
    const h = await start();
    const old = await mainChat(h);
    h.store.setStatus(old.id, "idle");
    const res = await h.call("POST", `/native/sessions/${old.id}/messages`, { text: "Add dark mode" });
    expect(res.status).toBe(200);
    expect(res.json.movedTo).toBeUndefined();
    expect(h.sent.find((x) => x.session === old.id && x.text.includes("Add dark mode"))).toBeTruthy();
    expect(mainReadOnlyRoot(h.store, old)).toBe(h.pond.rootPath);
    expect(readOnlyDenial(h.pond.rootPath, old.cwd, "Edit", { file_path: `${h.pond.rootPath}/a.txt` })).toBe(
      READ_ONLY_ROOT_REASON,
    );
  });
});

const text = (r: { content: { text: string }[] }): string => r.content[0]!.text;
const names = async (h: Awaited<ReturnType<typeof start>>, id: string): Promise<string[]> =>
  (await h.rpc<{ tools: { name: string }[] }>(id, { jsonrpc: "2.0", id: 2, method: "tools/list" })).tools.map(
    (t) => t.name,
  );
const roomLines = (h: Awaited<ReturnType<typeof start>>) =>
  h.store.roomPosts(h.pond.id, { limit: 100 }).map((r) => ({ who: r.authorName, kind: r.kind, text: r.text }));

describe("agent tools: streams, open_stream, leave_stream", () => {
  it("are hidden and refused with the flag off", async () => {
    flagOn(false);
    const h = await start();
    const main = await h.call("POST", "/native/sessions", body(h, { main: true }));
    const id = main.json.session.id as string;
    const listed = await names(h, id);
    for (const n of ["streams", "open_stream", "leave_stream", "branch_off", "join_branch"]) {
      expect(listed).not.toContain(n);
    }
    expect((await h.tool(id, "open_stream", { name: "x" })).isError).toBe(true);
    expect(h.store.listWorkspaces(h.pond.id)).toHaveLength(0);
  });

  it("a new Duck starts in Main with no Stream; open_stream creates one and returns its folder, the Room gets one line", async () => {
    flagOn(true);
    const h = await start();
    const first = await mainChat(h);
    const duck = h.store.duckForSession(first.id, h.pond.id)!;
    h.store.updateDuck(duck.id, { name: "Quiet Creek" });
    const listed = await names(h, first.id);
    expect(listed).toEqual(expect.arrayContaining(["streams", "open_stream", "leave_stream"]));
    expect(listed).not.toContain("branch_off");
    expect(text(await h.tool(first.id, "streams"))).toMatch(/no branch yet/);

    const opened = await h.tool(first.id, "open_stream", { name: "Login form" });
    expect(opened.isError).toBeUndefined();
    const streams = h.store.duckStreams(duck.id);
    expect(streams).toHaveLength(1);
    expect(streams[0]!.branch).toMatch(/login-form/);
    expect(text(opened)).toContain(streams[0]!.path);
    expect(fs.existsSync(streams[0]!.path)).toBe(true);
    // The chat itself did not move: still Main, still read-only.
    expect(h.store.getSession(first.id)).toMatchObject({ cwd: h.pond.rootPath, workspaceId: null });
    expect(roomLines(h)).toEqual([{ who: "Quiet Creek", kind: "message", text: "created Stream Login form" }]);
    // Opening it again is a no-op: no second line, no second Stream.
    expect(text(await h.tool(first.id, "open_stream", { name: "Login form" }))).toMatch(/already in/);
    expect(roomLines(h)).toHaveLength(1);
    expect(h.store.listWorkspaces(h.pond.id)).toHaveLength(1);
  });

  it("another Duck joins by name or branch; a Duck may be in several Streams; streams lists who is in each; leave_stream leaves", async () => {
    flagOn(true);
    const h = await start();
    const a = await mainChat(h);
    const b = await mainChat(h);
    const duckA = h.store.duckBySession(a.id)!;
    const duckB = h.store.duckBySession(b.id)!;
    h.store.updateDuck(duckA.id, { name: "Quiet Creek" });
    h.store.updateDuck(duckB.id, { name: "Staff Otter" });
    await h.tool(a.id, "open_stream", { name: "Login" });
    await h.tool(a.id, "open_stream", { branch: "feat/billing" });
    expect(h.store.duckStreams(duckA.id).map((w) => w.branch)).toEqual([
      expect.stringMatching(/login/),
      "feat/billing",
    ]);
    const joined = await h.tool(b.id, "open_stream", { branch: "feat/billing" });
    expect(joined.isError).toBeUndefined();
    expect(text(joined)).toMatch(/Joined branch feat\/billing/);
    expect(h.store.listWorkspaces(h.pond.id)).toHaveLength(2);
    const view = text(await h.tool(b.id, "streams"));
    expect(view).toMatch(/feat\/billing.*Quiet Creek, Staff Otter; you are in it/);
    expect(roomLines(h).map((r) => r.text)).toEqual([
      "created Stream Login",
      "created Stream Feat Billing",
      "joined Stream Feat Billing",
    ]);

    // Leaving needs a name once in several; the Duck leaves just that one.
    expect((await h.tool(a.id, "leave_stream")).isError).toBe(true);
    const left = await h.tool(a.id, "leave_stream", { name: "feat/billing" });
    expect(left.isError).toBeUndefined();
    expect(h.store.duckStreams(duckA.id).map((w) => w.branch)).toEqual([expect.stringMatching(/login/)]);
    expect(h.store.duckStreams(duckB.id)).toHaveLength(1);
    expect(roomLines(h).at(-1)!.text).toBe("left Stream Feat Billing");
    // With one left, no name is needed; a Duck in none is told so.
    expect((await h.tool(a.id, "leave_stream")).isError).toBeUndefined();
    expect(text(await h.tool(a.id, "leave_stream"))).toMatch(/not in any branch/);
  });

  it("the host state of a Duck lists its Streams", async () => {
    flagOn(true);
    const h = await start();
    const a = await mainChat(h);
    await h.tool(a.id, "open_stream", { name: "Login" });
    await h.tool(a.id, "open_stream", { name: "Billing" });
    const ducks = (await h.call("GET", `/native/projects/${h.pond.id}/ducks`)).json.ducks as {
      streams?: { branch: string }[];
    }[];
    expect(ducks[0]!.streams!.map((s) => s.branch)).toEqual([
      expect.stringMatching(/login/),
      expect.stringMatching(/billing/),
    ]);
  });

  it("limits: at most four Streams per Duck, and five created per hour", async () => {
    flagOn(true);
    const h = await start();
    const a = await mainChat(h);
    for (const n of ["one", "two", "three", "four"]) {
      expect((await h.tool(a.id, "open_stream", { name: n })).isError).toBeUndefined();
    }
    const over = await h.tool(a.id, "open_stream", { name: "five" });
    expect(over.isError).toBe(true);
    expect(text(over)).toMatch(/already in 4 branches/);
    // Another Duck may still join an existing one.
    const b = await mainChat(h);
    expect((await h.tool(b.id, "open_stream", { name: "one" })).isError).toBeUndefined();
    expect(h.store.listWorkspaces(h.pond.id)).toHaveLength(4);
    // Leaving frees a place.
    await h.tool(a.id, "leave_stream", { name: "four" });
    expect((await h.tool(a.id, "open_stream", { name: "five" })).isError).toBeUndefined();
    await h.tool(a.id, "leave_stream", { name: "five" });
    // That was the fifth creation this hour.
    const sixth = await h.tool(a.id, "open_stream", { name: "six" });
    expect(sixth.isError).toBe(true);
    expect(text(sixth)).toMatch(/enough branches this hour/);
  });

  it("branch off an existing branch with from; an unknown base is an error; the older tool names still answer", async () => {
    flagOn(true);
    const h = await start();
    const a = await mainChat(h);
    await h.tool(a.id, "open_stream", { branch: "feat/a" });
    const ws = h.store.duckStreams(h.store.duckBySession(a.id)!.id)[0]!;
    fs.writeFileSync(path.join(ws.path, "only-a.txt"), "x\n");
    git(ws.path, "add", ".");
    git(ws.path, "-c", "user.name=T", "-c", "user.email=t@e.com", "commit", "-q", "-m", "a");
    const off = await h.tool(a.id, "open_stream", { name: "Part two", from: "feat/a" });
    expect(off.isError).toBeUndefined();
    const part = h.store.duckStreams(h.store.duckBySession(a.id)!.id)[1]!;
    expect(fs.existsSync(path.join(part.path, "only-a.txt"))).toBe(true);
    const ghost = await h.tool(a.id, "open_stream", { name: "x", from: "no-such-branch" });
    expect(ghost.isError).toBe(true);
    expect((await h.tool(a.id, "open_stream", {})).isError).toBe(true);
    // A chat begun before this update may still call the old names.
    const old = await mainChat(h);
    expect((await h.tool(old.id, "join_branch", { branch: "feat/a" })).isError).toBeUndefined();
    expect(h.store.duckStreams(h.store.duckBySession(old.id)!.id).map((w) => w.branch)).toEqual(["feat/a"]);
    expect((await h.tool(old.id, "join_branch", { duck: "nobody" })).isError).toBe(true);
    expect((await h.tool(old.id, "branch_off", { name: "Old way" })).isError).toBeUndefined();
  });

  it("a plain-folder pond has no branches: streams says so, open_stream is refused", async () => {
    flagOn(true);
    const h = await start();
    const folder = (await h.call("POST", "/native/sessions", body({ pond: h.folderPond }, {}))).json
      .session as SessionRow;
    expect(text(await h.tool(folder.id, "streams"))).toMatch(/plain folder/);
    const res = await h.tool(folder.id, "open_stream", { name: "x" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/plain folder/);
  });

  it("agent text is plain: no Squeak words in the tool descriptions", async () => {
    flagOn(true);
    const h = await start();
    const a = await mainChat(h);
    const list = await h.rpc<{ tools: { name: string; description: string }[] }>(a.id, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    for (const t of list.tools.filter((x) => ["streams", "open_stream", "leave_stream"].includes(x.name))) {
      expect(t.description).not.toMatch(/\b(duck|pond|squeak|stream)s?\b/i);
    }
  });
});

describe("Main read-only and edits in Streams", () => {
  const edit = (h: Awaited<ReturnType<typeof start>>, id: string, file: string): string | null =>
    (h.host as unknown as { guardEdit(id: string, files: string[]): string | null }).guardEdit(id, [file]);

  it("an edit under Main is refused for a Duck in a git pond; the same edit in a Stream it joined is allowed and locked", async () => {
    flagOn(true);
    const h = await start();
    const a = await mainChat(h);
    const b = await mainChat(h);
    const root = mainReadOnlyRoot(h.store, a);
    expect(readOnlyDenial(root, a.cwd, "Write", { file_path: "new.txt" })).toBe(READ_ONLY_ROOT_REASON);
    expect(readOnlyDenial(root, a.cwd, "Edit", { file_path: path.join(h.repo, "a.txt") })).toBe(READ_ONLY_ROOT_REASON);
    await h.tool(a.id, "open_stream", { name: "Login" });
    const stream = h.store.duckStreams(h.store.duckBySession(a.id)!.id)[0]!;
    const file = path.join(stream.path, "a.txt");
    expect(readOnlyDenial(root, a.cwd, "Edit", { file_path: file })).toBeNull();
    expect(edit(h, a.id, file)).toBeNull();
    // A Duck that has not joined it may not edit there, and says how to join.
    expect(edit(h, b.id, file)).toMatch(/not joined.*open_stream/);
    // Once it joins, the lock is per file: it waits while a holds a.txt, and may edit any other file.
    await h.tool(b.id, "open_stream", { branch: stream.branch });
    expect(edit(h, b.id, file)).toMatch(/locked/);
    expect(edit(h, b.id, path.join(stream.path, "other.txt"))).toBeNull();
    // Leaving takes the right to edit away.
    await h.tool(b.id, "leave_stream");
    expect(edit(h, b.id, path.join(stream.path, "third.txt"))).toMatch(/not joined/);
  });

  it("folder ponds are unchanged: edits take file locks in the folder", async () => {
    flagOn(true);
    const h = await start();
    const x = (await h.call("POST", "/native/sessions", body({ pond: h.folderPond }, {}))).json.session as SessionRow;
    const y = (await h.call("POST", "/native/sessions", body({ pond: h.folderPond }, {}))).json.session as SessionRow;
    const file = path.join(h.folderPond.rootPath, "n.md");
    expect(edit(h, x.id, file)).toBeNull();
    expect(edit(h, y.id, file)).toMatch(/locked/);
    expect(mainReadOnlyRoot(h.store, x)).toBeNull();
  });

  it("with the flag off a git pond's Main is not guarded", async () => {
    flagOn(false);
    const h = await start();
    const s = (await h.call("POST", "/native/sessions", body(h, { main: true }))).json.session as SessionRow;
    expect(mainReadOnlyRoot(h.store, s)).toBeNull();
    expect(edit(h, s.id, path.join(h.repo, "a.txt"))).toBeNull();
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
    const main = await mainChat(h);
    const text = note(h, main);
    expect(text).toContain("Main is read-only for ducks");
    expect(text).toContain("Squeak never picks a stream for you");
    expect(text).toContain("pond app");
    expect(text).toMatch(new RegExp(`- feat\\/a: .*ducks: ${h.store.duckBySession(a.id)!.name}`));
    for (const t of ["streams", "open_stream", "leave_stream"]) expect(text).toContain(t);
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
    expect(note(h, folder)).not.toContain("open_stream");
    flagOn(false);
    const main = h.store.createSession({
      cwd: h.pond.rootPath,
      agent: "claude",
      model: "m",
      permissionMode: "default",
    });
    expect(note(h, main)).not.toContain("read-only");
    expect(note(h, a)).not.toContain("open_stream");
  });
});

describe("Streams and the Duck's record", () => {
  it("a chat started inside a Stream counts as its Duck joining it", async () => {
    flagOn(true);
    const h = await start();
    const made = await h.call("POST", "/native/sessions", body(h, { place: { kind: "new", branch: "feat/login" } }));
    const duck = h.store.duckBySession(made.json.session.id)!;
    expect(h.store.duckStreams(duck.id).map((w) => w.branch)).toEqual(["feat/login"]);
  });

  it("a Stream with a joined Duck is not cleaned up; once the Duck leaves it can be", async () => {
    flagOn(true);
    const h = await start();
    const a = await mainChat(h);
    await h.tool(a.id, "open_stream", { name: "Kept" });
    const stream = h.store.duckStreams(h.store.duckBySession(a.id)!.id)[0]!;
    // Branch merged and folder clean: only the joined Duck keeps it.
    const placement = new Placement({ store: h.store, workspaces: h.workspaces });
    expect(await placement.cleanup(h.pond.id)).toEqual([]);
    await h.tool(a.id, "leave_stream");
    // Leaving also starts a clean-up pass of its own; either way the folder is gone once the passes finish.
    await placement.cleanup(h.pond.id);
    await vi.waitFor(() => expect(h.store.getWorkspace(stream.id)!.state).toBe("archived"));
  });
});
