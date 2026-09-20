import { describe, expect, it } from "vitest";

import {
  GitStateReader,
  countUntracked,
  describeGitState,
  parseLeftRight,
  parseShortstat,
  type GitState,
} from "./git-state.js";

function gitState(overrides: Partial<GitState> = {}): GitState {
  return {
    branch: "feature",
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
    hasUpstream: true,
    aheadOfBase: null,
    ...overrides,
  };
}

describe("parseShortstat", () => {
  it("reads git's summary line", () => {
    expect(parseShortstat(" 8 files changed, 312 insertions(+), 40 deletions(-)")).toEqual({
      filesChanged: 8,
      insertions: 312,
      deletions: 40,
    });
  });

  it("handles the singular and partial forms", () => {
    expect(parseShortstat(" 1 file changed, 2 insertions(+)")).toEqual({
      filesChanged: 1,
      insertions: 2,
      deletions: 0,
    });
    expect(parseShortstat(" 1 file changed, 1 deletion(-)")).toEqual({
      filesChanged: 1,
      insertions: 0,
      deletions: 1,
    });
  });

  it("reads a clean tree as zeroes", () => {
    expect(parseShortstat("")).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
  });
});

describe("parseLeftRight", () => {
  it("reads behind and ahead in git's order", () => {
    expect(parseLeftRight("2\t5\n")).toEqual({ behind: 2, ahead: 5 });
  });

  it("returns null when there is no tracking branch to report", () => {
    expect(parseLeftRight("fatal: no upstream configured")).toBeNull();
    expect(parseLeftRight("")).toBeNull();
  });
});

describe("countUntracked", () => {
  it("counts only untracked entries", () => {
    const status = [" M src/index.ts", "?? notes.md", "?? scratch/", "A  src/new.ts"].join("\n");
    expect(countUntracked(status)).toBe(2);
  });
});

describe("describeGitState", () => {
  it("leads with the size of the change", () => {
    expect(describeGitState(gitState({ filesChanged: 8, insertions: 312, deletions: 40, ahead: 3 }))).toBe(
      "+312/−40 · 8 files · 3 unpushed",
    );
  });

  it("counts untracked files as touched", () => {
    expect(describeGitState(gitState({ filesChanged: 1, insertions: 5, deletions: 0, untracked: 2 }))).toBe(
      "+5/−0 · 3 files",
    );
  });

  it("says a branch with no upstream is not pushed at all", () => {
    // The normal state of a fresh Conductor branch: without this it would read
    // as having nothing outstanding while holding a day of work.
    expect(describeGitState(gitState({ hasUpstream: false, aheadOfBase: 4 }))).toBe("clean · 4 commits, not pushed");
  });

  it("uses the singular for one commit", () => {
    expect(describeGitState(gitState({ hasUpstream: false, aheadOfBase: 1 }))).toBe("clean · 1 commit, not pushed");
  });

  it("reports a clean, fully pushed tree as clean", () => {
    expect(describeGitState(gitState())).toBe("clean");
  });

  it("mentions being behind", () => {
    expect(describeGitState(gitState({ ahead: 1, behind: 2 }))).toBe("clean · 1 unpushed · 2 behind");
  });
});

describe("GitStateReader", () => {
  function fakeGit(responses: Record<string, string>, onCall?: (args: string[]) => void) {
    return async (dir: string, args: string[]): Promise<string> => {
      onCall?.(args);
      const key = args.join(" ");
      const match = Object.entries(responses).find(([prefix]) => key.startsWith(prefix));
      if (!match) {
        throw new Error(`git ${key} failed in ${dir}`);
      }
      return match[1];
    };
  }

  it("assembles one state from several git calls", async () => {
    const reader = new GitStateReader({
      runGit: fakeGit({
        "rev-parse": "feature/thing\n",
        status: " M src/a.ts\n?? notes.md\n",
        diff: " 1 file changed, 10 insertions(+), 2 deletions(-)\n",
        "rev-list --count --left-right": "0\t3\n",
      }),
    });

    const states = await reader.read([{ dir: "/repo" }]);

    expect(states.get("/repo")).toEqual({
      branch: "feature/thing",
      filesChanged: 1,
      insertions: 10,
      deletions: 2,
      untracked: 1,
      ahead: 3,
      behind: 0,
      hasUpstream: true,
      aheadOfBase: null,
    });
  });

  it("falls back to the base branch when there is no upstream", async () => {
    const reader = new GitStateReader({
      runGit: fakeGit({
        "rev-parse": "ushuaia\n",
        status: "",
        diff: "",
        // `@{upstream}` throws; the base-branch count is what answers instead.
        "rev-list --count origin/main..HEAD": "4\n",
      }),
    });

    const state = (await reader.read([{ dir: "/repo", baseRef: "origin/main" }])).get("/repo");

    expect(state?.hasUpstream).toBe(false);
    expect(state?.aheadOfBase).toBe(4);
  });

  it("omits a directory that is not a repository", async () => {
    const reader = new GitStateReader({ runGit: fakeGit({}) });

    expect((await reader.read([{ dir: "/gone" }])).size).toBe(0);
  });

  it("caches, including the misses", async () => {
    const calls: string[][] = [];
    const reader = new GitStateReader({
      ttlMs: 30_000,
      now: () => 1_000,
      runGit: fakeGit({ "rev-parse": "main\n", status: "", diff: "" }, (args) => calls.push(args)),
    });

    await reader.read([{ dir: "/repo" }]);
    const firstCallCount = calls.length;
    await reader.read([{ dir: "/repo" }]);

    // An archived workspace must not be re-probed on every single refresh.
    expect(calls.length).toBe(firstCallCount);
  });

  it("re-reads once the cache expires", async () => {
    const calls: string[][] = [];
    let now = 1_000;
    const reader = new GitStateReader({
      ttlMs: 100,
      now: () => now,
      runGit: fakeGit({ "rev-parse": "main\n", status: "", diff: "" }, (args) => calls.push(args)),
    });

    await reader.read([{ dir: "/repo" }]);
    const firstCallCount = calls.length;
    now += 500;
    await reader.read([{ dir: "/repo" }]);

    expect(calls.length).toBeGreaterThan(firstCallCount);
  });

  it("does not run more than maxConcurrent git processes at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const reader = new GitStateReader({
      maxConcurrent: 2,
      runGit: async (_dir, args) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        if (args[0] === "rev-parse") {
          return "main\n";
        }
        return "";
      },
    });

    await reader.read([{ dir: "/a" }, { dir: "/b" }, { dir: "/c" }, { dir: "/d" }, { dir: "/e" }]);

    // Each directory fans out internally, so the bound is on directories.
    expect(peak).toBeLessThanOrEqual(2 * 3);
  });

  it("treats HEAD as no branch rather than a branch called HEAD", async () => {
    const reader = new GitStateReader({
      runGit: fakeGit({ "rev-parse": "HEAD\n", status: "", diff: "" }),
    });

    expect((await reader.read([{ dir: "/repo" }])).get("/repo")?.branch).toBeNull();
  });
});

describe("git state on a real repository", () => {
  it("reads this checkout without throwing", async () => {
    const reader = new GitStateReader({ ttlMs: 0 });
    const dir = process.cwd();

    const state = (await reader.read([{ dir }])).get(dir);

    expect(state).toBeDefined();
    expect(typeof state?.filesChanged).toBe("number");
    expect(describeGitState(state as GitState)).toBeTruthy();
  });
});
