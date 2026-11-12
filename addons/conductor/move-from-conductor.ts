import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { importConductor } from "./import-conductor.js";

/**
 * Moves one Conductor project's files into Squeak's own folders and repoints Squeak's records.
 * Every refusal is decided before anything changes; the Claude history folders are copied, never
 * deleted; native.db is backed up first. conductor.db is only read.
 */
export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type ExecFn = (cmd: string, args: string[]) => ExecResult;

export const defaultExec: ExecFn = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error) : "") };
};

export interface MoveOptions {
  repo: string;
  conductorDbPath: string;
  nativeDbPath: string;
  conductorWorkspacesRoot: string;
  squeakReposRoot: string;
  squeakWorkspacesRoot: string;
  claudeProjectsDir: string;
  exec?: ExecFn;
  dryRun?: boolean;
  now?: () => Date;
}

export interface MovePair {
  from: string;
  to: string;
}

export interface MoveReport {
  dryRun: boolean;
  repo: string;
  folderMoves: MovePair[];
  claudeCopies: MovePair[];
  skippedWorkspaces: string[];
  needsImport: boolean;
  imported: boolean;
  backupPath: string | null;
  rowsUpdated: { projects: number; workspaces: number; sessions: number };
  worktreeList: string;
}

export class MoveRefused extends Error {}

type Row = Record<string, unknown>;

export function claudeFolderName(p: string): string {
  return p.replace(/[^A-Za-z0-9]/g, "-");
}

function columns(db: InstanceType<typeof Database>, table: string): Set<string> {
  return new Set((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name));
}

function isStrictlyUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : parent + "/");
}

