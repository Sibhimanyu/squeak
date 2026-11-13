import path from "node:path";

import type { PhonePond } from "../fleet/native-phone.js";
import { MainRepoFinder, type RepoIdentity } from "../fleet/repo-identity.js";

export { MainRepoFinder, type RepoIdentity };

/** What a session needs to be matched to a pond. */
export interface PondMatchable {
  projectId?: string | null;
  cwd?: string | null;
  workspaceRoot?: string | null;
  repoName?: string | null;
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
  // A clone or worktree of the project's repo kept elsewhere: the same normalized git remote, never a name.
  if (repos) {
    for (const where of [session.cwd, session.workspaceRoot]) {
      const remote = where ? repos.identity(where)?.remote : null;
      if (!remote) continue;
      const matches = rows.filter((row) => row.folder && repos.identity(row.folder)?.remote === remote);
      if (matches.length === 1) return matches[0]!;
    }
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
