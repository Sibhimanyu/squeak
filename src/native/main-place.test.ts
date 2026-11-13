import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentTools } from "./agent-tools.js";
import { GitActions } from "./git-actions.js";
import { SessionHost } from "./host.js";
import { forgetMainBranch, mainBranchOf } from "./main-place.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import type { Runner, RunnerHooks, SessionRow } from "./types.js";
import { WorkspaceManager } from "./workspaces.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (stops.length) await stops.pop()!();
  forgetMainBranch();
});

async function start() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "main-pond-")));
  const root = path.join(dir, "app");
  fs.mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.com");
  git(root, "config", "user.name", "T");
  fs.writeFileSync(path.join(root, "a.txt"), "one\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "first");
  const store = new NativeStore(":memory:");
  const sent: string[] = [];
  const host = new SessionHost({
    store,
    runnerFactory: (_s: SessionRow, h: RunnerHooks): Runner => ({
      canSteer: false,
      send: async (t) => {
        sent.push(t);
        h.onStatus("working");
      },
      steer: async () => false,
      interrupt: async () => {},
      setPermissionMode: async () => {},
      close: async () => {},
    }),
  });
  const workspaces = new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") });
  const actions = new GitActions({
    store,
    workspaces,
    send: async (id, text) => {
      sent.push(`${id}:${text}`);
      return { queued: false };
    },
    ghBin: null,
  });
  const tokenPath = path.join(dir, "hook-token");
  const server = new NativeServer({ host, store, workspaces, tokenPath, port: 0, routines: false, git: actions });
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
  const pond = workspaces.addProject(root);
  const main = async () => {
    const made = await call("POST", "/native/sessions", {
      agent: "claude",
      model: "claude-sonnet-4-5",
      projectId: pond.id,
      main: true,
      text: "hello",
    });
    return made;
  };
  return { dir, root, store, host, workspaces, call, pond, main, sent };
}

