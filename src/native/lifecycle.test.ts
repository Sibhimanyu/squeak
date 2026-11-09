import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitActions } from "./git-actions.js";
import { SessionHost } from "./host.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import type { Runner, RunnerHooks, SessionRow } from "./types.js";
import { WorkspaceManager } from "./workspaces.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

interface Harness {
  base: string;
  dir: string;
  repo: string;
  projectId: string;
  token: string;
  store: NativeStore;
  mgr: WorkspaceManager;
  sent: string[];
  hooks: Map<string, RunnerHooks>;
  ghLog: string;
  ghDir: string;
  stop: () => Promise<void>;
}

const open: Harness[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.stop();
});

/** A stand-in `gh`: prints pr.json for `pr view`, records every call, `merge.fail` makes a merge fail. */
function fakeGh(dir: string): string {
  const bin = path.join(dir, "gh");
  fs.writeFileSync(
    bin,
    `#!/bin/sh
d="$(dirname "$0")"
echo "$@" >> "$d/calls.log"
if [ "$1 $2" = "pr view" ]; then
  [ -f "$d/slow" ] && sleep 3
  if [ -f "$d/pr.json" ]; then cat "$d/pr.json"; exit 0; fi
  echo "no pull requests found for branch" >&2; exit 1
fi
if [ "$1 $2" = "pr merge" ]; then
  if [ -f "$d/merge.fail" ]; then echo "Pull request is not mergeable: base branch policy" >&2; exit 1; fi
  exit 0
fi
exit 2
`,
    { mode: 0o755 },
  );
  return bin;
}

async function start(opts: { gh?: boolean | "missing"; ghTimeoutMs?: number } = {}): Promise<Harness> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-life-")));
  const repo = path.join(dir, "demo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "trunk");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "t@example.com");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const remote = path.join(dir, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "trunk");
  git(repo, "remote", "set-head", "origin", "trunk");

  const store = new NativeStore(":memory:");
  const sent: string[] = [];
  const hooks = new Map<string, RunnerHooks>();
  const host = new SessionHost({
    store,
    runnerFactory: (s: SessionRow, h: RunnerHooks): Runner => {
      hooks.set(s.id, h);
      return {
        canSteer: false,
        send: async (t) => {
          sent.push(t);
          h.onStatus("working");
        },
        steer: async () => false,
        interrupt: async () => {},
        setPermissionMode: async () => {},
        close: async () => {},
      };
    },
  });
  const mgr = new WorkspaceManager({
    store,
    workspacesRoot: path.join(dir, "ws"),
    gitUser: "Test User",
    killGraceMs: 500,
    setupTimeoutMs: 5000,
  });
  const ghDir = path.join(dir, "ghbin");
  fs.mkdirSync(ghDir);
  const ghBin = opts.gh === "missing" ? null : fakeGh(ghDir);
  const gitActions = new GitActions({
    store,
    workspaces: mgr,
    send: (id, text) => host.send(id, text),
    ghBin,
    ...(opts.ghTimeoutMs ? { ghTimeoutMs: opts.ghTimeoutMs } : {}),
  });
  const tokenPath = path.join(dir, "hook-token");
  const server = new NativeServer({ host, store, workspaces: mgr, tokenPath, port: 0, git: gitActions });
  const port = await server.start();
  const project = mgr.addProject(repo);
  const h: Harness = {
    base: `http://127.0.0.1:${port}`,
    dir,
    repo,
    projectId: project.id,
    token: fs.readFileSync(tokenPath, "utf8").trim(),
    store,
    mgr,
    sent,
    hooks,
    ghLog: path.join(ghDir, "calls.log"),
    ghDir,
    stop: async () => {
      await mgr.shutdown();
      await server.stop();
      await host.stop();
    },
  };
  open.push(h);
  return h;
}

