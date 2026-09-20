import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitState {
  branch: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
  untracked: number;
  /** Relative to the tracking branch, when there is one. */
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  /**
   * Commits this branch has that the base branch does not. Conductor branches
   * usually have no upstream at all, so without this "unpushed" would read as
   * zero on a workspace holding a day of work.
   */
  aheadOfBase: number | null;
}

export interface GitTarget {
  dir: string;
  /** Usually `origin/<default branch>`; used when the branch has no upstream. */
  baseRef?: string | null;
}

export interface GitStateReaderOptions {
  ttlMs?: number;
  /** Bound on parallel git processes, so a big fleet cannot fork-bomb the Mac. */
  maxConcurrent?: number;
  runGit?: (dir: string, args: string[]) => Promise<string>;
  now?: () => number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_CONCURRENT = 4;

/**
 * "Finished, unreviewed" says a turn ended. It does not say whether the agent
 * touched three lines or rewrote the module, or whether any of it left the
 * machine. Reading git turns that into something you can actually triage from
 * a phone.
 *
 * Results are cached: a workspace's diff does not change between two radar
 * refreshes twenty seconds apart, and git is the most expensive thing the
 * fleet does.
 */
export class GitStateReader {
  private readonly ttlMs: number;
  private readonly maxConcurrent: number;
  private readonly runGit: (dir: string, args: string[]) => Promise<string>;
  private readonly now: () => number;
  private readonly cache = new Map<string, { expiresAt: number; state: GitState | null }>();

  constructor(options: GitStateReaderOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.runGit = options.runGit ?? defaultRunGit;
    this.now = options.now ?? Date.now;
  }

  async read(targets: GitTarget[]): Promise<Map<string, GitState>> {
    const results = new Map<string, GitState>();
    const pending: GitTarget[] = [];

    for (const target of targets) {
      const cached = this.cache.get(target.dir);
      if (cached && cached.expiresAt > this.now()) {
        if (cached.state) {
          results.set(target.dir, cached.state);
        }
        continue;
      }
      pending.push(target);
    }

    for (let index = 0; index < pending.length; index += this.maxConcurrent) {
      const batch = pending.slice(index, index + this.maxConcurrent);
      const states = await Promise.all(batch.map((target) => this.readOne(target)));
      for (const [offset, state] of states.entries()) {
        const target = batch[offset];
        if (!target) {
          continue;
        }
        // Cache misses too: an archived workspace whose directory is gone
        // should not be retried on every refresh.
        this.cache.set(target.dir, { expiresAt: this.now() + this.ttlMs, state });
        if (state) {
          results.set(target.dir, state);
        }
      }
    }

    return results;
  }

  private async readOne(target: GitTarget): Promise<GitState | null> {
    let branch: string | null;
    try {
      branch = (await this.runGit(target.dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() || null;
    } catch {
      // Not a repository, or the directory no longer exists. Both are normal
      // for an archived workspace.
      return null;
    }

    const [status, shortstat, upstream] = await Promise.all([
      this.tryGit(target.dir, ["status", "--porcelain=v1", "-uall"]),
      this.tryGit(target.dir, ["diff", "--shortstat", "HEAD"]),
      this.tryGit(target.dir, ["rev-list", "--count", "--left-right", "@{upstream}...HEAD"]),
    ]);

    const diff = parseShortstat(shortstat ?? "");
    const tracking = upstream === null ? null : parseLeftRight(upstream);

    let aheadOfBase: number | null = null;
    if (!tracking && target.baseRef) {
      const count = await this.tryGit(target.dir, ["rev-list", "--count", `${target.baseRef}..HEAD`]);
      const parsed = count === null ? Number.NaN : Number.parseInt(count.trim(), 10);
      aheadOfBase = Number.isFinite(parsed) ? parsed : null;
    }

    return {
      branch: branch === "HEAD" ? null : branch,
      filesChanged: diff.filesChanged,
      insertions: diff.insertions,
      deletions: diff.deletions,
      untracked: countUntracked(status ?? ""),
      ahead: tracking?.ahead ?? 0,
      behind: tracking?.behind ?? 0,
      hasUpstream: tracking !== null,
      aheadOfBase,
    };
  }

  private async tryGit(dir: string, args: string[]): Promise<string | null> {
    try {
      return await this.runGit(dir, args);
    } catch {
      // `@{upstream}` exits non-zero when the branch has no tracking branch,
      // which is the normal state of a fresh Conductor branch rather than an
      // error worth reporting.
      return null;
    }
  }
}

async function defaultRunGit(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", dir, ...args], {
    maxBuffer: 4 * 1024 * 1024,
    timeout: 5_000,
  });
  return stdout;
}

/** `3 files changed, 120 insertions(+), 8 deletions(-)` */
export function parseShortstat(output: string): { filesChanged: number; insertions: number; deletions: number } {
  const read = (pattern: RegExp): number => {
    const match = output.match(pattern);
    const value = match?.[1] ? Number.parseInt(match[1], 10) : 0;
    return Number.isFinite(value) ? value : 0;
  };

  return {
    filesChanged: read(/(\d+) files? changed/),
    insertions: read(/(\d+) insertions?\(\+\)/),
    deletions: read(/(\d+) deletions?\(-\)/),
  };
}

/** `git rev-list --left-right` prints "<behind>\t<ahead>". */
export function parseLeftRight(output: string): { behind: number; ahead: number } | null {
  const match = output.trim().match(/^(\d+)\s+(\d+)$/);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { behind: Number.parseInt(match[1], 10), ahead: Number.parseInt(match[2], 10) };
}

export function countUntracked(statusOutput: string): number {
  return statusOutput.split("\n").filter((line) => line.startsWith("??")).length;
}

/**
 * One line, phone-width. Says what changed and whether it has left the
 * machine, because those are the two questions worth answering from a radar.
 */
export function describeGitState(state: GitState): string | null {
  const parts: string[] = [];

  if (state.insertions > 0 || state.deletions > 0) {
    parts.push(`+${state.insertions}/−${state.deletions}`);
  }
  const touched = state.filesChanged + state.untracked;
  if (touched > 0) {
    parts.push(`${touched} file${touched === 1 ? "" : "s"}`);
  }
  if (parts.length === 0) {
    parts.push("clean");
  }

  if (state.hasUpstream) {
    if (state.ahead > 0) {
      parts.push(`${state.ahead} unpushed`);
    }
    if (state.behind > 0) {
      parts.push(`${state.behind} behind`);
    }
  } else if (state.aheadOfBase && state.aheadOfBase > 0) {
    // No tracking branch at all, so the whole branch is unpushed.
    parts.push(`${state.aheadOfBase} commit${state.aheadOfBase === 1 ? "" : "s"}, not pushed`);
  }

  return parts.join(" · ");
}
