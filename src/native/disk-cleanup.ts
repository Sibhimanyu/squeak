import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveGhBinary } from "./binaries.js";
import type { NativeStore } from "./store.js";
import type { ProjectRow, WorkspaceRow } from "./types.js";

/**
 * Disk clean-up: finds what Squeak left on disk (folders no stream owns, worktrees git still lists, archived streams'
 * folders, merged branches) and removes exactly what the person selects. Nothing is ever `rm -rf`ed: a folder goes
 * through `git worktree remove` (clean ones only) or to the Trash, a branch through `git branch -d`.
 * Nothing under `<workspaces root>` or a pond's own worktree list is the only thing it will touch; a pond's repo
 * folder itself never.
 */

export type CleanupKind = "untracked-folder" | "stale-worktree" | "archived-folder" | "merged-branch" | "live-stream";

export interface CleanupItem {
  id: string;
  kind: CleanupKind;
  /** The pond (project id) it belongs to; null for a folder under no known pond. */
  pondId: string | null;
  pondName: string | null;
  /** The folder; null for a branch. */
  path: string | null;
  branch: string | null;
  /** Bytes on disk (`du`), null when it could not be measured in time. */
  sizeBytes: number | null;
  modifiedAt: string | null;
  /** Dirty tree, unpushed commits, or a folder git cannot read. Never preselected; deleting needs `confirmUnsaved`. */
  unsavedWork: boolean;
  unsavedReason: string | null;
  preselected: boolean;
  /** Git lists this folder as a worktree of the pond's repo. */
  registered: boolean;
  /** Merged into the pond's target branch because GitHub says the PR was merged (squash), not by history. */
  mergedByPullRequest?: boolean;
  label: string;
}

export interface CleanupScan {
  items: CleanupItem[];
  /** Bytes the preselected (safe) items would free. */
  reclaimableBytes: number;
  scannedAt: string;
}

export interface CleanupSelection {
  id: string;
  confirmUnsaved?: boolean;
}

export interface CleanupOutcome {
  id: string;
  ok: boolean;
  error?: string;
  freedBytes: number;
}

export interface CleanupResult {
  outcomes: CleanupOutcome[];
  removedFolders: number;
  removedBranches: number;
  freedBytes: number;
  failed: number;
}

export interface BranchState {
  merged: boolean;
  /** GitHub (not history) said so; the local delete then needs `-D`, since git sees no merge. */
  byPullRequest: boolean;
  tip: string | null;
  base: string | null;
}

export class CleanupError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export interface DiskCleanupOptions {
  store: NativeStore;
  workspacesRoot: string;
  /** Path to `gh`, null = not installed; default resolves it. */
  ghBin?: string | null;
  /** Moves a folder to the Trash. Default: `~/.Trash`, else Finder. Tests pass their own. */
  trash?: (folder: string) => Promise<void>;
  now?: () => number;
  sizeTtlMs?: number;
  duTimeoutMs?: number;
}

interface Exec {
  code: number;
  stdout: string;
}

function run(cmd: string, args: string[], cwd: string | undefined, timeoutMs: number): Promise<Exec> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      const code = error
        ? typeof (error as { code?: unknown }).code === "number"
          ? (error as never as { code: number }).code
          : 1
        : 0;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });
}

async function git(cwd: string, args: string[], timeoutMs = 20_000): Promise<string | null> {
  const r = await run("git", ["-C", cwd, ...args], undefined, timeoutMs);
  return r.code === 0 ? r.stdout.trim() : null;
}

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** The folder segment a pond's streams live under (the same rule `WorkspaceManager` uses). */
export function pondFolder(project: ProjectRow): string {
  return project.name.replace(/[/\\:]/g, "-").replace(/^\.+$/, "-");
}

interface Worktree {
  path: string;
  branch: string | null;
  prunable: boolean;
}

async function listWorktrees(repo: string): Promise<Worktree[]> {
  const out = await git(repo, ["worktree", "list", "--porcelain"]);
  if (!out) return [];
  const list: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), branch: null, prunable: false };
      list.push(cur);
    } else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (cur && line.startsWith("prunable")) cur.prunable = true;
  }
  return list;
}