async function call(h: Harness, method: string, url: string, body?: unknown, token: string | null = h.token) {
  const res = await fetch(h.base + url, {
    method,
    headers: {
      ...(token ? { "x-squeak-token": token } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Json) : {} };
}

async function until(fn: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting");
}

const patch = (h: Harness, body: unknown) => call(h, "PATCH", `/native/projects/${h.projectId}/settings`, body);
const newChat = async (h: Harness, text?: string) =>
  (
    await call(h, "POST", "/native/sessions", {
      agent: "claude",
      model: "m",
      projectId: h.projectId,
      newWorkspace: true,
      ...(text ? { text } : {}),
    })
  ).body.session as SessionRow;

describe("project settings", () => {
  it("defaults, patches, clears and refuses bad input", async () => {
    const h = await start();
    const first = await call(h, "GET", `/native/projects/${h.projectId}/settings`);
    expect(first.status).toBe(200);
    expect(first.body.effective).toMatchObject({
      branchPrefix: "test-user/",
      mergeMethod: "squash",
      setupScript: null,
    });
    expect(first.body.effective.prompts["create-pr"]).toContain("{base}");
    expect(first.body.sources.mergeMethod).toBe("default");

    const set = await patch(h, {
      setupScript: "npm ci",
      branchPrefix: "feat",
      mergeMethod: "rebase",
      prompts: { review: "Look it over." },
    });
    expect(set.status).toBe(200);
    expect(set.body.effective).toMatchObject({ setupScript: "npm ci", branchPrefix: "feat/", mergeMethod: "rebase" });
    expect(set.body.effective.prompts.review).toBe("Look it over.");
    expect(set.body.sources).toMatchObject({ setupScript: "project", mergeMethod: "project" });
    expect(set.body.sources.prompts.review).toBe("project");

    const cleared = await patch(h, {
      setupScript: null,
      branchPrefix: "",
      mergeMethod: null,
      prompts: { review: null },
    });
    expect(cleared.body.effective).toMatchObject({
      setupScript: null,
      branchPrefix: "test-user/",
      mergeMethod: "squash",
    });
    expect(cleared.body.sources.prompts.review).toBe("default");

    expect((await patch(h, { mergeMethod: "fast-forward" })).status).toBe(400);
    expect((await patch(h, { branchPrefix: "bad prefix!" })).status).toBe(400);
    expect((await patch(h, { prompts: { nope: "x" } })).status).toBe(400);
    expect((await patch(h, { colour: "red" })).status).toBe(400);
    expect((await patch(h, { setupScript: 5 })).status).toBe(400);
    expect((await call(h, "GET", "/native/projects/nope/settings")).status).toBe(404);
    expect((await call(h, "GET", `/native/projects/${h.projectId}/settings`, undefined, null)).status).toBe(401);
  });

  it("uses conductor.json scripts when the project has none, and says so", async () => {
    const h = await start();
    fs.writeFileSync(
      path.join(h.repo, "conductor.json"),
      JSON.stringify({ scripts: { setup: "echo setup", run: "echo run", archive: "echo bye" } }),
    );
    const r = await call(h, "GET", `/native/projects/${h.projectId}/settings`);
    expect(r.body.effective).toMatchObject({
      setupScript: "echo setup",
      runScript: "echo run",
      archiveScript: "echo bye",
    });
    expect(r.body.sources).toMatchObject({ setupScript: "conductor.json", runScript: "conductor.json" });
    expect(r.body.settings.setupScript).toBeNull();
    const own = await patch(h, { runScript: "npm start" });
    expect(own.body.sources).toMatchObject({ runScript: "project", setupScript: "conductor.json" });
    expect(own.body.effective.runScript).toBe("npm start");
  });

  it("names the branch with the project's prefix", async () => {
    const h = await start();
    await patch(h, { branchPrefix: "team/x" });
    const s = await newChat(h);
    const ws = h.store.getWorkspace(s.workspaceId!)!;
    expect(ws.branch).toBe("team/x/mallard");
  });
});

describe("setup script", () => {
  it("runs with Squeak and Conductor env, gates the first message, then lets it go", async () => {
    const h = await start();
    const out = path.join(h.dir, "env.txt");
    const gate = path.join(h.dir, "gate");
    await patch(h, {
      setupScript: `echo "$SQUEAK_ROOT_PATH|$SQUEAK_WORKSPACE_PATH|$SQUEAK_PORT|$CONDUCTOR_ROOT_PATH|$CONDUCTOR_WORKSPACE_PATH|$CONDUCTOR_PORT" > "${out}"; echo hello-setup; while [ ! -f "${gate}" ]; do sleep 0.02; done`,
    });
    const s = await newChat(h, "do the thing");
    const wsId = s.workspaceId!;
    expect(h.store.getWorkspace(wsId)!.state).toBe("setting_up");
    expect(h.sent).toEqual([]);
    expect(h.store.queued(s.id).map((q) => q.text)).toEqual(["do the thing"]);
    // the chat can also be read while setup runs
    await until(() => fs.existsSync(out));
    const live = await call(h, "GET", `/native/workspaces/${wsId}/log`);
    expect(live.body.state).toBe("setting_up");
    await until(async () => (await call(h, "GET", `/native/workspaces/${wsId}/log`)).body.log.includes("hello-setup"));

    fs.writeFileSync(gate, "");
    await until(() => h.store.getWorkspace(wsId)!.state === "ready");
    await until(() => h.sent.length === 1);
    expect(h.sent).toEqual(["do the thing"]);
    expect(h.store.queued(s.id)).toEqual([]);

    const ws = h.store.getWorkspace(wsId)!;
    const [root, wsPath, port, croot, cpath, cport] = fs.readFileSync(out, "utf8").trim().split("|");
    expect(root).toBe(h.repo);
    expect(wsPath).toBe(ws.path);
    expect(croot).toBe(root);
    expect(cpath).toBe(wsPath);
    expect(Number(port)).toBe(ws.port);
    expect(cport).toBe(port);
    const done = await call(h, "GET", `/native/workspaces/${wsId}/log`);
    expect(done.body.log).toContain("hello-setup");
  });

  it("marks a failed setup, keeps the output and tells the chat", async () => {
    const h = await start();
    await patch(h, { setupScript: "echo boom-output; exit 3" });
    const s = await newChat(h, "go anyway");
    await until(() => h.store.getWorkspace(s.workspaceId!)!.state === "setup_failed");
    const log = await call(h, "GET", `/native/workspaces/${s.workspaceId}/log`);
    expect(log.body.state).toBe("setup_failed");
    expect(log.body.log).toContain("boom-output");
    expect(log.body.log).toContain("exit 3");
    const msgs = await call(h, "GET", `/native/sessions/${s.id}/messages`);
    const sys = msgs.body.messages.find((m: { kind: string }) => m.kind === "system/setup-failed");
    expect(sys.payload.text).toContain("setup script failed");
    await until(() => h.sent.length === 1);
  });

  it("stops a setup script that outlives its timeout, and a restart fails what was setting up", async () => {
    const h = await start();
    const slow = new WorkspaceManager({
      store: h.store,
      workspacesRoot: path.join(h.dir, "ws2"),
      setupTimeoutMs: 150,
      killGraceMs: 100,
    });
    await patch(h, { setupScript: "sleep 30" });
    const ws = slow.createWorkspace(h.projectId);
    await until(() => h.store.getWorkspace(ws.id)!.state === "setup_failed");
    expect(slow.getLog(ws.id).log).toContain("took too long");

    h.store.setWorkspaceState(ws.id, "setting_up");
    slow.recover();
    expect(h.store.getWorkspace(ws.id)!.state).toBe("setup_failed");
    expect(slow.getLog(ws.id).log).toContain("restarted");
  });
});

describe("run script", () => {
  it("starts one process group per workspace and kills the whole group on stop", async () => {
    const h = await start();
    const pidFile = path.join(h.dir, "bg.pid");
    await patch(h, { runScript: `sleep 60 & echo $! > "${pidFile}"; echo serving on $SQUEAK_PORT; wait` });
    const s = await newChat(h);
    const id = s.workspaceId!;
    const url = `/native/workspaces/${id}/run`;
    expect((await call(h, "GET", url)).body).toMatchObject({ running: false, logTail: "" });

    const started = await call(h, "POST", url, { action: "start" });
    expect(started.status).toBe(200);
    expect(started.body.running).toBe(true);
    expect(started.body.pid).toBeGreaterThan(0);
    expect((await call(h, "POST", url, { action: "start" })).status).toBe(400);
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "");
    const bg = Number(fs.readFileSync(pidFile, "utf8"));
    const status = await call(h, "GET", url);
    expect(status.body.port).toBe(h.store.getWorkspace(id)!.port);
    await until(async () => (await call(h, "GET", url)).body.logTail.includes(`serving on ${status.body.port}`));

    const stopped = await call(h, "POST", url, { action: "stop" });
    expect(stopped.body.running).toBe(false);
    expect(() => process.kill(bg, 0)).toThrow();
    expect(() => process.kill(started.body.pid, 0)).toThrow();
    expect((await call(h, "POST", url, { action: "jump" })).status).toBe(400);
  });

  it("needs a run script and a ready workspace; archive and shutdown stop it", async () => {
    const h = await start();
    const s = await newChat(h);
    const id = s.workspaceId!;
    const none = await call(h, "POST", `/native/workspaces/${id}/run`, { action: "start" });
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/no run script/);

    await patch(h, { runScript: "sleep 60" });
    const pid = (await call(h, "POST", `/native/workspaces/${id}/run`, { action: "start" })).body.pid as number;
    const archived = await call(h, "POST", `/native/workspaces/${id}/archive`, {});
    expect(archived.status).toBe(200);
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await call(h, "POST", `/native/workspaces/${id}/run`, { action: "start" })).status).toBe(400);

    const s2 = await newChat(h);
    const pid2 = (await call(h, "POST", `/native/workspaces/${s2.workspaceId}/run`, { action: "start" })).body
      .pid as number;
    await h.mgr.shutdown();
    expect(() => process.kill(pid2, 0)).toThrow();
    expect((await call(h, "GET", "/native/workspaces/nope/run")).status).toBe(404);
  });
});

