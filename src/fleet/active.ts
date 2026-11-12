import os from "node:os";

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
  // A run in the OS temp dir is a scratch script's, never a chat or a project (a native chat is native.db's word).
  if (session.origin !== "squeak" && isTempPath(session.cwd)) {
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
      return (
        session.alive && !session.rules?.hostManagedLiveness && session.origin !== "sdk" && session.origin !== "squeak"
      );
    default:
      return false;
  }
}

/** Whether a folder is under the OS temp dir ($TMPDIR, /private/var/folders/…/T, /tmp, /private/tmp). */
export function isTempPath(cwd: string | null | undefined): boolean {
  if (!cwd) return false;
  const roots = new Set(["/tmp", "/private/tmp", os.tmpdir()]);
  for (const root of [...roots]) {
    roots.add(root.startsWith("/private/") ? root.slice("/private".length) : `/private${root}`);
  }
  if (/^\/(private\/)?var\/folders\/[^/]+\/[^/]+\/T(\/|$)/.test(cwd)) return true;
  return [...roots].some((root) => {
    const r = root.replace(/\/+$/, "");
    return r.length > 1 && (cwd === r || cwd.startsWith(`${r}/`));
  });
}

export function selectActiveSessions(
  sessions: FleetSession[],
  nowMs: number,
  options: ActivityOptions = {},
): FleetSession[] {
  const workspaces = conductorWorkspaces(sessions);
  return sessions.filter((session) => isActiveSession(session, nowMs, options) && !isHelperRun(session, workspaces));
}

/** Every host-run chat's workspace folder (Conductor's), with a trailing separator so a prefix test cannot match a sibling. */
function conductorWorkspaces(sessions: FleetSession[]): string[] {
  const roots = new Set<string>();
  for (const session of sessions) {
    const root = session.hostId ? (session.workspaceRoot ?? null) : null;
    if (root) roots.add(root.endsWith("/") ? root : `${root}/`);
  }
  return [...roots];
}

/**
 * A headless run another agent started as a helper, not a chat of yours: an `sdk` session (`codex exec`, a Claude SDK
 * script) working inside a Conductor chat's workspace, or inside a hidden folder (`.context/…`, `.work-g1`). On a real
 * machine one chat's overnight brand rounds left four of them (`…/R26/.work-g1`–`g4`), each its own "project" on Home.
 * The chat that started them is what you follow. One that needs you still shows: that is never a helper's business.
 */
export function isHelperRun(session: FleetSession, conductorRoots: string[]): boolean {
  if (session.origin !== "sdk" || !session.cwd) return false;
  if (session.state === "awaiting_approval" || session.state === "awaiting_input") return false;
  const cwd = session.cwd.endsWith("/") ? session.cwd : `${session.cwd}/`;
  if (/\/\.[^/]+\//.test(cwd)) return true;
  return conductorRoots.some((root) => cwd.startsWith(root));
}

/** Every list is newest first by last activity; urgency lives in the sections, not in the sort. */
export function newestFirst(sessions: FleetSession[]): FleetSession[] {
  return [...sessions].sort(
    (a, b) => (Date.parse(b.lastActivityAt) || 0) - (Date.parse(a.lastActivityAt) || 0) || a.key.localeCompare(b.key),
  );
}
