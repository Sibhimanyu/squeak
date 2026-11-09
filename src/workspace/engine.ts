import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  LOCAL_RUNTIME_ID,
  asSessionId,
  asWorkspaceId,
  type AgentProvider,
  type AgentSession,
  type RuntimeId,
  type SessionId,
  type WorkspaceId,
} from "../core/types.js";
import { nextPortBlock } from "../native/scripts.js";
import { makeRedactor, normalizeSetup, runSetupCommands, splitEnvironment, workspaceEnv } from "./environment.js";
import { runGit } from "./git.js";
import { WorkspaceMetadataStore } from "./metadata-store.js";
import { validateBranchName, workspaceNames } from "./naming.js";
import { isInside, realpathLoose } from "./paths.js";
import { RepositoryResolver, type RepositoryDescriptor } from "./repository.js";
import { ProcessSupervisor, nodeSpawner, type Spawner } from "./supervisor.js";
import {
  DEFAULT_BRANCH_STRATEGY,
  WorkspaceEngineError,
  type AgentStartConfiguration,
  type LaunchPort,
  type ProcessRecord,
  type SqueakProjectRef,
  type WorkspaceConfiguration,
  type WorkspaceFailure,
  type WorkspaceMetadata,
  type WorkspaceState,
} from "./types.js";
import { WorktreeDirtyError, WorktreeManager } from "./worktree.js";

export interface WorkspaceLifecycleEvent {
  type: "state" | "session";
  workspaceId: WorkspaceId;
  state?: WorkspaceState;
  session?: AgentSession;
  at: string;
}

export interface WorkspaceEngineOptions {
  /** Squeak's support directory; workspaces live in `<supportDir>/Workspaces`. */
  supportDir: string;
  launch: LaunchPort;
  runtimeId?: RuntimeId;
  spawner?: Spawner;
  graceMs?: number;
  now?: () => Date;
  newId?: () => string;
  isAlive?: (pid: number) => boolean;
  onEvent?: (event: WorkspaceLifecycleEvent) => void;
}

interface SessionEntry {
  session: AgentSession;
  workspaceId: WorkspaceId;
  stopRequested: boolean;
}

export interface RecoveryReport {
  reconciled: ProcessRecord[];
  /** Still alive but no longer ours to supervise; never signalled, never claimed as reattached. */
  orphaned: ProcessRecord[];
  interruptedWorkspaces: WorkspaceId[];
}

const defaultAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export class WorkspaceEngine {
  readonly workspacesRoot: string;
  readonly store: WorkspaceMetadataStore;
  readonly repositories = new RepositoryResolver();
  readonly worktrees: WorktreeManager;
  readonly supervisor: ProcessSupervisor;
  private readonly sessions = new Map<SessionId, SessionEntry>();
  private readonly secrets = new Map<WorkspaceId, Record<string, string>>();
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly runtimeId: RuntimeId;

  constructor(private readonly options: WorkspaceEngineOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.runtimeId = options.runtimeId ?? LOCAL_RUNTIME_ID;
    this.workspacesRoot = path.join(options.supportDir, "Workspaces");
    fs.mkdirSync(this.workspacesRoot, { recursive: true });
    this.store = new WorkspaceMetadataStore(path.join(options.supportDir, "workspaces.json"));
    this.worktrees = new WorktreeManager({ root: this.workspacesRoot, now: this.now });
    this.supervisor = new ProcessSupervisor({
      spawner: options.spawner ?? nodeSpawner,
      logDir: path.join(options.supportDir, "Logs", "processes"),
      now: this.now,
      ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
      onChange: (record) => this.onProcess(record),
    });
  }

  // ---- create -----------------------------------------------------------------------------------

  async createWorkspace(project: SqueakProjectRef, configuration: WorkspaceConfiguration): Promise<WorkspaceMetadata> {
    const id = asWorkspaceId(this.newId());
    const strategy = configuration.branchStrategy ?? DEFAULT_BRANCH_STRATEGY;
    const sourcePath = path.resolve(configuration.source.path);

    let repo: RepositoryDescriptor | undefined;
    try {
      repo = await this.repositories.resolve(sourcePath);
    } catch (error) {
      const plainDirOk = configuration.source.kind === "existingDirectory" && strategy.kind === "currentBranch";
      if (!(plainDirOk && (error as WorkspaceEngineError).code === "not-a-repository")) throw error;
    }
    if (strategy.kind !== "currentBranch" && !repo) {
      throw new WorkspaceEngineError(
        "A branch strategy other than currentBranch needs a git repository.",
        "not-a-repository",
      );
    }
    if (strategy.kind === "newBranch") await validateBranchName(strategy.name);
    if (strategy.kind === "isolatedWorktree" && strategy.branchName) await validateBranchName(strategy.branchName);

    const { plain, secretRefs } = splitEnvironment(configuration.environment ?? {});
    const secretValues = Object.fromEntries(
      Object.entries(configuration.environment ?? {}).filter(([k]) => secretRefs.includes(k)),
    );
    const createdAt = this.now().toISOString();
    const meta: WorkspaceMetadata = {
      workspaceId: id,
      projectId: project.id,
      projectName: project.name,
      name: configuration.name,
      path: repo?.rootPath ?? sourcePath,
      ...(repo ? { repositoryRoot: repo.rootPath } : {}),
      source: configuration.source,
      ...(configuration.workingDirectory ? { workingDirectory: configuration.workingDirectory } : {}),
      setupCommands: normalizeSetup(configuration.setupCommands),
      environment: plain,
      secretRefs,
      cleanupPolicy: configuration.cleanupPolicy ?? { onArchive: "removeIfClean" },
      state: "creating",
      createdAt,
      updatedAt: createdAt,
      providerMetadata: {},
    };
    this.store.put(meta);
    if (Object.keys(secretValues).length) this.secrets.set(id, secretValues);
    this.log(meta, "engine", `create workspace ${meta.name} (${strategy.kind})`);

    try {
      if (strategy.kind === "currentBranch") {
        if (repo?.currentBranch) meta.branch = repo.currentBranch;
      } else if (strategy.kind === "newBranch" && repo) {
        const exists =
          (await runGit(repo.rootPath, ["show-ref", "--verify", "--quiet", `refs/heads/${strategy.name}`])).code === 0;
        if (exists) throw new WorkspaceEngineError(`Branch ${strategy.name} already exists`, "branch-exists");
        const co = await runGit(repo.rootPath, ["checkout", "-b", strategy.name]);
        if (co.code !== 0)
          throw new WorkspaceEngineError(`git checkout -b failed: ${co.stderr.trim()}`, "branch-failed");
        meta.branch = strategy.name;
        meta.createdBranch = true;
      } else if (strategy.kind === "isolatedWorktree" && repo) {
        const names = workspaceNames(this.workspacesRoot, project.name, configuration.name, id);
        const wt = await this.worktrees.create({
          repository: repo,
          branch: strategy.branchName ?? names.branch,
          destination: names.directory,
        });
        meta.path = wt.path;
        meta.worktreePath = wt.path;
        meta.branch = wt.branch;
        meta.createdBranch = wt.createdBranch;
        this.log(meta, "git", `worktree ${wt.path} on ${wt.branch}${wt.createdBranch ? " (new)" : ""}`);
      }
    } catch (error) {
      this.fail(meta, "create", error);
      throw error;
    }
    this.setState(meta, "preparing");
    return this.store.get(id) as WorkspaceMetadata;
  }

  // ---- prepare ----------------------------------------------------------------------------------

  async prepareWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceMetadata> {
    const meta = this.require(workspaceId);
    if (!["preparing", "setup-failed", "ready"].includes(meta.state)) {
      throw new WorkspaceEngineError(`Cannot prepare a workspace that is ${meta.state}`, "bad-state");
    }
    this.setState(meta, "preparing");
    try {
      if (!fs.existsSync(meta.path) || !fs.statSync(meta.path).isDirectory()) {
        throw new WorkspaceEngineError(`${meta.path} is missing`, "verify-failed");
      }
      if (!meta.portBase) {
        const taken = new Set(this.store.list().flatMap((w) => (w.portBase ? [w.portBase] : [])));
        meta.portBase = nextPortBlock(taken);
      }
      const secrets = this.secrets.get(workspaceId) ?? {};
      const redact = makeRedactor(Object.values(secrets));
      const run = await runSetupCommands({
        workspacePath: meta.path,
        commands: meta.setupCommands,
        env: workspaceEnv(meta, { ...meta.environment, ...secrets }),
        logDir: this.logDir(workspaceId),
        redact,
      });
      meta.setupResults = run.results;
      if (!run.ok) {
        const last = run.results[run.results.length - 1];
        meta.failure = {
          stage: "prepare",
          message: `Setup failed: ${last?.command ?? ""} (${last?.timedOut ? "timed out" : `exit ${last?.exitCode}`})`,
          at: this.iso(),
        };
        this.setState(meta, "setup-failed");
        throw new WorkspaceEngineError(meta.failure.message, "setup-failed");
      }
      delete meta.failure;
      this.setState(meta, "ready");
    } catch (error) {
      if ((error as WorkspaceEngineError).code !== "setup-failed") this.fail(meta, "prepare", error);
      throw error;
    }
    return this.store.get(workspaceId) as WorkspaceMetadata;
  }

  // ---- agents -----------------------------------------------------------------------------------

  async launchAgent(
    workspaceId: WorkspaceId,
    provider: AgentProvider,
    config: AgentStartConfiguration = {},
  ): Promise<AgentSession> {
    const meta = this.require(workspaceId);
    if (!["ready", "stopped", "running"].includes(meta.state)) {
      throw new WorkspaceEngineError(`Cannot launch an agent in a workspace that is ${meta.state}`, "bad-state");
    }
    const before = meta.state;
    this.setState(meta, "launchingAgent");
    try {
      const launch = await this.options.launch(structuredClone(meta), provider, config);
      const d = launch.descriptor;
      const cwd = path.resolve(d.workingDirectory);
      if (realpathLoose(cwd) !== realpathLoose(meta.path) && !isInside(meta.path, cwd)) {
        throw new WorkspaceEngineError(`Launch directory ${cwd} is outside the workspace`, "path-escape");
      }
      const sessionId = asSessionId(this.newId());
      const secrets = this.secrets.get(workspaceId) ?? {};
      const env = { ...workspaceEnv(meta, { ...meta.environment, ...secrets }), ...d.environment };
      const record = this.supervisor.start({
        id: sessionId,
        workspaceId,
        sessionId,
        runtimeId: this.runtimeId,
        provider,
        spec: { executable: d.executable, args: d.arguments, env, cwd, requiresPTY: d.requiresPTY },
      });
      const at = this.iso();
      const session: AgentSession = {
        id: sessionId,
        projectId: meta.projectId,
        workspaceId,
        runtimeId: this.runtimeId,
        provider,
        ...(launch.externalId ? { providerRef: { provider, externalId: launch.externalId } } : {}),
        title: launch.title ?? config.title ?? meta.name,
        state: "starting",
        createdAt: at,
        updatedAt: at,
      };
      this.sessions.set(sessionId, { session, workspaceId, stopRequested: false });
      this.store.putProcess(record);
      this.setState(meta, "running");
      this.options.onEvent?.({ type: "session", workspaceId, session, at });
      return { ...session };
    } catch (error) {
      meta.state = before;
      this.fail(meta, "launch", error, before);
      throw error;
    }
  }

  async stopAgent(sessionId: SessionId): Promise<void> {
    const entry = this.entry(sessionId);
    entry.stopRequested = true;
    const meta = this.require(entry.workspaceId);
    this.setState(meta, "stopping");
    await this.supervisor.stop(sessionId);
    this.settleWorkspace(entry.workspaceId);
  }

  async restartAgent(sessionId: SessionId): Promise<AgentSession> {
    const entry = this.entry(sessionId);
    const meta = this.require(entry.workspaceId);
    entry.stopRequested = true;
    this.setState(meta, "stopping");
    const record = await this.supervisor.restart(sessionId);
    entry.stopRequested = false;
    this.updateSession(entry, "starting");
    this.store.putProcess(record);
    this.setState(this.require(entry.workspaceId), "running");
    return { ...entry.session };
  }

  getSession(sessionId: SessionId): AgentSession | undefined {
    const e = this.sessions.get(sessionId);
    return e ? { ...e.session } : undefined;
  }

  // ---- archive ----------------------------------------------------------------------------------

  /**
   * Stops every agent, then removes the worktree only when nothing would be lost (or `force`, which
   * saves a recovery copy first). The branch is always kept. A dirty worktree is kept and says so.
   */
  async archiveWorkspace(workspaceId: WorkspaceId, options: { force?: boolean } = {}): Promise<WorkspaceMetadata> {
    const meta = this.require(workspaceId);
    for (const [sid, e] of this.sessions) {
      if (e.workspaceId === workspaceId) {
        e.stopRequested = true;
        await this.supervisor.stop(sid);
      }
    }
    if (meta.worktreePath && meta.repositoryRoot && meta.cleanupPolicy.onArchive === "removeIfClean") {
      try {
        const note = await this.worktrees.remove(
          { path: meta.worktreePath, repositoryRoot: meta.repositoryRoot, branch: meta.branch ?? "" },
          { force: options.force ?? false },
        );
        if (note) meta.recoveryNote = note;
        delete meta.keptReason;
      } catch (error) {
        if (error instanceof WorktreeDirtyError) meta.keptReason = "uncommitted or untracked work in the worktree";
        else {
          this.fail(meta, "archive", error, "stopped");
          throw error;
        }
      }
    } else if (meta.worktreePath) {
      meta.keptReason = "cleanup policy keeps the worktree";
    }
    meta.archivedAt = this.iso();
    this.setState(meta, "archived");
    return this.store.get(workspaceId) as WorkspaceMetadata;
  }

  // ---- recovery ---------------------------------------------------------------------------------

  /** Reconciles saved state with what is really running after a Squeak restart. Signals nothing. */
  recover(): RecoveryReport {
    const alive = this.options.isAlive ?? defaultAlive;
    const report: RecoveryReport = { reconciled: [], orphaned: [], interruptedWorkspaces: [] };
    const now = this.iso();
    for (const p of this.store.listProcesses()) {
      if (!["starting", "running", "stopping"].includes(p.state) || this.supervisor.get(p.id)) continue;
      if (p.pid !== undefined && alive(p.pid)) {
        report.orphaned.push(p);
        continue;
      }
      const next: ProcessRecord = { ...p, state: "exited", exitedAt: now };
      this.store.putProcess(next);
      report.reconciled.push(next);
    }
    const orphanWs = new Set(report.orphaned.map((p) => p.workspaceId));
    for (const w of this.store.list()) {
      if (w.state === "creating" || w.state === "preparing") {
        this.fail(w, w.state === "creating" ? "create" : "prepare", new Error("Squeak stopped before this finished"));
        report.interruptedWorkspaces.push(w.workspaceId);
      } else if (["running", "launchingAgent", "stopping"].includes(w.state) && !orphanWs.has(w.workspaceId)) {
        this.setState(w, "stopped");
      }
    }
    return report;
  }

  // ---- internals --------------------------------------------------------------------------------

  private onProcess(record: ProcessRecord): void {
    this.store.putProcess(record);
    const entry = this.sessions.get(record.sessionId);
    if (!entry) return;
    if (record.state === "exited" || record.state === "failed") {
      const next = entry.stopRequested
        ? "stopped"
        : record.state === "exited" && record.exitCode === 0
          ? "completed"
          : "failed";
      this.updateSession(entry, next);
      if (!entry.stopRequested) {
        const meta = this.store.get(entry.workspaceId);
        if (meta && next === "failed") {
          meta.failure = {
            stage: "launch",
            message: `Agent exited unexpectedly (${record.signal ?? `code ${record.exitCode}`})`,
            at: this.iso(),
          };
          this.store.put(meta);
        }
        this.settleWorkspace(entry.workspaceId);
      }
    } else if (record.state === "running") {
      this.updateSession(entry, "working");
    }
  }

  private settleWorkspace(workspaceId: WorkspaceId): void {
    const meta = this.store.get(workspaceId);
    if (!meta || meta.state === "archived") return;
    const stillRunning = this.supervisor
      .list()
      .some(
        (p) =>
          p.workspaceId === workspaceId && (p.state === "running" || p.state === "starting" || p.state === "stopping"),
      );
    this.setState(meta, stillRunning ? "running" : "stopped");
  }

  private updateSession(entry: SessionEntry, state: AgentSession["state"]): void {
    entry.session = { ...entry.session, state, updatedAt: this.iso() };
    this.options.onEvent?.({
      type: "session",
      workspaceId: entry.workspaceId,
      session: { ...entry.session },
      at: entry.session.updatedAt,
    });
  }

  private entry(sessionId: SessionId): SessionEntry {
    const e = this.sessions.get(sessionId);
    if (!e) throw new WorkspaceEngineError(`Unknown session ${sessionId}`, "unknown-session");
    return e;
  }

  private require(id: WorkspaceId): WorkspaceMetadata {
    const m = this.store.get(id);
    if (!m) throw new WorkspaceEngineError(`Unknown workspace ${id}`, "unknown-workspace");
    return m;
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private setState(meta: WorkspaceMetadata, state: WorkspaceState): void {
    meta.state = state;
    meta.updatedAt = this.iso();
    this.store.put(meta);
    this.log(meta, "engine", `state ${state}`);
    this.options.onEvent?.({ type: "state", workspaceId: meta.workspaceId, state, at: meta.updatedAt });
  }

  /**
   * Records a failure. A workspace that never got made ends `failed` with its worktree already rolled
   * back by the manager; an earlier state (launch, archive) is restored, with the failure attached.
   */
  private fail(
    meta: WorkspaceMetadata,
    stage: WorkspaceFailure["stage"],
    error: unknown,
    restore?: WorkspaceState,
  ): void {
    meta.failure = { stage, message: error instanceof Error ? error.message : String(error), at: this.iso() };
    this.setState(meta, restore ?? "failed");
    this.log(meta, "engine", `failure at ${stage}: ${meta.failure.message}`);
  }

  logDir(workspaceId: WorkspaceId): string {
    return path.join(this.options.supportDir, "Logs", "workspaces", workspaceId);
  }

  /** Separate files for engine, git and setup output (setup is written by the runner). */
  private log(meta: WorkspaceMetadata, channel: "engine" | "git", message: string): void {
    try {
      const dir = this.logDir(meta.workspaceId);
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `${channel}.log`), `${this.iso()} ${message}\n`);
    } catch {
      // logs never break the engine
    }
  }

  /** Delete a workspace's record and logs; the workspace itself must be archived first. */
  forget(workspaceId: WorkspaceId): void {
    const meta = this.require(workspaceId);
    if (meta.state !== "archived")
      throw new WorkspaceEngineError("Archive the workspace before forgetting it", "bad-state");
    const logs = this.logDir(workspaceId);
    if (fs.existsSync(logs)) fs.rmSync(logs, { recursive: true, force: true });
    this.store.delete(workspaceId);
  }
}
