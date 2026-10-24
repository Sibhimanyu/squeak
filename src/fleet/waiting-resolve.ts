import type { BackgroundTask } from "./background-work.js";
import type { FleetSession } from "./types.js";

/** A shell must have run this long before a quiet chat counts as finished: a fresh `npm serve` is still being set up. */
export const SHELL_SETTLED_MS = 60_000;

/**
 * Conductor says `waiting` while a chat's turn has ended but background work is alive, and the merge reads it as
 * working. That is right for a fan-out of subagents (each report starts a short turn of its own), and wrong for a
 * chat that finished and left a dev server running. So a `waiting` chat is finished when the transcript says its last
 * turn ended, no subagent runs, and at least one background shell has run past `SHELL_SETTLED_MS`; anything else
 * (no transcript, no task found, a subagent, a fresh shell) stays as it was.
 */
export function resolveWaiting(session: FleetSession, tasks: BackgroundTask[], nowMs: number): FleetSession {
  if (!session.conductorWaiting || session.state !== "working") {
    return session;
  }
  const ended = session.transcriptState === "finished" || session.transcriptState === "idle";
  const running = tasks.filter((task) => task.status === "running");
  const shells = running.filter((task) => task.kind === "shell");
  if (!ended || shells.length === 0 || running.some((task) => task.kind === "agent")) {
    return session;
  }
  const newest = Math.max(...shells.map((task) => (task.startedAt ? Date.parse(task.startedAt) : Number.NaN)));
  if (!Number.isFinite(newest) || nowMs - newest <= SHELL_SETTLED_MS) {
    return session;
  }
  return {
    ...session,
    state: session.transcriptState === "finished" ? "finished" : "idle",
    stateSource: "transcript",
    conductorState: null,
  };
}
