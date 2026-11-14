import path from "node:path";

import type { PhonePond } from "../fleet/native-phone.js";
import type { FleetSession } from "../fleet/types.js";
import { liveHandle } from "./live-turn.js";

/**
 * A pond's whole thread list for a phone that has that pond open (`pondthreads` in its caps).
 *
 * The phone view carries only the 24 h active set and a short Recent list, so a pond page built from it shows a
 * fraction of what the Mac's pond page lists. This document is the rest: every non-archived thread of the one pond
 * the phone has open, already grouped (Main first, then streams newest first, threads newest first inside), so the
 * phone only draws. Per thread only what a row shows: key, title, state, last activity. Written sealed into `live`,
 * only while a phone is open on that pond, rewritten only when it changes, deleted when it leaves.
 */

export const PHONE_POND_THREADS_CAP = "pondthreads";
/** The most threads one document holds (the newest); `total` says how many the pond has. */
export const POND_THREADS_MAX = 200;

export interface PondThreadRow {
  key: string;
  title: string;
  state: string;
  at: string;
}

export interface PondThreadStream {
  id: string;
  name: string;
  /** The pond's own folder: its threads run in Main, not in a stream. */
  main?: true;
  threads: PondThreadRow[];
}

export interface PondThreadsDoc {
  v: 1;
  pond: string;
  total: number;
  streams: PondThreadStream[];
}

/** The `live` document id of a pond's threads: the pond id hashed like a session key, under its own prefix. */
export function pondThreadsDoc(pondId: string): string {
  return `${liveHandle(`pond:${pondId}`)}-p`;
}

function time(session: FleetSession): number {
  return Date.parse(session.lastActivityAt) || 0;
}

/**
 * The pond's threads, from the Mac's own snapshot. `inPond` is the one placement of a chat in a pond; `titleOf` the
 * row headline. Archived and `skip`ped runs are left out; nothing else is, however old.
 */
export function buildPondThreads(
  pond: PhonePond,
  sessions: FleetSession[],
  inPond: (session: FleetSession) => boolean,
  titleOf: (session: FleetSession) => string,
  skip: (session: FleetSession) => boolean = () => false,
): PondThreadsDoc {
  const mine = sessions
    .filter((session) => session.archivedAt === undefined && !skip(session) && inPond(session))
    .sort((a, b) => time(b) - time(a) || a.key.localeCompare(b.key));
  const shown = mine.slice(0, POND_THREADS_MAX);
  const folder = pond.folder ? path.resolve(pond.folder) : null;
  const groups = new Map<string, PondThreadStream>();
  for (const session of shown) {
    const isMain = folder !== null && Boolean(session.cwd) && path.resolve(session.cwd ?? "") === folder;
    let id = "main";
    let name = "Main";
    if (!isMain) {
      const label = session.workspaceTitle?.trim() || session.branch || path.basename(session.cwd || "") || "Other";
      const known = pond.streams?.find(
        (stream) => (session.branch && stream.branch === session.branch) || stream.name === label,
      );
      id = known?.id ?? label;
      name = known?.name ?? label;
    }
    let group = groups.get(id);
    if (!group) {
      group = { id, name, ...(isMain ? { main: true as const } : {}), threads: [] };
      groups.set(id, group);
    }
    group.threads.push({
      key: session.key,
      title: titleOf(session),
      state: session.state,
      at: session.lastActivityAt,
    });
  }
  // `shown` is newest first, so each group's threads are, and a group's first thread is its newest.
  const streams = [...groups.values()].sort((a, b) => {
    if (a.main !== b.main) return a.main ? -1 : 1;
    return Date.parse(b.threads[0]?.at ?? "") - Date.parse(a.threads[0]?.at ?? "") || a.name.localeCompare(b.name);
  });
  return { v: 1, pond: pond.id, total: mine.length, streams };
}
