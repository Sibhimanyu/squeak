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

/**
 * A Squeak-run Claude chat whose turn ended while background work it started is still alive (an async subagent,
 * or a shell that began within `SHELL_SETTLED_MS`) is not done: each report starts a short turn of its own. It
 * stays `working` (`conductorState` keeps a Stop hook and the finish push from calling it finished) and carries
 * `backgroundTasks`, the count the Mac says as "Waiting for N background tasks". An old shell (a dev server left
 * up) does not count, as for Conductor.
 */
export function holdNativeWorking(session: FleetSession, tasks: BackgroundTask[], nowMs: number): FleetSession {
  if (session.origin !== "squeak" || (session.state !== "finished" && session.state !== "idle")) {
    return session;
  }
  const holding = tasks.filter((task) => {
    if (task.status !== "running") return false;
    if (task.kind === "agent") return true;
    const started = task.startedAt ? Date.parse(task.startedAt) : Number.NaN;
    return Number.isFinite(started) && nowMs - started <= SHELL_SETTLED_MS;
  });
  if (holding.length === 0) return session;
  return {
    ...session,
    state: "working",
    stateSource: "squeak",
    conductorState: "working",
    backgroundTasks: holding.length,
  };
}
