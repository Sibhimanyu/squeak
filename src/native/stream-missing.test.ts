import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionHost } from "./host.js";
import { mainReadOnlyRoot } from "./placement.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import { claudeProjectFolder, streamMissingText } from "./stream-missing.js";
import { ResumeFailedError, type Runner, type RunnerHooks, type SessionRow } from "./types.js";
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

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 400 && !fn(); i++) await tick(10);
};

async function start() {
  process.env.SQUEAK_DUCKS_OWN_BRANCH = "on";
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stream-missing-")));
  const repo = path.join(dir, "app");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  const projectsDir = path.join(dir, "claude-projects");
  fs.mkdirSync(projectsDir);
  const store = new NativeStore(":memory:");
  const sent: { session: string; cwd: string; text: string }[] = [];
  const started: RunnerHooks[] = [];
  const host = new SessionHost({
    store,
    checkFolders: true,
    projectsDir,
    runnerFactory: (s: SessionRow, h: RunnerHooks): Runner => {
      started.push(h);
      return {
        canSteer: false,
        send: async (t) => {
          sent.push({ session: s.id, cwd: s.cwd, text: t });
          h.onStatus("working");
        },
        steer: async () => false,
        interrupt: async () => {},
        setPermissionMode: async () => {},
        close: async () => {},
      };
    },
  });
  const workspaces = new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") });
  const tokenPath = path.join(dir, "hook-token");
  const server = new NativeServer({ host, store, workspaces, tokenPath, port: 0, routines: false });
  const port = await server.start();
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  stops.push(async () => {
    await server.stop();
    await host.stop();
    fs.rmSync(dir, { recursive: true, force: true });
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
  const tool = async (sessionId: string, name: string, args: Record<string, unknown> = {}) => {
    const endpoint = server.mcpEndpoint(sessionId)!;
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    return ((await res.json()) as { result: { content: { text: string }[]; isError?: boolean } }).result;
  };
  const pond = workspaces.addProject(repo);
  return { dir, repo, store, host, workspaces, server, call, tool, pond, sent, started, projectsDir };
}

type Rig = Awaited<ReturnType<typeof start>>;

/** A Duck named Ruby 2 on its own Stream, with a Claude conversation whose transcript sits where Claude keeps it. */
async function duckOnStream(h: Rig) {
  const ws = h.workspaces.createWorkspace(h.pond.id);
  const s = h.store.createSession({
    cwd: ws.path,
    agent: "claude",
    model: "m",
    permissionMode: "default",
    title: "Ruby 2 work",
    workspaceId: ws.id,
  });
  const duck = h.store.duckForSession(s.id, h.pond.id)!;
  h.store.updateDuck(duck.id, { name: "Ruby 2" });
  const agentId = "9894b9d4-e088-4965-8c7b-c6c4b36f3fea";
  h.store.setAgentSessionId(s.id, agentId);
  const oldDir = path.join(h.projectsDir, claudeProjectFolder(ws.path));
  fs.mkdirSync(path.join(oldDir, agentId), { recursive: true });
  fs.writeFileSync(path.join(oldDir, `${agentId}.jsonl`), '{"type":"user"}\n');
  fs.writeFileSync(path.join(oldDir, agentId, "tool-result.txt"), "kept");
  return { ws, s, duck, agentId, oldDir };
}

/** What disk clean-up does to a Closed Duck's Stream: the working copy goes, the branch stays. */
function removeWorktree(h: Rig, ws: { path: string }) {
  git(h.repo, "worktree", "remove", "--force", ws.path);
}

const errorText = (h: Rig, id: string): string | undefined => {
  const rows = h.store.messagesAfter(id, 0).filter((m) => m.kind === "system/error");
  return (rows[rows.length - 1]?.payload as { text?: string } | undefined)?.text;
};

describe("a Duck whose Stream folder is gone", () => {
  it("a message moves the Duck to the Pond, resumes its session, delivers the message once and adds one note", async () => {
    const h = await start();
    const { ws, s, agentId } = await duckOnStream(h);
    removeWorktree(h, ws);

    const res = await h.call("POST", `/native/sessions/${s.id}/messages`, { text: "compact" });
    expect(res.status).toBe(200);
    await until(() => h.sent.length > 0);

    const moved = h.store.getSession(s.id)!;
    expect(moved.cwd).toBe(h.repo);
    expect(moved.workspaceId).toBeNull();
    expect(moved.agentSessionId).toBe(agentId);
    expect(h.sent).toEqual([{ session: s.id, cwd: h.repo, text: "compact" }]);
    expect(h.started).toHaveLength(1);
    expect(h.store.messagesAfter(s.id, 0).some((m) => m.kind === "system/error")).toBe(false);
    const folder = path.basename(ws.path);
    const notes = h.store
      .messagesAfter(s.id, 0)
      .filter((m) => m.kind === "system/note")
      .map((m) => (m.payload as { text: string }).text);
    expect(notes).toEqual([`${folder[0]!.toUpperCase()}${folder.slice(1)} is gone; Ruby works in the Pond now`]);
    expect(h.store.messagesAfter(s.id, 0).filter((m) => m.kind === "user/text")).toHaveLength(1);

    const listed = (await h.call("GET", "/native/sessions")).json.sessions.find((x: SessionRow) => x.id === s.id);
    expect(listed.streamMissing).toBeUndefined();
  });

  it("a message when the Pond's own folder is gone too fails with the plain sentence", async () => {
    const h = await start();
    const { ws, s } = await duckOnStream(h);
    removeWorktree(h, ws);
    fs.renameSync(h.repo, `${h.repo}-moved`);
    try {
      await h.call("POST", `/native/sessions/${s.id}/messages`, { text: "compact" });
      await until(() => h.store.getSession(s.id)?.status === "error");
      expect(errorText(h, s.id)).toBe(streamMissingText("Ruby 2", path.basename(ws.path)));
      expect(h.sent).toHaveLength(0);
    } finally {
      fs.renameSync(`${h.repo}-moved`, h.repo);
    }
  });

  it("an agent that exits while resuming in a folder that vanished is not a lost resume", async () => {
    const h = await start();
    const { ws, s } = await duckOnStream(h);
    await h.host.send(s.id, "hello");
    expect(h.started).toHaveLength(1);
    removeWorktree(h, ws);
    h.started[0]!.onExit(new ResumeFailedError("spawn claude ENOENT"));
    await until(() => h.store.getSession(s.id)?.status === "error");
    expect(errorText(h, s.id)).toMatch(/Stream folder .* is gone/);
    expect(errorText(h, s.id)).not.toMatch(/earlier conversation/);
  });

  it("a folder that is there reports nothing and refuses a recovery", async () => {
    const h = await start();
    const { s } = await duckOnStream(h);
    const listed = (await h.call("GET", "/native/sessions")).json.sessions.find((x: SessionRow) => x.id === s.id);
    expect(listed.streamMissing).toBeUndefined();
    expect((await h.call("POST", `/native/sessions/${s.id}/recover-stream`, {})).status).toBe(409);
    expect((await h.call("POST", `/native/sessions/${s.id}/recover-stream`, { choice: "stream" })).status).toBe(400);
  });

  it("Return to the Pond: the same chat moves to the Pond's folder (read-only Main), history kept, the branch stays joined", async () => {
    const h = await start();
    const { ws, s, duck, agentId, oldDir } = await duckOnStream(h);
    h.store.appendMessage(s.id, "user", "user/text", { text: "earlier work" });
    removeWorktree(h, ws);
    h.store.setWorkspaceState(ws.id, "archived"); // what disk clean-up leaves behind

    const res = await h.call("POST", `/native/sessions/${s.id}/recover-stream`, {});
    expect(res.status).toBe(200);
    const moved = h.store.getSession(s.id)!;
    expect(moved.id).toBe(s.id);
    expect(moved.cwd).toBe(h.repo);
    expect(moved.workspaceId).toBeNull();
    expect(mainReadOnlyRoot(h.store, moved)).toBe(h.repo);
    expect(moved.agentSessionId).toBe(agentId);
    expect(moved.status).toBe("idle");
    // the old branch still exists: it stays the Duck's joined Stream, with no working copy until it joins it again
    expect(h.store.duckRow(duck.id)).toMatchObject({ workspaceId: null, branch: ws.branch });
    expect(h.store.listWorkspaces(h.pond.id).filter((w) => w.state !== "archived")).toHaveLength(0);
    expect(h.store.messagesAfter(s.id, 0).some((m) => (m.payload as { text?: string }).text === "earlier work")).toBe(
      true,
    );

    // Claude looks for the transcript under the folder it runs in: it was carried there, sidecar included.
    const newDir = path.join(h.projectsDir, claudeProjectFolder(fs.realpathSync(h.repo)));
    expect(fs.readFileSync(path.join(newDir, `${agentId}.jsonl`), "utf8")).toBe('{"type":"user"}\n');
    expect(fs.readFileSync(path.join(newDir, agentId, "tool-result.txt"), "utf8")).toBe("kept");
    expect(fs.existsSync(path.join(oldDir, `${agentId}.jsonl`))).toBe(true);

    const listed = (await h.call("GET", "/native/sessions")).json.sessions.find((x: SessionRow) => x.id === s.id);
    expect(listed.streamMissing).toBeUndefined();

    // And the Duck runs again, in the Pond, resuming the same conversation.
    await h.host.send(s.id, "carry on");
    expect(h.sent).toEqual([{ session: s.id, cwd: h.repo, text: "carry on" }]);
  });

  it("Return to the Pond when the branch is gone too: nothing stays joined", async () => {
    const h = await start();
    const { ws, s, duck } = await duckOnStream(h);
    removeWorktree(h, ws);
    git(h.repo, "branch", "-D", ws.branch);
    h.store.setWorkspaceState(ws.id, "archived");

    expect((await h.call("POST", `/native/sessions/${s.id}/recover-stream`, {})).status).toBe(200);
    expect(h.store.getSession(s.id)!.cwd).toBe(h.repo);
    expect(h.store.duckRow(duck.id)).toMatchObject({ workspaceId: null, branch: null });
  });

  it("a Duck open can recover a teammate with the recover_stream tool", async () => {
    const h = await start();
    const { ws, s } = await duckOnStream(h);
    const helper = h.store.createSession({
      cwd: h.repo,
      agent: "claude",
      model: "m",
      permissionMode: "default",
      title: "Helper",
    });
    h.store.duckForSession(helper.id, h.pond.id);
    removeWorktree(h, ws);

    const bad = await h.tool(helper.id, "recover_stream", { duck: "Nobody" });
    expect(bad.isError).toBe(true);
    const done = await h.tool(helper.id, "recover_stream", { duck: "Ruby 2" });
    expect(done.isError).toBeUndefined();
    expect(done.content[0]!.text).toMatch(/carries on there with its history/);
    expect(h.store.getSession(s.id)!.cwd).toBe(h.repo);
  });
});

describe("messaging a Closed Duck", () => {
  it("wakes it: the message is accepted, the Duck is open and its agent starts, with no error", async () => {
    const h = await start();
    const s = h.store.createSession({
      cwd: h.repo,
      agent: "claude",
      model: "m",
      permissionMode: "default",
      title: "Resting",
    });
    const duck = h.store.duckForSession(s.id, h.pond.id)!;
    h.store.updateDuck(duck.id, { state: "closed" });
    // a chat in a git pond's Main moves to its own Stream first, so give this one its own
    const ws = h.workspaces.createWorkspace(h.pond.id);
    h.store.moveSessionPlace(s.id, { cwd: ws.path, workspaceId: ws.id, branch: ws.branch });

    const res = await h.call("POST", `/native/sessions/${s.id}/messages`, { text: "are you there" });
    expect(res.status).toBe(200);
    expect(res.json.error).toBeUndefined();
    expect(h.store.duckOf(s.id).state).toBe("open");
    await until(() => h.sent.length > 0);
    expect(h.sent.map((x) => x.text)).toEqual(["are you there"]);
    expect(h.store.messagesAfter(s.id, 0).some((m) => m.kind === "system/error")).toBe(false);
  });

  it("A Closed Duck whose Stream was cleaned up while it rested returns to the Pond when a person messages it", async () => {
    const h = await start();
    const { ws, s, duck, agentId } = await duckOnStream(h);
    h.store.updateDuck(duck.id, { state: "closed" });
    removeWorktree(h, ws);
    h.store.setWorkspaceState(ws.id, "archived"); // disk clean-up removed it: the Duck was resting

    const res = await h.call("POST", `/native/sessions/${s.id}/messages`, { text: "are you there" });
    expect(res.status).toBe(200);
    await until(() => h.sent.length > 0);
    const moved = h.store.getSession(s.id)!;
    expect(h.store.duckOf(s.id).state).toBe("open");
    expect(moved.cwd).toBe(h.repo);
    expect(moved.agentSessionId).toBe(agentId);
    expect(h.sent).toEqual([{ session: s.id, cwd: h.repo, text: "are you there" }]);
    expect(h.store.messagesAfter(s.id, 0).some((m) => m.kind === "system/error")).toBe(false);
  });
});
