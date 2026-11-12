import type { BackgroundTask } from "./background-work.js";
import type { FleetSession } from "./types.js";

/** A shell must have run this long before a quiet chat counts as finished: a fresh `npm serve` is still being set up. */
const SHELL_SETTLED_MS = 60_000;

/**
 * A Squeak-run Claude chat whose turn ended while background work it started is still alive (an async subagent,
 * or a shell that began within `SHELL_SETTLED_MS`) is not done: each report starts a short turn of its own. It
 * stays `working` (`hostState` keeps a Stop hook and the finish push from calling it finished) and carries
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
    hostState: "working",
    backgroundTasks: holding.length,
  };
}
