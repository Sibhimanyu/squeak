import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NativeStore } from "./store.js";
import { WorkspaceError, WorkspaceManager } from "./workspaces.js";

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

  it("adds a folder that is not a git repo as a plain-folder pond, and refuses what cannot be one", () => {
    const { base, mgr } = tempRepo();
    const p = mgr.addProject(base);
    expect(p).toMatchObject({ rootPath: base, kind: "folder" });
    expect(() => mgr.createWorkspace(p.id)).toThrow("Streams need version history");
    expect(() => mgr.addProject(path.join(base, "nope"))).toThrow("doesn't exist");
    expect(() => mgr.addProject(path.join(base, "demo", "a.txt"))).toThrow("file, not a folder");
    expect(() => mgr.addProject(os.homedir())).toThrow(WorkspaceError);
    expect(() => mgr.addProject("/")).toThrow(WorkspaceError);
  });

  it("creates a worktree named from the pond generator, on user/<slug>, with a title, .context and included files", () => {
    const { repo, mgr, store } = tempRepo({ origin: true });
    fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
    fs.writeFileSync(path.join(repo, ".worktreeinclude"), "# env\n.env\n../escape\nmissing\n");
    const p = mgr.addProject(repo);
    const ws = mgr.createWorkspace(p.id);
    expect(ws.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(ws.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")).toContain(ws.name.replace(/-\d+$/, ""));
    expect(ws.path).toBe(path.join(mgr.workspacesRoot, "demo", ws.name));
    expect(ws.branch).toBe(`test-user/${ws.name}`);
    expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(ws.branch);
    expect(fs.readFileSync(path.join(ws.path, "a.txt"), "utf8")).toBe("a\n");
    expect(fs.readFileSync(path.join(ws.path, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(fs.statSync(path.join(ws.path, ".context")).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(ws.path), "escape"))).toBe(false);
    const second = mgr.createWorkspace(p.id);
    expect(second.name).not.toBe(ws.name);
    expect(store.getWorkspace(ws.id)?.title).toBe(ws.title);
  });

  it("suggests a name no folder, workspace or local branch uses", () => {
    const { repo, mgr, store } = tempRepo();
    const p = mgr.addProject(repo);
    const first = mgr.suggest(p, () => 0.5);
    expect(first.branch).toBe(`test-user/${first.slug}`);
    store.createWorkspace({ projectId: p.id, name: first.slug, path: `/fake/${first.slug}`, branch: "x/y" });
    const again = mgr.suggest(p, () => 0.5);
    expect(again.slug).not.toBe(first.slug);
  });

  it("a typed name becomes the title and is slugged, with -2 when taken; a typed branch still wins", () => {
    const { repo, mgr } = tempRepo();
    const p = mgr.addProject(repo);
    const a = mgr.createWorkspace(p.id, undefined, undefined, undefined, "Fix the Login Flow!");
    expect(a.title).toBe("Fix the Login Flow!");
    expect(a.name).toBe("fix-the-login-flow");
    expect(a.branch).toBe("test-user/fix-the-login-flow");
    const b = mgr.createWorkspace(p.id, undefined, undefined, undefined, "Fix the Login Flow!");
    expect(b.name).toBe("fix-the-login-flow-2");
    const c = mgr.createWorkspace(p.id, undefined, undefined, "my/own-branch", "Some title");
    expect(c.branch).toBe("my/own-branch");
    expect(c.title).toBe("Some title");
  });

  it("archives a clean workspace and refuses a dirty one", async () => {
    const { repo, mgr, store } = tempRepo();
    const p = mgr.addProject(repo);
    const clean = mgr.createWorkspace(p.id);
    const dirty = mgr.createWorkspace(p.id);
    fs.writeFileSync(path.join(dirty.path, "new.txt"), "x");
    await expect(mgr.archiveWorkspace(dirty.id)).rejects.toThrow(/uncommitted/);
    expect(fs.existsSync(dirty.path)).toBe(true);
    expect(store.getWorkspace(dirty.id)?.state).toBe("ready");

    expect((await mgr.archiveWorkspace(clean.id)).state).toBe("archived");
    expect(fs.existsSync(clean.path)).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain(clean.path);
  });
});
