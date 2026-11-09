import type { AgentState } from "../state.js";
import {
  asProjectId,
  asSessionId,
  LOCAL_RUNTIME_ID,
  type AgentAttention,
  type AgentProvider,
  type AgentSession,
  type ProjectId,
} from "../types.js";
import { projectIdFor } from "../repository.js";
import { isStalled } from "../../fleet/attention.js";
import type { AttentionKind, FleetSession, FleetState } from "../../fleet/types.js";

/** Where sessions with no repository path land. Never merged with a real project. */
export const IMPORTED_PROJECT_ID: ProjectId = asProjectId("imported-sessions");

/** The explicit table: every fleet state and what core calls it. */
export const FLEET_STATE_TABLE: Readonly<Record<FleetState, AgentState>> = {
  working: "working",
  awaiting_approval: "waitingForPermission",
  awaiting_input: "waitingForInput",
  finished: "completed",
  error: "failed",
  idle: "idle",
};

/** Same for the attention kinds the fleet classifies; `context_pressure` says nothing about state. */
export const ATTENTION_STATE_TABLE: Readonly<Record<AttentionKind, AgentState>> = {
  blocked_approval: "waitingForPermission",
  blocked_question: "waitingForInput",
  asked_question: "waitingForInput",
  stalled: "working",
  errored: "failed",
  finished_unreviewed: "completed",
  context_pressure: "idle",
};

/** Unknown (a state a newer daemon adds) maps to `idle`. */
export function mapFleetState(state: string): AgentState {
  return Object.hasOwn(FLEET_STATE_TABLE, state) ? FLEET_STATE_TABLE[state as FleetState] : "idle";
}

export function mapAttentionKind(kind: string): AgentState {
  return Object.hasOwn(ATTENTION_STATE_TABLE, kind) ? ATTENTION_STATE_TABLE[kind as AttentionKind] : "idle";
}

/**
 * The core state of a fleet session. A `finished` session whose last message
 * closes on a question (`asks`) is waiting on the person, as every surface
 * already treats it. Lossy: `stalled` and `stalled`-style flags are not in
 * `state`, so a stuck working session still reads `working`.
 */
export function mapSessionState(session: Pick<FleetSession, "state" | "asks">): AgentState {
  if (session.state === "finished" && session.asks) return "waitingForInput";
  return mapFleetState(session.state);
}

/** Conductor-joined sessions are Conductor's; everything else follows its agent. */
export function providerFor(session: Pick<FleetSession, "conductorSessionId" | "agent">): AgentProvider {
  if (session.conductorSessionId) return "conductor";
  return session.agent === "codex" ? "codex" : "claudeCode";
}

/** The repo's own folder when known; otherwise the fixed imported project. */
export function projectIdForSession(session: Pick<FleetSession, "workspaceRoot" | "cwd">): ProjectId {
  const localPath = session.workspaceRoot || session.cwd;
  return localPath ? projectIdFor({ localPath }) : IMPORTED_PROJECT_ID;
}

/** What the radar computes across sessions, which one session cannot know alone. */
export interface AttentionContext {
  /** `distinctTitles(active)` for the whole set; a missing key means no collision. */
  distinctTitles?: ReadonlyMap<string, string | null>;
  /** Attention kinds per session key, from the snapshot's attention list. */
  kinds?: ReadonlyMap<string, readonly string[]>;
  nowMs: number;
}

/**
 * The attention summary. A stalled session keeps `working` with `stalled` set; context pressure keeps its
 * real state and carries `contextPercent`. The title rule stays in radar's `distinctTitles`.
 */
export function toAttention(session: FleetSession, context: AttentionContext): AgentAttention {
  const attention: AgentAttention = {
    asks: [...(context.kinds?.get(session.key) ?? [])],
    stalled: isStalled(session, context.nowMs),
    displayTitle: context.distinctTitles?.get(session.key) ?? baseTitle(session),
    lastActivityAt: session.lastActivityAt,
  };
  if (session.asks) attention.question = session.asks;
  if (typeof session.contextPercent === "number") attention.contextPercent = session.contextPercent;
  return attention;
}

function baseTitle(session: FleetSession): string {
  return session.title ?? session.repoName ?? session.key;
}

/**
 * Fleet session to core session. The id is the fleet key (stable, and what
 * the repliers resolve). Lossy: the fleet has no creation time, so
 * `createdAt` is the last activity; and it has no remote URL or git root, so
 * two worktrees of one repo get two projects rather than risking a merge.
 */
export function toAgentSession(session: FleetSession, context?: AttentionContext): AgentSession {
  const provider = providerFor(session);
  return {
    id: asSessionId(session.key),
    projectId: projectIdForSession(session),
    runtimeId: LOCAL_RUNTIME_ID,
    provider,
    ...(session.agentSessionId ? { providerRef: { provider, externalId: session.agentSessionId } } : {}),
    title: baseTitle(session),
    state: mapSessionState(session),
    ...(context ? { attention: toAttention(session, context) } : {}),
    createdAt: session.lastActivityAt,
    updatedAt: session.lastActivityAt,
  };
}
