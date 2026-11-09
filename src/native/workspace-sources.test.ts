import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NativeStore } from "./store.js";
import { cloneUrl, repoName, slug, WorkspaceSources, type Runner } from "./workspace-sources.js";
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