export async function moveFromConductor(options: MoveOptions): Promise<MoveReport> {
  const exec = options.exec ?? defaultExec;
  const dryRun = options.dryRun === true;
  const repoName = options.repo;
  if (!repoName || /[\\/]/.test(repoName) || repoName === "." || repoName === "..")
    throw new MoveRefused(`Not a usable repo name: "${repoName}".`);

  // 1. What Conductor knows.
  const src = new Database(options.conductorDbPath, { readonly: true, fileMustExist: true });
  let oldRepo: string;
  const worktrees: Array<MovePair & { dir: string }> = [];
  const skipped: string[] = [];
  try {
    const repos = src.prepare("SELECT id, name, root_path FROM repos WHERE name = ?").all(repoName) as Row[];
    if (repos.length === 0) throw new MoveRefused(`Conductor has no repo named "${repoName}".`);
    if (repos.length > 1) throw new MoveRefused(`Conductor has ${repos.length} repos named "${repoName}"; refusing.`);
    const repo = repos[0]!;
    oldRepo = repo.root_path as string;
    if (!oldRepo || !path.isAbsolute(oldRepo)) throw new MoveRefused(`Repo "${repoName}" has no usable root_path.`);
    const wCols = columns(src, "workspaces");
    const rows = src
      .prepare(
        `SELECT directory_name, ${wCols.has("workspace_path") ? "workspace_path" : "NULL"} AS workspace_path
           FROM workspaces WHERE repository_id = ?`,
      )
      .all(repo.id) as Row[];
    for (const w of rows) {
      const dir = w.directory_name as string | null;
      if (!dir) continue;
      const from = (w.workspace_path as string | null) || path.join(options.conductorWorkspacesRoot, repoName, dir);
      if (!fs.existsSync(from)) {
        skipped.push(from);
        continue;
      }
      if (worktrees.some((x) => x.from === from)) continue;
      worktrees.push({ from, dir, to: path.join(options.squeakWorkspacesRoot, repoName, dir) });
    }
  } finally {
    src.close();
  }
  if (!fs.existsSync(oldRepo)) throw new MoveRefused(`The repo folder ${oldRepo} does not exist.`);
  const newRepo = path.join(options.squeakReposRoot, repoName);
  if (oldRepo === newRepo) throw new MoveRefused(`${oldRepo} is already in Squeak's folder.`);

  const folderMoves: MovePair[] = [
    { from: oldRepo, to: newRepo },
    ...worktrees.map((w) => ({ from: w.from, to: w.to })),
  ];

  // 2. Refusals.
  for (const m of folderMoves) {
    if (fs.existsSync(m.to)) throw new MoveRefused(`Target already exists: ${m.to}. Nothing was changed.`);
  }
  const nativeExists = fs.existsSync(options.nativeDbPath);
  let needsImport = true;
  if (nativeExists) {
    const db = new Database(options.nativeDbPath, { readonly: true });
    try {
      const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get();
      if (has) {
        needsImport = db.prepare("SELECT 1 FROM projects WHERE root_path = ?").get(oldRepo) === undefined;
        const busy = (
          db.prepare("SELECT cwd, status, title FROM sessions WHERE status NOT IN ('idle','error')").all() as Row[]
        ).filter((s) => folderMoves.some((m) => isStrictlyUnder(s.cwd as string, m.from)));
        if (busy.length > 0)
          throw new MoveRefused(
            `${busy.length} chat(s) in ${repoName} are not at rest (status ${[...new Set(busy.map((b) => b.status))].join(", ")}). Nothing was changed.`,
          );
      }
    } finally {
      db.close();
    }
  }
  for (const m of folderMoves) {
    const r = exec("lsof", ["+D", m.from]);
    if (r.status !== 0 && r.status !== 1)
      throw new MoveRefused(`lsof failed on ${m.from} (exit ${r.status}): ${r.stderr.trim()}`);
    if (r.stdout.trim()) {
      const lines = r.stdout.trim().split("\n");
      throw new MoveRefused(
        `Something has ${m.from} open (${lines
          .slice(1, 4)
          .map((l) => l.split(/\s+/).slice(0, 2).join(" "))
          .join("; ")}). Quit it and retry. Nothing was changed.`,
      );
    }
  }

  const home = options.claudeProjectsDir;
  const claudeCopies: MovePair[] = folderMoves
    .map((m) => ({ from: path.join(home, claudeFolderName(m.from)), to: path.join(home, claudeFolderName(m.to)) }))
    .filter((c) => fs.existsSync(c.from));

  const report: MoveReport = {
    dryRun,
    repo: repoName,
    folderMoves,
    claudeCopies,
    skippedWorkspaces: skipped,
    needsImport,
    imported: false,
    backupPath: null,
    rowsUpdated: { projects: 0, workspaces: 0, sessions: 0 },
    worktreeList: "",
  };
  // 3. Dry run stops here.
  if (dryRun) return report;

  // 4. Backup.
  if (nativeExists) {
    const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[^0-9]/g, "");
    const backup = `${options.nativeDbPath}.before-move-${repoName}-${stamp}`;
    const db = new Database(options.nativeDbPath, { fileMustExist: true });
    try {
      await db.backup(backup);
    } finally {
      db.close();
    }
    report.backupPath = backup;
  }

  // 5. Import first when the project is not in native.db yet (rows then carry the old paths).
  if (needsImport) {
    importConductor({
      conductorDbPath: options.conductorDbPath,
      nativeDbPath: options.nativeDbPath,
      workspacesRoot: options.conductorWorkspacesRoot,
      repos: [repoName],
    });
    report.imported = true;
  }

  // 6. Move folders; undo on failure.
  const done: MovePair[] = [];
  try {
    for (const m of folderMoves) {
      fs.mkdirSync(path.dirname(m.to), { recursive: true });
      fs.renameSync(m.from, m.to);
      done.push(m);
    }
  } catch (e) {
    for (const m of done.reverse()) {
      try {
        fs.renameSync(m.to, m.from);
      } catch {
        /* reported below */
      }
    }
    throw new MoveRefused(`Moving folders failed (${(e as Error).message}); moved folders were put back.`);
  }
  const repair = exec("git", ["-C", newRepo, "worktree", "repair", ...worktrees.map((w) => w.to)]);
  if (repair.status !== 0)
    throw new MoveRefused(`Folders moved, but "git worktree repair" failed: ${repair.stderr.trim()}`);

  // 7. Claude history: copy, never overwrite, never delete.
  for (const c of claudeCopies) fs.cpSync(c.from, c.to, { recursive: true, force: false, errorOnExist: false });

  // 8. Repoint native.db.
  const db = new Database(options.nativeDbPath, { fileMustExist: true });
  try {
    const rewrite = (table: "projects" | "workspaces" | "sessions", col: string): number => {
      let n = 0;
      for (const m of folderMoves) {
        const len = m.from.length;
        n += db
          .prepare(`UPDATE ${table} SET ${col} = ? || substr(${col}, ?) WHERE ${col} = ? OR substr(${col}, 1, ?) = ?`)
          .run(m.to, len + 1, m.from, len + 1, m.from + "/").changes;
      }
      return n;
    };
    db.transaction(() => {
      report.rowsUpdated.projects = rewrite("projects", "root_path");
      report.rowsUpdated.workspaces = rewrite("workspaces", "path");
      report.rowsUpdated.sessions = rewrite("sessions", "cwd");
    })();
  } finally {
    db.close();
  }

  // 9. Report.
  report.worktreeList = exec("git", ["-C", newRepo, "worktree", "list"]).stdout.trim();
  return report;
}

export function formatMoveReport(r: MoveReport): string {
  const lines = [
    r.dryRun ? `Dry run for "${r.repo}": nothing was changed.` : `Moved "${r.repo}" into Squeak's folders.`,
    ...r.folderMoves.map((m) => `  ${r.dryRun ? "will move" : "moved"} ${m.from} -> ${m.to}`),
    ...r.claudeCopies.map(
      (c) => `  ${r.dryRun ? "will copy" : "copied"} Claude history ${c.from} -> ${c.to} (old kept)`,
    ),
    ...r.skippedWorkspaces.map((p) => `  skipped (folder gone): ${p}`),
    r.dryRun
      ? `  native.db: ${r.needsImport ? "import the chats first, then " : ""}update project, workspace and chat paths`
      : `  native.db rows updated: ${r.rowsUpdated.projects} project, ${r.rowsUpdated.workspaces} workspace, ${r.rowsUpdated.sessions} chat paths${r.imported ? " (chats imported first)" : ""}`,
  ];
  if (r.backupPath) lines.push(`  backup: ${r.backupPath}`);
  if (r.worktreeList) lines.push("git worktree list:", ...r.worktreeList.split("\n").map((l) => `  ${l}`));
  return lines.join("\n");
}
