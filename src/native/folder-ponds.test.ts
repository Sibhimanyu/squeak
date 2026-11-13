import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentTools } from "./agent-tools.js";
import { GitActions } from "./git-actions.js";
import { SessionHost } from "./host.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import type { Runner, RunnerHooks, SessionRow } from "./types.js";
import { HISTORY_LIMITS, NO_CHANGES, NO_PULL_REQUESTS, NO_STREAMS, VersionHistory } from "./version-history.js";
import { RepoPickers, WorkspaceSources } from "./workspace-sources.js";
import { WorkspaceManager } from "./workspaces.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (stops.length) await stops.pop()!();
});

async function start() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "folder-pond-")));
  const folder = path.join(dir, "notes");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "todo.txt"), "milk\n");
  fs.mkdirSync(path.join(folder, "node_modules"));
  fs.writeFileSync(path.join(folder, "node_modules", "big.js"), "x".repeat(5000));
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
  const pond = workspaces.addProject(folder);
  return { dir, folder, store, host, workspaces, call, pond, sent };
}

describe("a pond in a plain folder", () => {
  it("is added as a folder pond and a chat in it runs in the folder with no workspace", async () => {
    const h = await start();
    expect(h.pond.kind).toBe("folder");
    const made = await h.call("POST", "/native/sessions", {
      agent: "claude",
      model: "claude-sonnet-4-5",
      projectId: h.pond.id,
      text: "hello",
    });
    expect(made.status).toBe(201);
    const row = h.store.getSession(made.json.session.id)!;
    expect(row.cwd).toBe(h.folder);
    expect(row.workspaceId ?? null).toBeNull();
    expect(h.sent.length).toBeGreaterThan(0);
    // the pond can't be removed from under a working chat
    const del = await h.call("DELETE", `/native/projects/${h.pond.id}`);
    expect(del.status).toBe(409);
  });

  it("refuses a new stream, a branch list, pulls and issues, with plain sentences", async () => {
    const h = await start();
    const stream = await h.call("POST", `/native/projects/${h.pond.id}/workspaces`, {});
    expect(stream.status).toBe(400);
    expect(stream.json.error).toBe(NO_STREAMS);
    const asked = await h.call("POST", "/native/sessions", {
      agent: "claude",
      model: "m",
      projectId: h.pond.id,
      newWorkspace: true,
    });
    expect(asked.json.error).toBe(NO_STREAMS);
    expect((await h.call("GET", `/native/projects/${h.pond.id}/branches`)).json).toEqual({ branches: [] });
    expect((await h.call("GET", `/native/projects/${h.pond.id}/pulls`)).json.available).toBe(false);
    await expect(
      new WorkspaceSources({ store: h.store, workspaces: h.workspaces }).create(h.pond.id, {
        kind: "branch",
        branch: "x",
      }),
    ).rejects.toThrow(NO_STREAMS);
    expect((await new RepoPickers({ store: h.store }).issues(h.pond.id)).available).toBe(false);
  });

  it("says there are no changes, no pull request and no checkpoints instead of a git error", async () => {
    const h = await start();
    const s = h.store.createSession({ cwd: h.folder, agent: "claude", model: "m", permissionMode: "default" });
    const status = await h.call("GET", `/native/sessions/${s.id}/git`);
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ noHistory: NO_CHANGES, dirty: 0, branch: null });
    for (const action of ["create-pr", "commit-push", "merge"]) {
      const r = await h.call("POST", `/native/sessions/${s.id}/actions/${action}`, { confirm: true });
      expect(r.status).toBe(409);
      expect(r.json.error).toBe(NO_PULL_REQUESTS);
    }
    const tools = new AgentTools({
      store: h.store,
      workspaces: h.workspaces,
      send: async () => ({ queued: false }),
      create: async () => s,
      post: () => undefined,
    });
    expect(await tools.call(s.id, "stream_changes", {})).toBe(NO_CHANGES);
    await expect(tools.call(s.id, "set_merge_branch", { branch: "main" })).rejects.toThrow(NO_STREAMS);
    expect(
      new GitActions({ store: h.store, workspaces: h.workspaces, send: async () => ({ queued: false }) }),
    ).toBeTruthy();
  });

  it("keeps no checkpoints, even when the folder sits inside some other repository", async () => {
    const h = await start();
    const outer = path.join(h.dir, "outer");
    fs.mkdirSync(path.join(outer, "inner"), { recursive: true });
    git(outer, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(outer, "inner", "a.txt"), "a\n");
    const inner = path.join(outer, "inner");
    const nested = h.store.createProject({ name: "inner", rootPath: inner, defaultBranch: "main", kind: "folder" });
    const made = await h.call("POST", "/native/sessions", {
      agent: "claude",
      model: "m",
      projectId: nested.id,
      text: "go",
    });
    expect(made.status).toBe(201);
    await new Promise((r) => setTimeout(r, 100));
    expect(h.store.listTurns(made.json.session.id)[0]?.startCommit ?? null).toBeNull();
    const turns = await h.call("POST", `/native/sessions/${made.json.session.id}/revert`, {
      turn: 1,
      to: "start",
      confirm: true,
    });
    expect([409]).toContain(turns.status);
    expect(turns.json.error).not.toMatch(/git repository/);
  });
});

