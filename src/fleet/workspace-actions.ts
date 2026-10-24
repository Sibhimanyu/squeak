import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

import Database from "better-sqlite3";

/**
 * Workspace actions from a phone or the Mac app, all through Conductor's own relay routes so its window shows
 * them at once: archive a workspace (`POST /workspaces/:id/archive`), create one in a repository
 * (`POST /workspaces`, the same shape Conductor's remote clients send), and the prompt that asks a chat to open
 * a pull request. Everything the request names is looked up again in Conductor's records here; nothing the caller
 * says about a workspace or repository is trusted.
 */

export interface WorkspaceRepo {
  id: string;
  name: string;
  defaultBranch: string;
  /** Never sent to a phone: Conductor matches the repository by it. */
  remoteUrl: string;
}

export interface WorkspaceRecord {
  id: string;
  state: string;
  path: string | null;
  repoName: string;
  targetBranch: string;
  remote: string;
  /** Chats in it whose agent holds the turn: archiving would stop them. */
  busyChats: number;
}

export interface WorkspaceRelay {
  isReady(): boolean;
  archiveWorkspace?(workspaceId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  createWorkspace?(args: {
    workspaceId: string;
    repositoryId: string;
    repoUrl: string;
    baseBranch: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export type ActionOutcome = { ok: true; workspaceId?: string } | { ok: false; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUSY = ["working", "waiting", "cancelling", "needs_user_input", "needs_plan_response", "needs_user_permission"];

/** Repositories a new workspace can be made in: shown in Conductor, with a remote Conductor can match. */
export function listWorkspaceRepos(dbPath: string): WorkspaceRepo[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.pragma("busy_timeout = 2000");
    const rows = db
      .prepare(
        `SELECT r.id, r.name, r.default_branch AS defaultBranch, r.remote_url AS remoteUrl,
                (SELECT MAX(datetime(w.updated_at)) FROM workspaces w WHERE w.repository_id = r.id) AS lastUsed
           FROM repos r
          WHERE IFNULL(r.hidden, 0) = 0 AND IFNULL(r.remote_url, '') != ''
          ORDER BY lastUsed DESC, r.name`,
      )
      .all() as Array<{ id: string; name: string | null; defaultBranch: string | null; remoteUrl: string }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name ?? "",
      defaultBranch: row.defaultBranch?.trim() || "main",
      remoteUrl: row.remoteUrl,
    }));
  } finally {
    db.close();
  }
}

export function readWorkspace(dbPath: string, workspaceId: string): WorkspaceRecord | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.pragma("busy_timeout = 2000");
    const columns = new Set(
      (db.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>).map((column) => column.name),
    );
    const path = columns.has("workspace_path") ? "w.workspace_path" : "NULL";
    const target = columns.has("intended_target_branch") ? "w.intended_target_branch" : "NULL";
    const row = db
      .prepare(
        `SELECT w.id, IFNULL(w.state, '') AS state, ${path} AS path, r.name AS repoName,
                IFNULL(NULLIF(${target}, ''), r.default_branch) AS targetBranch, IFNULL(r.remote, 'origin') AS remote,
                (SELECT COUNT(*) FROM sessions s WHERE s.workspace_id = w.id AND IFNULL(s.is_hidden, 0) = 0
                   AND s.status IN (${BUSY.map(() => "?").join(",")})) AS busyChats
           FROM workspaces w JOIN repos r ON r.id = w.repository_id
          WHERE w.id = ? LIMIT 1`,
      )
      .get(...BUSY, workspaceId) as
      | {
          id: string;
          state: string;
          path: string | null;
          repoName: string | null;
          targetBranch: string | null;
          remote: string | null;
          busyChats: number;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      state: row.state,
      path: row.path,
      repoName: row.repoName ?? "",
      targetBranch: row.targetBranch?.trim() || "main",
      remote: row.remote?.trim() || "origin",
      busyChats: row.busyChats,
    };
  } finally {
    db.close();
  }
}

/** Uncommitted files in a worktree: null when git cannot say (the caller refuses then too). */
export function uncommittedFiles(dir: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", dir, "status", "--porcelain"], { timeout: 10_000 }, (error, stdout) => {
      if (error) return resolve(null);
      resolve(stdout.split("\n").filter((line) => line.trim()).length);
    });
  });
}

