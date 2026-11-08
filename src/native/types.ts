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

export interface Resolution {
  decision: "allow" | "deny";
  message?: string;
  /** Answers to an AskUserQuestion, merged into the tool's input. */
  answers?: unknown;
}

/** What a runner reports back to the host. */
export interface RunnerHooks {
  onAgentSessionId(id: string): void;
  /** A message to persist (the SDK / app-server message, verbatim). */
  onMessage(role: "agent" | "system", kind: string, payload: unknown): void;
  /** A partial stream chunk: emitted live, never stored. */
  onDelta(payload: unknown): void;
  onStatus(status: SessionStatus): void;
  /** Resolves when a person answers. */
  onRequest(kind: RequestKind, payload: unknown): Promise<Resolution>;
  onTurnEnd(outcome: "idle" | "error", detail?: string): void;
  /** The process behind the runner is gone (not called after close()). */
  onExit(error?: Error): void;
}

export interface Runner {
  readonly canSteer: boolean;
  send(text: string): Promise<void>;
  /** Add to the running turn. False when there is nothing to steer. */
  steer(text: string): Promise<boolean>;
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
}

export interface MessageRow {
  seq: number;
  sessionId: string;
  role: "user" | "agent" | "system";
  kind: string;
  payload: unknown;
  createdAt: string;
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
  state: "ready" | "archived";
  createdAt: string;
}
