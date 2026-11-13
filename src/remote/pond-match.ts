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

/** The minimum a pond row needs to place a chat: its project id and its project's folder. */
export interface PondRow {
  id: string;
  projectId?: string;
  folder?: string;
}

/** The row whose folder holds `target`, the deepest folder winning. */
function byFolder<T extends PondRow>(ponds: T[], target: string): T | null {
  let best: T | null = null;
  for (const pond of ponds) {
    if (!pond.folder || !contains(pond.folder, target)) continue;
    if (!best || pond.folder.length > (best.folder?.length ?? 0)) best = pond;
  }
  return best;
}

/** The row a folder is in: directly, or through the main repository of the git worktree it is in. */
export function pondByFolder<T extends PondRow>(rows: T[], where: string, repos?: MainRepoFinder): T | null {
  const direct = byFolder(rows, where);
  if (direct) return direct;
  const main = repos?.find(where);
  return main ? byFolder(rows, main) : null;
}

/**
 * THE one placement of a chat in a pond ("session to pond id"), used by the pond directory, the phone view and `/state`.
 * A chat with a project id (a native chat: its workspace's project, else its own) is in that project's row, or in none;
 * any other chat is placed by its cwd inside a project folder, or a worktree whose git common dir is that folder.
 * Never by name, label or repo name: a terminal in the home folder is in none ("Other").
 */
export function placeInRows<T extends PondRow>(
  rows: T[],
  session: PondMatchable & { native?: boolean },
  repos?: MainRepoFinder,
): T | null {
  if (session.projectId) {
    const byId = rows.find((row) => row.projectId === session.projectId);
    if (byId) return byId;
  }
  if (session.native) return null;
  for (const where of [session.cwd, session.workspaceRoot]) {
    if (!where) continue;
    const found = pondByFolder(rows, where, repos);
    if (found) return found;
  }
  return null;
}

/** The pond a phone-view chat belongs to (`placeInRows`). A native chat is told by its fleet key. */
export function matchPond(
  ponds: PhonePond[],
  session: PondMatchable & { key?: string; native?: boolean },
  repos: MainRepoFinder,
): PhonePond | null {
  const native = session.native ?? session.key?.startsWith("squeak-native:") ?? false;
  return placeInRows(ponds, { ...session, native }, repos);
}
