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
};

/** Kinds that earn an unsolicited Telegram message rather than a radar row. */
export const PUSH_KINDS: ReadonlySet<AttentionKind> = new Set<AttentionKind>(["blocked_approval", "blocked_question"]);

/** Waiting longer raises priority, but never enough to outrank a worse kind. */
const MAX_AGE_BONUS = 240;

/** Being able to act on a session from Telegram breaks ties in its favour. */
const ACTIONABLE_BONUS = 50;

export function classifyAttention(session: FleetSession): AttentionKind | null {
  switch (session.state) {
    case "awaiting_approval":
      return "blocked_approval";
    case "awaiting_input":
      return "blocked_question";
    case "error":
      return "errored";
    case "finished":
      return "finished_unreviewed";
    default:
      return null;
  }
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

export function attentionLabel(kind: AttentionKind): string {
  switch (kind) {
    case "blocked_approval":
      return "Waiting for approval";
    case "blocked_question":
      return "Waiting for your answer";
    case "errored":
      return "Errored";
    case "finished_unreviewed":
      return "Finished, unreviewed";
  }
}
