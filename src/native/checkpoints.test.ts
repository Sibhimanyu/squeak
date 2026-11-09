import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Checkpointer, checkpointRef } from "./checkpoints.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

export function tempRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-")));
  dirs.push(dir);
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.log\nbuild/\n");
  fs.writeFileSync(path.join(dir, "a.txt"), "a1\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "b1\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return dir;
}

const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
const write = (dir: string, f: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
  fs.writeFileSync(path.join(dir, f), c);
};
const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), "utf8");

describe("Checkpointer", () => {
  it("snapshots tracked and untracked files without touching index, HEAD, stash or the tree", async () => {
    const dir = tempRepo();
    write(dir, "a.txt", "a2\n"); // unstaged edit
    write(dir, "b.txt", "b2\n");
    git(dir, "add", "b.txt"); // staged edit
    write(dir, "new.txt", "n\n"); // untracked
    write(dir, "ignored.log", "x\n");
    git(dir, "stash", "push", "-q", "-m", "mine", "--", "a.txt");
    write(dir, "a.txt", "a3\n");
    const before = {
      head: git(dir, "rev-parse", "HEAD"),
      status: git(dir, "status", "--porcelain=v2"),
      index: git(dir, "ls-files", "-s"),
      stash: git(dir, "stash", "list"),
      indexBytes: fs.readFileSync(path.join(dir, ".git", "index")),
    };
    const c = new Checkpointer();
    const commit = await c.snapshot(dir, checkpointRef("s1", 1, "start"));
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, "rev-parse", checkpointRef("s1", 1, "start")).trim()).toBe(commit);
    const files = git(dir, "ls-tree", "-r", "--name-only", commit!).split("\n").filter(Boolean);
    expect(files.sort()).toEqual([".gitignore", "a.txt", "b.txt", "new.txt"]);
    expect(git(dir, "show", `${commit}:a.txt`)).toBe("a3\n");
    expect(git(dir, "show", `${commit}:b.txt`)).toBe("b2\n");
    expect(git(dir, "rev-parse", "HEAD")).toBe(before.head);
    expect(git(dir, "status", "--porcelain=v2")).toBe(before.status);
    expect(git(dir, "ls-files", "-s")).toBe(before.index);
    expect(git(dir, "stash", "list")).toBe(before.stash);
    expect(fs.readFileSync(path.join(dir, ".git", "index")).equals(before.indexBytes)).toBe(true);
    expect(read(dir, "a.txt")).toBe("a3\n");
    expect(read(dir, "new.txt")).toBe("n\n");
  });

  it("returns null outside a git repository", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nogit-"));
    dirs.push(dir);
    expect(await new Checkpointer().snapshot(dir, "refs/squeak-checkpoints/x/1-start")).toBeNull();
    expect(await new Checkpointer().snapshot("/no/such/dir", null)).toBeNull();
  });

  it("lists the files that changed between two snapshots", async () => {
    const dir = tempRepo();
    const c = new Checkpointer();
    const a = (await c.snapshot(dir, null))!;
    write(dir, "a.txt", "changed\n");
    write(dir, "added.txt", "x\n");
    fs.rmSync(path.join(dir, "b.txt"));
    const b = (await c.snapshot(dir, null))!;
    expect((await c.changes(dir, a, b)).sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: "a.txt", status: "M" },
      { path: "added.txt", status: "A" },
      { path: "b.txt", status: "D" },
    ]);
  });

  it("restores files, removes only untracked non-ignored newcomers, and can be undone", async () => {
    const dir = tempRepo();
    const c = new Checkpointer();
    const start = (await c.snapshot(dir, null))!;
    write(dir, "a.txt", "agent edit\n");
    fs.rmSync(path.join(dir, "b.txt")); // a tracked file the agent deleted
    write(dir, "src/new.ts", "created\n"); // untracked
    write(dir, "ignored.log", "keep me\n");
    write(dir, "build/out.js", "keep me too\n");
    write(dir, "staged.txt", "staged new\n");
    git(dir, "add", "staged.txt"); // tracked in the index now: stays
    const head = git(dir, "rev-parse", "HEAD");
    const index = git(dir, "ls-files", "-s");

    const r = await c.restore(dir, "s1", start);
    expect(read(dir, "a.txt")).toBe("a1\n");
    expect(read(dir, "b.txt")).toBe("b1\n");
    expect(fs.existsSync(path.join(dir, "src/new.ts"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "src"))).toBe(false);
    expect(read(dir, "ignored.log")).toBe("keep me\n");
    expect(read(dir, "build/out.js")).toBe("keep me too\n");
    expect(read(dir, "staged.txt")).toBe("staged new\n");
    expect(git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(git(dir, "ls-files", "-s")).toBe(index);
    expect(r.written).toBe(2);
    expect(r.removed).toBe(1);

    // the safety snapshot undoes the restore (a tracked file is never removed, so b.txt stays)
    await c.restore(dir, "s1", r.safety);
    expect(read(dir, "a.txt")).toBe("agent edit\n");
    expect(read(dir, "src/new.ts")).toBe("created\n");
  });

  it("prunes a session's refs", async () => {
    const dir = tempRepo();
    const c = new Checkpointer();
    await c.snapshot(dir, checkpointRef("s1", 1, "start"));
    await c.snapshot(dir, checkpointRef("s1", 1, "end"));
    await c.snapshot(dir, checkpointRef("s2", 1, "start"));
    expect(await c.prune(dir, "s1")).toBe(2);
    expect(git(dir, "for-each-ref", "--format=%(refname)", "refs/squeak-checkpoints/").trim()).toBe(
      "refs/squeak-checkpoints/s2/1-start",
    );
  });
});
