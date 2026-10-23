import { needsYou, type AttentionItem, type FleetSession } from "./types.js";

/**
 * What the desktop duck is doing. Derived here rather than in the renderer so
 * it is covered by the same tests as everything else — the duck stays purely
 * presentational and cannot disagree with Telegram about what is going on.
 */
export type DuckMood =
  /** Nothing active at all. */
  | "asleep"
  /** Sessions are open but none are doing anything. */
  | "idle"
  /** At least one agent is mid-turn. */
  | "working"
  /** Something finished a moment ago. */
  | "celebrating"
  /** Something is blocked on you, which outranks everything else. */
  | "needs_you";

/** How long the duck keeps celebrating after a session finishes. */
export const CELEBRATION_MS = 45_000;

export interface DuckState {
  mood: DuckMood;
  /** Sessions blocked on you; drives the badge. */
  blockedCount: number;
  workingCount: number;
  /** Finished recently enough to still be worth pointing at. */
  justFinished: string[];
}

export function deriveDuckState(
  active: FleetSession[],
  attention: AttentionItem[],
  nowMs: number,
  celebrationMs = CELEBRATION_MS,
): DuckState {
  // Blocked, or finished on a question put to you: both are waiting on you.
  const blocked = active.filter(needsYou);
  const working = active.filter((session) => session.state === "working");

  // `since` rather than lastActivityAt: it is when the session entered the
  // finished state, so the celebration is timed from the finish and not from
  // whatever the agent last wrote to its transcript.
  const justFinished = attention
    .filter((item) => item.kind === "finished_unreviewed" && nowMs - Date.parse(item.since) < celebrationMs)
    .map((item) => item.session.key);

  return {
    mood: pickMood({
      blocked: blocked.length,
      working: working.length,
      justFinished: justFinished.length,
      active: active.length,
    }),
    blockedCount: blocked.length,
    workingCount: working.length,
    justFinished,
  };
}

function pickMood(counts: { blocked: number; working: number; justFinished: number; active: number }): DuckMood {
  // Being blocked outranks a celebration: if one agent finished while another
  // is waiting on you, the waiting one is the thing you need to see.
  if (counts.blocked > 0) {
    return "needs_you";
  }
  if (counts.justFinished > 0) {
    return "celebrating";
  }
  if (counts.working > 0) {
    return "working";
  }
  return counts.active > 0 ? "idle" : "asleep";
}
