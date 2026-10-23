import type { FleetSession } from "./types.js";

/**
 * How long a finished (or errored) session stays on screen: a day, so a chat
 * that ended this morning is still on the Home page this afternoon. This only
 * keeps it visible. Pushes and the duck's celebration are timed separately
 * (`PUSH_FINISH_WITHIN_MS`, `CELEBRATION_MS`) and are not stretched by it.
 */
export const DEFAULT_RECENTLY_FINISHED_MS = 24 * 60 * 60 * 1000;

export interface ActivityOptions {
  recentlyFinishedMs?: number;
}

/**
 * The few sessions you are actually working with right now.
 *
 * The radar began as an inventory of everything on the machine, which on a
 * normal day is twenty-odd sessions, almost all of them abandoned. That is an
 * archive, not a status display. What you want while working is the handful
 * that are running, stuck, or just finished — on this machine that is four.
 */
export function isActiveSession(session: FleetSession, nowMs: number, options: ActivityOptions = {}): boolean {
  if (session.retired) {
    return false;
  }

  switch (session.state) {
    case "working":
    case "awaiting_approval":
    case "awaiting_input":
      return true;
    case "finished":
    case "error":
      return nowMs - Date.parse(session.lastActivityAt) < (options.recentlyFinishedMs ?? DEFAULT_RECENTLY_FINISHED_MS);
    case "idle":
      // A quiet terminal session whose process is still up is one you have
      // open and are about to type into, which is very different from one
      // abandoned on Tuesday. Not so for Conductor: its sidecar keeps a warm
      // agent process per recently used chat for hours, so a live process
      // says nothing about you, and Conductor reports the chat's status
      // itself. Any other SDK harness is a program holding a process, not
      // someone at a prompt, so the same goes for it.
      return session.alive && session.origin !== "conductor" && session.origin !== "sdk";
    default:
      return false;
  }
}

export function selectActiveSessions(
  sessions: FleetSession[],
  nowMs: number,
  options: ActivityOptions = {},
): FleetSession[] {
  return sessions.filter((session) => isActiveSession(session, nowMs, options));
}

/** Every list is newest first by last activity; urgency lives in the sections, not in the sort. */
export function newestFirst(sessions: FleetSession[]): FleetSession[] {
  return [...sessions].sort(
    (a, b) => (Date.parse(b.lastActivityAt) || 0) - (Date.parse(a.lastActivityAt) || 0) || a.key.localeCompare(b.key),
  );
}
