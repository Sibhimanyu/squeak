import path from "node:path";

import type { LiveAgentProcess } from "./observers/process-liveness.js";
import type { FleetSession, HookEvent, ObservedSession } from "./types.js";
import { isQuestionTool } from "./pending-question.js";
import { stateFromHookEvent } from "./hook-protocol.js";

/**
 * Observers are deliberately ignorant of each other, so the same session can
 * arrive three times: once from Conductor's database, once from the agent's
 * transcript, once implied by a running process. They are joined on the
 * agent's own session id, which Conductor happens to store too.
 */
export function mergeObservations(observations: ObservedSession[]): FleetSession[] {
  const groups = new Map<string, ObservedSession[]>();

  for (const observation of observations) {
    // Fall back to the observer-scoped key so a session with no shared id
    // still appears, just unjoined.
    const groupKey = observation.agentSessionId ?? observation.key;
    const bucket = groups.get(groupKey);
    if (bucket) {
      bucket.push(observation);
    } else {
      groups.set(groupKey, [observation]);
    }
  }

  return Array.from(groups.values()).map((group) => mergeGroup(group));
}

/** See `mergeGroup`: how far behind the transcript a working Conductor status may be and still hold. */
const CONDUCTOR_WORKING_GRACE_MS = 30_000;

function mergeGroup(group: ObservedSession[]): FleetSession {
  const conductor = group.find((entry) => entry.source === "conductor") ?? null;
  const transcript = group.find((entry) => entry.source !== "conductor") ?? null;
  // Prefer the transcript's identity: it is the thing that exists on disk, and
  // it is the only member of the group when the session is not Conductor's.
  const base = transcript ?? conductor;
  if (!base) {
    throw new Error("mergeGroup called with an empty group");
  }

  const lastActivityAt = group
    .map((entry) => entry.lastActivityAt)
    .reduce((latest, candidate) => (candidate > latest ? candidate : latest), base.lastActivityAt);

  // Conductor knows the session's status first-hand; the transcript is
  // inference. Where both exist and Conductor is not behind, Conductor wins.
  // "Behind" allows Conductor a grace window while it says working: when a
  // background task reports in, Claude Code runs a short turn by itself that
  // ends in an ordinary `end_turn`, and Conductor's status write (`waiting`,
  // then `working` again) lands a moment later in whole seconds — so a plain
  // newer-wins let that `end_turn` through as a finish. A status minutes
  // behind the transcript is still stale and still loses.
  //
  // A transcript that has merely gone quiet reads as idle, which is the right
  // guess for a terminal agent whose process may be gone — but Conductor
  // knows its chat is still working, stuck or not, so its word stands.
  const conductorGraceMs = conductor?.state === "working" ? CONDUCTOR_WORKING_GRACE_MS : 0;
  const stateOwner =
    conductor && transcript
      ? Date.parse(conductor.lastActivityAt) + conductorGraceMs >= Date.parse(transcript.lastActivityAt) ||
        (conductor.state === "working" && transcript.state === "idle")
        ? conductor
        : transcript
      : (conductor ?? transcript);

  return {
    ...base,
    key: base.key,
    agentSessionId: base.agentSessionId ?? conductor?.agentSessionId ?? null,
    conductorSessionId: conductor?.conductorSessionId ?? base.conductorSessionId,
    conductorWorkspaceId: conductor?.conductorWorkspaceId ?? base.conductorWorkspaceId ?? null,
    origin: conductor ? "conductor" : base.origin,
    // Conductor names things better than a transcript's first prompt does.
    title: conductor?.title ?? base.title,
    repoName: conductor?.repoName ?? base.repoName,
    branch: conductor?.branch ?? base.branch,
    cwd: transcript?.cwd ?? base.cwd,
    transcriptPath: transcript?.transcriptPath ?? base.transcriptPath,
    state: stateOwner?.state ?? base.state,
    // A pending question's text beats a transcript's "Running <tool>".
    detail:
      stateOwner?.state === "awaiting_input" && stateOwner.detail
        ? stateOwner.detail
        : (transcript?.detail ?? conductor?.detail ?? null),
    // Conductor is the only source for these two, so take them from it
    // whichever observer supplied the rest of the identity.
    contextPercent: conductor?.contextPercent ?? base.contextPercent,
    retired: conductor?.retired ?? base.retired,
    ...optionalFlags(conductor, base),
    baseRef: conductor?.baseRef ?? base.baseRef,
    // Only the transcript observer can ever have this; Conductor does not.
    costUsd: base.costUsd,
    lastActivityAt,
    pid: null,
    alive: false,
    git: null,
    stateSource: stateOwner?.source === "conductor" ? "conductor" : "transcript",
    conductorState: conductor?.state ?? null,
  };
}

