import path from "node:path";

import type { LiveAgentProcess } from "./observers/process-liveness.js";
import type { FleetSession, HookEvent, ObservedSession } from "./types.js";
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
  const stateOwner =
    conductor && transcript
      ? conductor.lastActivityAt >= transcript.lastActivityAt
        ? conductor
        : transcript
      : (conductor ?? transcript);

  return {
    ...base,
    key: base.key,
    agentSessionId: base.agentSessionId ?? conductor?.agentSessionId ?? null,
    conductorSessionId: conductor?.conductorSessionId ?? base.conductorSessionId,
    origin: conductor ? "conductor" : base.origin,
    // Conductor names things better than a transcript's first prompt does.
    title: conductor?.title ?? base.title,
    repoName: conductor?.repoName ?? base.repoName,
    branch: conductor?.branch ?? base.branch,
    cwd: transcript?.cwd ?? base.cwd,
    transcriptPath: transcript?.transcriptPath ?? base.transcriptPath,
    state: stateOwner?.state ?? base.state,
    detail: transcript?.detail ?? conductor?.detail ?? null,
    // Conductor is the only source for these two, so take them from it
    // whichever observer supplied the rest of the identity.
    contextPercent: conductor?.contextPercent ?? base.contextPercent,
    retired: conductor?.retired ?? base.retired,
    baseRef: conductor?.baseRef ?? base.baseRef,
    lastActivityAt,
    pid: null,
    alive: false,
    git: null,
    stateSource: stateOwner?.source === "conductor" ? "conductor" : "transcript",
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
