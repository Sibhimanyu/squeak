import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceSources } from "./workspace-sources.js";
import { activeBranches, isInside, mainReadOnlyRoot, parsePlace, Placement, PlacementError } from "./placement.js";
import { NativeStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";

// Real git on this Mac stalls ~3 s per launch, so these get room.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const before = process.env.SQUEAK_DUCKS_OWN_BRANCH;
afterEach(() => {
  if (before === undefined) delete process.env.SQUEAK_DUCKS_OWN_BRANCH;
  else process.env.SQUEAK_DUCKS_OWN_BRANCH = before;
});
const flagOn = (on: boolean) => {
  if (on) process.env.SQUEAK_DUCKS_OWN_BRANCH = "on";
  else process.env.SQUEAK_DUCKS_OWN_BRANCH = "off";
};

function setup(opts: { origin?: boolean } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "placement-")));
  const repo = path.join(base, "demo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "trunk");
  git(repo, "config", "user.name", "T");
  git(repo, "config", "user.email", "t@example.com");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  if (opts.origin) {
    const remote = path.join(base, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-q", "origin", "trunk");
    git(repo, "remote", "set-head", "origin", "trunk");
  }
  const store = new NativeStore(":memory:");
  const workspaces = new WorkspaceManager({ store, workspacesRoot: path.join(base, "ws") });
  const project = workspaces.addProject(repo);
  const sources = new WorkspaceSources({ store, workspaces });
  const placement = new Placement({ store, workspaces, sources });
  const folder = path.join(base, "plain");
  fs.mkdirSync(folder);
  const folderPond = workspaces.addProject(folder);
  return { base, repo, store, workspaces, project, placement, folderPond };
}

function chat(store: NativeStore, cwd: string, workspaceId: string | null, projectId: string, title = "Chat") {
  const s = store.createSession({
    cwd,
    agent: "claude",
    model: "sonnet",
    permissionMode: "default",
    title,
    workspaceId,
  });
  const duck = store.duckForSession(s.id, projectId)!;
  return { s: store.getSession(s.id)!, duck };
}

describe("parsePlace", () => {
  it("accepts the three kinds, strictly", () => {
    expect(parsePlace({ kind: "main" })).toEqual({ kind: "main" });
    expect(parsePlace({ kind: "new" })).toEqual({ kind: "new" });
    expect(parsePlace({ kind: "new", branch: " feat/x " })).toEqual({ kind: "new", branch: "feat/x" });
    expect(parsePlace({ kind: "join", duckId: "d1" })).toEqual({ kind: "join", duckId: "d1" });
    expect(parsePlace({ kind: "join", branch: "feat/x" })).toEqual({ kind: "join", branch: "feat/x" });
  });

  it("refuses a bad shape", () => {
    for (const bad of [null, [], "main", { kind: "stream" }, { kind: "main", branch: "x" }, { kind: "join" }]) {
      expect(() => parsePlace(bad)).toThrow(PlacementError);
    }
    expect(() => parsePlace({ kind: "join", duckId: "d", branch: "b" })).toThrow(/not both/);
    expect(() => parsePlace({ kind: "new", branch: 3 })).toThrow(/text/);
    expect(() => parsePlace({ kind: "new", from: "x" })).toThrow(/unknown key/);
  });
});

describe("Main is read-only for ducks in git ponds", () => {
  it("flag on: Main of a git pond is guarded; a branch and a folder pond are not", () => {
    const { store, project, folderPond, workspaces } = setup();
    const ws = workspaces.createWorkspace(project.id);
    flagOn(true);
    expect(mainReadOnlyRoot(store, { workspaceId: null, cwd: project.rootPath })).toBe(project.rootPath);
    expect(mainReadOnlyRoot(store, { workspaceId: ws.id, cwd: ws.path })).toBeNull();
    expect(mainReadOnlyRoot(store, { workspaceId: null, cwd: folderPond.rootPath })).toBeNull();
    expect(mainReadOnlyRoot(store, { workspaceId: null, cwd: "/elsewhere" })).toBeNull();
  });

  it("flag off: nothing is read-only", () => {
    const { store, project } = setup();
    flagOn(false);
    expect(mainReadOnlyRoot(store, { workspaceId: null, cwd: project.rootPath })).toBeNull();
  });

  it("isInside is lexical on whole path parts", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b/", "/a/b/c.txt")).toBe(true);
    expect(isInside("/a/b", "/a/bc/c.txt")).toBe(false);
  });
});

