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

import type { GitState } from "./git-state.js";
import type { WorkflowStatus } from "../workflows/types.js";

export type AgentKind = "claude" | "codex";

/**
 * Who started the session. Decides which actions we can offer for it.
 *
 * Only `mergeObservations` assigns `conductor`, and only when a Conductor row
 * joins: a transcript can say it was driven through an SDK (`sdk`), but so
 * are Superset's, gstack's and every other harness's, so it cannot say whose.
 */
export type SessionOrigin = "conductor" | "terminal" | "ide" | "desktop" | "cowork" | "sdk" | "unknown";

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
 * Wants a person right now: blocked, or finished on a question put to them
 * ("Want me to open a PR?"). The one rule every surface counts "needs you" by,
 * so the duck, the radar, the Mac app and the phone cannot disagree. A session
 * that asks stays `finished`, so replying to it is allowed (a blocked Conductor
 * chat refuses one); only the word and the colour say it is waiting.
 */
export function needsYou(session: Pick<FleetSession, "state" | "asks">): boolean {
  return isBlockedState(session.state) || (session.state === "finished" && Boolean(session.asks));
}

/**
 * A session as one observer sees it. Observers never merge with each other;
 * the monitor does that, so each observer stays independently testable.
 */
export interface ObservedSession {
  /** Stable across polls. `${source}:${sourceId}`. */
  key: string;
  source: "conductor" | "claude-transcript" | "claude-cowork" | "codex-rollout";
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
  /** Conductor's workspace for the chat, which is what its sidebar links by. */
  conductorWorkspaceId?: string | null;
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
  /**
   * The chat's own tab is closed in Conductor (`is_hidden`). Only Conductor reports it; a transcript
   * cannot, so it is undefined for anything Conductor does not hold. A closed chat is also `retired`.
   */
  closed?: boolean;
  /**
   * The workspace is archived, done or canceled: `retired` without counting a closed chat, so the phone
   * can still list a chat whose tab was closed in a workspace that lives on.
   */
  workspaceRetired?: boolean;
  /**
   * Branch to measure unpushed work against when the session's branch has no
   * upstream, which is the normal state of a fresh Conductor branch.
   */
  baseRef: string | null;
  /**
   * What this session has cost so far, when the agent reports it locally.
   * Only Claude Code does — Codex's spend shows up as account-wide quota
   * instead, in FleetSnapshot.codexUsage, not per session.
   */
  costUsd: number | null;
  /**
   * What the turn is waiting on, per the transcript's last entry (Claude
   * only): a running tool, the model, or an API retry; null once it ended.
   * Waited since `lastActivityAt` of the transcript observation.
   */
  waitingOn?: "model" | "api" | "tool" | null;
  /** Conductor says `waiting`: the turn ended, background work it started is alive. Still `working` by default. */
  conductorWaiting?: boolean;
  /** When the transcript's last entry was written, which `waitingOn` has waited since. */
  waitingSince?: string | null;
  /**
   * The model the chat runs, as a display name ("Opus 5.5 · 1M"). Only Conductor's own row says; a
   * transcript's model is not read, so it is absent for terminal agents.
   */
  model?: string | null;
  /** The thinking level in words ("Medium", "Extra high"), when Conductor stores one for the chat's model. */
  effort?: string | null;
  /** Fast mode is on for the chat. Absent when off or unknown. */
  fast?: boolean;
  /**
   * The same as Conductor stores it (`opus-5-5-1m`, `high`), for a picker that changes it; absent when
   * Conductor stores no model for the chat.
   */
  modelId?: string;
  effortId?: string;
}

/** A session after the monitor has merged observers, hooks, and liveness. */
export interface FleetSession extends ObservedSession {
  pid: number | null;
  alive: boolean;
  /** What the working tree actually looks like. Read lazily, so often null. */
  git: GitState | null;
  /** Set when a hook told us the state rather than us inferring it. */
  stateSource: "hook" | "transcript" | "conductor";
  /**
   * What Conductor's own row says, for a session it runs; null otherwise.
   * While it says working, nothing else may call the turn finished.
   */
  conductorState?: FleetState | null;
  /** The transcript's own state, kept only for a `conductorWaiting` chat (see `resolveWaiting`). */
  transcriptState?: FleetState;
  /**
   * Set when the session is directing a product that is waiting on the
   * human for one of its own calls (src/workflows/: RasanAI's pick a
   * story, pick a look…). The state is then `awaiting_input`.
   */
  workflow?: WorkflowStatus | null;
  /**
   * Set only while the session is `finished` and its last message closes on a question put to the person
   * ("Want me to open a PR?"): that question, clipped. The agent is waiting on an answer, so every surface
   * treats it as needing you. Gone as soon as a new turn starts, because the state leaves `finished`.
   */
  asks?: string | null;
}

export type AttentionKind =
  | "blocked_approval"
  | "blocked_question"
  /** The turn ended on a question for the person: finished, but waiting on an answer. */
  | "asked_question"
  /** Working, but the model has not answered for far longer than it ever takes. */
  | "stalled"
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
