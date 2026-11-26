import { needsYouReason } from "./needs-you.js";
import type { FleetSession } from "./types.js";

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
  Partial<Pick<FleetSession, "looping" | "retired" | "hostState" | "ducklings" | "errorSeenAt" | "lastActivityAt">>;

/**
 * `needsYou` is the count by the one rule (`needsYouReason`): waiting, looping and an unseen failure all count. The
 * mark still tells them apart: a pond with only failures draws the failed mark (`error`), anything waiting draws
 * the triangle.
 */
export function rollupStatus(sessions: readonly RollupInput[], nowMs: number = Date.now()): StatusRollup {
  let working = 0;
  let needs = 0;
  let waiting = 0;
  let failed = 0;
  for (const session of sessions) {
    const reason = needsYouReason({ ...session, updatedAt: session.lastActivityAt }, nowMs);
    if (reason) {
      needs += 1;
      if (reason === "failed") failed += 1;
      else waiting += 1;
    } else if (session.state === "working" || (session.ducklings?.running ?? 0) > 0) working += 1;
  }
  const activity: RollupActivity = waiting > 0 ? "needs_you" : working > 0 ? "working" : failed > 0 ? "error" : "idle";
  return { activity, working, needsYou: needs };
}
