import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NativeStore } from "./store.js";
import { cloneUrl, repoName, RepoPickers, slug, WorkspaceSources, type Runner } from "./workspace-sources.js";
import { WorkspaceManager } from "./workspaces.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

/** origin (bare) with main and feature, a clone as the project, a store and a manager. */
function setup(gh: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-sources-"));
  const seed = path.join(dir, "seed");
  fs.mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  git(seed, "config", "user.email", "t@t");
  git(seed, "config", "user.name", "t");
  fs.writeFileSync(path.join(seed, "a.txt"), "a\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "one");
  git(seed, "checkout", "-qb", "feature");
  fs.writeFileSync(path.join(seed, "b.txt"), "b\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "two");
  git(seed, "checkout", "-q", "main");
  const origin = path.join(dir, "origin.git");
  git(dir, "clone", "-q", "--bare", seed, origin);
  const root = path.join(dir, "proj");
  git(dir, "clone", "-q", origin, root);
  const store = new NativeStore(":memory:");
  const workspaces = new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws"), gitUser: "t" });
  const project = workspaces.addProject(root);
  const calls: string[][] = [];
  const run: Runner = (file, args, cwd, timeoutMs) => {
    if (file === "gh") {
      calls.push(args);
      const key = `${args[0]} ${args[2]}`;
      const answer = gh[key];
      return Promise.resolve(
        answer === undefined
          ? { code: 1, stdout: "", stderr: "no such thing" }
          : { code: 0, stdout: JSON.stringify(answer), stderr: "" },
      );
    }
    return new Promise((resolve) =>
      execFile(file, args, { cwd, timeout: timeoutMs }, (e, stdout, stderr) =>
        resolve({ code: e ? 1 : 0, stdout: String(stdout), stderr: String(stderr) }),
      ),
    );
  };
  const sources = new WorkspaceSources({ store, workspaces, run, ghBin: "gh", reposRoot: path.join(dir, "repos") });
  return { dir, store, workspaces, project, sources, calls, root };
}

describe("workspace sources", () => {
  it("checks out an existing branch from origin as is, and never renames it", async () => {
    const { store, project, sources } = setup();
    const { workspace } = await sources.create(project.id, { kind: "branch", branch: "origin/feature" });
    expect(workspace.branch).toBe("feature");
    expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
    expect(fs.existsSync(path.join(workspace.path, "b.txt"))).toBe(true);
    expect(store.branchRenamePending(workspace.id)).toBe(false);
    // A branch lives in one worktree only.
    await expect(sources.create(project.id, { kind: "branch", branch: "feature" })).rejects.toThrow(
      /already checked out/,
    );
    await expect(sources.create(project.id, { kind: "branch", branch: "nope" })).rejects.toThrow(/no branch nope/);
    await expect(sources.create(project.id, { kind: "branch", branch: "--upload-pack=x" })).rejects.toThrow(
      /not a branch/,
    );
  });

  it("cuts a new branch from another base, which becomes the target", async () => {
    const { store, project, sources } = setup();
    const { workspace } = await sources.create(project.id, { kind: "base", branch: "feature" });
    expect(workspace.branch).toBe(`t/${workspace.name}`);
    expect(fs.existsSync(path.join(workspace.path, "b.txt"))).toBe(true);
    expect(store.getTargetBranch(workspace.id)).toBe("feature");
    expect(store.branchRenamePending(workspace.id)).toBe(true);
  });

  it("opens a pull request's head branch with its base as the target; refuses forks", async () => {
    const { store, project, sources } = setup({
      "pr 7": { headRefName: "feature", baseRefName: "main", isCrossRepository: false, title: "Add b", state: "OPEN" },
      "pr 8": { headRefName: "x", baseRefName: "main", isCrossRepository: true, title: "Fork", state: "OPEN" },
    });
    const made = await sources.create(project.id, { kind: "pr", number: 7 });
    expect(made.workspace.branch).toBe("feature");
    expect(made.title).toBe("#7 Add b");
    expect(store.getTargetBranch(made.workspace.id)).toBeNull();
    await expect(sources.create(project.id, { kind: "pr", number: 8 })).rejects.toThrow(/fork/);
    await expect(sources.create(project.id, { kind: "pr", number: 9 })).rejects.toThrow(/GitHub said/);
  });

  it("names an issue's branch after it and suggests a first message that closes it", async () => {
    const { store, project, sources } = setup({
      "issue 12": { title: "Fix the login bug!", body: "Steps...", url: "https://github.com/o/r/issues/12" },
    });
    const made = await sources.create(project.id, { kind: "issue", number: 12 });
    expect(made.workspace.branch).toBe("t/12-fix-the-login-bug");
    expect(made.prompt).toContain("Work on issue #12: Fix the login bug!");
    expect(made.prompt).toContain('"Fixes #12"');
    expect(store.branchRenamePending(made.workspace.id)).toBe(false);
  });

  it("clones into the repos folder and adds the project; an existing clone is just added", async () => {
    const { dir, sources, root } = setup();
    // The fake runner clones from the local project instead of the network.
    const local = new WorkspaceSources({
      store: sources["options"].store,
      workspaces: sources["options"].workspaces,
      reposRoot: path.join(dir, "repos"),
      run: (file, args, cwd) => {
        const dest = args[args.length - 1]!;
        execFileSync("git", ["clone", "-q", root, dest], { cwd });
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    });
    const p = await local.clone("owner/proj");
    expect(p.rootPath).toBe(fs.realpathSync(path.join(dir, "repos", "proj")));
    expect((await local.clone("https://github.com/owner/proj.git")).id).toBe(p.id);
    await expect(local.clone("/etc")).rejects.toThrow(/owner\/repo/);
  });
});

describe("clone input", () => {
  it("accepts owner/repo, https and ssh, and nothing that could be a path or a flag", () => {
    expect(cloneUrl("owner/repo")).toBe("https://github.com/owner/repo.git");
    expect(cloneUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
    expect(cloneUrl("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
    for (const bad of ["/etc/passwd", "--upload-pack=x", "file:///x", "http://x/y", "a b/c", "../x"]) {
      expect(cloneUrl(bad)).toBeNull();
    }
    expect(repoName("git@github.com:o/my-repo.git")).toBe("my-repo");
    expect(slug("Fix: the LOGIN bug!!")).toBe("fix-the-login-bug");
  });
});

const realRun: Runner = (file, args, cwd, timeoutMs) =>
  new Promise((resolve) =>
    execFile(file, args, { cwd, timeout: timeoutMs }, (e, stdout, stderr) =>
      resolve({ code: e ? 1 : 0, stdout: String(stdout), stderr: String(stderr) }),
    ),
  );

describe("typed names", () => {
  it("names a new branch and its folder as typed, and the first message does not rename it", async () => {
    const { store, project, workspaces } = setup();
    const ws = workspaces.createWorkspace(project.id, undefined, undefined, "me/Fix Login".replace(" ", "-"));
    expect(ws.branch).toBe("me/Fix-Login");
    expect(ws.name).toBe("me-fix-login");
    expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("me/Fix-Login");
    expect(store.branchRenamePending(ws.id)).toBe(false);
    // Taken: the branch exists, or its folder does.
    expect(() => workspaces.createWorkspace(project.id, undefined, undefined, "me/Fix-Login")).toThrow(
      /already a branch/,
    );
  });

  it("refuses names git rejects, and a name whose folder is taken", async () => {
    const { project, workspaces } = setup();
    for (const bad of ["a b", "x..y", "-x", "a~b", "end.lock", "a/"]) {
      expect(() => workspaces.createWorkspace(project.id, undefined, undefined, bad)).toThrow(/not a name git accepts/);
    }
    workspaces.createWorkspace(project.id, undefined, undefined, "one/two");
    // Different branch, same folder slug.
    expect(() => workspaces.createWorkspace(project.id, undefined, undefined, "one-two")).toThrow(/folder named/);
  });

  it("applies a typed branch to a base source and an issue; an opened branch keeps its own", async () => {
    const { project, sources } = setup({
      "issue 12": { title: "Fix the login bug!", body: "", url: "u" },
    });
    const base = await sources.create(project.id, { kind: "base", branch: "feature" }, { branch: "my/work" });
    expect(base.workspace.branch).toBe("my/work");
    const issue = await sources.create(project.id, { kind: "issue", number: 12 }, { branch: "login-fix" });
    expect(issue.workspace.branch).toBe("login-fix");
    await expect(
      sources.create(project.id, { kind: "base", branch: "feature" }, { branch: "my/work" }),
    ).rejects.toThrow(/already a branch/);
    const opened = await sources.create(project.id, { kind: "branch", branch: "feature" }, { branch: "ignored" });
    expect(opened.workspace.branch).toBe("feature");
  });

  it("takes an optional display name for a project: trimmed, 1-60 characters; the folder stays", async () => {
    const { dir, store, workspaces, root } = setup();
    const other = path.join(dir, "other");
    git(dir, "clone", "-q", root, other);
    const p = workspaces.addProject(other, "  My Pond  ");
    expect(p.name).toBe("My Pond");
    expect(p.rootPath).toBe(fs.realpathSync(other));
    expect(store.getProject(p.id)!.name).toBe("My Pond");
    const third = path.join(dir, "third");
    git(dir, "clone", "-q", root, third);
    expect(() => workspaces.addProject(third, "   ")).toThrow(/1 to 60/);
    expect(() => workspaces.addProject(third, "x".repeat(61))).toThrow(/1 to 60/);
    expect(workspaces.addProject(third).name).toBe("third");
    // A slash in a name never becomes a path.
    const slashed = workspaces.createWorkspace(workspaces.addProject(other, "unused").id);
    expect(slashed.path.startsWith(workspaces.workspacesRoot)).toBe(true);
  });

  it("clone keeps the typed name too", async () => {
    const { dir, sources, root } = setup();
    const local = new WorkspaceSources({
      store: sources["options"].store,
      workspaces: sources["options"].workspaces,
      reposRoot: path.join(dir, "repos"),
      run: (_f, args, cwd) => {
        execFileSync("git", ["clone", "-q", root, args[args.length - 1]!], { cwd });
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    });
    expect((await local.clone("owner/proj", undefined, "Nice Name")).name).toBe("Nice Name");
    await expect(local.clone("owner/other", undefined, "")).rejects.toThrow(/1 to 60/);
  });
});

describe("pickers", () => {
  it("lists branches newest first, local and origin deduped, with current and checked-out flags", async () => {
    const { store, project, workspaces } = setup();
    git(project.rootPath, "branch", "local-only");
    workspaces.createWorkspace(project.id, undefined, undefined, "in-tree");
    const pickers = new RepoPickers({ store, run: realRun });
    const { branches } = await pickers.branches(project.id);
    const by = Object.fromEntries(branches.map((b) => [b.name, b]));
    expect(branches.map((b) => b.name).filter((n) => n === "main")).toHaveLength(1);
    expect(by.main).toMatchObject({ remote: true, current: true, checkedOut: true });
    expect(by.feature).toMatchObject({ remote: true, current: false, checkedOut: false });
    expect(by["local-only"]).toMatchObject({ remote: false, checkedOut: false });
    expect(by["in-tree"]).toMatchObject({ remote: false, checkedOut: true });
    expect(by.HEAD).toBeUndefined();
    const times = branches.map((b) => Date.parse(b.lastCommitAt!));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // No fetch unless asked.
    const calls: string[][] = [];
    const spy = new RepoPickers({ store, run: (f, a, c, t) => (calls.push(a), realRun(f, a, c, t)) });
    await spy.branches(project.id);
    expect(calls.some((a) => a[0] === "fetch")).toBe(false);
    await spy.branches(project.id, { fetch: true });
    expect(calls.find((a) => a[0] === "fetch")).toEqual(["fetch", "--prune"]);
    await expect(pickers.branches("nope")).rejects.toThrow(/No such project/);
  });

  it("lists pull requests and issues through gh, cached 60 s; a missing gh is data, not an error", async () => {
    const { store, project } = setup();
    let now = 1_000_000;
    const asked: string[][] = [];
    const run: Runner = (_f, args) => {
      asked.push(args);
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify([
          {
            number: 1,
            title: "Old",
            author: { login: "a" },
            updatedAt: "2026-01-01T00:00:00Z",
            headRefName: "x",
            isCrossRepository: false,
            url: "u1",
          },
          {
            number: 2,
            title: "New",
            author: { login: "b" },
            updatedAt: "2026-02-01T00:00:00Z",
            headRefName: "y",
            isCrossRepository: true,
            url: "u2",
          },
        ]),
        stderr: "",
      });
    };
    const pickers = new RepoPickers({ store, run, ghBin: "gh", now: () => now });
    const pulls = await pickers.pulls(project.id);
    expect(pulls.available).toBe(true);
    expect(pulls.items.map((i) => i.number)).toEqual([2, 1]);
    expect(pulls.items[0]).toEqual({
      number: 2,
      title: "New",
      author: "b",
      updatedAt: "2026-02-01T00:00:00Z",
      branch: "y",
      fork: true,
      url: "u2",
    });
    expect(asked[0]).toEqual([
      "pr",
      "list",
      "--json",
      "number,title,author,updatedAt,headRefName,isCrossRepository,url",
      "--limit",
      "50",
    ]);
    await pickers.pulls(project.id);
    expect(asked).toHaveLength(1);
    now += 61_000;
    await pickers.pulls(project.id);
    expect(asked).toHaveLength(2);
    const issues = await pickers.issues(project.id);
    expect(issues.items[0]).not.toHaveProperty("branch");
    expect(asked[2]![0]).toBe("issue");

    expect(await new RepoPickers({ store, ghBin: null }).pulls(project.id)).toEqual({
      items: [],
      available: false,
      reason: "GitHub CLI isn't installed",
    });
    const failing = (stderr: string) =>
      new RepoPickers({ store, ghBin: "gh", run: () => Promise.resolve({ code: 1, stdout: "", stderr }) });
    expect(
      (await failing("To get started with GitHub CLI, please run:  gh auth login").issues(project.id)).reason,
    ).toBe("not signed in to GitHub CLI");
    expect((await failing("no git remotes found").issues(project.id)).reason).toBe("no GitHub remote");
    expect((await failing("boom").issues(project.id)).available).toBe(false);
  });
});