describe("Placement.resolve", () => {
  it("main is the pond's own folder (both flag states: the resolver is flag-free)", async () => {
    const { placement, project } = setup();
    for (const on of [false, true]) {
      flagOn(on);
      expect(await placement.resolve(project.id, { kind: "main" })).toMatchObject({
        kind: "main",
        cwd: project.rootPath,
        workspaceId: null,
        branch: null,
      });
    }
  });

  it("new makes a working copy on a fresh branch, typed or named", async () => {
    const { placement, project, store } = setup();
    const typed = await placement.resolve(project.id, { kind: "new", branch: "feat/login" });
    expect(typed).toMatchObject({ kind: "branch", branch: "feat/login" });
    expect(fs.existsSync(typed.cwd)).toBe(true);
    expect(store.getWorkspace(typed.workspaceId!)?.branch).toBe("feat/login");
    const generated = await placement.resolve(project.id, { kind: "new" });
    expect(generated.workspaceId).not.toBe(typed.workspaceId);
    await expect(placement.resolve(project.id, { kind: "new", branch: "feat/login" })).rejects.toThrow(
      /already a branch/,
    );
  });

  it("new from a branch cuts from it (its local commits included) and targets it", async () => {
    const { placement, project, store } = setup();
    const a = await placement.resolve(project.id, { kind: "new", branch: "feat/a" });
    fs.writeFileSync(path.join(a.cwd, "only-a.txt"), "x\n");
    git(a.cwd, "add", ".");
    git(a.cwd, "-c", "user.name=T", "-c", "user.email=t@e.com", "commit", "-q", "-m", "a work");
    const b = await placement.resolve(project.id, { kind: "new", from: "feat/a", title: "Part two" });
    expect(fs.existsSync(path.join(b.cwd, "only-a.txt"))).toBe(true);
    expect(b.workspace?.title).toBe("Part two");
    expect(store.getTargetBranch(b.workspaceId!)).toBe("feat/a");
    await expect(placement.resolve(project.id, { kind: "new", from: "nope" })).rejects.toThrow(/no branch nope/);
  });

  it("join by branch and by duck reuses the same working copy (one branch, one folder)", async () => {
    const { placement, project, store } = setup();
    const a = await placement.resolve(project.id, { kind: "new", branch: "feat/shared" });
    const { duck } = chat(store, a.cwd, a.workspaceId, project.id);
    const byBranch = await placement.resolve(project.id, { kind: "join", branch: "feat/shared" });
    const byDuck = await placement.resolve(project.id, { kind: "join", duckId: duck.id });
    expect(byBranch.workspaceId).toBe(a.workspaceId);
    expect(byDuck.workspaceId).toBe(a.workspaceId);
    expect(byDuck.cwd).toBe(a.cwd);
    expect(store.listWorkspaces(project.id)).toHaveLength(1);
  });

  it("join a duck on Main lands in Main; the default branch is Main; unknown things are refused", async () => {
    const { placement, project, store } = setup();
    const { duck } = chat(store, project.rootPath, null, project.id);
    expect(await placement.resolve(project.id, { kind: "join", duckId: duck.id })).toMatchObject({ kind: "main" });
    expect(await placement.resolve(project.id, { kind: "join", branch: "trunk" })).toMatchObject({ kind: "main" });
    await expect(placement.resolve(project.id, { kind: "join", branch: "ghost" })).rejects.toThrow(/no branch ghost/);
    await expect(placement.resolve(project.id, { kind: "join", duckId: "nope" })).rejects.toMatchObject({
      status: 404,
    });
    const idle = store.createDuck({ projectId: project.id, name: "Idle" });
    await expect(placement.resolve(project.id, { kind: "join", duckId: idle.id })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("join a branch whose working copy was removed opens a new one on the kept branch", async () => {
    const { placement, project, store, workspaces } = setup();
    const a = await placement.resolve(project.id, { kind: "new", branch: "feat/again" });
    await workspaces.archiveWorkspace(a.workspaceId!);
    const back = await placement.resolve(project.id, { kind: "join", branch: "feat/again" });
    expect(back.branch).toBe("feat/again");
    expect(back.workspaceId).not.toBe(a.workspaceId);
    expect(store.getWorkspace(back.workspaceId!)?.state).not.toBe("archived");
  });

  it("a plain-folder pond has only Main", async () => {
    const { placement, folderPond } = setup();
    expect(await placement.resolve(folderPond.id, { kind: "main" })).toMatchObject({ cwd: folderPond.rootPath });
    await expect(placement.resolve(folderPond.id, { kind: "new" })).rejects.toThrow(/version history/);
    await expect(placement.resolve("nope", { kind: "main" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("activeBranches", () => {
  it("lists branches with a working copy, their live ducks and last activity, newest first; archived and folder ponds are empty", async () => {
    const { placement, project, store, workspaces, folderPond } = setup();
    const a = await placement.resolve(project.id, { kind: "new", branch: "feat/a", title: "Login" });
    const b = await placement.resolve(project.id, { kind: "new", branch: "feat/b", title: "Billing" });
    const one = chat(store, a.cwd, a.workspaceId, project.id, "Quiet Creek");
    store.updateDuck(one.duck.id, { name: "Quiet Creek" });
    const two = chat(store, a.cwd, a.workspaceId, project.id, "Other");
    store.setStatus(two.s.id, "idle");
    store.setOpen(two.s.id, false);
    const list = activeBranches(store, project.id);
    expect(list.map((x) => x.branch).sort()).toEqual(["feat/a", "feat/b"]);
    const first = list.find((x) => x.branch === "feat/a")!;
    expect(first).toMatchObject({ title: "Login", workspaceId: a.workspaceId });
    expect(first.ducks).toEqual([{ id: one.duck.id, name: "Quiet Creek" }]);
    expect(list.find((x) => x.branch === "feat/b")!.ducks).toEqual([]);
    expect(list[0]!.lastActiveAt).toBeGreaterThanOrEqual(list[1]!.lastActiveAt);
    await workspaces.archiveWorkspace(b.workspaceId!);
    expect(activeBranches(store, project.id).map((x) => x.branch)).toEqual(["feat/a"]);
    expect(activeBranches(store, folderPond.id)).toEqual([]);
  });
});

describe("Placement.cleanup", () => {
  it("removes an unused working copy whose branch is merged, keeps the branch; keeps one a live duck uses", async () => {
    const { placement, project, store, repo } = setup();
    const used = await placement.resolve(project.id, { kind: "new", branch: "feat/used" });
    const idle = await placement.resolve(project.id, { kind: "new", branch: "feat/idle" });
    chat(store, used.cwd, used.workspaceId, project.id);
    const removed = await placement.cleanup(project.id);
    expect(removed.map((w) => w.branch)).toEqual(["feat/idle"]);
    expect(store.getWorkspace(idle.workspaceId!)?.state).toBe("archived");
    expect(fs.existsSync(idle.cwd)).toBe(false);
    expect(git(repo, "branch", "--list", "feat/idle")).toContain("feat/idle");
    expect(store.getWorkspace(used.workspaceId!)?.state).toBe("ready");
  });

  it("a closed duck or an archived chat no longer holds its working copy", async () => {
    const { placement, project, store } = setup();
    const a = await placement.resolve(project.id, { kind: "new", branch: "feat/a" });
    const { s } = chat(store, a.cwd, a.workspaceId, project.id);
    expect(await placement.cleanup(project.id)).toHaveLength(0);
    store.setOpen(s.id, false);
    expect(await placement.cleanup(project.id)).toHaveLength(1);
  });

  it("keeps a branch with commits that are not pushed or merged, and a folder with uncommitted work", async () => {
    const { placement, project, store } = setup({ origin: true });
    const ahead = await placement.resolve(project.id, { kind: "new", branch: "feat/ahead" });
    fs.writeFileSync(path.join(ahead.cwd, "x.txt"), "x\n");
    git(ahead.cwd, "add", ".");
    git(ahead.cwd, "-c", "user.name=T", "-c", "user.email=t@e.com", "commit", "-q", "-m", "work");
    const dirty = await placement.resolve(project.id, { kind: "new", branch: "feat/dirty" });
    fs.writeFileSync(path.join(dirty.cwd, "wip.txt"), "wip\n");
    expect(await placement.cleanup(project.id)).toHaveLength(0);
    // Pushed: now it may go; the dirty one still stays.
    git(ahead.cwd, "push", "-q", "origin", "feat/ahead");
    const removed = await placement.cleanup(project.id);
    expect(removed.map((w) => w.branch)).toEqual(["feat/ahead"]);
    expect(store.getWorkspace(dirty.workspaceId!)?.state).toBe("ready");
  });

  it("keeps a working copy a busy chat is in", async () => {
    const { placement, project, store } = setup();
    const a = await placement.resolve(project.id, { kind: "new", branch: "feat/busy" });
    const { s } = chat(store, a.cwd, a.workspaceId, project.id);
    store.setOpen(s.id, false);
    store.setStatus(s.id, "working");
    expect(await placement.cleanup(project.id)).toHaveLength(0);
  });
});

describe("Placement.move", () => {
  it("starts a fresh chat for the same duck in the new place and leaves the old one as history", async () => {
    const { placement, project, store } = setup();
    const { s, duck } = chat(store, project.rootPath, null, project.id, "Plan it");
    const created: Record<string, unknown>[] = [];
    const create = async (spec: Record<string, unknown>) => {
      created.push(spec);
      const next = store.createSession({
        cwd: spec.cwd as string,
        agent: "claude",
        model: spec.model as string,
        permissionMode: spec.permissionMode as string,
        title: spec.title as string,
        workspaceId: spec.workspaceId as string | null,
      });
      store.attachSessionToDuck(spec.duckId as string, next.id);
      return store.getSession(next.id)!;
    };
    const moved = await placement.move(s.id, { kind: "new", title: "Login work" }, create as never, "Build the form");
    expect(moved.session).not.toBeNull();
    expect(String(created[0]!.text)).toContain("Build the form");
    expect(String(created[0]!.text)).toContain(s.id);
    const after = store.duckRow(duck.id)!;
    expect(after.currentSessionId).toBe(moved.session!.id);
    expect(after.workspaceId).toBe(moved.place.workspaceId);
    expect(after.branch).toBe(moved.place.branch);
    expect(store.duckSessionIds(duck.id)).toEqual(expect.arrayContaining([s.id, moved.session!.id]));
    // Already there: nothing starts.
    const again = await placement.move(
      moved.session!.id,
      { kind: "join", branch: moved.place.branch! },
      create as never,
    );
    expect(again.session).toBeNull();
    expect(created).toHaveLength(1);
  });

  it("refuses a chat in a plain-folder pond", async () => {
    const { placement, folderPond, store } = setup();
    const { s } = chat(store, folderPond.rootPath, null, folderPond.id);
    await expect(placement.move(s.id, { kind: "new" }, (async () => s) as never)).rejects.toThrow(/version history/);
  });
});
