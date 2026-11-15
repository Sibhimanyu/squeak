import { needsYou, type FleetSession } from "./types.js";

/**
 * What one pond or one stream says at a glance, decided here so every surface (the Mac sidebar, the phone's lists,
 * `/state`) draws the same mark: needs you wins, then working, then error, else idle. A running duckling (background
 * helper) keeps its chat working. Optional on the wire; an older client ignores it.
 */
export type RollupActivity = "working" | "needs_you" | "error" | "idle";

export interface StatusRollup {
  activity: RollupActivity;
  working: number;
  needsYou: number;
}

type RollupInput = Pick<FleetSession, "state" | "asks"> &
  Partial<Pick<FleetSession, "looping" | "retired" | "hostState" | "ducklings">>;

export function rollupStatus(sessions: readonly RollupInput[]): StatusRollup {
  let working = 0;
  let waiting = 0;
  let failed = 0;
  for (const session of sessions) {
    if (needsYou(session)) waiting += 1;
    else if (session.state === "working" || (session.ducklings?.running ?? 0) > 0) working += 1;
    else if (session.state === "error") failed += 1;
  }
  const activity: RollupActivity = waiting > 0 ? "needs_you" : working > 0 ? "working" : failed > 0 ? "error" : "idle";
  return { activity, working, needsYou: waiting };
}
