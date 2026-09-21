import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DiffFile {
  path: string;
  insertions: number;
  deletions: number;
  binary: boolean;
  /** Never committed and never staged, so absent from `git diff` entirely. */
  untracked: boolean;
}

export interface WorkspaceDiff {
  /** What the diff is measured against, or null when it is just uncommitted work. */
  baseRef: string | null;
  files: DiffFile[];
  insertions: number;
  deletions: number;
  /** More files existed than we were willing to list. */
  truncated: boolean;
}

export interface DiffReaderOptions {
  maxFiles?: number;
  maxPatchChars?: number;
  runGit?: (dir: string, args: string[]) => Promise<string>;
}

const DEFAULT_MAX_FILES = 40;
const DEFAULT_MAX_PATCH_CHARS = 12_000;

/**
 * Reads what a session changed, so a finished turn can be reviewed rather than
 * merely acknowledged.
 *
 * The diff is taken against the base branch rather than HEAD, because the
 * question being answered is "what did this workspace produce", not "what is
 * still uncommitted". `git diff <base>` covers both: committed work on the
 * branch and whatever is still in the tree.
 */
export class DiffReader {
  private readonly maxFiles: number;
  private readonly maxPatchChars: number;
  private readonly runGit: (dir: string, args: string[]) => Promise<string>;

  constructor(options: DiffReaderOptions = {}) {
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxPatchChars = options.maxPatchChars ?? DEFAULT_MAX_PATCH_CHARS;
    this.runGit = options.runGit ?? defaultRunGit;
  }

  async readSummary(dir: string, baseRef: string | null): Promise<WorkspaceDiff | null> {
    const base = await this.resolveBase(dir, baseRef);
    const numstat = await this.tryGit(dir, ["diff", "--numstat", base ?? "HEAD"]);
    if (numstat === null) {
      return null;
    }

    const files = parseNumstat(numstat);
    // An agent that creates a file almost never stages it, so without this a
    // review would silently omit every new file it wrote.
    files.push(...(await this.readUntracked(dir, this.maxFiles - files.length)));

    const truncated = files.length > this.maxFiles;
    const kept = truncated ? files.slice(0, this.maxFiles) : files;
    kept.sort((left, right) => right.insertions + right.deletions - (left.insertions + left.deletions));

    return {
      baseRef: base,
      files: kept,
      insertions: kept.reduce((total, file) => total + file.insertions, 0),
      deletions: kept.reduce((total, file) => total + file.deletions, 0),
      truncated,
    };
  }

  async readFilePatch(dir: string, baseRef: string | null, file: DiffFile): Promise<string | null> {
    const patch = file.untracked
      ? // An untracked file has nothing to diff against, so diff it against nothing.
        await this.tryGit(dir, ["diff", "--no-index", "--", "/dev/null", file.path])
      : await this.tryGit(dir, ["diff", (await this.resolveBase(dir, baseRef)) ?? "HEAD", "--", file.path]);

    if (patch === null) {
      return null;
    }
    const trimmed = stripDiffPreamble(patch);
    return trimmed.length > this.maxPatchChars ? `${trimmed.slice(0, this.maxPatchChars)}\n… patch truncated` : trimmed;
  }

  /** A base ref that does not exist locally is worse than no base at all. */
  private async resolveBase(dir: string, baseRef: string | null): Promise<string | null> {
    if (!baseRef) {
      return null;
    }
    const verified = await this.tryGit(dir, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]);
    return verified && verified.trim() ? baseRef : null;
  }

  private async readUntracked(dir: string, budget: number): Promise<DiffFile[]> {
    if (budget <= 0) {
      return [];
    }
    const status = await this.tryGit(dir, ["status", "--porcelain=v1", "-uall"]);
    if (!status) {
      return [];
    }

    const paths = status
      .split("\n")
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .slice(0, budget);

    const files: DiffFile[] = [];
    for (const path of paths) {
      // `--no-index` exits non-zero whenever the files differ, which for a new
      // file is always, so the output matters and the status does not.
      const numstat = await this.tryGit(dir, ["diff", "--no-index", "--numstat", "--", "/dev/null", path]);
      const parsed = numstat ? parseNumstat(numstat) : [];
      const entry = parsed[0];
      files.push({
        path,
        insertions: entry?.insertions ?? 0,
        deletions: 0,
        binary: entry?.binary ?? false,
        untracked: true,
      });
    }
    return files;
  }

  private async tryGit(dir: string, args: string[]): Promise<string | null> {
    try {
      return await this.runGit(dir, args);
    } catch (error) {
      // `git diff --no-index` uses exit code 1 to mean "they differ", so its
      // output is still the answer even though execFile treats it as failure.
      const stdout = (error as { stdout?: unknown })?.stdout;
      if (typeof stdout === "string" && stdout.length > 0) {
        return stdout;
      }
      return null;
    }
  }
}