export interface WorkspaceActionDeps {
  conductorDbPath: string;
  relay: WorkspaceRelay | null;
  /** Injected for tests. */
  dirty?: (dir: string) => Promise<number | null>;
  exists?: (dir: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
}

/**
 * Archive a workspace, as Conductor's Archive does (it stops the workspace's agents and removes the worktree;
 * the branch stays). Refused while any of its chats holds a turn, and while its worktree has uncommitted
 * changes, which archiving would leave behind: those wait for the person at the Mac.
 */
export async function archiveWorkspace(deps: WorkspaceActionDeps, workspaceId: unknown): Promise<ActionOutcome> {
  if (typeof workspaceId !== "string" || !UUID.test(workspaceId)) return { ok: false, reason: "Not a workspace." };
  const relay = deps.relay;
  if (!relay?.isReady() || !relay.archiveWorkspace) {
    return { ok: false, reason: "Conductor's relay isn't connected, so this Mac can't archive from here." };
  }
  let workspace: WorkspaceRecord | null;
  try {
    workspace = readWorkspace(deps.conductorDbPath, workspaceId);
  } catch {
    workspace = null;
  }
  if (!workspace) return { ok: false, reason: "That workspace isn't in Conductor any more." };
  if (workspace.state === "archived") return { ok: false, reason: "That workspace is already archived." };
  if (workspace.busyChats > 0) {
    return { ok: false, reason: "A chat in that workspace is working. Stop it or wait for it to finish first." };
  }
  const exists = deps.exists ?? ((dir: string) => fs.existsSync(dir));
  if (workspace.path && exists(workspace.path)) {
    const dirty = await (deps.dirty ?? uncommittedFiles)(workspace.path);
    if (dirty === null) return { ok: false, reason: "This Mac couldn't check that workspace for uncommitted work." };
    if (dirty > 0) {
      return {
        ok: false,
        reason: `That workspace has ${dirty} uncommitted ${dirty === 1 ? "change" : "changes"}. Commit or discard ${dirty === 1 ? "it" : "them"} first.`,
      };
    }
  }
  const result = await relay.archiveWorkspace(workspaceId);
  return result.ok ? { ok: true } : { ok: false, reason: `Conductor didn't archive it (${result.reason}).` };
}

/**
 * A new workspace in a repository, branched from its default branch, as Conductor's New workspace makes one.
 * The id is ours, so the caller can start a chat in it; this waits until Conductor lists it (up to 20 s).
 */
export async function createWorkspace(deps: WorkspaceActionDeps, repoId: unknown): Promise<ActionOutcome> {
  if (typeof repoId !== "string" || repoId.length > 64) return { ok: false, reason: "Not a repository." };
  const relay = deps.relay;
  if (!relay?.isReady() || !relay.createWorkspace) {
    return { ok: false, reason: "Conductor's relay isn't connected, so this Mac can't make a workspace from here." };
  }
  let repo: WorkspaceRepo | undefined;
  try {
    repo = listWorkspaceRepos(deps.conductorDbPath).find((candidate) => candidate.id === repoId);
  } catch {
    repo = undefined;
  }
  if (!repo) return { ok: false, reason: "That repository isn't in Conductor any more." };
  const workspaceId = (deps.newId ?? crypto.randomUUID)();
  const result = await relay.createWorkspace({
    workspaceId,
    repositoryId: repo.id,
    repoUrl: repo.remoteUrl,
    baseBranch: repo.defaultBranch,
  });
  if (!result.ok) return { ok: false, reason: `Conductor didn't make the workspace (${result.reason}).` };
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let waited = 0; waited < 20_000; waited += 500) {
    try {
      if (readWorkspace(deps.conductorDbPath, workspaceId)) return { ok: true, workspaceId };
    } catch {
      // Conductor is writing; look again.
    }
    await sleep(500);
  }
  return { ok: true, workspaceId };
}

/**
 * What a chat is asked to do to open a pull request: Conductor's own steps (commit what is left, push, read the
 * whole workspace diff, `gh pr create` onto the workspace's target branch), in Squeak's words.
 */
export function createPrPrompt(workspace: Pick<WorkspaceRecord, "targetBranch" | "remote">): string {
  const { targetBranch: target, remote } = workspace;
  return [
    "Open a pull request for this workspace's work.",
    "",
    "1. Run `git status`. If there are uncommitted changes, review them with `git diff` and commit them.",
    `2. If the branch has no upstream or has unpushed commits, push with \`git push -u ${remote} HEAD\`.`,
    `3. Review the whole diff against the target branch: \`git diff ${remote}/${target}...\`.`,
    `4. Create the PR with \`gh pr create --base ${target}\`. Keep the title under 80 characters and the description under five sentences, covering every change in the workspace, not just this chat's.`,
    "5. Reply with the PR's link.",
  ].join("\n");
}

/** The ingress control hooks: the Mac app's (and a test's) way in, gated by the hook token. */
export function workspaceControl(deps: WorkspaceActionDeps) {
  return {
    workspaceRepos: () => {
      try {
        return {
          repos: listWorkspaceRepos(deps.conductorDbPath).map(({ id, name, defaultBranch }) => ({
            id,
            name,
            defaultBranch,
          })),
        };
      } catch {
        return { repos: [] };
      }
    },
    workspaceAction: (body: Record<string, unknown>): Promise<ActionOutcome> => {
      if (body.action === "archive") return archiveWorkspace(deps, body.workspaceId);
      if (body.action === "create") return createWorkspace(deps, body.repoId);
      return Promise.resolve({ ok: false, reason: "Not an action this Mac knows." });
    },
  };
}
