/**
 * The fleet model: one normalized view of every coding agent session on this
 * Mac, regardless of who launched it.
 *
 * The bridge used to only know about sessions Conductor spawned, because those
 * were the only ones it had a pipe to. A session started by hand in a terminal
 * was invisible even though its transcript sits on the same disk. The fleet
 * layer reads those transcripts, so "what is running right now" stops being a
 * question only Conductor can answer.
 */

export type AgentKind = "claude" | "codex";

/** Who started the session. Decides which actions we can offer for it. */
export type SessionOrigin = "conductor" | "terminal" | "ide" | "unknown";

export type FleetState =
  /** A turn is in flight. */
  | "working"
  /** Blocked: the agent asked permission to run something. */
  | "awaiting_approval"
  /** Blocked: the agent asked the human a question. */
  | "awaiting_input"
  /** The turn ended cleanly and nobody has looked at it yet. */
  | "finished"
  /** The turn ended badly. */
  | "error"
  /** Alive but nothing has happened for a while. */
  | "idle";

export const BLOCKED_STATES: ReadonlySet<FleetState> = new Set<FleetState>(["awaiting_approval", "awaiting_input"]);

export function isBlockedState(state: FleetState): boolean {
  return BLOCKED_STATES.has(state);
}

/**
 * A session as one observer sees it. Observers never merge with each other;
 * the monitor does that, so each observer stays independently testable.
 */
export interface ObservedSession {
  /** Stable across polls. `${source}:${sourceId}`. */
  key: string;
  source: "conductor" | "claude-transcript" | "codex-rollout";
  agent: AgentKind;
  origin: SessionOrigin;
  /** Identifier within the observer's own namespace. */
  sourceId: string;
  /**
   * The agent's own session id. Conductor stores the same value, so this is
   * what lets a transcript-discovered session and a Conductor row be
   * recognised as one session — and how a hook event finds its way back.
   */
  agentSessionId: string | null;
  conductorSessionId: string | null;
  cwd: string | null;
  repoName: string | null;
  branch: string | null;
  title: string | null;
  state: FleetState;
  /** Human-readable "what is it doing / waiting on", shown on the card. */
  detail: string | null;
  lastActivityAt: string;
  transcriptPath: string | null;
  /**
   * Share of the context window consumed, 0-100. Only Conductor reports this;
   * a transcript cannot tell you how close a session is to compacting.
   */
  contextPercent: number | null;
  /**
   * The workspace has been marked done, canceled, or archived. Such a session
   * should not keep asking to be reviewed.
   */
  retired: boolean;
}

/** A session after the monitor has merged observers, hooks, and liveness. */
export interface FleetSession extends ObservedSession {
  pid: number | null;
  alive: boolean;
  /** Set when a hook told us the state rather than us inferring it. */
  stateSource: "hook" | "transcript" | "conductor";
}

export type AttentionKind =
  | "blocked_approval"
  | "blocked_question"
  | "errored"
  | "finished_unreviewed"
  | "context_pressure";

export interface AttentionItem {
  session: FleetSession;
  kind: AttentionKind;
  /** Higher wins. Drives radar ordering and which card gets pushed first. */
  score: number;
  /** When the session entered the state that needs attention. */
  since: string;
}

/** A normalized hook callback, whatever agent it came from. */
export interface HookEvent {
  agent: AgentKind;
  event: string;
  sessionId: string | null;
  cwd: string | null;
  transcriptPath: string | null;
  message: string | null;
  toolName: string | null;
  receivedAt: string;
}
