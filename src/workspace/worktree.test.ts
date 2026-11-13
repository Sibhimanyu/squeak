import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { assertInside, safeRemove } from "./paths.js";
import { shortId, slugify, validateBranchName, workspaceNames } from "./naming.js";
import { RepositoryResolver } from "./repository.js";
import { fakeSpawner, git, makeRepo, tmpDir } from "./test-utils.js";
import { WorktreeDirtyError, WorktreeManager } from "./worktree.js";

async function setup() {
  const repoDir = makeRepo();
  const root = path.join(tmpDir(), "Workspaces");
  fs.mkdirSync(root);
  const repository = await new RepositoryResolver().resolve(repoDir);
  return { repoDir, root, repository, mgr: new WorktreeManager({ root }) };
}

describe("RepositoryResolver", () => {
  it("describes a repository", async () => {
    const repoDir = makeRepo("thing");
    git(repoDir, "remote", "add", "origin", "https://example.com/thing.git");
    const r = await new RepositoryResolver().resolve(repoDir);
    expect(r).toMatchObject({
      name: "thing",
      remoteUrl: "https://example.com/thing.git",
      defaultBranch: "main",
      currentBranch: "main",
      isDirty: false,
      supportsWorktrees: true,
    });
    fs.writeFileSync(path.join(repoDir, "new.txt"), "x");
    expect((await new RepositoryResolver().resolve(repoDir)).isDirty).toBe(true);
  });
  it("rejects a plain folder", async () => {
    await expect(new RepositoryResolver().resolve(tmpDir())).rejects.toMatchObject({ code: "not-a-repository" });
  });
});

describe("naming", () => {
  it("is deterministic and readable", () => {
    const a = workspaceNames("/r", "RasanAI", "Timeline redesign!", "id-1");
    expect(a).toEqual(workspaceNames("/r", "RasanAI", "Timeline redesign!", "id-1"));
    expect(a.branch).toBe(`squeak/rasanai/timeline-redesign-${shortId("id-1")}`);
    expect(a.directory).toBe(path.join("/r", "rasanai", `timeline-redesign-${shortId("id-1")}`));
    expect(workspaceNames("/r", "RasanAI", "Timeline redesign!", "id-2").branch).not.toBe(a.branch);
    expect(slugify("../../etc")).toBe("etc");
    expect(slugify("!!!")).toBe("task");
  });
  it("rejects bad branch names", async () => {
    for (const bad of ["", "-x", "a b", "a..b", "a/", "x.lock", "a~b"])
      await expect(validateBranchName(bad)).rejects.toMatchObject({ code: "bad-branch" });
    await expect(validateBranchName("squeak/p/x-1a2b")).resolves.toBeUndefined();
  });
});

describe("path safety", () => {
  it("refuses escapes, the root itself and symlinks out", () => {
    const root = tmpDir();
    const outside = tmpDir();
    fs.mkdirSync(path.join(root, "ok"));
    expect(() => assertInside(root, path.join(root, "ok"))).not.toThrow();
    expect(() => assertInside(root, root)).toThrow();
    expect(() => assertInside(root, path.join(root, "..", "x"))).toThrow();
    fs.symlinkSync(outside, path.join(root, "link"));
    fs.writeFileSync(path.join(outside, "keep"), "1");
    expect(() => safeRemove(root, path.join(root, "link"))).toThrow(/not inside/);
    expect(() => safeRemove(root, path.join(root, "link", "keep"))).toThrow();
    expect(fs.existsSync(path.join(outside, "keep"))).toBe(true);
  });
});

