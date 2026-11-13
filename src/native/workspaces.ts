import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cloneFiles, cloneFolders, planClones, startsWithNpmCi, type CloneOptions } from "./clone-deps.js";
import { resolveSettings, type ResolvedSettings } from "./project-settings.js";
import { freePortBlock, LogBuffer, nextPortBlock, runScript, scriptEnv, type RunningScript } from "./scripts.js";
import type { NativeStore } from "./store.js";
import { NO_STREAMS } from "./version-history.js";
import { generateStreamName, slugify, uniqueSlug } from "./stream-names.js";
import type { ProjectRow, SessionRow, SessionStatus, WorkspaceRow } from "./types.js";

export class WorkspaceError extends Error {}

/** `gone`: folder and branch both deleted. `branch-deleted`: the folder is still there. */
export type StreamGit = "ok" | "gone" | "branch-deleted";

/**
 * How a workspace's worktree starts, when not the usual new branch from the project's default: an existing
 * branch checked out as is (a PR's head), or a new branch from another base. Worked out by
 * `workspace-sources.ts`, which does the network part (fetch, gh) first.
 */
export interface WorktreePlan {
  /** The branch the worktree is on. */
  branch: string;
  /** `git worktree add <path> ...<args>`. */
  args: string[];
  /** The branch already has its name (an existing branch, an issue's): the first message must not rename it. */
  named: boolean;
  /** The branch this workspace merges into, when not the project's default. */
  target?: string | null;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

export interface WorkspaceManagerOptions {
  store: NativeStore;
  /** Default `~/squeak/workspaces`. */
  workspacesRoot?: string;
  /** Branch prefix; default the repo's `user.name`, else the account name. */
  gitUser?: string;
  /** A setup script that runs longer than this is stopped and the setup fails. Default 15 minutes. */
  setupTimeoutMs?: number;
  /** How long a stopped script gets to leave before SIGKILL. */
  killGraceMs?: number;
  /** Test seam for the copy-on-write clone of dependency folders (runner, volume probe). */
  clone?: CloneOptions;
}

const BUSY_STATUSES = new Set<SessionStatus>([
  "working",
  "stopping",
  "awaiting_approval",
  "awaiting_plan",
  "awaiting_answer",
]);

export interface RunStatus {
  running: boolean;
  pid?: number;
  port: number | null;
  logTail: string;
}

const RUN_TAIL = 16 * 1024;

/**
 * Emits `setup-settled` (the workspace row, state `ready` or `setup_failed`) when its setup script ends.
 */
export class WorkspaceManager extends EventEmitter {
  private readonly store: NativeStore;
  readonly workspacesRoot: string;
  private readonly gitUser: string | undefined;
  private readonly setupTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly cloneOptions: CloneOptions;
  private readonly setups = new Map<string, { log: LogBuffer; proc: RunningScript | null }>();
  private readonly runs = new Map<string, { log: LogBuffer; proc: RunningScript }>();
  private shuttingDown = false;

  constructor(options: WorkspaceManagerOptions) {
    super();
    this.store = options.store;
    this.workspacesRoot = options.workspacesRoot ?? path.join(os.homedir(), "squeak", "workspaces");
    this.gitUser = options.gitUser;
    this.setupTimeoutMs = options.setupTimeoutMs ?? 15 * 60_000;
    this.killGraceMs = options.killGraceMs ?? 3000;
    this.cloneOptions = options.clone ?? {};
  }

  settingsFor(project: ProjectRow): ResolvedSettings {
    return resolveSettings(
      this.store,
      project,
      () => this.gitUser ?? tryGit(project.rootPath, ["config", "user.name"]) ?? os.userInfo().username,
    );
  }

  /** A restart cut off whatever was setting up. */
  recover(): void {
    for (const ws of this.store.workspacesInState("setting_up")) {
      this.store.setWorkspaceLog(ws.id, `${this.store.getWorkspaceLog(ws.id)}\nSqueak restarted during setup.\n`);
      this.store.setWorkspaceState(ws.id, "setup_failed");
    }
  }

