import type { Role } from "./types.js";

// The Pond policy: one pure `decide`, shared with the web app (src/shared/pond-policy.ts, docs/adr/0006-pond-policy.md).
export * from "../shared/pond-policy.js";

/**
 * What a role may do, in the shape older clients read (`caps` on the pond view, and the Room's port). Derived, never
 * stored: a Viewer reads; a Member also messages and answers, and `start` means "may start or ask for a Duck or Task"
 * (a Member's always waits for the Owner's approval); the Owner just does it. Older apps keep reading it until no app does.
 */
export interface Caps {
  see: boolean;
  diffs: boolean;
  message: boolean;
  answer: boolean;
  start: boolean;
}

export function capsOf(role: Role): Caps {
  if (role === "viewer") return { see: true, diffs: true, message: false, answer: false, start: false };
  return { see: true, diffs: true, message: true, answer: true, start: true };
}
