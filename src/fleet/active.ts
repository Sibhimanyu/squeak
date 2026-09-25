import type { FleetSession } from "./types.js";

/**
 * How long a finished session stays on screen. Long enough to notice it went
 * green and read what it did; short enough that the panel does not silt up.
 */
export const DEFAULT_RECENTLY_FINISHED_MS = 15 * 60 * 1000;

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