  /**
   * Streams whose branch or worktree was deleted outside Squeak (`git branch -D`, a worktree removed by hand,
   * disk cleanup). Cheap (one `git show-ref` per stream, cached) and it deletes nothing: a `ready` stream
   * whose folder AND branch are both gone is marked `archived`; one whose branch is gone but whose folder
   * remains is reported as "branch-deleted" so the screen says so instead of looking normal.
   */
  private readonly goneChecks = new Map<string, { at: number; status: StreamGit }>();
  private static readonly GONE_TTL_MS = 30_000;

  streamGit(ws: WorkspaceRow, now = Date.now()): StreamGit {
    if (ws.state !== "ready") return "ok";
    const hit = this.goneChecks.get(ws.id);
    if (hit && now - hit.at < WorkspaceManager.GONE_TTL_MS) return hit.status;
    const project = this.store.getProject(ws.projectId);
    let status: StreamGit = "ok";
    if (project && project.kind === "git" && fs.existsSync(project.rootPath)) {
      const branchGone =
        !!ws.branch &&
        tryGit(project.rootPath, ["show-ref", "--verify", "--quiet", `refs/heads/${ws.branch}`]) === null;
      const folderGone = !fs.existsSync(ws.path);
      if (branchGone && folderGone) status = "gone";
      else if (branchGone) status = "branch-deleted";
    }
    this.goneChecks.set(ws.id, { at: now, status });
    return status;
  }

  /** Archives every ready stream of a project whose folder and branch are both gone; returns the ones archived. */
  reconcileGone(projectId: string, now = Date.now()): WorkspaceRow[] {
    const archived: WorkspaceRow[] = [];
    for (const ws of this.store.listWorkspaces(projectId)) {
      if (this.streamGit(ws, now) !== "gone") continue;
      this.store.setWorkspaceState(ws.id, "archived");
      this.goneChecks.delete(ws.id);
      archived.push({ ...ws, state: "archived" });
    }
    return archived;
  }

  /** Stops every run script and any setup still going (the host is shutting down). */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const procs = [...this.runs.values(), ...this.setups.values()].map((x) => x.proc).filter((p) => p !== null);
    await Promise.all(procs.map((p) => p!.kill(this.killGraceMs)));
  }

  /** A typed display name: trimmed, 1-60 characters, no control characters. */
  static checkProjectName(raw: unknown): string {
    if (typeof raw !== "string") throw new WorkspaceError("The name must be text.");
    const name = raw.trim();
    // eslint-disable-next-line no-control-regex
    if (!name || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new WorkspaceError("A name is 1 to 60 characters, on one line.");
    }
    return name;
  }

  /** The folder segment a project's workspaces live under: its name, with path separators made safe. */
  private folderOf(project: ProjectRow): string {
    return project.name.replace(/[/\\:]/g, "-").replace(/^\.+$/, "-");
  }

  /**
   * A typed branch name for a new workspace: valid for git, not already a local branch, and its folder
   * (a slug of it) free. Returns the branch as typed and the workspace name (the folder).
   */
  resolveNewBranch(project: ProjectRow, raw: unknown): { branch: string; name: string } {
    if (typeof raw !== "string" || !raw.trim()) throw new WorkspaceError("The branch name must be text.");
    const branch = raw.trim();
    if (
      branch.length > 200 ||
      branch.startsWith("-") ||
      tryGit(project.rootPath, ["check-ref-format", "--branch", branch]) === null
    ) {
      throw new WorkspaceError(`"${branch.slice(0, 80)}" is not a name git accepts for a branch.`);
    }
    if (this.branchExists(project.rootPath, branch)) {
      throw new WorkspaceError(`There is already a branch named ${branch}. Pick another name.`);
    }
    const name = branch
      .toLowerCase()
      .replace(/[^a-z0-9._]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "");
    if (!name) throw new WorkspaceError("That name has nothing a folder can be named after. Use letters or digits.");
    if (this.nameTaken(project, name)) {
      throw new WorkspaceError(`A workspace folder named ${name} already exists. Pick another name.`);
    }
    return { branch, name };
  }

  private nameTaken(project: ProjectRow, name: string): boolean {
    return (
      this.store.listWorkspaces(project.id).some((w) => w.name === name) ||
      fs.existsSync(path.join(this.workspacesRoot, this.folderOf(project), name))
    );
  }