async function defaultRunGit(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", dir, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10_000,
  });
  return stdout;
}

/** `120\t8\tsrc/a.ts`, with `-` for binary files. */
export function parseNumstat(output: string): DiffFile[] {
  const files: DiffFile[] = [];

  for (const line of output.split("\n")) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!match?.[1] || !match[2] || !match[3]) {
      continue;
    }
    const binary = match[1] === "-" || match[2] === "-";
    files.push({
      path: normalizeRenamePath(match[3]),
      insertions: binary ? 0 : Number.parseInt(match[1], 10),
      deletions: binary ? 0 : Number.parseInt(match[2], 10),
      binary,
      untracked: false,
    });
  }

  return files;
}

/** Renames arrive as `old => new`, sometimes with a shared prefix or suffix. */
function normalizeRenamePath(raw: string): string {
  const braced = raw.match(/^(.*)\{.* => (.*)\}(.*)$/);
  if (braced) {
    return `${braced[1] ?? ""}${braced[2] ?? ""}${braced[3] ?? ""}`.replace(/\/\//g, "/");
  }
  const plain = raw.split(" => ");
  return (plain.length > 1 ? plain[plain.length - 1] : raw) ?? raw;
}

/**
 * Drop the `diff --git` / `index` / `---` / `+++` header. On a phone those
 * four lines repeat the filename already in the message title and cost a
 * quarter of the visible patch.
 */
export function stripDiffPreamble(patch: string): string {
  const lines = patch.split("\n");
  const start = lines.findIndex((line) => line.startsWith("@@"));
  return (start === -1 ? lines : lines.slice(start)).join("\n").trim();
}

/**
 * A page holds as many files as fit on a phone screen with a button each.
 * Telegram allows more buttons than that, but a wall of them is unusable.
 */
export const DIFF_PAGE_SIZE = 8;

export function diffPageCount(diff: WorkspaceDiff): number {
  return Math.max(1, Math.ceil(diff.files.length / DIFF_PAGE_SIZE));
}

/** Clamped, so a stale button from an older, longer list cannot land nowhere. */
export function diffPageSlice(diff: WorkspaceDiff, page: number): { page: number; start: number; files: DiffFile[] } {
  const clamped = Math.min(Math.max(Number.isFinite(page) ? page : 0, 0), diffPageCount(diff) - 1);
  const start = clamped * DIFF_PAGE_SIZE;
  return { page: clamped, start, files: diff.files.slice(start, start + DIFF_PAGE_SIZE) };
}

export function renderDiffSummary(diff: WorkspaceDiff, title: string, page = 0): string {
  const lines = [`**${title}**`];
  lines.push(diff.baseRef ? `diff vs \`${diff.baseRef}\`` : "uncommitted changes");
  lines.push("");

  if (diff.files.length === 0) {
    lines.push("No changes.");
    return lines.join("\n");
  }

  const total = diff.files.length;
  lines.push(`+${diff.insertions}/−${diff.deletions} across ${total} file${total === 1 ? "" : "s"}`);

  const slice = diffPageSlice(diff, page);
  if (diffPageCount(diff) > 1) {
    lines.push(`showing ${slice.start + 1}–${slice.start + slice.files.length} of ${total}`);
  }
  lines.push("");

  for (const file of slice.files) {
    const stat = file.binary ? "binary" : `+${file.insertions}/−${file.deletions}`;
    lines.push(`\`${stat}\`  ${file.path}${file.untracked ? "  (new)" : ""}`);
  }
  if (diff.truncated) {
    lines.push("");
    lines.push("_More files were changed than are listed._");
  }

  return lines.join("\n");
}

export function renderFilePatch(file: DiffFile, patch: string): string {
  const stat = file.binary ? "binary" : `+${file.insertions}/−${file.deletions}`;
  if (file.binary || !patch.trim()) {
    return [`**${file.path}**`, `\`${stat}\``, "", "_No textual diff to show._"].join("\n");
  }
  return [`**${file.path}**`, `\`${stat}\``, "", "```diff", patch, "```"].join("\n");
}
