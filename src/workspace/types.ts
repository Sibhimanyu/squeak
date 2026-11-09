import type { AgentProvider, ProjectId, RuntimeId, SessionId, WorkspaceId } from "../core/types.js";

export type WorkspaceState =
  | "creating"
  | "preparing"
  | "ready"
  | "launchingAgent"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "setup-failed"
  | "archived";

export type WorkspaceSource = { kind: "existingDirectory"; path: string } | { kind: "gitRepository"; path: string };

export type BranchStrategy =
  | { kind: "currentBranch" }
  | { kind: "newBranch"; name: string }
  | { kind: "isolatedWorktree"; branchName?: string };

export const DEFAULT_BRANCH_STRATEGY: BranchStrategy = { kind: "isolatedWorktree" };

export interface SetupCommand {
  command: string;
  /** Relative to the workspace; must stay inside it. */
  workingDirectory?: string;
  timeoutMs?: number;
  continueOnFailure?: boolean;
}

export interface WorkspaceCleanupPolicy {
  /** `removeIfClean` (default): archive removes the worktree when nothing would be lost. `keep`: never. */
  onArchive: "removeIfClean" | "keep";
}

export interface WorkspaceConfiguration {
  name: string;
  source: WorkspaceSource;
  branchStrategy?: BranchStrategy;
  setupCommands?: (string | SetupCommand)[];
  /** Keys that look secret are never persisted; they stay in memory and are recorded by name only. */
  environment?: Record<string, string>;
  workingDirectory?: string;
  cleanupPolicy?: WorkspaceCleanupPolicy;
}

export interface SqueakProjectRef {
  id: ProjectId;
  name: string;
}

export interface SetupResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  logPath: string;
}

export interface WorkspaceFailure {
  stage: "create" | "prepare" | "launch" | "archive";
  message: string;
  at: string;
}

export interface WorkspaceMetadata {
  workspaceId: WorkspaceId;
  projectId: ProjectId;
  projectName: string;
  name: string;
  /** Where agents run: the worktree, or the source directory for currentBranch/newBranch. */
  path: string;
  repositoryRoot?: string;
  branch?: string;
  worktreePath?: string;
  /** True when Squeak created the branch, so it is the only one it may ever offer to delete. */
  createdBranch?: boolean;
  source: WorkspaceSource;
  workingDirectory?: string;
  setupCommands: SetupCommand[];
  /** Non-secret values only. */
  environment: Record<string, string>;
  /** Names of variables whose values were kept out of this file. */
  secretRefs: string[];
  cleanupPolicy: WorkspaceCleanupPolicy;
  portBase?: number;
  state: WorkspaceState;
  failure?: WorkspaceFailure;
  setupResults?: SetupResult[];
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  /** Set when archive kept the worktree and why. */
  keptReason?: string;
  recoveryNote?: string;
  providerMetadata: Record<string, string>;
}

export type ProcessState = "starting" | "running" | "stopping" | "exited" | "failed";

export interface ProcessRecord {
  id: string;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  runtimeId: RuntimeId;
  provider: AgentProvider;
  pid?: number;
  state: ProcessState;
  executable: string;
  args: string[];
  cwd: string;
  requiresPTY: boolean;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  restarts: number;
}

export interface AgentLaunchDescriptor {
  executable: string;
  arguments: string[];
  environment: Record<string, string>;
  requiresPTY: boolean;
  workingDirectory: string;
  startupTimeoutMs?: number;
}

export interface AgentStartConfiguration {
  prompt?: string;
  model?: string;
  title?: string;
  extra?: Record<string, string>;
}

/** What an adapter's launch port hands back: how to start the process, and what to call the session. */
export interface AgentLaunch {
  descriptor: AgentLaunchDescriptor;
  externalId?: string;
  title?: string;
}

export type LaunchPort = (
  workspace: WorkspaceMetadata,
  provider: AgentProvider,
  config: AgentStartConfiguration,
) => Promise<AgentLaunch>;

export class WorkspaceEngineError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "WorkspaceEngineError";
  }
}
