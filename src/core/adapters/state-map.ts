import type { AgentState } from "../state.js";
import {
  asProjectId,
  asSessionId,
  LOCAL_RUNTIME_ID,
  type AgentProvider,
  type AgentSession,
  type ProjectId,
} from "../types.js";
import { projectIdFor } from "../repository.js";
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

/**
 * Fleet session to core session. The id is the fleet key (stable, and what
 * the repliers resolve). Lossy: the fleet has no creation time, so
 * `createdAt` is the last activity; and it has no remote URL or git root, so
 * two worktrees of one repo get two projects rather than risking a merge.
 */
export function toAgentSession(session: FleetSession): AgentSession {
  const provider = providerFor(session);
  return {
    id: asSessionId(session.key),
    projectId: projectIdForSession(session),
    runtimeId: LOCAL_RUNTIME_ID,
    provider,
    ...(session.agentSessionId ? { providerRef: { provider, externalId: session.agentSessionId } } : {}),
    title: session.title ?? session.repoName ?? session.key,
    state: mapSessionState(session),
    createdAt: session.lastActivityAt,
    updatedAt: session.lastActivityAt,
  };
}