function idOf(...parts: Array<string | null>): string {
  return createHash("sha1")
    .update(parts.map((p) => p ?? "").join("\0"))
    .digest("hex")
    .slice(0, 16);
}

export class DiskCleanup {
  private readonly sizes = new Map<string, { at: number; bytes: number | null }>();
  private readonly now: () => number;

  constructor(private readonly options: DiskCleanupOptions) {
    this.now = options.now ?? Date.now;
  }

  private gh(): string | null {
    return this.options.ghBin !== undefined ? this.options.ghBin : (resolveGhBinary() ?? null);
  }

  // ---- merged branches -------------------------------------------------------------------------------------

  /** The ref a branch must be merged into: the stream's target, else `origin/<default>` when present, else local. */
  private async baseRef(repo: string, base: string): Promise<string | null> {
    for (const ref of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) {
      if ((await git(repo, ["rev-parse", "--verify", "--quiet", ref])) !== null) return ref;
    }
    return null;
  }

  /**
   * Is the branch fully merged into the target? By history (`merge-base --is-ancestor`); a squash merge only when
   * `gh` says a pull request from exactly this tip is MERGED. No `gh`, or no answer: not merged, never a guess.
   */
  async branchState(project: ProjectRow, branch: string, target?: string | null): Promise<BranchState> {
    const none: BranchState = { merged: false, byPullRequest: false, tip: null, base: null };
    const repo = project.rootPath;
    const base = target || project.defaultBranch;
    if (!branch || branch === base || branch === project.defaultBranch) return none;
    const tip = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (!tip) return none;
    const ref = await this.baseRef(repo, base);
    if (!ref) return { ...none, tip };
    const r = await run("git", ["-C", repo, "merge-base", "--is-ancestor", tip, ref], undefined, 20_000);
    if (r.code === 0) return { merged: true, byPullRequest: false, tip, base: ref };
    const gh = this.gh();
    if (!gh) return { ...none, tip, base: ref };
    const pr = await run(
      gh,
      ["pr", "list", "--head", branch, "--state", "merged", "--json", "state,headRefOid", "--limit", "5"],
      repo,
      15_000,
    );
    if (pr.code !== 0) return { ...none, tip, base: ref };
    try {
      const rows = JSON.parse(pr.stdout) as Array<{ state?: string; headRefOid?: string }>;
      const hit = rows.some((x) => x.state === "MERGED" && x.headRefOid === tip);
      return { merged: hit, byPullRequest: hit, tip, base: ref };
    } catch {
      return { ...none, tip, base: ref };
    }
  }

  /** Can this archived stream's branch be offered for deletion? Used by the archive route. */
  async branchDeletable(ws: WorkspaceRow): Promise<{ deletable: boolean; branch: string }> {
    const project = this.options.store.getProject(ws.projectId);
    if (!project || !ws.branch) return { deletable: false, branch: ws.branch };
    if (await this.branchInUse(project, ws)) return { deletable: false, branch: ws.branch };
    const state = await this.branchState(project, ws.branch, this.options.store.getTargetBranch(ws.id));
    return { deletable: state.merged, branch: ws.branch };
  }

  /** Another live stream, or any worktree, still has the branch checked out. */
  private async branchInUse(project: ProjectRow, ws: WorkspaceRow): Promise<boolean> {
    const store = this.options.store;
    if (
      store.listWorkspaces(project.id).some((w) => w.id !== ws.id && w.state !== "archived" && w.branch === ws.branch)
    )
      return true;
    return (await listWorktrees(project.rootPath)).some((w) => w.branch === ws.branch && !w.prunable);
  }

