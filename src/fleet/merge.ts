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
  // A chat Squeak's own host runs: its row is first-hand like Conductor's, and its key is the one a reply is
  // addressed to, so it is the base whenever it is there.
  const native = group.find((entry) => entry.source === "squeak-native") ?? null;
  // A chat imported from Conductor keeps its agent session id, so the old Conductor row joins the group. A
  // native session never takes Conductor's ids, reply route or fields, picked workspace or not: the Conductor
  // row is folded away and the native one is the single visible session.
  const conductor = native ? null : (group.find((entry) => entry.source === "conductor") ?? null);
  const transcript = group.find((entry) => entry.source !== "conductor" && entry.source !== "squeak-native") ?? null;
  // Prefer the transcript's identity: it is the thing that exists on disk, and
  // it is the only member of the group when the session is not Conductor's.
  const base = native ?? transcript ?? conductor;
  if (!base) {
    throw new Error("mergeGroup called with an empty group");
  }

  const lastActivityAt = group
    .filter((entry) => !(native && entry.source === "conductor"))
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
  const stateOwner = native
    ? native
    : conductor && transcript
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
    origin: native ? "squeak" : conductor ? "conductor" : base.origin,
    // Conductor names things better than a transcript's first prompt does.
    title: native?.title ?? conductor?.title ?? base.title,
    repoName: native?.repoName ?? conductor?.repoName ?? base.repoName,
    ...(native?.projectId ? { projectId: native.projectId } : {}),
    ...(native?.workspaceTitle ? { workspaceTitle: native.workspaceTitle } : {}),
    branch: native?.branch ?? conductor?.branch ?? base.branch,
    cwd: native?.cwd ?? transcript?.cwd ?? base.cwd,
    ...(conductor?.cwd ? { workspaceRoot: conductor.cwd } : {}),
    transcriptPath: transcript?.transcriptPath ?? native?.transcriptPath ?? base.transcriptPath,
    state: stateOwner?.state ?? base.state,
    // A pending question's text beats a transcript's "Running <tool>".
    detail:
      (native && native.state === "awaiting_approval" && native.detail) ||
      (stateOwner?.state === "awaiting_input" && stateOwner.detail ? stateOwner.detail : null) ||
      (transcript?.detail ?? conductor?.detail ?? null),
    // Conductor is the only source for these two, so take them from it
    // whichever observer supplied the rest of the identity.
    contextPercent: conductor?.contextPercent ?? base.contextPercent,
    retired: native?.retired ?? conductor?.retired ?? base.retired,
    ...optionalFlags(conductor, base),
    // Only Conductor's row names the model and its level.
    ...(conductor?.model ? { model: conductor.model } : {}),
    ...(conductor?.effort ? { effort: conductor.effort } : {}),
    ...(conductor?.fast ? { fast: true } : {}),
    ...(conductor?.modelId ? { modelId: conductor.modelId } : {}),
    ...(conductor?.effortId ? { effortId: conductor.effortId } : {}),
    baseRef: native?.baseRef ?? conductor?.baseRef ?? base.baseRef,
    // Only the transcript observer can ever have this; Conductor does not.
    costUsd: base.costUsd ?? transcript?.costUsd ?? null,
    // A native chat's own row has none of these; they are the transcript's.
    ...(native && transcript?.waitingOn !== undefined ? { waitingOn: transcript.waitingOn } : {}),
    ...(native && transcript?.waitingSince !== undefined ? { waitingSince: transcript.waitingSince } : {}),
    lastActivityAt,
    pid: null,
    alive: false,
    git: null,
    stateSource:
      stateOwner?.source === "squeak-native"
        ? "squeak"
        : stateOwner?.source === "conductor"
          ? "conductor"
          : "transcript",
    ...(native?.nativeRequest ? { nativeRequest: native.nativeRequest } : {}),
    conductorState: conductor?.state ?? null,
    ...(conductor?.conductorWaiting ? { conductorWaiting: true } : {}),
    ...(conductor?.conductorWaiting && transcript ? { transcriptState: transcript.state } : {}),
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
    // A native chat's own row is the authority on its status; a hook (its Stop fires between queued turns)
    // must not overrule it.
    if (session.stateSource === "squeak") {
      return session;
    }
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

  // A Claude process names its session in its pid file: that match is exact, and holds after the agent `cd`s.
  for (const session of ordered) {
    const match = session.agentSessionId
      ? available.find(
          (entry) =>
            !taken.has(entry.pid) && entry.agent === session.agent && entry.sessionId === session.agentSessionId,
        )
      : undefined;
    if (match) {
      taken.add(match.pid);
      assigned.set(session.key, match);
    }
  }
  for (const session of ordered) {
    if (!session.cwd || assigned.has(session.key)) {
      continue;
    }
    const normalizedCwd = path.resolve(session.cwd);
    const match = available.find(
      (entry) =>
        !taken.has(entry.pid) &&
        entry.agent === session.agent &&
        // A process that names another session is that one's, whatever folder it shares.
        (entry.sessionId === undefined || entry.sessionId === session.agentSessionId) &&
        path.resolve(entry.cwd ?? "") === normalizedCwd,
    );
    if (match) {
      taken.add(match.pid);
      assigned.set(session.key, match);
    }
  }

  return sessions.map((session) => {
    const match = assigned.get(session.key);
    if (!match) {
      return session;
    }
    return { ...applyClaudeStatus(session, match), pid: match.pid, alive: true };
  });
}

/**
 * A terminal Claude session's own pid file says idle or busy first-hand (verified against the process's start, so
 * a reused pid never speaks for it), which beats inferring it from the transcript. It only settles the
 * working/idle question: a blocked or errored state is hook news, and a Conductor or Squeak chat has its own referee.
 */
function applyClaudeStatus(session: FleetSession, match: LiveAgentProcess): FleetSession {
  if (session.agent !== "claude" || session.origin !== "terminal" || !match.claudeStatus) {
    return session;
  }
  if (match.claudeStatus === "idle" && session.state === "working") {
    return { ...session, state: "idle", waitingOn: null };
  }
  if (match.claudeStatus === "busy" && (session.state === "idle" || session.state === "finished")) {
    return { ...session, state: "working" };
  }
  return session;
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
