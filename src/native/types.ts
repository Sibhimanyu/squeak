export type AgentKind = "claude" | "codex";

export type SessionStatus =
  | "idle"
  | "working"
  | "needs_user_permission"
  | "needs_plan_response"
  | "needs_user_input"
  | "cancelling"
  | "error";

export type RequestKind = "tool" | "plan" | "question" | "command" | "file_change";

/** `edits`: file edits inside the chat's workspace (value `workspace`); only the `allowEditsForChat` decision creates one. */
export type AllowRuleKind = "tool" | "bash-exact" | "bash-prefix" | "edits";

export interface AllowRule {
  kind: AllowRuleKind;
  value: string;
}

export interface RuleRow extends AllowRule {
  id: string;
  sessionId: string;
  createdAt: string;
}

export interface Resolution {
  decision: "allow" | "deny";
  /** `session`: also keep an allow rule for this chat (the host derives or validates `rule`). */
  scope?: "session";
  rule?: AllowRule;
  message?: string;
  /** Answers to an AskUserQuestion, merged into the tool's input. */
  answers?: unknown;
}

/** What a client may answer a request with: `allowEditsForChat` = allow this and keep a rule for edits inside the workspace. */
export type ResponseDecision = Resolution["decision"] | "allowEditsForChat";

/** What a runner reports back to the host. */
export interface RunnerHooks {
  onAgentSessionId(id: string): void;
  /** A message to persist (the SDK / app-server message, verbatim). */
  onMessage(role: "agent" | "system", kind: string, payload: unknown): void;
  /** A partial stream chunk: emitted live, never stored. */
  onDelta(payload: unknown): void;
  onStatus(status: SessionStatus): void;
  /** True (and logged) when a rule of this chat already allows the request: ask nobody. */
  tryAutoAllow?(kind: RequestKind, payload: unknown): boolean;
  /** Resolves when a person answers. */
  onRequest(kind: RequestKind, payload: unknown): Promise<Resolution>;
  onTurnEnd(outcome: "idle" | "error", detail?: string): void;
  /** How many background tasks (async subagents, background shells) are alive; the chat stays working while > 0. */
  onBackground?(count: number): void;
  /** The process behind the runner is gone (not called after close()). */
  onExit(error?: Error): void;
}

/** The process exited before it started, while it was meant to resume an agent session. */
export class ResumeFailedError extends Error {
  constructor(detail?: string) {
    super(detail ? `Resume failed: ${detail}` : "Resume failed");
    this.name = "ResumeFailedError";
  }
}

export interface Runner {
  readonly canSteer: boolean;
  /** `after`: the turn's start snapshot; the agent is started in parallel but must not see the message before it. */
  send(text: string, options?: { after?: Promise<void> }): Promise<void>;
  /** Add to the running turn. False when there is nothing to steer. */
  steer(text: string): Promise<boolean>;
  /** Start the agent process now, before any message (optional: Claude only). */
  warm?(): Promise<void>;
  interrupt(): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  /** Switch model (and effort) for the turns that follow; a running turn is untouched. */
  setModel?(model: string, effort?: string | null): Promise<void>;
  close(): Promise<void>;
}

export interface SessionRow {
  id: string;
  workspaceId: string | null;
  cwd: string;
  agent: AgentKind;
  agentSessionId: string | null;
  title: string | null;
  model: string;
  effort: string | null;
  permissionMode: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  lastTurnEndedAt: string | null;
  prunedThrough: number;
  /** Background work the agent still has running (added by the host; absent when none). */
  background?: { count: number };
}

export interface MessageRow {
  seq: number;
  sessionId: string;
  role: "user" | "agent" | "system";
  kind: string;
  payload: unknown;
  createdAt: string;
  /** Who wrote a user message that came from someone else through a pond; absent for the owner's own. */
  author?: MessageAuthor;
}

export interface MessageAuthor {
  id: string;
  name: string;
}

export interface RequestRow {
  id: string;
  sessionId: string;
  kind: RequestKind;
  payload: unknown;
  createdAt: string;
  resolvedAt: string | null;
  resolution: Resolution | null;
}

export interface QueueRow {
  id: string;
  sessionId: string;
  text: string;
  createdAt: string;
  /** A pond member's message waiting its turn keeps its author. */
  author?: MessageAuthor;
}

export interface ProjectRow {
  id: string;
  name: string;
  rootPath: string;
  defaultBranch: string;
  createdAt: string;
}

export interface WorkspaceRow {
  id: string;
  projectId: string;
  name: string;
  path: string;
  branch: string;
  state: WorkspaceState;
  /** First of a block of ten ports reserved for this workspace's scripts (SQUEAK_PORT). */
  port: number | null;
  createdAt: string;
  /** What the stream is called on screen ("Detached HEAD Duck"); a prettified `name` when it never had one. */
  title: string;
}

export type WorkspaceState = "setting_up" | "ready" | "setup_failed" | "archived";

export type MergeMethod = "squash" | "merge" | "rebase";

export const GIT_ACTIONS = [
  "create-pr",
  "commit-push",
  "fix-errors",
  "resolve-conflicts",
  "review",
  "pull-latest",
  "changelog",
] as const;
export type GitAction = (typeof GIT_ACTIONS)[number];

/** What a project stores itself; null/absent means "use the default" (or conductor.json for scripts). */
export interface ProjectSettingsRow {
  projectId: string;
  setupScript: string | null;
  runScript: string | null;
  archiveScript: string | null;
  branchPrefix: string | null;
  mergeMethod: MergeMethod | null;
  /** A model for Review: when set, the review runs in a new chat with it. */
  reviewModel: string | null;
  reviewEffort: string | null;
  prompts: Partial<Record<GitAction, string>>;
}

/** One user message and the agent's work on it; the checkpoints are commit ids under refs/squeak-checkpoints. */
export interface TurnRow {
  sessionId: string;
  n: number;
  text: string;
  startSeq: number;
  endSeq: number | null;
  startCommit: string | null;
  endCommit: string | null;
  createdAt: string;
}