/**
 * Apply the most recent hook report for a session.
 *
 * Hooks win over polled state only when they are newer, otherwise a stale
 * "Stop" from the previous turn would keep overwriting a session that has
 * since started working again.
 */
export function applyHookEvents(sessions: FleetSession[], hookEvents: Map<string, HookEvent>): FleetSession[] {
  return sessions.map((session) => {
    const key = session.agentSessionId;
    const event = key ? hookEvents.get(key) : undefined;
    if (!event) {
      return session;
    }

    const state = stateFromHookEvent(event);
    if (!state || event.receivedAt < session.lastActivityAt) {
      return session;
    }
    // Stop fires at the end of every turn, including the ones Claude Code
    // starts by itself as background tasks report in. Conductor, which runs
    // the chat, knows whether it is actually done; a blocked state from a
    // hook is still news and still applies.
    if (state === "finished" && session.conductorState === "working") {
      return session;
    }

    return {
      ...session,
      state,
      detail: event.message ?? describeHook(event.event, event.toolName) ?? session.detail,
      lastActivityAt: event.receivedAt,
      stateSource: "hook",
      cwd: session.cwd ?? event.cwd,
      transcriptPath: session.transcriptPath ?? event.transcriptPath,
    };
  });
}

function describeHook(event: string, toolName: string | null): string | null {
  if (isQuestionTool(toolName)) {
    return null;
  }
  if (event === "PreToolUse" && toolName) {
    return `About to run ${toolName}`;
  }
  return null;
}

/**
 * Attach liveness. A process is matched to a session by working directory,
 * because that is all `ps` and `lsof` can tell us — when two sessions share a
 * cwd, the more recently active one gets the process.
 */
export function applyLiveness(sessions: FleetSession[], processes: LiveAgentProcess[]): FleetSession[] {
  const available = processes.filter((entry) => entry.cwd !== null);
  const taken = new Set<number>();

  const ordered = [...sessions].sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
  const assigned = new Map<string, LiveAgentProcess>();

  for (const session of ordered) {
    if (!session.cwd) {
      continue;
    }
    const normalizedCwd = path.resolve(session.cwd);
    const match = available.find(
      (entry) =>
        !taken.has(entry.pid) && entry.agent === session.agent && path.resolve(entry.cwd ?? "") === normalizedCwd,
    );
    if (match) {
      taken.add(match.pid);
      assigned.set(session.key, match);
    }
  }

  return sessions.map((session) => {
    const match = assigned.get(session.key);
    return match ? { ...session, pid: match.pid, alive: true } : session;
  });
}

/** Conductor's word on a chat's tab and workspace, when it has one; absent otherwise (a transcript cannot say). */
function optionalFlags(
  conductor: ObservedSession | null | undefined,
  base: ObservedSession,
): Pick<ObservedSession, "closed" | "workspaceRetired"> {
  const closed = conductor?.closed ?? base.closed;
  const workspaceRetired = conductor?.workspaceRetired ?? base.workspaceRetired;
  return {
    ...(closed === undefined ? {} : { closed }),
    ...(workspaceRetired === undefined ? {} : { workspaceRetired }),
  };
}
