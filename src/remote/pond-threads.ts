import path from "node:path";

import type { PhoneFlockThread, PhoneHostThread, PhonePond } from "../fleet/native-phone.js";
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
  /** Other members' threads in this pond (read-only on the phone), when the pond is shared. Optional: older phones skip it. */
  flock?: PhoneFlockThread[];
  /** Whether this person may message in the pond right now, and the calm reason when not. Optional. */
  access?: { canMessage: boolean; reason?: string };
}

/** The `live` document id of a pond's threads: the pond id hashed like a session key, under its own prefix. */
export function pondThreadsDoc(pondId: string): string {
  return `${liveHandle(`pond:${pondId}`)}-p`;
}

interface Item {
  key: string;
  title: string;
  state: string;
  at: string;
  cwd: string;
  workspaceTitle?: string;
  branch?: string;
}

function time(item: { at: string }): number {
  return Date.parse(item.at) || 0;
}

/**
 * The pond's threads, from the Mac's own snapshot plus the host's own per-project list (`hostThreads`: every
 * non-archived native chat of the project, which the snapshot, holding only the newest 100, can miss). The snapshot's
 * row wins when both name a chat. `inPond` is the one placement of a chat in a pond; `titleOf` the row headline.
 * Archived and `skip`ped runs are left out; nothing else is, however old.
 */
export function buildPondThreads(
  pond: PhonePond,
  sessions: FleetSession[],
  inPond: (session: FleetSession) => boolean,
  titleOf: (session: FleetSession) => string,
  skip: (session: FleetSession) => boolean = () => false,
  hostThreads: PhoneHostThread[] = [],
): PondThreadsDoc {
  const items = new Map<string, Item>();
  for (const session of sessions) {
    if (session.archivedAt !== undefined || skip(session) || !inPond(session)) continue;
    items.set(session.key, {
      key: session.key,
      title: titleOf(session),
      state: session.state,
      at: session.lastActivityAt,
      cwd: session.cwd ?? "",
      ...(session.workspaceTitle?.trim() ? { workspaceTitle: session.workspaceTitle.trim() } : {}),
      ...(session.branch ? { branch: session.branch } : {}),
    });
  }
  for (const host of hostThreads) {
    if (items.has(host.key)) continue;
    items.set(host.key, { ...host, title: host.title.trim() || "Untitled chat" });
  }
  const mine = [...items.values()].sort((a, b) => time(b) - time(a) || a.key.localeCompare(b.key));
  const shown = mine.slice(0, POND_THREADS_MAX);
  const folder = pond.folder ? path.resolve(pond.folder) : null;
  const groups = new Map<string, PondThreadStream>();
  for (const item of shown) {
    const isMain = folder !== null && Boolean(item.cwd) && path.resolve(item.cwd) === folder;
    let id = "main";
    let name = "Main";
    if (!isMain) {
      const label = item.workspaceTitle || item.branch || path.basename(item.cwd || "") || "Other";
      const known = pond.streams?.find(
        (stream) => (item.branch && stream.branch === item.branch) || stream.name === label,
      );
      id = known?.id ?? label;
      name = known?.name ?? label;
    }
    let group = groups.get(id);
    if (!group) {
      group = { id, name, ...(isMain ? { main: true as const } : {}), threads: [] };
      groups.set(id, group);
    }
    group.threads.push({ key: item.key, title: item.title, state: item.state, at: item.at });
  }
  // `shown` is newest first, so each group's threads are, and a group's first thread is its newest.
  const streams = [...groups.values()].sort((a, b) => {
    if (a.main !== b.main) return a.main ? -1 : 1;
    return Date.parse(b.threads[0]?.at ?? "") - Date.parse(a.threads[0]?.at ?? "") || a.name.localeCompare(b.name);
  });
  return { v: 1, pond: pond.id, total: mine.length, streams };
}
