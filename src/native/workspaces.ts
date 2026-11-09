import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveSettings, type ResolvedSettings } from "./project-settings.js";
import { freePortBlock, LogBuffer, nextPortBlock, runScript, scriptEnv, type RunningScript } from "./scripts.js";
import type { NativeStore } from "./store.js";
import type { ProjectRow, SessionRow, SessionStatus, WorkspaceRow } from "./types.js";

/** Squeak's duck theme: workspace names, in the order they are handed out. */
export const BIRD_NAMES = [
  "mallard",
  "teal",
  "wigeon",
  "pintail",
  "gadwall",
  "shoveler",
  "pochard",
  "goldeneye",
  "bufflehead",
  "scaup",
  "eider",
  "merganser",
  "smew",
  "garganey",
  "canvasback",
  "redhead",
  "scoter",
  "mandarin",
  "wood-duck",
  "ruddy",
];

export class WorkspaceError extends Error {}

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
}

const BUSY_STATUSES = new Set<SessionStatus>([
  "working",
  "cancelling",
  "needs_user_permission",
  "needs_plan_response",
  "needs_user_input",
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

  /** Stops every run script and any setup still going (the host is shutting down). */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const procs = [...this.runs.values(), ...this.setups.values()].map((x) => x.proc).filter((p) => p !== null);
    await Promise.all(procs.map((p) => p!.kill(this.killGraceMs)));
  }

  addProject(rootPath: string): ProjectRow {
    const top = tryGit(rootPath, ["rev-parse", "--show-toplevel"]);
    if (!top) throw new WorkspaceError("That folder is not a git repository.");
    const root = fs.realpathSync(top);
    const existing = this.store.getProjectByRoot(root);
    if (existing) return existing;
    const origin = tryGit(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const defaultBranch =
      (origin ? origin.replace(/^origin\//, "") : null) ||
      tryGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]) ||
      "main";
    return this.store.createProject({ name: path.basename(root), rootPath: root, defaultBranch });
  }

  createWorkspace(projectId: string): WorkspaceRow {
    const project = this.store.getProject(projectId);
    if (!project) throw new WorkspaceError("No such project.");
    const resolved = this.settingsFor(project);
    const name = this.pickName(project);
    const workspacePath = path.join(this.workspacesRoot, project.name, name);
    const branch = `${resolved.effective.branchPrefix}${name}`;
    const hasOrigin = tryGit(project.rootPath, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${project.defaultBranch}`,
    ]);
    const base = hasOrigin ? `origin/${project.defaultBranch}` : project.defaultBranch;

    fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
    try {
      git(project.rootPath, ["worktree", "add", workspacePath, "-b", branch, base]);
    } catch (error) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
      throw new WorkspaceError(`git worktree add failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.copyIncluded(project.rootPath, workspacePath);
    fs.mkdirSync(path.join(workspacePath, ".context"), { recursive: true });
    const hasSetup = Boolean(resolved.effective.setupScript);
    const ws = this.store.createWorkspace({
      projectId,
      name,
      path: workspacePath,
      branch,
      state: hasSetup ? "setting_up" : "ready",
      port: nextPortBlock(new Set(this.store.usedPorts())),
    });
    if (hasSetup) {
      // Registered before returning, so the first message sees the gate and a log read finds the buffer.
      this.setups.set(ws.id, { log: new LogBuffer(), proc: null });
      void this.runSetup(ws, project, resolved.effective.setupScript!);
    }
    return ws;
  }

  private async runSetup(ws: WorkspaceRow, project: ProjectRow, script: string): Promise<void> {
    const entry = this.setups.get(ws.id)!;
    let failure: string | null = null;
    try {
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
   * After a new workspace's first user message: `<prefix>/<bird>` becomes `<prefix>/<first words>`, no model call.
   * Only while the branch is still the bird name, has no upstream and no commits beyond the base; one try per workspace.
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
   * Conductor's archive: refused while any chat in it works or waits, or the setup still runs; runs the archive
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

  private pickName(project: ProjectRow): string {
    const used = new Set(this.store.listWorkspaces(project.id).map((w) => w.name));
    const taken = (n: string): boolean => used.has(n) || fs.existsSync(path.join(this.workspacesRoot, project.name, n));
    for (const bird of BIRD_NAMES) if (!taken(bird)) return bird;
    for (let n = 2; ; n++) {
      for (const bird of BIRD_NAMES) if (!taken(`${bird}-${n}`)) return `${bird}-${n}`;
    }
  }

  /** `.worktreeinclude`: one path per line (comments with #); copies those that exist and stay inside the repo. */
  private copyIncluded(root: string, dest: string): void {
    const file = path.join(root, ".worktreeinclude");
    if (!fs.existsSync(file)) return;
    for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
      const rel = raw.trim();
      if (!rel || rel.startsWith("#")) continue;
      const from = path.resolve(root, rel);
      const to = path.resolve(dest, rel);
      if (!from.startsWith(root + path.sep) || !to.startsWith(dest + path.sep) || !fs.existsSync(from)) continue;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.cpSync(from, to, { recursive: true });
    }
  }
}
