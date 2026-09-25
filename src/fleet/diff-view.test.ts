import { describe, expect, it } from "vitest";

import {
  DIFF_PAGE_SIZE,
  DiffReader,
  diffPageCount,
  diffPageSlice,
  parseNumstat,
  renderDiffSummary,
  renderFilePatch,
  stripDiffPreamble,
  type DiffFile,
} from "./diff-view.js";

function file(overrides: Partial<DiffFile> = {}): DiffFile {
  return { path: "src/a.ts", insertions: 10, deletions: 2, binary: false, untracked: false, ...overrides };
}

describe("parseNumstat", () => {
  it("reads insertions, deletions and path", () => {
    expect(parseNumstat("120\t8\tsrc/a.ts\n3\t0\tREADME.md\n")).toEqual([
      { path: "src/a.ts", insertions: 120, deletions: 8, binary: false, untracked: false },
      { path: "README.md", insertions: 3, deletions: 0, binary: false, untracked: false },
    ]);
  });

  it("marks binary files instead of reporting zero changes", () => {
    const [entry] = parseNumstat("-\t-\tassets/logo.png\n");
    expect(entry?.binary).toBe(true);
    expect(entry?.path).toBe("assets/logo.png");
  });

  it("resolves a rename to the new path", () => {
    expect(parseNumstat("1\t1\tsrc/{old.ts => new.ts}\n")[0]?.path).toBe("src/new.ts");
    expect(parseNumstat("1\t1\told.ts => new.ts\n")[0]?.path).toBe("new.ts");
  });

  it("ignores lines that are not numstat", () => {
    expect(parseNumstat("warning: something\n\n")).toEqual([]);
  });
});

describe("stripDiffPreamble", () => {
  it("drops the header that just repeats the filename", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1234567..89abcde 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,4 @@",
      " context",
      "+added",
    ].join("\n");

    expect(stripDiffPreamble(patch)).toBe("@@ -1,3 +1,4 @@\n context\n+added");
  });

  it("leaves a patch with no hunk header alone", () => {
    expect(stripDiffPreamble("Binary files differ")).toBe("Binary files differ");
  });
});

describe("renderDiffSummary", () => {
  it("leads with the totals and names the base", () => {
    const text = renderDiffSummary(
      {
        baseRef: "origin/main",
        files: [file({ insertions: 120, deletions: 8 }), file({ path: "README.md", insertions: 3, deletions: 0 })],
        insertions: 123,
        deletions: 8,
        truncated: false,
      },
      "squeak · ushuaia",
    );

    expect(text).toContain("squeak · ushuaia");
    expect(text).toContain("diff vs `origin/main`");
    expect(text).toContain("+123/−8 across 2 files");
    expect(text).toContain("src/a.ts");
  });

  it("marks new files, which is how an agent's output usually arrives", () => {
    const text = renderDiffSummary(
      { baseRef: null, files: [file({ untracked: true })], insertions: 10, deletions: 2, truncated: false },
      "x",
    );

    expect(text).toContain("(new)");
    expect(text).toContain("uncommitted changes");
  });

  it("says so when there is nothing to review", () => {
    const text = renderDiffSummary(
      { baseRef: "origin/main", files: [], insertions: 0, deletions: 0, truncated: false },
      "x",
    );
    expect(text).toContain("No changes.");
  });

  it("admits when the list is incomplete", () => {
    const text = renderDiffSummary(
      { baseRef: null, files: [file()], insertions: 10, deletions: 2, truncated: true },
      "x",
    );
    expect(text).toContain("More files were changed");
  });
});

describe("renderFilePatch", () => {
  it("wraps the patch in a diff block so Telegram renders it", () => {
    const text = renderFilePatch(file(), "@@ -1 +1 @@\n-a\n+b");

    expect(text).toContain("```diff");
    expect(text).toContain("+b");
  });

  it("does not pretend a binary file has a patch", () => {
    expect(renderFilePatch(file({ binary: true }), "")).toContain("No textual diff");
  });
});