  /**
   * Any folder can be a pond. A git repository (its top folder) is `git`; anything else is `folder`: chats run in
   * it with no streams until version history is turned on. The home folder and `/` are never a pond.
   */
  addProject(rootPath: string, name?: string): ProjectRow {
    let real: string;
    try {
      real = fs.realpathSync(rootPath);
    } catch {
      throw new WorkspaceError("That folder doesn't exist.");
    }
    if (!fs.statSync(real).isDirectory()) throw new WorkspaceError("That is a file, not a folder.");
    const home = fs.realpathSync(os.homedir());
    if (real === home || real === path.parse(real).root) {
      throw new WorkspaceError("Pick a folder inside your home folder, not the whole home folder or the disk.");
    }
    const top = tryGit(real, ["rev-parse", "--show-toplevel"]);
    const topReal = top ? fs.realpathSync(top) : null;
    // A repository above the home folder (dotfiles in ~) does not make this folder part of that repository.
    const isGit = topReal !== null && topReal !== home && topReal !== path.parse(topReal).root;
    const root = isGit ? topReal : real;
    const detect = (): string => {
      const origin = tryGit(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
      return (
        (origin ? origin.replace(/^origin\//, "") : null) ||
        tryGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]) ||
        "main"
      );
    };
    const existing = this.store.getProjectByRoot(root);
    if (existing) {
      // Someone ran `git init` here themselves: it is a repository now.
      if (existing.kind === "folder" && isGit) {
        const defaultBranch = detect();
        this.store.setProjectKind(existing.id, "git", defaultBranch);
        return { ...existing, kind: "git", defaultBranch };
      }
      return existing;
    }
    return this.store.createProject({
      name: name === undefined ? path.basename(root) : WorkspaceManager.checkProjectName(name),
      rootPath: root,
      defaultBranch: isGit ? detect() : "main",
      kind: isGit ? "git" : "folder",
    });
  }

  /** The branch a new workspace named `name` would get (`<prefix><name>`). */
  branchFor(project: ProjectRow, name: string): string {
    return `${this.settingsFor(project).effective.branchPrefix}${name}`;
  }

  /** A slug no stream folder, workspace or local branch of this project uses yet. */
  private slugTaken(project: ProjectRow, slug: string): boolean {
    return this.nameTaken(project, slug) || this.branchExists(project.rootPath, this.branchFor(project, slug));
  }

  /** The name the next stream of this project gets: a title, its folder slug and its branch. */
  suggest(project: ProjectRow, rng: () => number = Math.random): { title: string; slug: string; branch: string } {
    const { title, slug } = generateStreamName(rng, (s) => this.slugTaken(project, s));
    return { title, slug, branch: this.branchFor(project, slug) };
  }

  /**
   * A stream's title and folder name: a typed title becomes the title and is slugged (made unique with -2, -3),
   * none means a generated one.
   */
  nameFor(project: ProjectRow, typedTitle?: string): { title: string; name: string } {
    const typed = typedTitle?.trim();
    if (typed) {
      const base = slugify(typed) || "stream";
      return { title: typed.slice(0, 120), name: uniqueSlug(base, (s) => this.slugTaken(project, s)) };
    }
    const g = this.suggest(project);
    return { title: g.title, name: g.slug };
  }

  /** `typedBranch` (a new branch from the default, no plan): the person's own branch name, kept as is. */
  createWorkspace(
    projectId: string,
    plan?: WorktreePlan,
    name?: string,
    typedBranch?: string,
    title?: string,
  ): WorkspaceRow {
    const project = this.store.getProject(projectId);
    if (!project) throw new WorkspaceError("No such project.");
    if (project.kind === "folder") throw new WorkspaceError(NO_STREAMS);
    const resolved = this.settingsFor(project);
    if (typedBranch !== undefined) {
      const typed = this.resolveNewBranch(project, typedBranch);
      name = typed.name;
      typedBranch = typed.branch;
    }
    if (name === undefined) {
      const made = this.nameFor(project, title);
      name = made.name;
      title = made.title;
    }
    const workspacePath = path.join(this.workspacesRoot, this.folderOf(project), name);
    const branch = typedBranch ?? plan?.branch ?? `${resolved.effective.branchPrefix}${name}`;
    const hasOrigin = tryGit(project.rootPath, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${project.defaultBranch}`,
    ]);
    const base = hasOrigin ? `origin/${project.defaultBranch}` : project.defaultBranch;

    fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
    try {
      git(project.rootPath, ["worktree", "add", workspacePath, ...(plan?.args ?? ["-b", branch, base])]);
    } catch (error) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
      throw new WorkspaceError(`git worktree add failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Ignored dependency folders are cloned (copy-on-write) before the setup script, off the event loop; small
    // ignored files (.env*) at once. What cannot be cloned falls back to the plain `.worktreeinclude` copy.
    const clonePlan = resolved.effective.cloneDependencies ? planClones(project.rootPath, workspacePath) : null;
    if (clonePlan) cloneFiles(project.rootPath, workspacePath, clonePlan.files);
    this.copyIncluded(project.rootPath, workspacePath, clonePlan?.all);
    fs.mkdirSync(path.join(workspacePath, ".context"), { recursive: true });
    const cloneDirs = clonePlan?.dirs ?? [];
    const hasSetup = Boolean(resolved.effective.setupScript) || cloneDirs.length > 0;
    const ws = this.store.createWorkspace({
      projectId,
      name,
      path: workspacePath,
      branch,
      state: hasSetup ? "setting_up" : "ready",
      title: title?.trim() || null,
      port: nextPortBlock(new Set(this.store.usedPorts())),
    });
    if (plan?.named || typedBranch !== undefined) this.store.markBranchRenamed(ws.id);
    if (plan?.target) this.store.setTargetBranch(ws.id, plan.target);
    if (hasSetup) {
      // Registered before returning, so the first message sees the gate and a log read finds the buffer.
      this.setups.set(ws.id, { log: new LogBuffer(), proc: null });
      void this.runSetup(ws, project, resolved.effective.setupScript, cloneDirs);
    }
    return ws;
  }

  private async runSetup(
    ws: WorkspaceRow,
    project: ProjectRow,
    script: string | null,
    cloneDirs: string[] = [],
  ): Promise<void> {
    const entry = this.setups.get(ws.id)!;
    let failure: string | null = null;
    try {
      if (cloneDirs.length > 0) {
        const done = await cloneFolders(
          project.rootPath,
          ws.path,
          cloneDirs,
          (l) => entry.log.append(l),
          this.cloneOptions,
        );
        if (script && done.cloned.includes("node_modules") && startsWithNpmCi(script)) {
          entry.log.append("Hint: npm ci removes the cloned node_modules; `npm install` keeps it.\n");
        }
      }
      if (script !== null) {
        const port = await freePortBlock(ws.port, new Set(this.store.usedPorts().filter((p) => p !== ws.port)));
        if (port !== ws.port) this.store.setWorkspacePort(ws.id, port);
        if (this.shuttingDown) throw new Error("Squeak is shutting down.");
        const proc = runScript({
          script,
          cwd: ws.path,
          env: scriptEnv(project, ws, port),
          log: entry.log,
          timeoutMs: this.setupTimeoutMs,
        });
        entry.proc = proc;
        const result = await proc.done;
        if (result.timedOut) failure = "The setup script took too long and was stopped.";
        else if (this.shuttingDown) failure = "Squeak stopped during setup.";
        else if (result.code !== 0) failure = `The setup script failed (exit ${result.code ?? result.signal}).`;
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure) entry.log.append(`\n${failure}\n`);
    this.store.setWorkspaceLog(ws.id, entry.log.toString());
    this.store.setWorkspaceState(ws.id, failure ? "setup_failed" : "ready");
    this.setups.delete(ws.id);
    const settled = this.store.getWorkspace(ws.id)!;
    this.emit("setup-settled", settled, failure);
  }

  /** The setup output: live while it runs, then what was kept (the last 200 KB). */
  getLog(workspaceId: string): { state: WorkspaceRow["state"]; log: string } {
    const ws = this.requireWorkspace(workspaceId);
    return { state: ws.state, log: this.setups.get(ws.id)?.log.toString() ?? this.store.getWorkspaceLog(ws.id) };
  }

  private requireWorkspace(id: string): WorkspaceRow {
    const ws = this.store.getWorkspace(id);
    if (!ws) throw new WorkspaceError("No such workspace.");
    return ws;
  }

  // run script

  runStatus(workspaceId: string): RunStatus {
    const ws = this.requireWorkspace(workspaceId);
    const run = this.runs.get(ws.id);
    return {
      running: Boolean(run),
      ...(run ? { pid: run.proc.pid } : {}),
      port: ws.port,
      logTail: run?.log.tail(RUN_TAIL) ?? this.lastRunLogs.get(ws.id) ?? "",
    };
  }
  private readonly lastRunLogs = new Map<string, string>();

  async startRun(workspaceId: string): Promise<RunStatus> {
    const ws = this.requireWorkspace(workspaceId);
    const project = this.store.getProject(ws.projectId)!;
    if (ws.state === "archived") throw new WorkspaceError("This workspace is archived.");
    if (ws.state === "setting_up") throw new WorkspaceError("The workspace is still being set up.");
    if (this.runs.has(ws.id)) throw new WorkspaceError("The run script is already running.");
    const script = this.settingsFor(project).effective.runScript;
    if (!script) throw new WorkspaceError("This project has no run script. Set one in the project's settings.");
    if (!fs.existsSync(ws.path)) throw new WorkspaceError("The workspace folder is gone.");
    const port = await freePortBlock(ws.port, new Set(this.store.usedPorts().filter((p) => p !== ws.port)));
    if (port !== ws.port) this.store.setWorkspacePort(ws.id, port);
    if (this.runs.has(ws.id)) throw new WorkspaceError("The run script is already running.");
    const log = new LogBuffer();
    const proc = runScript({ script, cwd: ws.path, env: scriptEnv(project, ws, port), log });
    const entry = { log, proc };
    this.runs.set(ws.id, entry);
    this.lastRunLogs.delete(ws.id);
    void proc.done.then((result) => {
      log.append(`\n[run script ended${result.code !== null ? `, exit ${result.code}` : ""}]\n`);
      if (this.runs.get(ws.id) === entry) this.runs.delete(ws.id);
      this.lastRunLogs.set(ws.id, log.tail(RUN_TAIL));
    });
    return this.runStatus(ws.id);
  }

  async stopRun(workspaceId: string): Promise<RunStatus> {
    const ws = this.requireWorkspace(workspaceId);
    const run = this.runs.get(ws.id);
    if (run) await run.proc.kill(this.killGraceMs);
    return this.runStatus(ws.id);
  }

  // first-message branch rename

  /**
   * After a new workspace's first user message: `<prefix>/<name>` becomes `<prefix>/<first words>`, no model call.
   * Only while the branch is still the generated name, has no upstream and no commits beyond the base; one try per workspace.
   * Returns the new branch, or null when nothing was renamed.
   */
  renameBranchFromMessage(session: Pick<SessionRow, "workspaceId">, text: string): string | null {
    if (!session.workspaceId) return null;
    const ws = this.store.getWorkspace(session.workspaceId);
    if (!ws || ws.state === "archived" || !this.store.branchRenamePending(ws.id)) return null;
    this.store.markBranchRenamed(ws.id);
    const project = this.store.getProject(ws.projectId);
    if (!project || !fs.existsSync(ws.path)) return null;
    const cut = ws.branch.lastIndexOf("/") + 1;
    const prefix = ws.branch.slice(0, cut);
    if (ws.branch !== `${prefix}${ws.name}`) return null;
    if (tryGit(ws.path, ["rev-parse", "--abbrev-ref", "HEAD"]) !== ws.branch) return null;
    // Cut from origin/<base>, a branch tracks it; only another upstream means it was pushed.
    const upstream = tryGit(ws.path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    if (upstream && upstream !== `origin/${project.defaultBranch}`) return null;
    const baseRef = this.baseRef(project, ws.path);
    const ahead = baseRef ? tryGit(ws.path, ["rev-list", "--count", `${baseRef}..HEAD`]) : null;
    if (ahead !== "0") return null;

    const words = text
      .split(/\s+/)
      .map((w) => w.toLowerCase().replace(/[^a-z0-9]+/g, ""))
      .filter(Boolean)
      .slice(0, 6);
    const base = words.join("-").slice(0, 48).replace(/-+$/g, "");
    if (!base) return null;
    let candidate = `${prefix}${base}`;
    for (let n = 2; this.branchExists(ws.path, candidate); n++) candidate = `${prefix}${base}-${n}`;
    if (tryGit(ws.path, ["check-ref-format", "--branch", candidate]) === null) return null;
    try {
      git(ws.path, ["branch", "-m", ws.branch, candidate]);
    } catch {
      return null;
    }
    this.store.markBranchRenamed(ws.id, candidate);
    return candidate;
  }

  private branchExists(cwd: string, branch: string): boolean {
    return tryGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]) !== null;
  }

  private baseRef(project: ProjectRow, cwd: string): string | null {
    for (const ref of [`refs/remotes/origin/${project.defaultBranch}`, `refs/heads/${project.defaultBranch}`]) {
      if (tryGit(cwd, ["rev-parse", "--verify", "--quiet", ref]) !== null)
        return ref.replace(/^refs\/(remotes|heads)\//, "");
    }
    return null;
  }

  /**
   * Archives a workspace: refused while any chat in it works or waits, or the setup still runs; runs the archive
   * script; removes the worktree (refused when dirty unless `force`); the branch is kept.
   */
  async archiveWorkspace(workspaceId: string, options: { force?: boolean } = {}): Promise<WorkspaceRow> {
    const ws = this.requireWorkspace(workspaceId);
    const project = this.store.getProject(ws.projectId)!;
    if (ws.state === "archived") return ws;
    if (ws.state === "setting_up") throw new WorkspaceError("The workspace is still being set up.");
    const busy = this.store.listSessions().filter((s) => s.workspaceId === ws.id && BUSY_STATUSES.has(s.status));
    if (busy.length > 0) {
      throw new WorkspaceError(
        busy.length === 1
          ? "A chat in this workspace is still working or waiting. Stop it first."
          : `${busy.length} chats in this workspace are still working or waiting. Stop them first.`,
      );
    }
    const exists = fs.existsSync(ws.path);
    if (exists && !options.force) {
      // `.context/` is ours and is created empty; everything else counts.
      const dirty = git(ws.path, ["status", "--porcelain", "--untracked-files=all"])
        .split("\n")
        .filter((line) => line && !line.slice(3).startsWith(".context/"));
      if (dirty.length > 0) throw new WorkspaceError("The workspace has uncommitted changes.");
    }
    await this.stopRun(ws.id);
    const script = this.settingsFor(project).effective.archiveScript;
    if (script && exists) {
      const log = new LogBuffer();
      const proc = runScript({
        script,
        cwd: ws.path,
        env: scriptEnv(project, ws, ws.port ?? 0),
        log,
        timeoutMs: this.setupTimeoutMs,
      });
      const result = await proc.done;
      if (result.code !== 0 && !options.force) {
        throw new WorkspaceError(
          `The archive script failed (exit ${result.code ?? result.signal}), so nothing was removed. ${log.tail(300).trim()}`.trim(),
        );
      }
    }
    if (exists) {
      try {
        git(project.rootPath, ["worktree", "remove", "--force", ws.path]);
      } catch (error) {
        throw new WorkspaceError(
          `git worktree remove failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.store.setWorkspaceState(ws.id, "archived");
    return this.store.getWorkspace(ws.id)!;
  }

  /** `.worktreeinclude`: one path per line (comments with #); copies those that exist and stay inside the repo. */
  private copyIncluded(root: string, dest: string, skip?: Set<string>): void {
    const file = path.join(root, ".worktreeinclude");
    if (!fs.existsSync(file)) return;
    for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
      const rel = raw.trim();
      if (!rel || rel.startsWith("#") || skip?.has(path.normalize(rel).replace(/\/+$/, ""))) continue;
      const from = path.resolve(root, rel);
      const to = path.resolve(dest, rel);
      if (!from.startsWith(root + path.sep) || !to.startsWith(dest + path.sep) || !fs.existsSync(from)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true });
    }
  }
}
