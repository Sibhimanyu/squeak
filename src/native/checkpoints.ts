import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const CHECKPOINT_NS = "refs/squeak-checkpoints";

export interface FileChange {
  path: string;
  /** A added, M modified, D deleted, T type changed. */
  status: "A" | "M" | "D" | "T";
}

export interface RestoreResult {
  /** The commit of the worktree as it was just before the restore: restoring it undoes the restore. */
  safety: string;
  written: number;
  removed: number;
}

export const checkpointRef = (sessionId: string, turn: number, which: "start" | "end"): string =>
  `${CHECKPOINT_NS}/${sessionId}/${turn}-${which}`;

/**
 * Snapshots of a worktree as commit objects, made with a temporary index so the person's index, HEAD,
 * stash and working tree are never touched. Every method resolves null / [] / throws only for restore;
 * a checkpoint problem must never stop a turn.
 */
export class Checkpointer {
  private readonly env = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: "Squeak",
    GIT_AUTHOR_EMAIL: "checkpoint@squeak.local",
    GIT_COMMITTER_NAME: "Squeak",
    GIT_COMMITTER_EMAIL: "checkpoint@squeak.local",
  };

  private async git(root: string, args: string[], extra: Record<string, string> = {}, input?: string): Promise<string> {
    const child = run("git", ["-C", root, ...args], {
      env: { ...this.env, ...extra },
      maxBuffer: 256 * 1024 * 1024,
      encoding: "utf8",
    });
    if (input !== undefined) child.child.stdin?.end(input);
    return (await child).stdout;
  }

  /** The repository's top directory, or null when `cwd` is not inside a git worktree. */
  async root(cwd: string): Promise<string | null> {
    try {
      if (!fs.existsSync(cwd)) return null;
      const out = (await this.git(cwd, ["rev-parse", "--show-toplevel"])).trim();
      return out || null;
    } catch {
      return null;
    }
  }

  private async withTempIndex<T>(root: string, fn: (indexFile: string) => Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-ckpt-"));
    const indexFile = path.join(dir, "index");
    try {
      return await fn(indexFile);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Tracked and untracked files (not ignored) as a commit; refs it under `ref` when given. Null when impossible. */
  async snapshot(cwd: string, ref: string | null): Promise<string | null> {
    const root = await this.root(cwd);
    if (!root) return null;
    try {
      return await this.withTempIndex(root, async (indexFile) => {
        const env = { GIT_INDEX_FILE: indexFile };
        // Start from a copy of the real index (cheap stat cache), else from HEAD, else empty; then follow the worktree.
        const real = (await this.git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
        if (real && fs.existsSync(real)) {
          fs.copyFileSync(real, indexFile);
          // Keep the copy's mtime: git rehashes files as new as the index ("racy git"), and a fresh mtime would hide edits.
          const st = fs.statSync(real);
          fs.utimesSync(indexFile, st.atime, st.mtime);
        } else if (await this.hasHead(root)) await this.git(root, ["read-tree", "HEAD"], env);
        await this.git(root, ["add", "-A", "--", ":/"], env);
        const tree = (await this.git(root, ["write-tree"], env)).trim();
        const commit = (await this.git(root, ["commit-tree", tree, "-m", "squeak checkpoint"])).trim();
        if (ref) await this.git(root, ["update-ref", ref, commit]);
        return commit;
      });
    } catch {
      return null;
    }
  }

  private async hasHead(root: string): Promise<boolean> {
    try {
      await this.git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
      return true;
    } catch {
      return false;
    }
  }

  /** Files that differ between two snapshots. */
  async changes(cwd: string, from: string, to: string): Promise<FileChange[]> {
    const root = await this.root(cwd);
    if (!root) return [];
    try {
      return parseNameStatus(
        await this.git(root, ["diff-tree", "-r", "--no-renames", "--name-status", "-z", from, to]),
      );
    } catch {
      return [];
    }
  }

  /**
   * Puts the worktree's files back to `target`: files the snapshot has are written when they differ; files
   * made since are removed only if untracked (and, since snapshots skip them, never ignored). Index, HEAD and
   * stash are not touched. A safety snapshot goes first and is returned.
   */
  async restore(cwd: string, sessionId: string, target: string): Promise<RestoreResult> {
    const root = await this.root(cwd);
    if (!root) throw new Error("not a git repository");
    const safety = await this.snapshot(root, `${CHECKPOINT_NS}/${sessionId}/safety-${Date.now()}`);
    if (!safety) throw new Error("could not take a safety checkpoint");
    const diff = parseNameStatus(
      await this.git(root, ["diff-tree", "-r", "--no-renames", "--name-status", "-z", safety, target]),
    );
    const write = diff.filter((d) => d.status !== "D").map((d) => d.path);
    const gone = diff.filter((d) => d.status === "D").map((d) => d.path);
    if (write.length > 0) {
      await this.withTempIndex(root, async (indexFile) => {
        const env = { GIT_INDEX_FILE: indexFile };
        await this.git(root, ["read-tree", target], env);
        await this.git(root, ["checkout-index", "-f", "-z", "--stdin"], env, write.join("\0") + "\0");
      });
    }
    let removed = 0;
    if (gone.length > 0) {
      const tracked = new Set((await this.git(root, ["ls-files", "-z"])).split("\0").filter(Boolean));
      for (const rel of gone) {
        if (tracked.has(rel)) continue;
        const abs = path.join(root, rel);
        try {
          fs.rmSync(abs, { force: true });
          removed++;
          removeEmptyParents(root, path.dirname(abs));
        } catch {
          // a file that will not go stays; the person sees it in git status
        }
      }
    }
    return { safety, written: write.length, removed };
  }

  /** Deletes every checkpoint ref of a session (its workspace was archived). Returns how many. */
  async prune(repoDir: string, sessionId: string): Promise<number> {
    const root = await this.root(repoDir);
    if (!root) return 0;
    try {
      const refs = (await this.git(root, ["for-each-ref", "--format=%(refname)", `${CHECKPOINT_NS}/${sessionId}/`]))
        .split("\n")
        .filter(Boolean);
      for (const r of refs) await this.git(root, ["update-ref", "-d", r]);
      return refs.length;
    } catch {
      return 0;
    }
  }
}

function parseNameStatus(out: string): FileChange[] {
  const parts = out.split("\0").filter((p) => p.length > 0);
  const changes: FileChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!.charAt(0);
    if (status === "A" || status === "M" || status === "D" || status === "T") {
      changes.push({ status, path: parts[i + 1]! });
    }
  }
  return changes;
}

function removeEmptyParents(root: string, dir: string): void {
  let current = dir;
  while (current.startsWith(root + path.sep) && current !== root) {
    try {
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}