  /** Deletes one archived stream's merged branch: locally, and on GitHub only when asked. */
  async deleteBranch(
    workspaceId: string,
    alsoRemote: boolean,
  ): Promise<{ deleted: boolean; remoteDeleted: boolean; branch: string; note?: string }> {
    const ws = this.options.store.getWorkspace(workspaceId);
    if (!ws) throw new CleanupError("No such stream.", 404);
    if (ws.state !== "archived") throw new CleanupError("Archive the stream first.");
    const project = this.options.store.getProject(ws.projectId);
    if (!project) throw new CleanupError("No such pond.", 404);
    if (await this.branchInUse(project, ws)) throw new CleanupError("The branch is still checked out somewhere.");
    const state = await this.branchState(project, ws.branch, this.options.store.getTargetBranch(ws.id));
    if (!state.merged || !state.tip) throw new CleanupError("That branch is not merged, so it was kept.");
    return this.dropBranch(project, ws.branch, state, alsoRemote);
  }

  private async dropBranch(project: ProjectRow, branch: string, state: BranchState, alsoRemote: boolean) {
    const repo = project.rootPath;
    // `-d` checks merge into HEAD/upstream itself; a PR-confirmed squash merge is invisible to it, so only then `-D`.
    const del = await run(
      "git",
      ["-C", repo, "branch", state.byPullRequest ? "-D" : "-d", "--", branch],
      undefined,
      20_000,
    );
    let deleted = del.code === 0;
    if (!deleted && !state.byPullRequest) {
      // `-d` compares with HEAD of the main checkout; history already proved it against the target.
      const tip = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
      if (tip === state.tip && state.merged) {
        const forced = await run("git", ["-C", repo, "branch", "-D", "--", branch], undefined, 20_000);
        deleted = forced.code === 0;
      }
    }
    if (!deleted) throw new CleanupError(`git would not delete ${branch}.`);
    let remoteDeleted = false;
    let note: string | undefined;
    if (alsoRemote) {
      const remote = await run("git", ["-C", repo, "ls-remote", "--heads", "origin", branch], undefined, 20_000);
      const line = remote.code === 0 ? remote.stdout.trim().split("\n")[0] : "";
      const remoteTip = line ? line.split(/\s+/)[0] : "";
      if (!line) note = "It was not on GitHub.";
      else if (remoteTip !== state.tip) note = "GitHub's copy has newer commits, so it was kept there.";
      else {
        const push = await run("git", ["-C", repo, "push", "origin", "--delete", branch], undefined, 30_000);
        remoteDeleted = push.code === 0;
        if (!remoteDeleted) note = "Could not delete it on GitHub.";
      }
    }
    return { deleted: true, remoteDeleted, branch, ...(note ? { note } : {}) };
  }

  // ---- measuring ---------------------------------------------------------------------------------------------

  private async sizeOf(folder: string): Promise<number | null> {
    const hit = this.sizes.get(folder);
    const ttl = this.options.sizeTtlMs ?? 10 * 60_000;
    if (hit && this.now() - hit.at < ttl) return hit.bytes;
    const r = await run("du", ["-sk", folder], undefined, this.options.duTimeoutMs ?? 60_000);
    const kb = Number(r.stdout.split(/\s/)[0]);
    // du exits 1 on an unreadable file but still prints a total; a timeout prints nothing.
    const bytes = Number.isFinite(kb) && r.stdout.trim() ? kb * 1024 : null;
    this.sizes.set(folder, { at: this.now(), bytes });
    return bytes;
  }

  private async unsaved(folder: string): Promise<{ unsaved: boolean; reason: string | null }> {
    const top = await git(folder, ["rev-parse", "--show-toplevel"]);
    if (!top || realOrResolved(top) !== realOrResolved(folder))
      return { unsaved: true, reason: "Not a git folder Squeak can read" };
    const status = await git(folder, ["status", "--porcelain", "--untracked-files=all"], 60_000);
    if (status === null) return { unsaved: true, reason: "Git could not read it" };
    const dirty = status.split("\n").filter((l) => l && !l.slice(3).startsWith(".context/"));
    if (dirty.length > 0) return { unsaved: true, reason: "Uncommitted changes" };
    const ahead = await git(folder, ["rev-list", "--count", "HEAD", "--not", "--remotes"], 30_000);
    if (ahead === null) return { unsaved: true, reason: "Git could not read it" };
    if (Number(ahead) > 0) return { unsaved: true, reason: "Commits not pushed anywhere" };
    return { unsaved: false, reason: null };
  }

