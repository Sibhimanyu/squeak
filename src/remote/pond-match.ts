import fs from "node:fs";
import path from "node:path";

import type { PhonePond } from "../fleet/native-phone.js";

/** What a session needs to be matched to a pond. */
export interface PondMatchable {
  projectId?: string | null;
  cwd?: string | null;
  workspaceRoot?: string | null;
  repoName?: string | null;
}

const MAIN_REPO_TTL_MS = 5 * 60_000;
const MAIN_REPO_MISS_TTL_MS = 60_000;

/**
 * The main repository folder of the git worktree `cwd` is in: its `.git` is a file naming
 * `<main>/.git/worktrees/<name>`, whose `commondir` leads back to `<main>/.git`. Read from files, never a git call,
 * and cached per folder (a miss for a shorter time, since a clone may appear). Null outside a linked worktree.
 */
export class MainRepoFinder {
  private cache = new Map<string, { at: number; root: string | null }>();

  constructor(private readonly now: () => number = Date.now) {}

  find(cwd: string): string | null {
    const hit = this.cache.get(cwd);
    if (hit && this.now() - hit.at < (hit.root ? MAIN_REPO_TTL_MS : MAIN_REPO_MISS_TTL_MS)) return hit.root;
    const root = this.read(cwd);
    this.cache.set(cwd, { at: this.now(), root });
    if (this.cache.size > 2_000) this.cache.delete(this.cache.keys().next().value as string);
    return root;
  }

  private read(cwd: string): string | null {
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
          if (!gitdir) return null;
          const worktreeGit = path.resolve(dir, gitdir);
          let common = worktreeGit;
          try {
            const rel = fs.readFileSync(path.join(worktreeGit, "commondir"), "utf8").trim();
            common = path.resolve(worktreeGit, rel);
          } catch {
            // No commondir: not a linked worktree layout we know.
            return null;
          }
          return path.basename(common) === ".git" ? path.dirname(common) : null;
        }
        if (stat?.isDirectory()) return null; // an ordinary checkout: its own folder is the answer
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
      }
    } catch {
      // unreadable: no answer
    }
    return null;
  }
}

function contains(folder: string, target: string): boolean {
  const base = path.resolve(folder);
  const rel = path.relative(base, path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The pond whose folder holds `target`, the deepest folder winning. */
function byFolder(ponds: PhonePond[], target: string): PhonePond | null {
  let best: PhonePond | null = null;
  for (const pond of ponds) {
    if (!pond.folder || !contains(pond.folder, target)) continue;
    if (!best || pond.folder.length > (best.folder?.length ?? 0)) best = pond;
  }
  return best;
}

/**
 * The pond a chat belongs to, in this order: its project id (a native chat); a pond whose project folder holds its cwd;
 * a pond whose folder is the main repository of the cwd's git worktree. Never by name, label or repo name: a chat that
 * is in no project (a terminal in the home folder) is in none ("Other").
 */
export function matchPond(ponds: PhonePond[], session: PondMatchable, repos: MainRepoFinder): PhonePond | null {
  if (session.projectId) {
    const byId = ponds.find((pond) => pond.projectId === session.projectId);
    if (byId) return byId;
  }
  for (const where of [session.cwd, session.workspaceRoot]) {
    if (!where) continue;
    const direct = byFolder(ponds, where);
    if (direct) return direct;
    const main = repos.find(where);
    const viaWorktree = main ? byFolder(ponds, main) : null;
    if (viaWorktree) return viaWorktree;
  }
  return null;
}