describe("branch rename from the first message", () => {
  it("renames <prefix>/<bird> to the first six words once, with -2 on a collision", async () => {
    const h = await start();
    const a = await newChat(h, "Fix the login bug when the token expires tomorrow");
    const wsA = h.store.getWorkspace(a.workspaceId!)!;
    expect(wsA.branch).toBe("test-user/fix-the-login-bug-when-the");
    expect(git(wsA.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("test-user/fix-the-login-bug-when-the");
    await call(h, "POST", `/native/sessions/${a.id}/messages`, { text: "Something else entirely" });
    expect(h.store.getWorkspace(a.workspaceId!)!.branch).toBe("test-user/fix-the-login-bug-when-the");

    const b = await newChat(h, "fix the login bug when the token expires");
    expect(h.store.getWorkspace(b.workspaceId!)!.branch).toBe("test-user/fix-the-login-bug-when-the-2");
  });

  it("leaves a branch alone that has commits, an upstream, or no usable words", async () => {
    const h = await start();
    const committed = h.mgr.createWorkspace(h.projectId);
    fs.writeFileSync(path.join(committed.path, "x.txt"), "x");
    git(committed.path, "add", ".");
    git(committed.path, "commit", "-q", "-m", "work");
    expect(h.mgr.renameBranchFromMessage({ workspaceId: committed.id }, "add a feature")).toBeNull();
    expect(h.store.getWorkspace(committed.id)!.branch).toBe(committed.branch);

    const pushed = h.mgr.createWorkspace(h.projectId);
    git(pushed.path, "push", "-q", "-u", "origin", pushed.branch);
    expect(h.mgr.renameBranchFromMessage({ workspaceId: pushed.id }, "add a feature")).toBeNull();

    const words = h.mgr.createWorkspace(h.projectId);
    expect(h.mgr.renameBranchFromMessage({ workspaceId: words.id }, "!!! ???")).toBeNull();
    // one try only: a later message does not get another chance
    expect(h.mgr.renameBranchFromMessage({ workspaceId: words.id }, "now real words")).toBeNull();
    expect(h.mgr.renameBranchFromMessage({ workspaceId: null }, "x")).toBeNull();
  });
});

describe("archive", () => {
  it("refuses while a chat works, while dirty (unless forced), runs the archive script and keeps the branch", async () => {
    const h = await start();
    const marker = path.join(h.dir, "archived.txt");
    await patch(h, { archiveScript: `echo "$SQUEAK_WORKSPACE_PATH" > "${marker}"` });
    const s = await newChat(h, "start working");
    const id = s.workspaceId!;
    const ws = h.store.getWorkspace(id)!;
    const url = `/native/workspaces/${id}/archive`;

    const busy = await call(h, "POST", url, {});
    expect(busy.status).toBe(400);
    expect(busy.body.error).toMatch(/working or waiting/);
    expect(fs.existsSync(ws.path)).toBe(true);

    h.hooks.get(s.id)!.onTurnEnd("idle");
    fs.writeFileSync(path.join(ws.path, "dirty.txt"), "x");
    const dirty = await call(h, "POST", url, {});
    expect(dirty.status).toBe(400);
    expect(dirty.body.error).toMatch(/uncommitted/);
    expect(fs.existsSync(marker)).toBe(false);
    expect((await call(h, "POST", url, { force: "yes" })).status).toBe(400);

    const forced = await call(h, "POST", url, { force: true });
    expect(forced.status).toBe(200);
    expect(forced.body.workspace.state).toBe("archived");
    expect(fs.readFileSync(marker, "utf8").trim()).toBe(ws.path);
    expect(fs.existsSync(ws.path)).toBe(false);
    expect(git(h.repo, "branch", "--list", ws.branch)).toContain(ws.branch);
    // idempotent
    expect((await call(h, "POST", url, {})).status).toBe(200);
  });

  it("refuses while setup is running and when the archive script fails", async () => {
    const h = await start();
    const gate = path.join(h.dir, "gate");
    await patch(h, {
      setupScript: `while [ ! -f "${gate}" ]; do sleep 0.02; done`,
      archiveScript: "echo nope; exit 1",
    });
    const s = await newChat(h);
    const id = s.workspaceId!;
    const setting = await call(h, "POST", `/native/workspaces/${id}/archive`, {});
    expect(setting.body.error).toMatch(/still being set up/);
    fs.writeFileSync(gate, "");
    await until(() => h.store.getWorkspace(id)!.state === "ready");
    const failed = await call(h, "POST", `/native/workspaces/${id}/archive`, {});
    expect(failed.status).toBe(400);
    expect(failed.body.error).toMatch(/archive script failed/);
    expect(fs.existsSync(h.store.getWorkspace(id)!.path)).toBe(true);
    expect((await call(h, "POST", `/native/workspaces/${id}/archive`, { force: true })).body.workspace.state).toBe(
      "archived",
    );
    expect((await call(h, "POST", "/native/workspaces/nope/archive", {})).status).toBe(404);
    expect((await call(h, "POST", `/native/workspaces/${id}/archive`, {}, null)).status).toBe(401);
  });
});

describe("git status", () => {
  it("counts ahead, behind and dirty files, and reads the PR through gh", async () => {
    const h = await start();
    const s = await newChat(h);
    const ws = h.store.getWorkspace(s.workspaceId!)!;
    fs.writeFileSync(path.join(ws.path, "one.txt"), "1");
    git(ws.path, "add", ".");
    git(ws.path, "commit", "-q", "-m", "one");
    fs.writeFileSync(path.join(ws.path, "two.txt"), "2");
    // origin/trunk moves on
    const other = path.join(h.dir, "other");
    execFileSync("git", ["clone", "-q", "-b", "trunk", path.join(h.dir, "remote.git"), other]);
    git(other, "config", "user.email", "o@example.com");
    git(other, "config", "user.name", "O");
    fs.writeFileSync(path.join(other, "up.txt"), "u");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "up");
    git(other, "push", "-q", "origin", "trunk");
    git(ws.path, "fetch", "-q", "origin");

    fs.writeFileSync(
      path.join(h.ghDir, "pr.json"),
      JSON.stringify({
        number: 7,
        url: "https://github.com/o/r/pull/7",
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        statusCheckRollup: [
          { status: "COMPLETED", conclusion: "SUCCESS" },
          { status: "IN_PROGRESS", conclusion: "" },
        ],
      }),
    );
    const r = await call(h, "GET", `/native/sessions/${s.id}/git`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      branch: ws.branch,
      base: "trunk",
      baseRef: "origin/trunk",
      ahead: 1,
      behind: 1,
      dirty: 1,
      pr: {
        number: 7,
        url: "https://github.com/o/r/pull/7",
        state: "open",
        draft: false,
        mergeable: true,
        checks: "running",
      },
    });
    expect(r.body.upstream).toBeUndefined();

    // cached for 30 s: a second read does not call gh again
    await call(h, "GET", `/native/sessions/${s.id}/git`);
    const views = fs
      .readFileSync(h.ghLog, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("pr view"));
    expect(views).toHaveLength(1);
  });

  it("explains a missing PR, a missing gh and a gh that is too slow", async () => {
    const h = await start({ ghTimeoutMs: 300 });
    const s = await newChat(h);
    fs.writeFileSync(path.join(h.ghDir, "slow"), "");
    const t = Date.now();
    const slow = await call(h, "GET", `/native/sessions/${s.id}/git`);
    expect(Date.now() - t).toBeLessThan(2500);
    expect(slow.status).toBe(200);
    expect(slow.body.prReason).toBe("unavailable");
    expect(slow.body.prMessage).toMatch(/too long/);
    fs.rmSync(path.join(h.ghDir, "slow"));
    const none = await call(h, "GET", `/native/sessions/${s.id}/git`);
    expect(none.body.pr).toBeUndefined();
    expect(none.body.prReason).toBe("none");

    const m = await start({ gh: "missing" });
    const s2 = await newChat(m);
    const missing = await call(m, "GET", `/native/sessions/${s2.id}/git`);
    expect(missing.body.prReason).toBe("gh-missing");
    expect(missing.body.branch).toBeTruthy();

    expect((await call(h, "GET", "/native/sessions/nope/git")).status).toBe(404);
    expect((await call(h, "GET", `/native/sessions/${s.id}/git`, undefined, null)).status).toBe(401);
    const bare = (await call(h, "POST", "/native/sessions", { agent: "claude", model: "m", cwd: h.repo })).body.session;
    const noWs = await call(h, "GET", `/native/sessions/${bare.id}/git`);
    expect(noWs.status).toBe(400);
    expect(noWs.body.error).toMatch(/not in a Squeak workspace/);
  });
});

