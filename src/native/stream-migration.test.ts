import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionHost } from "./host.js";
import { joinedStreamDirs } from "./placement.js";
import { NativeStore } from "./store.js";
import { moveDucksToPond } from "./stream-migration.js";
import { claudeProjectFolder } from "./stream-missing.js";
import { WorkspaceManager } from "./workspaces.js";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const ID = "11111111-2222-3333-4444-555555555555";

function setup() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "duck-migrate-")));
  dirs.push(dir);
  const repo = path.join(dir, "app");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  const store = new NativeStore(":memory:");
  const workspaces = new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") });
  const pond = workspaces.addProject(repo);
  const projects = path.join(dir, "claude-projects");
  /** A Stream: a branch with a real working copy, and a chat in it. */
  const stream = (branch: string, agent: "claude" | "codex" = "claude", agentId: string | null = null) => {
    const wt = path.join(dir, "ws", branch);
    git(repo, "worktree", "add", "-q", "-b", branch, wt);
    const ws = store.createWorkspace({ projectId: pond.id, name: branch, path: wt, branch });
    const s = store.createSession({
      cwd: wt,
      agent,
      model: "m",
      permissionMode: "default",
      workspaceId: ws.id,
      branch,
      title: null,
    } as never);
    store.duckForSession(s.id, pond.id);
    if (agentId) store.setAgentSessionId(s.id, agentId);
    return { ws, wt, s };
  };
  return { dir, repo, store, pond, projects, stream };
}

function transcript(projects: string, cwd: string, id: string) {
  const folder = path.join(projects, claudeProjectFolder(cwd));
  fs.mkdirSync(path.join(folder, id), { recursive: true });
  fs.writeFileSync(path.join(folder, `${id}.jsonl`), '{"type":"user"}\n');
  fs.writeFileSync(path.join(folder, id, "side.txt"), "sidecar");
}