describe("turning on version history", () => {
  it("previews the files a first commit takes, leaving ignored folders out", async () => {
    const h = await start();
    const preview = (await h.call("GET", `/native/projects/${h.pond.id}/history`)).json;
    expect(preview.kind).toBe("folder");
    expect(preview.preview).toMatchObject({ files: 1, bytes: 5, tooBig: false, hasGitignore: false });
  });

  it("without a commit: git init on main, a .gitignore, an empty first commit, and the pond becomes git", async () => {
    const h = await start();
    const r = await h.call("POST", `/native/projects/${h.pond.id}/history`, {});
    expect(r.status).toBe(200);
    expect(r.json.project).toMatchObject({ kind: "git", defaultBranch: "main" });
    expect(git(h.folder, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(fs.readFileSync(path.join(h.folder, ".gitignore"), "utf8")).toContain("node_modules/");
    expect(git(h.folder, "ls-files")).toBe("");
    expect(git(h.folder, "rev-list", "--count", "HEAD")).toBe("1");
    // streams work now
    const ws = h.workspaces.createWorkspace(h.pond.id);
    expect(fs.existsSync(ws.path)).toBe(true);
  });

  it("with a commit it saves what is there, and keeps a .gitignore that already exists", async () => {
    const h = await start();
    fs.writeFileSync(path.join(h.folder, ".gitignore"), "secret.txt\n");
    fs.writeFileSync(path.join(h.folder, "secret.txt"), "s\n");
    const r = await h.call("POST", `/native/projects/${h.pond.id}/history`, { commit: true });
    expect(r.status).toBe(200);
    expect(fs.readFileSync(path.join(h.folder, ".gitignore"), "utf8")).toBe("secret.txt\n");
    expect(git(h.folder, "ls-files").split("\n").sort()).toEqual([".gitignore", "node_modules/big.js", "todo.txt"]);
  });

  it("refuses a first commit over the file or size limit, with a sentence, and changes nothing", async () => {
    const h = await start();
    const fake = new VersionHistory(h.store, async (args, cwd, env) => {
      if (args.includes("ls-files")) {
        return {
          code: 0,
          stdout: Array.from({ length: HISTORY_LIMITS.files + 1 }, (_, i) => `f${i}`).join("\0"),
          stderr: "",
        };
      }
      return realGit(args, cwd, env);
    });
    await expect(fake.enable(h.pond.id, { commit: true })).rejects.toThrow(/20,000/);
    expect(fs.existsSync(path.join(h.folder, ".git"))).toBe(false);
    expect(h.store.getProject(h.pond.id)!.kind).toBe("folder");
  });

  it("refuses while a chat is working, and turning it on twice is harmless", async () => {
    const h = await start();
    await h.call("POST", "/native/sessions", { agent: "claude", model: "m", projectId: h.pond.id, text: "go" });
    expect((await h.call("POST", `/native/projects/${h.pond.id}/history`, {})).status).toBe(409);
  });

  it("is idempotent and a body that is not a boolean is refused", async () => {
    const h = await start();
    expect((await h.call("POST", `/native/projects/${h.pond.id}/history`, { commit: "yes" })).status).toBe(400);
    expect((await h.call("POST", `/native/projects/${h.pond.id}/history`, {})).status).toBe(200);
    expect((await h.call("POST", `/native/projects/${h.pond.id}/history`, {})).json.project.kind).toBe("git");
  });
});

function realGit(args: string[], cwd: string, env?: Record<string, string>) {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch {
    return { code: 1, stdout: "", stderr: "" };
  }
}
