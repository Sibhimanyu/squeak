import type { FleetDucklings, FleetSession } from "./types.js";

/** A shell must have run this long before it stops counting as work: a fresh `npm serve` is still being set up (the same rule as `addons/conductor/waiting-resolve.ts`). */
export const SHELL_SETTLED_MS = 60_000;
/** A finished subagent keeps the chat working this long while its report has not been taken in (the follow-up turn starts within seconds). */
export const REPORT_GRACE_MS = 2 * 60_000;

/**
 * Whether a Squeak chat's background helpers keep it working although its turn ended: a running subagent, a subagent
 * that finished but whose report the agent has not taken in yet (so the gap between the last worker and the follow-up
 * turn is not a finish), or a shell that started within `SHELL_SETTLED_MS`. An old shell (a dev server left up) does
 * not. One rule, used by the session host's rows and the fleet.
 */
export function helpersKeepWorking(ducklings: FleetDucklings | undefined | null, nowMs: number): boolean {
  if (!ducklings) return false;
  for (const item of ducklings.items) {
    const started = Date.parse(item.startedAt);
    if (item.kind === "agent") {
      if (item.status === "running") return true;
      const ended = item.endedAt ? Date.parse(item.endedAt) : Number.NaN;
      if (item.status !== "stopped" && !item.reportedAt && Number.isFinite(ended) && nowMs - ended < REPORT_GRACE_MS) {
        return true;
      }
    } else if (item.status === "running" && Number.isFinite(started) && nowMs - started <= SHELL_SETTLED_MS) {
      return true;
    }
  }
  return false;
}

/**
 * A Squeak-run chat's background helpers ("ducklings"), as the session host reports them (`GET /native/sessions`,
 * `ducklings`). They ride on the session for the surfaces to draw. A chat whose turn ended is working, everywhere,
 * while `helpersKeepWorking` says so, so its finish (and its push) waits for the last worker and the follow-up turn.
 * Only a finished or idle chat changes: a question, an approval or an error is still what it is.
 */
export function attachDucklings(
  session: FleetSession,
  ducklings: FleetDucklings | undefined,
  nowMs: number = Date.now(),
): FleetSession {
  if (session.origin !== "squeak" || !ducklings || ducklings.items.length === 0) return session;
  const held = { ...session, ducklings };
  if ((session.state === "finished" || session.state === "idle") && helpersKeepWorking(ducklings, nowMs)) {
    return { ...held, state: "working", stateSource: "host" };
  }
  return held;
}

/** Helpers running across sessions, for `/state`'s `ducklingsRunning`. */
export function ducklingsRunning(sessions: FleetSession[]): number {
  return sessions.reduce((sum, session) => sum + (session.ducklings?.running ?? 0), 0);
}
