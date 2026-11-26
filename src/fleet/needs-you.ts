import { isLoopingSession, type FleetSession } from "./types.js";

/**
 * The one rule for "needs you", decided once so the Pond Dashboard tile, the sidebar mark, the board, the Duck badge
 * and the phone cannot count it differently. A chat needs you when it is
 *
 * - waiting on an approval or on an answer (`approval`, `question`; a finish that ends on a question is a `question`),
 * - repeating the same failing step (`looping`),
 * - a turn the model or the network has left hanging (`stalled`, only where the caller measured it), or
 * - failed (`failed`) and the person has not yet seen it.
 *
 * A failure stops counting when the person opens the chat or dismisses it (`errorSeenAt`), when the chat is sent
 * anything (the status leaves `error`), and after `FAILED_COUNTS_FOR_MS`, so an old failure nobody touched does not
 * hold a red mark on a Pond for ever. The failure's own row stays in the chat either way.
 */
export type NeedsYouReason = "approval" | "question" | "looping" | "stalled" | "failed";

/** How long an unseen failure keeps counting. Same window the Mac keeps finished and failed chats in its lists. */
export const FAILED_COUNTS_FOR_MS = 24 * 60 * 60 * 1000;

export interface NeedsYouInput {
  state: FleetSession["state"];
  asks?: FleetSession["asks"] | undefined;
  looping?: FleetSession["looping"] | undefined;
  retired?: boolean | undefined;
  hostState?: FleetSession["hostState"] | undefined;
  /** When the person opened or dismissed the failure; absent or null = not yet. */
  errorSeenAt?: string | null | undefined;
  /** When the chat last changed (ISO): the failure's age. */
  updatedAt?: string | null | undefined;
  /** The caller measured that the turn is hanging (`isStalled`). */
  stalled?: boolean | undefined;
}

export function needsYouReason(session: NeedsYouInput, nowMs: number): NeedsYouReason | null {
  if (session.state === "awaiting_approval") return "approval";
  if (session.state === "awaiting_input") return "question";
  if (session.state === "finished" && session.asks) return "question";
  if (
    isLoopingSession({
      state: session.state,
      looping: session.looping ?? null,
      hostState: session.hostState ?? null,
      ...(session.retired ? { retired: true } : {}),
    })
  )
    return "looping";
  if (session.stalled) return "stalled";
  if (session.state === "error" && failureCounts(session, nowMs)) return "failed";
  return null;
}

/** An error the person has not seen, still young enough to count. */
export function failureCounts(
  session: Pick<NeedsYouInput, "errorSeenAt" | "updatedAt" | "retired">,
  nowMs: number,
): boolean {
  if (session.retired || session.errorSeenAt) return false;
  const at = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN;
  // No age to judge by: count it (never hide a failure for want of a date).
  return !Number.isFinite(at) || nowMs - at <= FAILED_COUNTS_FOR_MS;
}
