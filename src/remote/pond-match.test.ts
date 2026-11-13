import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { PhonePond } from "../fleet/native-phone.js";
import { MainRepoFinder, matchPond } from "./pond-match.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "squeak-pond-")));
  dirs.push(dir);
  return dir;
};

const pond = (id: string, name: string, extra: Partial<PhonePond> = {}): PhonePond => ({
  id,
  name,
  shared: false,
  members: [],
  match: name.toLowerCase(),
  ...extra,
});

/** A main repo with a linked worktree, laid out the way `git worktree add` leaves it. */
function makeWorktree(): { main: string; worktree: string } {
  const root = tmp();
  const main = path.join(root, "repos", "greenroom");
  const worktree = path.join(root, "workspaces", "greenroom", "hong-kong");
  const admin = path.join(main, ".git", "worktrees", "hong-kong");
  fs.mkdirSync(admin, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(admin, "commondir"), "../..\n");
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${admin}\n`);
  return { main, worktree };
}

describe("matchPond", () => {
  const finder = () => new MainRepoFinder();

  it("matches by project id before anything else", () => {
    const ponds = [pond("a", "Shop", { projectId: "p1", folder: "/x/shop" }), pond("b", "Blog", { projectId: "p2" })];
    expect(matchPond(ponds, { projectId: "p2", cwd: "/x/shop/src", repoName: "shop" }, finder())?.id).toBe("b");
  });

  it("matches a cwd under a pond's project folder, the deepest folder winning", () => {
    const ponds = [
      pond("a", "Mono", { projectId: "p1", folder: "/work/mono" }),
      pond("b", "Mono web", { projectId: "p2", folder: "/work/mono/web" }),
    ];
    expect(matchPond(ponds, { cwd: "/work/mono/web/src" }, finder())?.id).toBe("b");
    expect(matchPond(ponds, { cwd: "/work/mono/api" }, finder())?.id).toBe("a");
    expect(matchPond(ponds, { cwd: "/work/monorepo" }, finder())).toBeNull();
  });

  it("matches a git worktree through the main repository's common dir", () => {
    const { main, worktree } = makeWorktree();
    const ponds = [pond("g", "greenroom", { projectId: "pg", folder: main })];
    expect(matchPond(ponds, { cwd: worktree, repoName: null }, finder())?.id).toBe("g");
    expect(matchPond(ponds, { cwd: path.join(worktree, "src", "deep") }, finder())?.id).toBe("g");
  });

  it("reads the common dir once per folder", () => {
    const { main, worktree } = makeWorktree();
    const repos = finder();
    expect(repos.find(worktree)).toBe(main);
    fs.rmSync(path.join(worktree, ".git"));
    expect(repos.find(worktree)).toBe(main);
  });

  it("gives a project-only pond to its chats (id = the project's id)", () => {
    const ponds = [pond("pz", "Zeta", { projectId: "pz", folder: "/p/zeta", projectOnly: true })];
    expect(matchPond(ponds, { projectId: "pz", cwd: "/elsewhere" }, finder())?.id).toBe("pz");
  });

  it("gives a chat with no project, in the home folder, no pond", () => {
    const ponds = [pond("a", "Shop", { projectId: "p1", folder: "/work/shop" })];
    expect(matchPond(ponds, { cwd: os.homedir(), repoName: null }, finder())).toBeNull();
  });

  it("falls back to the repo name only for a pond with no project id", () => {
    const ponds = [pond("a", "Shop", { projectId: "p1" }), pond("n", "Blog")];
    expect(matchPond(ponds, { repoName: "shop", projectId: "other" }, finder())).toBeNull();
    expect(matchPond(ponds, { repoName: "Blog" }, finder())?.id).toBe("n");
  });
});
