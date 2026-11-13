import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CleanupError, DiskCleanup } from "./disk-cleanup.js";
import { NativeStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function setup(opts: { gh?: string | null } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-clean-")));
  dirs.push(base);
  const repo = path.join(base, "demo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "trunk");
  git(repo, "config", "user.name", "T");
  git(repo, "config", "user.email", "t@example.com");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const remote = path.join(base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "origin", "trunk");
  git(repo, "fetch", "-q", "origin");
  const store = new NativeStore(":memory:");
  const wsRoot = path.join(base, "ws");
  const mgr = new WorkspaceManager({ store, workspacesRoot: wsRoot, gitUser: "t" });
  const project = store.createProject({ name: "demo", rootPath: repo, defaultBranch: "trunk" });
  const trashDir = path.join(base, "trash");
  fs.mkdirSync(trashDir);
  const trashed: string[] = [];
  const cleanup = new DiskCleanup({
    store,
    workspacesRoot: wsRoot,
    ghBin: opts.gh === undefined ? null : opts.gh,
    trash: async (folder) => {
      trashed.push(folder);
      fs.renameSync(folder, path.join(trashDir, `${path.basename(folder)}-${trashed.length}`));
    },
    duTimeoutMs: 20_000,
  });
  const worktree = (name: string, branch = `u/${name}`) => {
    const p = path.join(wsRoot, "demo", name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", branch, p, "origin/trunk");
    return p;
  };
  return { base, repo, store, mgr, project, cleanup, wsRoot, trashed, trashDir, worktree };
}

describe("DiskCleanup scan", () => {
  it("finds untracked folders, stale worktrees, archived folders and merged branches", async () => {
    const t = setup();
    // (a) a worktree Squeak has no row for, clean
    const loose = t.worktree("loose");
    // (b) a registered worktree whose folder is gone
    const gone = t.worktree("gone");
    fs.rmSync(gone, { recursive: true });
    // (c) an archived row whose folder still exists, branch merged (no commits)
    const arch = t.worktree("arch");
    t.store.createWorkspace({ projectId: t.project.id, name: "arch", path: arch, branch: "u/arch", state: "archived" });
    // a live tracked stream is never listed
    const live = t.worktree("live");
    t.store.createWorkspace({ projectId: t.project.id, name: "live", path: live, branch: "u/live" });
    // a non-git, user-looking folder under the pond folder
    const stray = path.join(t.wsRoot, "demo", "notes");
    fs.mkdirSync(stray);
    fs.writeFileSync(path.join(stray, "x.txt"), "x");
    // a folder under an unknown pond folder that is no worktree: left alone
    fs.mkdirSync(path.join(t.wsRoot, "mine", "docs"), { recursive: true });

    const scan = await t.cleanup.scan();
    const kinds = (k: string) => scan.items.filter((i) => i.kind === k);
    expect(
      kinds("untracked-folder")
        .map((i) => i.path)
        .sort(),
    ).toEqual([loose, stray].sort());
    expect(kinds("stale-worktree").map((i) => i.path)).toEqual([gone]);
    expect(kinds("archived-folder").map((i) => i.path)).toEqual([arch]);
    // its branch is still checked out in that folder, so no branch item until the folder is gone
    expect(kinds("merged-branch")).toEqual([]);
    expect(scan.items.find((i) => i.path === live)).toBeUndefined();
    expect(scan.items.find((i) => i.path?.includes("mine"))).toBeUndefined();
    const looseItem = scan.items.find((i) => i.path === loose)!;
    expect(looseItem).toMatchObject({ registered: true, unsavedWork: false, preselected: true, pondName: "demo" });
    expect(looseItem.sizeBytes).toBeGreaterThan(0);
    expect(looseItem.modifiedAt).toBeTruthy();
    // a folder git cannot vouch for counts as unsaved
    expect(scan.items.find((i) => i.path === stray)).toMatchObject({ unsavedWork: true, preselected: false });
  });

  it("lists the merged branch of an archived stream whose folder is gone", async () => {
    const t = setup();
    const w = t.worktree("done", "u/done");
    git(t.repo, "worktree", "remove", w);
    t.store.createWorkspace({ projectId: t.project.id, name: "done", path: w, branch: "u/done", state: "archived" });
    const scan = await t.cleanup.scan();
    expect(scan.items.filter((i) => i.kind === "merged-branch").map((i) => i.branch)).toEqual(["u/done"]);
    const res = await t.cleanup.clean(scan.items.map((i) => ({ id: i.id })));
    expect(res.removedBranches).toBe(1);
    expect(git(t.repo, "branch", "--list", "u/done")).toBe("");
  });

  it("never preselects a dirty tree or unpushed commits", async () => {
    const t = setup();
    const dirty = t.worktree("dirty");
    fs.writeFileSync(path.join(dirty, "new.txt"), "wip");
    const ahead = t.worktree("ahead");
    fs.writeFileSync(path.join(ahead, "b.txt"), "b");
    git(ahead, "add", ".");
    git(ahead, "-c", "user.name=T", "-c", "user.email=t@e.com", "commit", "-q", "-m", "local");
    const clean = t.worktree("clean");
    const scan = await t.cleanup.scan();
    const by = (p: string) => scan.items.find((i) => i.path === p)!;
    expect(by(dirty)).toMatchObject({ unsavedWork: true, preselected: false, unsavedReason: "Uncommitted changes" });
    expect(by(ahead)).toMatchObject({ unsavedWork: true, preselected: false });
    expect(by(clean)).toMatchObject({ unsavedWork: false, preselected: true });
    expect(scan.reclaimableBytes).toBe(by(clean).sizeBytes);
    // an archived stream with an unmerged commit gives no branch item
    t.store.createWorkspace({
      projectId: t.project.id,
      name: "ahead",
      path: ahead,
      branch: "u/ahead",
      state: "archived",
    });
    expect((await t.cleanup.scan()).items.some((i) => i.kind === "merged-branch")).toBe(false);
  });

  it("narrows to one pond", async () => {
    const t = setup();
    t.worktree("one");
    const other = t.store.createProject({ name: "other", rootPath: path.join(t.base, "nope"), defaultBranch: "main" });
    expect((await t.cleanup.scan({ pondId: other.id })).items).toEqual([]);
    expect((await t.cleanup.scan({ pondId: t.project.id })).items).toHaveLength(1);
  });
});

describe("DiskCleanup clean", () => {
  it("removes a clean registered worktree through git and prunes the stale one", async () => {
    const t = setup();
    const a = t.worktree("a");
    const b = t.worktree("b");
    fs.rmSync(b, { recursive: true });
    const scan = await t.cleanup.scan();
    const res = await t.cleanup.clean(scan.items.filter((i) => i.preselected).map((i) => ({ id: i.id })));
    expect(res.failed).toBe(0);
    expect(res.removedFolders).toBe(1);
    expect(fs.existsSync(a)).toBe(false);
    expect(t.trashed).toEqual([]); // git removed it, no Trash needed
    expect(git(t.repo, "worktree", "list", "--porcelain")).not.toContain(b);
  });

  it("moves a folder git does not own to the Trash, never deletes it", async () => {
    const t = setup();
    const stray = path.join(t.wsRoot, "demo", "notes");
    fs.mkdirSync(stray, { recursive: true });
    fs.writeFileSync(path.join(stray, "x.txt"), "x");
    const scan = await t.cleanup.scan();
    const id = scan.items[0]!.id;
    const refused = await t.cleanup.clean([{ id }]);
    expect(refused.outcomes[0]).toMatchObject({ ok: false });
    expect(fs.existsSync(stray)).toBe(true);
    const done = await t.cleanup.clean([{ id, confirmUnsaved: true }]);
    expect(done.outcomes[0]).toMatchObject({ ok: true });
    expect(t.trashed).toEqual([stray]);
    expect(fs.readFileSync(path.join(t.trashDir, "notes-1", "x.txt"), "utf8")).toBe("x");
  });

  it("refuses ids that did not come out of a scan, and paths outside Squeak's folders", async () => {
    const t = setup();
    const outside = path.join(t.base, "precious");
    fs.mkdirSync(outside);
    const res = await t.cleanup.clean([{ id: "deadbeef" }]);
    expect(res.outcomes[0]).toMatchObject({ ok: false });
    expect(fs.existsSync(outside)).toBe(true);
    // an archived row whose folder is outside the workspaces root and no worktree: never listed, never touched
    t.store.createWorkspace({ projectId: t.project.id, name: "p", path: outside, branch: "x", state: "archived" });
    const scan = await t.cleanup.scan();
    expect(scan.items.find((i) => i.path === outside)).toBeUndefined();
    // the pond's own repo is never allowed even if forged
    const forged = {
      id: "x",
      kind: "untracked-folder",
      pondId: t.project.id,
      pondName: "demo",
      path: t.repo,
      branch: null,
      sizeBytes: 0,
      modifiedAt: null,
      unsavedWork: false,
      unsavedReason: null,
      preselected: true,
      registered: false,
      label: "demo",
    } as const;
    await expect(
      (t.cleanup as unknown as { allowedFolder(i: unknown, p: unknown): Promise<string> }).allowedFolder(
        forged,
        t.project,
      ),
    ).rejects.toBeInstanceOf(CleanupError);
    expect(fs.existsSync(t.repo)).toBe(true);
  });

  it("deletes a merged branch with -d and refuses an unmerged one", async () => {
    const t = setup();
    const w = t.worktree("m", "u/merged");
    git(t.repo, "worktree", "remove", w);
    const row = t.store.createWorkspace({
      projectId: t.project.id,
      name: "m",
      path: w,
      branch: "u/merged",
      state: "archived",
    });
    expect(await t.cleanup.branchDeletable(row)).toEqual({ deletable: true, branch: "u/merged" });
    // unmerged branch: one commit not on trunk
    const w2 = t.worktree("n", "u/unmerged");
    fs.writeFileSync(path.join(w2, "n.txt"), "n");
    git(w2, "add", ".");
    git(w2, "-c", "user.name=T", "-c", "user.email=t@e.com", "commit", "-q", "-m", "n");
    git(t.repo, "worktree", "remove", w2);
    const row2 = t.store.createWorkspace({
      projectId: t.project.id,
      name: "n",
      path: w2,
      branch: "u/unmerged",
      state: "archived",
    });
    expect(await t.cleanup.branchDeletable(row2)).toEqual({ deletable: false, branch: "u/unmerged" });
    await expect(t.cleanup.deleteBranch(row2.id, false)).rejects.toBeInstanceOf(CleanupError);
    expect(git(t.repo, "branch", "--list", "u/unmerged")).toContain("u/unmerged");
    // the merged one goes, locally; GitHub's copy only when asked
    git(t.repo, "push", "-q", "origin", "u/merged");
    const res = await t.cleanup.deleteBranch(row.id, false);
    expect(res).toMatchObject({ deleted: true, remoteDeleted: false });
    expect(git(t.repo, "branch", "--list", "u/merged")).toBe("");
    expect(git(t.repo, "ls-remote", "--heads", "origin", "u/merged")).toContain("u/merged");
  });

  it("also deletes the remote branch when asked and it matches", async () => {
    const t = setup();
    const w = t.worktree("r", "u/remote");
    git(t.repo, "push", "-q", "origin", "u/remote");
    git(t.repo, "worktree", "remove", w);
    const row = t.store.createWorkspace({
      projectId: t.project.id,
      name: "r",
      path: w,
      branch: "u/remote",
      state: "archived",
    });
    const res = await t.cleanup.deleteBranch(row.id, true);
    expect(res.remoteDeleted).toBe(true);
    expect(git(t.repo, "ls-remote", "--heads", "origin", "u/remote")).toBe("");
  });

  it("treats a squash-merged branch as merged only when gh says MERGED for that tip", async () => {
    const t = setup();
    const w = t.worktree("s", "u/squash");
    fs.writeFileSync(path.join(w, "s.txt"), "s");
    git(w, "add", ".");
    git(w, "-c", "user.name=T", "-c", "user.email=t@e.com", "commit", "-q", "-m", "s");
    const tip = git(w, "rev-parse", "HEAD");
    git(t.repo, "worktree", "remove", w);
    const row = t.store.createWorkspace({
      projectId: t.project.id,
      name: "s",
      path: w,
      branch: "u/squash",
      state: "archived",
    });
    const fake = (json: string, code = 0) => {
      const bin = path.join(t.base, `gh-${code}-${json.length}`);
      fs.writeFileSync(bin, `#!/bin/sh\necho '${json}'\nexit ${code}\n`, { mode: 0o755 });
      return bin;
    };
    const make = (ghBin: string | null) => new DiskCleanup({ store: t.store, workspacesRoot: t.wsRoot, ghBin });
    expect((await make(null).branchDeletable(row)).deletable).toBe(false);
    expect((await make(fake("[]")).branchDeletable(row)).deletable).toBe(false);
    expect((await make(fake("x", 1)).branchDeletable(row)).deletable).toBe(false);
    expect((await make(fake(`[{"state":"MERGED","headRefOid":"abc"}]`)).branchDeletable(row)).deletable).toBe(false);
    const yes = make(fake(`[{"state":"MERGED","headRefOid":"${tip}"}]`));
    expect((await yes.branchDeletable(row)).deletable).toBe(true);
    expect((await yes.deleteBranch(row.id, false)).deleted).toBe(true);
    expect(git(t.repo, "branch", "--list", "u/squash")).toBe("");
  });

  it("will not offer a branch another live stream still uses", async () => {
    const t = setup();
    const w = t.worktree("u1", "u/shared");
    const row = t.store.createWorkspace({
      projectId: t.project.id,
      name: "u1",
      path: w,
      branch: "u/shared",
      state: "archived",
    });
    t.store.createWorkspace({
      projectId: t.project.id,
      name: "u2",
      path: path.join(t.base, "elsewhere"),
      branch: "u/shared",
    });
    expect((await t.cleanup.branchDeletable(row)).deletable).toBe(false);
  });
});