describe("Main, a git pond's own folder", () => {
  it("starts a chat in the root with no workspace row, and refuses to mix it with a stream", async () => {
    const h = await start();
    expect(h.pond.kind).toBe("git");
    const made = await h.main();
    expect(made.status).toBe(201);
    const row = h.store.getSession(made.json.session.id)!;
    expect(row.cwd).toBe(h.root);
    expect(row.workspaceId ?? null).toBeNull();
    expect(h.store.listWorkspaces(h.pond.id)).toEqual([]);
    const mixed = await h.call("POST", "/native/sessions", {
      agent: "claude",
      model: "m",
      projectId: h.pond.id,
      main: true,
      newWorkspace: true,
    });
    expect(mixed.status).toBe(400);
    expect(h.store.listWorkspaces(h.pond.id)).toEqual([]);
    expect((await h.call("POST", "/native/sessions", { agent: "claude", model: "m", main: true })).status).toBe(400);
  });

  it("places a Main chat in its pond in the directory, never in Other", async () => {
    const h = await start();
    const made = await h.main();
    const d = (await h.call("GET", "/native/directory")).json;
    expect(d.threads[`squeak-native:${made.json.session.id}`]).toBe(h.pond.id);
    expect(d.other).not.toContain(`squeak-native:${made.json.session.id}`);
    expect(d.ponds.find((p: { id: string }) => p.id === h.pond.id).counts.threads).toBe(1);
  });

  it("stores the chosen stream on a chat started in it, by id or by its folder", async () => {
    const h = await start();
    const ws = h.store.createWorkspace({
      projectId: h.pond.id,
      name: "dallas",
      branch: "student-remarks",
      path: path.join(h.dir, "ws", "dallas"),
    });
    fs.mkdirSync(ws.path, { recursive: true });
    const byId = await h.call("POST", "/native/sessions", {
      agent: "claude",
      model: "m",
      projectId: h.pond.id,
      workspaceId: ws.id,
    });
    expect(byId.status).toBe(201);
    expect(h.store.getSession(byId.json.session.id)).toMatchObject({ workspaceId: ws.id, cwd: ws.path });
    // An older Mac names only the folder: the host still files the chat under that stream.
    const byPath = await h.call("POST", "/native/sessions", {
      agent: "claude",
      model: "m",
      projectId: h.pond.id,
      cwd: ws.path,
    });
    expect(h.store.getSession(byPath.json.session.id)?.workspaceId).toBe(ws.id);
    const d = (await h.call("GET", "/native/directory")).json;
    expect(d.threads[`squeak-native:${byId.json.session.id}`]).toBe(h.pond.id);
    expect(d.threads[`squeak-native:${byPath.json.session.id}`]).toBe(h.pond.id);
  });

  it("is not adopted into a stream, and a working Main chat blocks removing the pond", async () => {
    const h = await start();
    const made = await h.main();
    const ws = h.store.createWorkspace({
      projectId: h.pond.id,
      name: "mallard",
      branch: "mallard",
      path: path.join(h.dir, "ws", "mallard"),
    });
    expect(ws.path).not.toBe(h.root);
    expect(h.store.adoptWorkspaces()).toBe(0);
    expect(h.store.getSession(made.json.session.id)?.workspaceId ?? null).toBeNull();
    const del = await h.call("DELETE", `/native/projects/${h.pond.id}`);
    expect(del.status).toBe(409);
  });

  it("lists the branch the root is on with the project, a detached head as its short sha", async () => {
    const h = await start();
    const first = (await h.call("GET", "/native/projects")).json.projects.find(
      (p: { id: string }) => p.id === h.pond.id,
    );
    expect(first.mainBranch).toBe("main");
    git(h.root, "checkout", "-q", "-b", "feature/x");
    forgetMainBranch();
    expect(await mainBranchOf(h.root)).toBe("feature/x");
    const sha = git(h.root, "rev-parse", "--short", "HEAD");
    git(h.root, "checkout", "-q", "--detach");
    forgetMainBranch();
    expect(await mainBranchOf(h.root)).toBe(sha);
  });

  it("reports git status by its folder: uncommitted files counted, no pull request on the default branch", async () => {
    const h = await start();
    const made = await h.main();
    const id = made.json.session.id;
    fs.writeFileSync(path.join(h.root, "b.txt"), "new\n");
    const status = await h.call("GET", `/native/sessions/${id}/git`);
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ branch: "main", base: "main", dirty: 1, main: true, onDefaultBranch: true });
    expect(status.json.prReason).toBe("none");
    expect(status.json.prMessage).toMatch(/default branch/);
  });

  it("refuses Create PR on the default branch, allows it on another, and has no merge target", async () => {
    const h = await start();
    const made = await h.main();
    const id = made.json.session.id;
    const refused = await h.call("POST", `/native/sessions/${id}/actions/create-pr`, {});
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/Main is on main, the default branch/);
    expect(h.sent.some((t) => t.startsWith(`${id}:`))).toBe(false);
    git(h.root, "checkout", "-q", "-b", "feature/x");
    const status = await h.call("GET", `/native/sessions/${id}/git`);
    expect(status.json).toMatchObject({ branch: "feature/x", main: true, onDefaultBranch: false });
    const ok = await h.call("POST", `/native/sessions/${id}/actions/create-pr`, {});
    expect(ok.status).toBe(200);
    expect(h.sent.some((t) => t.startsWith(`${id}:`))).toBe(true);
    const tools = new AgentTools({
      store: h.store,
      workspaces: h.workspaces,
      send: async () => ({ queued: false }),
      create: async () => h.store.getSession(id)!,
      post: () => undefined,
    });
    await expect(tools.call(id, "set_merge_branch", { branch: "main" })).rejects.toThrow(/Main/);
  });

  it("shows uncommitted changes as the agent's stream_changes", async () => {
    const h = await start();
    const made = await h.main();
    const id = made.json.session.id;
    fs.writeFileSync(path.join(h.root, "a.txt"), "one\ntwo\n");
    fs.writeFileSync(path.join(h.root, "c.txt"), "brand new\n");
    const tools = new AgentTools({
      store: h.store,
      workspaces: h.workspaces,
      send: async () => ({ queued: false }),
      create: async () => h.store.getSession(id)!,
      post: () => undefined,
    });
    const out = await tools.call(id, "stream_changes", {});
    expect(out).toContain("+two");
    expect(out).toContain("c.txt");
  });
});
