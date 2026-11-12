import type { ReplyOutcome } from "../../fleet/reply-types.js";

export function assertSent(outcome: ReplyOutcome): void {
  if (outcome.status === "started") return;
  throw new Error(outcome.reason);
}