describe("git actions", () => {
  it("sends the action's prompt as a normal message, the project's own when set", async () => {
    const h = await start();
    const s = await newChat(h);
    const r = await call(h, "POST", `/native/sessions/${s.id}/actions/create-pr`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, queued: false });
    expect(h.sent[0]).toContain("open a pull request against trunk with gh");
    expect(h.sent[0]).not.toContain("{base}");

    // the chat is working now, so the next one queues
    const queued = await call(h, "POST", `/native/sessions/${s.id}/actions/commit-push`);
    expect(queued.body.queued).toBe(true);
    expect(h.store.queued(s.id)[0]!.text).toContain("push the branch");

    await patch(h, { prompts: { review: "Check {branch} against {base}, nothing else." } });
    const rev = await call(h, "POST", `/native/sessions/${s.id}/actions/review`);
    expect(rev.body.prompt).toBe(`Check ${h.store.getWorkspace(s.workspaceId!)!.branch} against trunk, nothing else.`);

    for (const a of ["fix-errors", "resolve-conflicts"]) {
      expect((await call(h, "POST", `/native/sessions/${s.id}/actions/${a}`)).status).toBe(200);
    }
    expect((await call(h, "POST", `/native/sessions/${s.id}/actions/launch-rocket`)).status).toBe(404);
    expect((await call(h, "POST", `/native/sessions/nope/actions/review`)).status).toBe(404);
    expect((await call(h, "POST", `/native/sessions/${s.id}/actions/review`, undefined, null)).status).toBe(401);
  });

  it("refuses an action in an archived workspace", async () => {
    const h = await start();
    const s = await newChat(h);
    await call(h, "POST", `/native/workspaces/${s.workspaceId}/archive`, {});
    const r = await call(h, "POST", `/native/sessions/${s.id}/actions/review`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/archived/);
  });
});