describe("DiffReader", () => {
  function fakeGit(responses: Record<string, string | Error>, seen?: string[][]) {
    return async (_dir: string, args: string[]): Promise<string> => {
      seen?.push(args);
      const key = args.join(" ");
      const match = Object.entries(responses).find(([prefix]) => key.startsWith(prefix));
      if (!match) {
        throw new Error(`no stub for git ${key}`);
      }
      if (match[1] instanceof Error) {
        throw match[1];
      }
      return match[1];
    };
  }

  it("diffs against the base branch, not HEAD", async () => {
    const seen: string[][] = [];
    const reader = new DiffReader({
      runGit: fakeGit(
        {
          "rev-parse --verify": "abc123\n",
          "diff --numstat origin/main": "120\t8\tsrc/a.ts\n",
          status: "",
        },
        seen,
      ),
    });

    const diff = await reader.readSummary("/repo", "origin/main");

    expect(diff?.baseRef).toBe("origin/main");
    expect(diff?.files[0]?.path).toBe("src/a.ts");
    expect(seen.some((args) => args.includes("origin/main"))).toBe(true);
  });

  it("falls back to HEAD when the base ref does not exist locally", async () => {
    const reader = new DiffReader({
      runGit: fakeGit({
        "rev-parse --verify": "",
        "diff --numstat HEAD": "1\t0\tsrc/a.ts\n",
        status: "",
      }),
    });

    expect((await reader.readSummary("/repo", "origin/gone"))?.baseRef).toBeNull();
  });

  it("includes untracked files, which is how agents create new ones", async () => {
    const reader = new DiffReader({
      runGit: fakeGit({
        "rev-parse --verify": "abc\n",
        "diff --numstat origin/main": "",
        status: "?? src/new.ts\n M src/old.ts\n",
        "diff --no-index --numstat": "42\t0\tsrc/new.ts\n",
      }),
    });

    const diff = await reader.readSummary("/repo", "origin/main");

    expect(diff?.files).toHaveLength(1);
    expect(diff?.files[0]).toMatchObject({ path: "src/new.ts", insertions: 42, untracked: true });
  });

  it("orders the biggest change first", async () => {
    const reader = new DiffReader({
      runGit: fakeGit({
        "rev-parse --verify": "abc\n",
        "diff --numstat origin/main": "1\t0\tsmall.ts\n200\t10\tbig.ts\n",
        status: "",
      }),
    });

    expect((await reader.readSummary("/repo", "origin/main"))?.files.map((f) => f.path)).toEqual([
      "big.ts",
      "small.ts",
    ]);
  });

  it("truncates a very large file list rather than producing an unusable message", async () => {
    const numstat = Array.from({ length: 10 }, (_, index) => `1\t0\tfile${index}.ts`).join("\n");
    const reader = new DiffReader({
      maxFiles: 3,
      runGit: fakeGit({ "rev-parse --verify": "abc\n", "diff --numstat": numstat, status: "" }),
    });

    const diff = await reader.readSummary("/repo", "origin/main");

    expect(diff?.files).toHaveLength(3);
    expect(diff?.truncated).toBe(true);
  });

  it("returns null when the directory is not a repository", async () => {
    const reader = new DiffReader({ runGit: fakeGit({}) });
    expect(await reader.readSummary("/gone", null)).toBeNull();
  });

  it("uses the output of git diff --no-index even though it exits non-zero", async () => {
    // `--no-index` signals "these differ" with exit code 1, so execFile
    // rejects on exactly the successful case.
    const failure = Object.assign(new Error("exit 1"), { stdout: "@@ -0,0 +1 @@\n+hello\n" });
    const reader = new DiffReader({ runGit: fakeGit({ "diff --no-index": failure }) });

    const patch = await reader.readFilePatch("/repo", null, file({ untracked: true }));

    expect(patch).toContain("+hello");
  });

  it("truncates an enormous patch", async () => {
    const huge = `@@ -1 +1 @@\n${"+line\n".repeat(5000)}`;
    const reader = new DiffReader({
      maxPatchChars: 200,
      runGit: fakeGit({ "rev-parse --verify": "", diff: huge }),
    });

    const patch = await reader.readFilePatch("/repo", null, file());

    expect(patch?.length).toBeLessThan(400);
    expect(patch).toContain("patch truncated");
  });
});

describe("DiffReader against this repository", () => {
  it("reads a real summary without throwing", async () => {
    const reader = new DiffReader();

    const diff = await reader.readSummary(process.cwd(), null);

    expect(diff).not.toBeNull();
    expect(Array.isArray(diff?.files)).toBe(true);
  });
});

describe("diff paging", () => {
  function diffWith(count: number) {
    return {
      baseRef: "origin/main",
      files: Array.from({ length: count }, (_, index) => file({ path: `file${index}.ts` })),
      insertions: count * 10,
      deletions: count * 2,
      truncated: false,
    };
  }

  it("keeps a single page for a small diff", () => {
    expect(diffPageCount(diffWith(3))).toBe(1);
    expect(diffPageCount(diffWith(0))).toBe(1);
  });

  it("splits a large diff into pages of a readable size", () => {
    const diff = diffWith(39);
    expect(diffPageCount(diff)).toBe(Math.ceil(39 / DIFF_PAGE_SIZE));

    const second = diffPageSlice(diff, 1);
    expect(second.start).toBe(DIFF_PAGE_SIZE);
    expect(second.files[0]?.path).toBe(`file${DIFF_PAGE_SIZE}.ts`);
  });

  it("clamps a page number from a stale button instead of showing nothing", () => {
    const diff = diffWith(10);
    expect(diffPageSlice(diff, 99).page).toBe(1);
    expect(diffPageSlice(diff, -5).page).toBe(0);
    expect(diffPageSlice(diff, Number.NaN).page).toBe(0);
  });

  it("says which slice of the files it is showing", () => {
    const text = renderDiffSummary(diffWith(39), "repo", 1);

    expect(text).toContain("across 39 files");
    expect(text).toContain(`showing ${DIFF_PAGE_SIZE + 1}–${DIFF_PAGE_SIZE * 2} of 39`);
  });

  it("says nothing about paging when everything fits", () => {
    expect(renderDiffSummary(diffWith(3), "repo")).not.toContain("showing");
  });
});