  private async mapLimit<T, R>(list: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(list.length);
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await fn(list[i]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
    return out;
  }

  // ---- scan --------------------------------------------------------------------------------------------------

  /**
   * `pondId` narrows to one pond. `includeLive` (a pond being removed) also lists its live streams' folders.
   */
  async scan(options: { pondId?: string | null; includeLive?: boolean } = {}): Promise<CleanupScan> {
    const store = this.options.store;
    const root = realOrResolved(this.options.workspacesRoot);
    const allProjects = store.listProjects();
    // A plain-folder pond has no repo of its own (its folder may sit inside someone else's): never asked git.
    const projects = (options.pondId ? allProjects.filter((p) => p.id === options.pondId) : allProjects).filter(
      (p) => p.kind !== "folder",
    );
    const rows = allProjects.flatMap((p) => store.listWorkspaces(p.id));
    const rowByPath = new Map(rows.map((w) => [realOrResolved(w.path), w]));
    const folderToProject = new Map(allProjects.map((p) => [pondFolder(p), p]));

    type Raw = Omit<CleanupItem, "sizeBytes" | "modifiedAt" | "unsavedWork" | "unsavedReason" | "preselected"> & {
      folder: string | null;
    };
    const raws: Raw[] = [];
    const seenPaths = new Set<string>();
    const wanted = (p: ProjectRow | undefined | null) => !options.pondId || p?.id === options.pondId;

    // Git's own list per pond (by repo), registered folders and stale entries.
    const registered = new Map<string, { project: ProjectRow; wt: Worktree }>();
    const stale: Raw[] = [];
    for (const project of projects) {
      const list = await listWorktrees(project.rootPath);
      const mainPath = list[0] ? realOrResolved(list[0].path) : null;
      for (const wt of list) {
        const real = realOrResolved(wt.path);
        if (real === mainPath) continue;
        registered.set(real, { project, wt });
        if (wt.prunable || !fs.existsSync(wt.path)) {
          stale.push({
            id: idOf("stale-worktree", project.id, real),
            kind: "stale-worktree",
            pondId: project.id,
            pondName: project.name,
            path: wt.path,
            branch: wt.branch,
            folder: null,
            registered: true,
            label: path.basename(wt.path),
          });
        }
      }
    }

    // (a)+(b) folders under the workspaces root with no live row.
    const addFolder = (folder: string, project: ProjectRow | null, isRegistered: boolean) => {
      const real = realOrResolved(folder);
      // A folder a stream row owns is tracked (live) or category (c) (archived), never "not tracked".
      if (rowByPath.has(real) || seenPaths.has(real)) return;
      seenPaths.add(real);
      raws.push({
        id: idOf("untracked-folder", project?.id ?? null, real),
        kind: "untracked-folder",
        pondId: project?.id ?? null,
        pondName: project?.name ?? null,
        path: real,
        branch: registered.get(real)?.wt.branch ?? null,
        folder: real,
        registered: isRegistered,
        label: path.basename(real),
      });
    };
    if (fs.existsSync(root)) {
      for (const pondDir of safeDirs(root)) {
        const project = folderToProject.get(path.basename(pondDir)) ?? null;
        if (options.pondId && project?.id !== options.pondId) continue;
        for (const child of safeDirs(pondDir)) {
          const real = realOrResolved(child);
          const reg = registered.get(real);
          // Under no known pond, only something that is itself a worktree (a `.git` file) counts.
          if (!project && !fs.existsSync(path.join(child, ".git"))) continue;
          addFolder(child, project ?? null, Boolean(reg));
        }
      }
    }
    // Registered worktrees inside the root that no folder walk reached (a pond whose name changed).
    for (const [real, { project }] of registered) {
      if (!inside(root, real) || !fs.existsSync(real)) continue;
      if (wanted(project)) addFolder(real, project, true);
    }

    // (c) archived rows whose folder still exists; live streams only for a pond being removed.
    for (const ws of rows) {
      const project = allProjects.find((p) => p.id === ws.projectId) ?? null;
      if (!wanted(project)) continue;
      const real = realOrResolved(ws.path);
      const isArchived = ws.state === "archived";
      if (!isArchived && !options.includeLive) continue;
      if (!fs.existsSync(ws.path) || seenPaths.has(real)) continue;
      if (!inside(root, real) && !registered.has(real)) continue;
      seenPaths.add(real);
      raws.push({
        id: idOf(isArchived ? "archived-folder" : "live-stream", project?.id ?? null, real),
        kind: isArchived ? "archived-folder" : "live-stream",
        pondId: project?.id ?? null,
        pondName: project?.name ?? null,
        path: real,
        branch: ws.branch,
        folder: real,
        registered: registered.has(real),
        label: ws.title || ws.name,
      });
    }

    // (d) merged branches of archived streams.
    const branchRaws: Raw[] = [];
    const seenBranches = new Set<string>();
    const archivedRows = rows.filter((w) => w.state === "archived");
    const branchChecks = await this.mapLimit(archivedRows, 4, async (ws) => {
      const project = allProjects.find((p) => p.id === ws.projectId) ?? null;
      if (!project || project.kind === "folder" || !wanted(project) || !ws.branch) return null;
      const key = `${project.id}\0${ws.branch}`;
      if (seenBranches.has(key)) return null;
      seenBranches.add(key);
      if (await this.branchInUse(project, ws)) return null;
      const state = await this.branchState(project, ws.branch, store.getTargetBranch(ws.id));
      return state.merged ? { project, ws, state } : null;
    });
    for (const hit of branchChecks) {
      if (!hit) continue;
      branchRaws.push({
        id: idOf("merged-branch", hit.project.id, hit.ws.branch),
        kind: "merged-branch",
        pondId: hit.project.id,
        pondName: hit.project.name,
        path: null,
        branch: hit.ws.branch,
        folder: null,
        registered: false,
        mergedByPullRequest: hit.state.byPullRequest,
        label: hit.ws.branch,
      });
    }

    const folderItems = await this.mapLimit(raws, 4, async (raw): Promise<CleanupItem> => {
      const { folder, ...rest } = raw;
      const [sizeBytes, check] = await Promise.all([this.sizeOf(folder!), this.unsaved(folder!)]);
      let modifiedAt: string | null = null;
      try {
        modifiedAt = fs.statSync(folder!).mtime.toISOString();
      } catch {
        /* gone while scanning */
      }
      return {
        ...rest,
        sizeBytes,
        modifiedAt,
        unsavedWork: check.unsaved,
        unsavedReason: check.reason,
        preselected: !check.unsaved && raw.kind !== "live-stream",
      };
    });
    const plain = (raw: Raw): CleanupItem => {
      const rest: Omit<Raw, "folder"> & { folder?: unknown } = { ...raw };
      delete rest.folder;
      return {
        ...rest,
        sizeBytes: 0,
        modifiedAt: null,
        unsavedWork: false,
        unsavedReason: null,
        preselected: true,
      };
    };
    const items = [...folderItems, ...stale.map(plain), ...branchRaws.map(plain)];
    const reclaimableBytes = items.filter((i) => i.preselected).reduce((n, i) => n + (i.sizeBytes ?? 0), 0);
    return { items, reclaimableBytes, scannedAt: new Date(this.now()).toISOString() };
  }

  // ---- delete ------------------------------------------------------------------------------------------------

  private async trash(folder: string): Promise<void> {
    if (this.options.trash) return this.options.trash(folder);
    const dir = path.join(os.homedir(), ".Trash");
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
    const dest = path.join(dir, `${path.basename(folder)} ${stamp}`);
    try {
      fs.renameSync(folder, dest);
      return;
    } catch {
      /* another volume or no access to ~/.Trash: let Finder do it */
    }
    const script = `tell application "Finder" to delete POSIX file "${folder.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const r = await run("osascript", ["-e", script], undefined, 120_000);
    if (r.code !== 0 || fs.existsSync(folder)) throw new Error("macOS would not move it to the Trash.");
  }

  /** A folder is only ever touched when it sits under the workspaces root or in a pond's worktree list. */
  private async allowedFolder(item: CleanupItem, project: ProjectRow | null): Promise<string> {
    if (!item.path) throw new CleanupError("No folder.");
    const real = realOrResolved(item.path);
    const root = realOrResolved(this.options.workspacesRoot);
    const isRoot = inside(root, real) && path.dirname(real) !== root;
    for (const p of this.options.store.listProjects()) {
      if (real === realOrResolved(p.rootPath))
        throw new CleanupError("That is a pond's own folder; it is never removed.");
    }
    if (isRoot) return real;
    if (project) {
      const list = await listWorktrees(project.rootPath);
      if (list.slice(1).some((w) => realOrResolved(w.path) === real)) return real;
    }
    throw new CleanupError("That folder is outside Squeak's workspaces.");
  }

  /**
   * Removes exactly the selected items. Each id must come out of a fresh scan (so a stale or invented one, or any
   * path outside Squeak's folders, is refused). Unsaved work goes only with `confirmUnsaved`, and then to the Trash.
   */
  async clean(
    selections: CleanupSelection[],
    options: { pondId?: string | null; includeLive?: boolean; alsoOnGitHub?: boolean } = {},
  ): Promise<CleanupResult> {
    const scan = await this.scan({ pondId: options.pondId ?? null, includeLive: options.includeLive === true });
    const byId = new Map(scan.items.map((i) => [i.id, i]));
    const outcomes: CleanupOutcome[] = [];
    const prunePonds = new Set<string>();
    let removedFolders = 0;
    let removedBranches = 0;
    let freed = 0;
    const store = this.options.store;

    for (const sel of selections) {
      const item = byId.get(sel.id);
      if (!item) {
        outcomes.push({ id: sel.id, ok: false, error: "That item is no longer there.", freedBytes: 0 });
        continue;
      }
      const project = item.pondId ? store.getProject(item.pondId) : null;
      try {
        if (item.kind === "merged-branch") {
          if (!project || !item.branch) throw new CleanupError("No pond.");
          const ws = store.listWorkspaces(project.id).find((w) => w.branch === item.branch && w.state === "archived");
          const state = await this.branchState(project, item.branch, ws ? store.getTargetBranch(ws.id) : null);
          if (!state.merged) throw new CleanupError("That branch is not merged, so it was kept.");
          await this.dropBranch(project, item.branch, state, options.alsoOnGitHub === true);
          removedBranches++;
          outcomes.push({ id: item.id, ok: true, freedBytes: 0 });
          continue;
        }
        if (item.kind === "stale-worktree") {
          if (!project) throw new CleanupError("No pond.");
          prunePonds.add(project.id);
          outcomes.push({ id: item.id, ok: true, freedBytes: 0 });
          continue;
        }
        if (item.unsavedWork && sel.confirmUnsaved !== true)
          throw new CleanupError("It has unsaved work; confirm that to move it to the Trash.");
        const folder = await this.allowedFolder(item, project);
        let done = false;
        if (item.registered && project && !item.unsavedWork) {
          // No --force: git refuses a dirty or locked tree, and the Trash path below takes over.
          const r = await run("git", ["-C", project.rootPath, "worktree", "remove", folder], undefined, 120_000);
          done = r.code === 0 && !fs.existsSync(folder);
        }
        if (!done) {
          await this.trash(folder);
          if (project) prunePonds.add(project.id);
        }
        this.sizes.delete(item.path!);
        this.sizes.delete(folder);
        removedFolders++;
        freed += item.sizeBytes ?? 0;
        outcomes.push({ id: item.id, ok: true, freedBytes: item.sizeBytes ?? 0 });
      } catch (error) {
        outcomes.push({
          id: item.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          freedBytes: 0,
        });
      }
    }
    for (const id of prunePonds) {
      const p = store.getProject(id);
      if (p) await git(p.rootPath, ["worktree", "prune"]);
    }
    return {
      outcomes,
      removedFolders,
      removedBranches,
      freedBytes: freed,
      failed: outcomes.filter((o) => !o.ok).length,
    };
  }
}

function safeDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith("."))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}