describe("merge", () => {
  const pr = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      number: 12,
      url: "https://github.com/o/r/pull/12",
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      ...over,
    });
  const merges = (h: Harness) =>
    (fs.existsSync(h.ghLog) ? fs.readFileSync(h.ghLog, "utf8") : "")
      .split("\n")
      .filter((l) => l.startsWith("pr merge"));

  it("needs confirm and a mergeable PR whose checks are not failing", async () => {
    const h = await start();
    const s = await newChat(h);
    const url = `/native/sessions/${s.id}/actions/merge`;
    expect((await call(h, "POST", url, {})).body.error).toMatch(/confirm/);
    expect((await call(h, "POST", url, { confirm: "true" })).status).toBe(400);
    expect((await call(h, "POST", url, { confirm: true })).body.error).toMatch(/no pull request/);

    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ isDraft: true }, /draft/],
      [{ mergeable: "CONFLICTING" }, /conflicts/],
      [{ mergeable: "UNKNOWN" }, /still checking/],
      [{ statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] }, /failing/],
      [{ state: "MERGED" }, /already merged/],
      [{ state: "CLOSED" }, /closed/],
    ];
    for (const [over, re] of cases) {
      fs.writeFileSync(path.join(h.ghDir, "pr.json"), pr(over));
      const r = await call(h, "POST", url, { confirm: true });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(re);
    }
    expect(merges(h)).toEqual([]);
  });

  it("merges with the project's method (squash by default) and says why GitHub refused", async () => {
    const h = await start();
    const s = await newChat(h);
    const url = `/native/sessions/${s.id}/actions/merge`;
    fs.writeFileSync(
      path.join(h.ghDir, "pr.json"),
      pr({ statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: "" }] }),
    );
    const ok = await call(h, "POST", url, { confirm: true });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, method: "squash", pr: { number: 12, state: "merged" } });
    expect(merges(h)).toEqual(["pr merge 12 --squash"]);

    await patch(h, { mergeMethod: "rebase" });
    await call(h, "POST", url, { confirm: true });
    expect(merges(h)[1]).toBe("pr merge 12 --rebase");

    fs.writeFileSync(path.join(h.ghDir, "merge.fail"), "");
    const refused = await call(h, "POST", url, { confirm: true });
    expect(refused.status).toBe(502);
    expect(refused.body.error).toMatch(/GitHub refused the merge: Pull request is not mergeable/);
  });

  it("says plainly when gh is not installed", async () => {
    const h = await start({ gh: "missing" });
    const s = await newChat(h);
    const r = await call(h, "POST", `/native/sessions/${s.id}/actions/merge`, { confirm: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/gh/);
  });
});
