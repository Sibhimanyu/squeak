import type { AttentionItem, AttentionKind, FleetSession } from "./types.js";

/**
 * Base weights. The ordering is the whole product decision: something the
 * agent cannot proceed without beats something that merely happened.
 */
const KIND_SCORE: Record<AttentionKind, number> = {
  blocked_approval: 1000,
  blocked_question: 900,
  errored: 600,
  finished_unreviewed: 300,
  context_pressure: 250,
};

/**
 * Past this share of the context window a session is close to compacting,
 * which costs it fidelity on everything it has already worked out. Worth
 * knowing before it happens rather than after.
 */
export const DEFAULT_CONTEXT_PRESSURE_PERCENT = 80;

/** States where a session is live enough that compacting would actually cost you. */
const CONTEXT_PRESSURE_STATES = new Set(["working", "finished", "awaiting_approval", "awaiting_input"]);

/**
 * Kinds that earn an unsolicited Telegram message rather than a radar row.
 *
 * Finishing counts. "Tell me when it is done" is the main thing wanted from a
 * phone, and it stays quiet in practice because only *active* sessions reach
 * here — a retired workspace or a session abandoned on Tuesday never does.
 */
export const PUSH_KINDS: ReadonlySet<AttentionKind> = new Set<AttentionKind>([
  "blocked_approval",
  "blocked_question",
  "finished_unreviewed",
]);

/** Waiting longer raises priority, but never enough to outrank a worse kind. */
const MAX_AGE_BONUS = 240;

/** Being able to act on a session from Telegram breaks ties in its favour. */
const ACTIONABLE_BONUS = 50;

/**
 * A session can want attention for more than one reason at once — it can have
 * just finished *and* be nearly out of context — so this returns every reason
 * rather than the first.
 */
export function classifyAttentions(
  session: FleetSession,
  contextPressurePercent = DEFAULT_CONTEXT_PRESSURE_PERCENT,
): AttentionKind[] {
  const kinds: AttentionKind[] = [];

  switch (session.state) {
    case "awaiting_approval":
      kinds.push("blocked_approval");
      break;
    case "awaiting_input":
      kinds.push("blocked_question");
      break;
    case "error":
      kinds.push("errored");
      break;
    case "finished":
      // Work the user already signed off on should stop asking to be reviewed.
      if (!session.retired) {
        kinds.push("finished_unreviewed");
      }
      break;
    default:
      break;
  }

  if (
    !session.retired &&
    session.contextPercent !== null &&
    session.contextPercent >= contextPressurePercent &&
    CONTEXT_PRESSURE_STATES.has(session.state)
  ) {
    kinds.push("context_pressure");
  }

  return kinds;
}

/**
 * Whether this reason is worth an unsolicited message, for this session.
 *
 * A finish only interrupts when it is a Conductor chat. Every agent on the Mac
 * ends turns all day — a scratch session in a terminal finishing is not news,
 * and it was the bulk of what arrived. A Conductor session finishing is work
 * the user handed off and is waiting on, and it is the only kind they can open
 * and review from the phone. Blocked sessions still always push: being stuck
 * is urgent wherever it happens.
 */
export function shouldPush(kind: AttentionKind, session: FleetSession): boolean {
  if (!PUSH_KINDS.has(kind)) {
    return false;
  }
  return kind === "finished_unreviewed" ? isActionable(session) : true;
}

/** A session we can actually reply to, versus one we can only watch. */
export function isActionable(session: FleetSession): boolean {
  return session.conductorSessionId !== null;
}

export function scoreAttention(params: {
  kind: AttentionKind;
  since: string;
  session: FleetSession;
  now: number;
}): number {
  const ageMinutes = Math.max(0, Math.floor((params.now - Date.parse(params.since)) / 60_000));
  const ageBonus = Number.isFinite(ageMinutes) ? Math.min(ageMinutes, MAX_AGE_BONUS) : 0;
  return KIND_SCORE[params.kind] + ageBonus + (isActionable(params.session) ? ACTIONABLE_BONUS : 0);
}

export function sortAttention(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.session.key.localeCompare(right.session.key);
  });
}
