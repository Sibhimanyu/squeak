import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NativeStore } from "./store.js";
import { BIRD_NAMES, WorkspaceError, WorkspaceManager } from "./workspaces.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function tempRepo(opts: { origin?: boolean } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-ws-")));
  const repo = path.join(base, "demo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "trunk");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "t@example.com");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".env\n");
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
  const mgr = new WorkspaceManager({ store, workspacesRoot: path.join(base, "ws") });
  return { base, repo, store, mgr };
}

describe("WorkspaceManager", () => {
  it("adds a project from a git folder (default branch = current when there is no origin) and is idempotent", () => {
    const { repo, mgr, store } = tempRepo();
    const p = mgr.addProject(repo);
    expect(p).toMatchObject({ name: "demo", rootPath: repo, defaultBranch: "trunk" });
    expect(mgr.addProject(path.join(repo, "."))).toEqual(p);
    expect(store.listProjects()).toHaveLength(1);
  });

  it("reads the default branch from origin/HEAD", () => {
    const { repo, mgr } = tempRepo({ origin: true });
    expect(mgr.addProject(repo).defaultBranch).toBe("trunk");
  });

  it("refuses a folder that is not a git repo", () => {
    const { base, mgr } = tempRepo();
    expect(() => mgr.addProject(base)).toThrow(WorkspaceError);
  });

  it("creates a worktree named for a bird, on user/bird, from origin when there is one, with .context and included files", () => {
    const { repo, mgr } = tempRepo({ origin: true });
    fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
    fs.writeFileSync(path.join(repo, ".worktreeinclude"), "# env\n.env\n../escape\nmissing\n");
    const p = mgr.addProject(repo);
    const ws = mgr.createWorkspace(p.id);
    expect(ws.name).toBe(BIRD_NAMES[0]);
    expect(ws.path).toBe(path.join(mgr.workspacesRoot, "demo", BIRD_NAMES[0]!));
    expect(ws.branch).toBe(`test-user/${BIRD_NAMES[0]}`);
    expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(ws.branch);
    expect(fs.readFileSync(path.join(ws.path, "a.txt"), "utf8")).toBe("a\n");
    expect(fs.readFileSync(path.join(ws.path, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(fs.statSync(path.join(ws.path, ".context")).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(ws.path), "escape"))).toBe(false);
    const second = mgr.createWorkspace(p.id);
    expect(second.name).toBe(BIRD_NAMES[1]);
  });

  it("falls back to the local default branch with no origin, and suffixes -2 when the list runs out", () => {
    const { repo, mgr, store } = tempRepo();
    const p = mgr.addProject(repo);
    for (const name of BIRD_NAMES) {
      store.createWorkspace({ projectId: p.id, name, path: `/fake/${name}`, branch: `x/${name}` });
    }
    const ws = mgr.createWorkspace(p.id);
    expect(ws.name).toBe(`${BIRD_NAMES[0]}-2`);
    expect(fs.existsSync(path.join(ws.path, "a.txt"))).toBe(true);
  });

  it("archives a clean workspace and refuses a dirty one", () => {
    const { repo, mgr, store } = tempRepo();
    const p = mgr.addProject(repo);
    const clean = mgr.createWorkspace(p.id);
    const dirty = mgr.createWorkspace(p.id);
    fs.writeFileSync(path.join(dirty.path, "new.txt"), "x");
    expect(() => mgr.archiveWorkspace(dirty.id)).toThrow(/uncommitted/);
    expect(fs.existsSync(dirty.path)).toBe(true);
    expect(store.getWorkspace(dirty.id)?.state).toBe("ready");

    expect(mgr.archiveWorkspace(clean.id).state).toBe("archived");
    expect(fs.existsSync(clean.path)).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain(clean.path);
  });
});
