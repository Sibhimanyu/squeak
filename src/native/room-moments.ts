import { isSqueakLine, mentions, type Room } from "./room.js";
import type { RoomTask } from "./room-tasks.js";
import type { NativeStore } from "./store.js";

/**
 * The Room moments that need a person, for Telegram and Cliq (`fleet/room-moments.ts` polls this). Exactly three, and
 * nothing else from the Room ever leaves it:
 *
 * - `ask`: a Duck asked a person in the Room (a `needs` post, or an @mention of a person by a Duck).
 * - `blocked`: a Task's turn did not finish.
 * - `approval`: a Member's Task is waiting for the Owner's approval.
 *
 * The host decides what counts; the daemon only draws and filters by the per-channel switches.
 */

export interface RoomAskMoment {
  seq: number;
  id: string;
  duck: string;
  /** The person the Duck named, for an @mention; absent for a plain `needs` post. */
  to?: string;
  text: string;
}

export interface RoomTaskMoment {
  id: string;
  title: string;
  /** Who made it, for an approval. */
  by?: string;
  /** The Duck that holds it, for a blocked Task. */
  duck?: string;
  updatedAt: number;
}

export interface RoomMoments {
  pond: string;
  latestSeq: number;
  asks: RoomAskMoment[];
  blocked: RoomTaskMoment[];
  approvals: RoomTaskMoment[];
}

const MAX_POSTS = 200;

/** One line, plain, short: a lock-screen card, not a document. */
function oneLine(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}...` : flat;
}

export function roomMoments(input: {
  store: NativeStore;
  room: Room;
  projectId: string;
  pondName: string;
  /** Posts after this seq are looked at; the first look passes the newest seq so history is never announced. */
  since: number;
  tasks: RoomTask[];
  /** Other people the pond knows by name (its Members), beside those who have posted. */
  people?: string[];
}): RoomMoments {
  const { store, projectId, since } = input;
  const latestSeq = store.latestRoomSeq(projectId);
  const rows = store.roomPosts(projectId, { since, limit: MAX_POSTS }).filter((r) => !isSqueakLine(r));
  const duckNames = new Set(input.room.listDucks(projectId).map((d) => d.name.trim().toLowerCase()));
  const people = new Set<string>(input.people ?? []);
  for (const r of store.roomPosts(projectId, { limit: MAX_POSTS })) {
    if (r.authorKind === "person" && r.authorName.trim()) people.add(r.authorName.trim());
  }
  const named = [...people].filter((n) => !duckNames.has(n.toLowerCase()));

  const asks: RoomAskMoment[] = [];
  for (const r of rows) {
    // Only a Duck speaking to the person in the Room: never a person's message, never the agents-only level.
    if (r.authorKind !== "agent" || r.level !== "room") continue;
    // A hand-off is work given to a Duck, not a question for a person.
    if (r.kind === "handoff") continue;
    const to = named.find((n) => mentions(r.text, n));
    if (r.kind !== "needs" && !to) continue;
    asks.push({ seq: r.seq, id: r.id, duck: r.authorName, ...(to ? { to } : {}), text: oneLine(r.text) });
  }

  const blocked: RoomTaskMoment[] = [];
  const approvals: RoomTaskMoment[] = [];
  for (const t of input.tasks) {
    if (t.state === "blocked") {
      blocked.push({
        id: t.id,
        title: oneLine(t.title, 100),
        ...(t.handedTo?.title ? { duck: t.handedTo.title } : {}),
        updatedAt: t.updatedAt,
      });
    } else if (t.state === "waiting" && t.approval) {
      approvals.push({ id: t.id, title: oneLine(t.title, 100), by: t.approval.name, updatedAt: t.updatedAt });
    }
  }
  return { pond: input.pondName, latestSeq, asks, blocked, approvals };
}