describe("moveDucksToPond", () => {
  it("moves a chat in a Stream to the Pond folder, joins that Stream and carries the Claude transcript", async () => {
    const h = setup();
    const a = h.stream("feat-a", "claude", ID);
    transcript(h.projects, a.wt, ID);
    const r = await moveDucksToPond({ store: h.store, projectsDir: h.projects });
    expect(r).toEqual({ moved: 1, missing: 0 });
    const s = h.store.getSession(a.s.id)!;
    expect(s.cwd).toBe(h.repo);
    expect(s.workspaceId).toBeNull();
    const duck = h.store.duckBySession(a.s.id)!;
    expect(duck.workspaceId).toBeNull();
    expect(duck.branch).toBe("feat-a");
    expect(h.store.duckStreams(duck.id).map((w) => w.id)).toEqual([a.ws.id]);
    const folder = path.join(h.projects, claudeProjectFolder(h.repo));
    expect(fs.readFileSync(path.join(folder, `${ID}.jsonl`), "utf8")).toContain("user");
    expect(fs.readFileSync(path.join(folder, ID, "side.txt"), "utf8")).toBe("sidecar");
    // the old copy stays
    expect(fs.existsSync(path.join(h.projects, claudeProjectFolder(a.wt), `${ID}.jsonl`))).toBe(true);
    expect(h.store.messagesAfter(a.s.id).some((m) => m.kind === "system/note")).toBe(true);
    expect(joinedStreamDirs(h.store, h.store.getSession(a.s.id)!)).toEqual([a.wt]); // what the agent may edit
  });

  it("is once and idempotent: a second run, or a chat already in the Pond folder, changes nothing", async () => {
    const h = setup();
    const a = h.stream("feat-a");
    expect((await moveDucksToPond({ store: h.store, projectsDir: h.projects })).moved).toBe(1);
    const again = await moveDucksToPond({ store: h.store, projectsDir: h.projects });
    expect(again).toEqual({ moved: 0, missing: 0 });
    const duck = h.store.duckBySession(a.s.id)!;
    expect(h.store.duckStreams(duck.id)).toHaveLength(1);
    // a chat that is back in a Stream after the run is not moved by a rerun
    const b = h.stream("feat-b");
    expect((await moveDucksToPond({ store: h.store, projectsDir: h.projects })).moved).toBe(0);
    expect(h.store.getSession(b.s.id)!.cwd).toBe(b.wt);
  });

  it("leaves a chat that is already in the Pond folder or in a folder Pond alone", async () => {
    const h = setup();
    const main = h.store.createSession({
      cwd: h.repo,
      agent: "claude",
      model: "m",
      permissionMode: "default",
      workspaceId: null,
      title: null,
    } as never);
    h.store.duckForSession(main.id, h.pond.id);
    expect((await moveDucksToPond({ store: h.store, projectsDir: h.projects })).moved).toBe(0);
    expect(h.store.getSession(main.id)!.cwd).toBe(h.repo);
  });

  it("a missing working copy: the chat moves, the transcript is carried, the branch is kept when git has it", async () => {
    const h = setup();
    const a = h.stream("feat-a", "claude", ID);
    transcript(h.projects, a.wt, ID);
    fs.rmSync(a.wt, { recursive: true, force: true });
    const r = await moveDucksToPond({ store: h.store, projectsDir: h.projects });
    expect(r).toEqual({ moved: 1, missing: 1 });
    expect(h.store.getSession(a.s.id)!.cwd).toBe(h.repo);
    const duck = h.store.duckBySession(a.s.id)!;
    expect(duck.branch).toBe("feat-a");
    expect(h.store.duckStreams(duck.id)).toEqual([]); // no folder to be in; open_stream makes it again
    expect(fs.existsSync(path.join(h.projects, claudeProjectFolder(h.repo), `${ID}.jsonl`))).toBe(true);
    const note = h.store.messagesAfter(a.s.id).find((m) => m.kind === "system/note")!;
    expect((note.payload as { text: string }).text).toMatch(/join it again with open_stream/);
  });

  it("a missing working copy whose branch is gone records no branch", async () => {
    const h = setup();
    const a = h.stream("feat-a");
    fs.rmSync(a.wt, { recursive: true, force: true });
    git(h.repo, "worktree", "prune");
    git(h.repo, "branch", "-D", "feat-a");
    await moveDucksToPond({ store: h.store, projectsDir: h.projects });
    expect(h.store.duckBySession(a.s.id)!.branch).toBeNull();
    const note = h.store.messagesAfter(a.s.id).find((m) => m.kind === "system/note")!;
    expect((note.payload as { text: string }).text).toMatch(/branch is gone/);
  });

  it("Codex: moves the chat and keeps its thread id; nothing is copied (a thread resumes by id from disk)", async () => {
    const h = setup();
    const a = h.stream("feat-a", "codex", "thread-xyz");
    await moveDucksToPond({ store: h.store, projectsDir: h.projects });
    const s = h.store.getSession(a.s.id)!;
    expect(s.cwd).toBe(h.repo);
    expect(s.agentSessionId).toBe("thread-xyz");
    expect(fs.existsSync(h.projects)).toBe(false);
  });

  it("two chats of one Stream both join it", async () => {
    const h = setup();
    const a = h.stream("feat-a");
    const second = h.store.createSession({
      cwd: a.wt,
      agent: "claude",
      model: "m",
      permissionMode: "default",
      workspaceId: a.ws.id,
      branch: "feat-a",
      title: null,
    } as never);
    h.store.duckForSession(second.id, h.pond.id);
    expect((await moveDucksToPond({ store: h.store, projectsDir: h.projects })).moved).toBe(2);
    expect(h.store.ducksInStream(a.ws.id)).toHaveLength(2);
  });

  it("runs when the host starts", async () => {
    const h = setup();
    const a = h.stream("feat-a");
    const host = new SessionHost({ store: h.store, runnerFactory: () => ({}) as never, projectsDir: h.projects });
    host.start();
    await vi.waitFor(() => expect(h.store.getSession(a.s.id)!.cwd).toBe(h.repo));
    await host.stop();
  });
});