describe("WorktreeManager", () => {
  it("creates a worktree on a new branch and inspects it", async () => {
    const { repository, root, mgr } = await setup();
    const dest = path.join(root, "demo", "task-a41f");
    const wt = await mgr.create({ repository, branch: "squeak/demo/task-a41f", destination: dest });
    expect(wt).toMatchObject({ branch: "squeak/demo/task-a41f", createdBranch: true, path: dest });
    expect(fs.existsSync(path.join(dest, "README.md"))).toBe(true);
    expect(await mgr.inspect(wt)).toMatchObject({
      dirty: false,
      branch: "squeak/demo/task-a41f",
      changedFiles: 0,
      untrackedFiles: 0,
    });
    fs.writeFileSync(path.join(dest, "a.txt"), "x");
    fs.appendFileSync(path.join(dest, "README.md"), "more");
    expect(await mgr.inspect(wt)).toMatchObject({ dirty: true, changedFiles: 1, untrackedFiles: 1 });
  });

  it("refuses duplicate paths, outside paths, bad and in-use branches", async () => {
    const { repository, root, mgr, repoDir } = await setup();
    const dest = path.join(root, "demo", "one");
    await mgr.create({ repository, branch: "b1", destination: dest });
    await expect(mgr.create({ repository, branch: "b2", destination: dest })).rejects.toMatchObject({
      code: "duplicate-path",
    });
    await expect(
      mgr.create({ repository, branch: "b1", destination: path.join(root, "demo", "two") }),
    ).rejects.toMatchObject({ code: "branch-in-use" });
    await expect(mgr.create({ repository, branch: "b3", destination: path.join(tmpDir(), "x") })).rejects.toMatchObject(
      { code: "path-escape" },
    );
    await expect(
      mgr.create({ repository, branch: "bad name", destination: path.join(root, "demo", "three") }),
    ).rejects.toMatchObject({ code: "bad-branch" });
    expect(fs.existsSync(path.join(root, "demo", "two"))).toBe(false);
    expect(git(repoDir, "branch", "--list", "b3")).toBe("");
  });

  it("reuses an existing branch instead of recreating it", async () => {
    const { repository, root, mgr, repoDir } = await setup();
    git(repoDir, "branch", "feature");
    const wt = await mgr.create({ repository, branch: "feature", destination: path.join(root, "demo", "f") });
    expect(wt.createdBranch).toBe(false);
  });

  it("leaves nothing behind when git fails", async () => {
    const { repository, root, mgr, repoDir } = await setup();
    const bad = { ...repository, currentBranch: "no-such-base" };
    await expect(
      mgr.create({ repository: bad, branch: "x1", destination: path.join(root, "fresh", "w") }),
    ).rejects.toMatchObject({ code: "worktree-failed" });
    expect(fs.existsSync(path.join(root, "fresh"))).toBe(false);
    expect(git(repoDir, "branch", "--list", "x1")).toBe("");
    expect(git(repoDir, "worktree", "list", "--porcelain")).not.toContain(path.join(root, "fresh", "w"));
  });

  it("refuses to remove a dirty worktree, and force keeps a recovery copy", async () => {
    const { repository, root, mgr, repoDir } = await setup();
    const dest = path.join(root, "demo", "d");
    const wt = await mgr.create({ repository, branch: "dirty", destination: dest });
    fs.writeFileSync(path.join(dest, "untracked.txt"), "precious");
    fs.appendFileSync(path.join(dest, "README.md"), "edit\n");
    await expect(mgr.remove(wt)).rejects.toBeInstanceOf(WorktreeDirtyError);
    expect(fs.existsSync(dest)).toBe(true);
    const note = await mgr.remove(wt, { force: true });
    expect(fs.existsSync(dest)).toBe(false);
    expect(note).toBeTruthy();
    const dir = path.dirname(note as string);
    expect(JSON.parse(fs.readFileSync(note as string, "utf8")).untrackedCopied).toEqual(["untracked.txt"]);
    expect(fs.readFileSync(path.join(dir, "untracked", "untracked.txt"), "utf8")).toBe("precious");
    expect(fs.readFileSync(path.join(dir, "changes.patch"), "utf8")).toContain("+edit");
    expect(git(repoDir, "branch", "--list", "dirty")).toContain("dirty");
  });

  it("removes a clean worktree and prunes stale registrations", async () => {
    const { repository, root, mgr, repoDir } = await setup();
    const a = await mgr.create({ repository, branch: "c1", destination: path.join(root, "demo", "c1") });
    expect(await mgr.remove(a)).toBeUndefined();
    expect(fs.existsSync(a.path)).toBe(false);
    const b = await mgr.create({ repository, branch: "c2", destination: path.join(root, "demo", "c2") });
    fs.rmSync(b.path, { recursive: true });
    const registered = () =>
      git(repoDir, "worktree", "list", "--porcelain")
        .split("\n")
        .filter((l) => l.startsWith("worktree "))
        .map((l) => fs.realpathSync.native(path.dirname(l.slice(9))) + path.sep + path.basename(l.slice(9)));
    const bPath = path.join(fs.realpathSync.native(path.dirname(b.path)), path.basename(b.path));
    expect(registered()).toContain(bPath);
    await mgr.prune(repoDir);
    expect(registered()).not.toContain(bPath);
    // a folder that is not a registered worktree is never deleted
    fs.mkdirSync(path.join(root, "demo", "stray"));
    await expect(
      mgr.remove({ path: path.join(root, "demo", "stray"), repositoryRoot: repoDir, branch: "" }),
    ).rejects.toMatchObject({ code: "not-a-worktree" });
    expect(fs.existsSync(path.join(root, "demo", "stray"))).toBe(true);
  });

  it("will not remove anything outside its root", async () => {
    const { repoDir, mgr } = await setup();
    const elsewhere = tmpDir();
    await expect(
      mgr.remove({ path: elsewhere, repositoryRoot: repoDir, branch: "" }, { force: true }),
    ).rejects.toMatchObject({ code: "path-escape" });
    expect(fs.existsSync(elsewhere)).toBe(true);
    void fakeSpawner;
  });
});
