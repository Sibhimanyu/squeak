import fs from "node:fs";
import path from "node:path";

import { normalizeRemoteUrl } from "../core/repository.js";

/** Which repository a folder belongs to: the main checkout's folder and its normalized `origin`. */
export interface RepoIdentity {
  mainFolder: string;
  remote: string | null;
}

const TTL_MS = 5 * 60_000;
const MISS_TTL_MS = 60_000;

/**
 * The repository a folder is in, read from files only (never a git call) and cached per folder, so observers stay cheap.
 * A linked worktree's `.git` file names `<main>/.git/worktrees/<name>`, whose `commondir` leads back to `<main>/.git`;
 * an ordinary checkout is its own main folder. The remote is `origin`'s url in the common dir's `config`.
 */
export class MainRepoFinder {
  private cache = new Map<string, { at: number; id: RepoIdentity | null; linked: boolean }>();

  constructor(private readonly now: () => number = Date.now) {}

  private lookup(cwd: string): { id: RepoIdentity | null; linked: boolean } {
    const hit = this.cache.get(cwd);
    if (hit && this.now() - hit.at < (hit.id ? TTL_MS : MISS_TTL_MS)) return hit;
    const found = this.read(cwd);
    const entry = { at: this.now(), ...found };
    this.cache.set(cwd, entry);
    if (this.cache.size > 2_000) this.cache.delete(this.cache.keys().next().value as string);
    return entry;
  }

  /** The main folder when `cwd` is in a linked worktree; null for an ordinary checkout or outside git. */
  find(cwd: string): string | null {
    const { id, linked } = this.lookup(cwd);
    return linked && id ? id.mainFolder : null;
  }

  /** The repository `cwd` is in (a worktree or an ordinary checkout), or null outside git. */
  identity(cwd: string): RepoIdentity | null {
    return this.lookup(cwd).id;
  }

  /** The name of the project's repository folder, so a worktree is named for its repo, not its own folder. */
  repoName(cwd: string): string {
    const id = this.identity(cwd);
    return path.basename(id ? id.mainFolder : cwd);
  }

  private remoteOf(commonDir: string): string | null {
    try {
      const text = fs.readFileSync(path.join(commonDir, "config"), "utf8");
      const section = /\[remote "origin"\]([^[]*)/.exec(text)?.[1] ?? "";
      const url = /^\s*url\s*=\s*(.+)$/m.exec(section)?.[1]?.trim();
      return url ? normalizeRemoteUrl(url) : null;
    } catch {
      return null;
    }
  }

  private read(cwd: string): { id: RepoIdentity | null; linked: boolean } {
    const none = { id: null, linked: false };
    try {
      let dir = path.resolve(cwd);
      for (let depth = 0; depth < 12; depth += 1) {
        const dot = path.join(dir, ".git");
        let stat: fs.Stats | null = null;
        try {
          stat = fs.statSync(dot);
        } catch {
          stat = null;
        }
        if (stat?.isFile()) {
          const text = fs.readFileSync(dot, "utf8");
          const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
          if (!gitdir) return none;
          const worktreeGit = path.resolve(dir, gitdir);
          let common: string;
          try {
            const rel = fs.readFileSync(path.join(worktreeGit, "commondir"), "utf8").trim();
            common = path.resolve(worktreeGit, rel);
          } catch {
            return none; // not a linked worktree layout we know
          }
          if (path.basename(common) !== ".git") return none;
          return { id: { mainFolder: path.dirname(common), remote: this.remoteOf(common) }, linked: true };
        }
        if (stat?.isDirectory()) return { id: { mainFolder: dir, remote: this.remoteOf(dot) }, linked: false };
        const parent = path.dirname(dir);
        if (parent === dir) return none;
        dir = parent;
      }
    } catch {
      // unreadable: no answer
    }
    return none;
  }
}

/** Shared by the Claude and Codex observers, so a worktree session carries its repository's name. */
const shared = new MainRepoFinder();
export function repoNameOfCwd(cwd: string | null | undefined): string | null {
  return cwd ? shared.repoName(cwd) : null;
}
