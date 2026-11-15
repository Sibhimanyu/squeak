import type { PhoneFlockAccess, PhoneFlockThread } from "../fleet/native-phone.js";
import { liveHandle } from "./live-turn.js";

/**
 * One pond member's thread, opened on a phone (`flockthread` in its caps).
 *
 * The thread runs on its starter's Mac. This Mac already reads its seq'd events through the pond (the same events the
 * Mac app's `PondReplica` folds), so for the one thread a phone has open it reduces them to rows and publishes them
 * sealed into `live`, rewritten only when they change and deleted when the phone leaves. Read and message only: an
 * approval is shown and stays with the starter, a question is shown and is answered on a Mac.
 */

export const PHONE_FLOCK_THREAD_CAP = "flockthread";
/** The most rows one document holds (the newest), and the longest text of one. */
export const FLOCK_ENTRIES_MAX = 200;
export const FLOCK_TEXT_MAX = 4000;
/** The longest message a phone may send into a member's thread. */
export const FLOCK_MESSAGE_MAX = 4000;

export interface FlockEntry {
  /** The thread's own event seq of the row's first event: stable, ascending. */
  id: number;
  role: "user" | "agent" | "thinking" | "tool" | "question" | "approval";
  text: string;
  /** Who a user row came from. */
  by?: string;
  /** A tool that finished, a question or approval that was answered or withdrawn. */
  done?: true;
  /** Internal: the tool's or request's own id, never sent. */
  ref?: string;
}

export interface FlockThreadDoc {
  v: 1;
  pond: string;
  thread: string;
  title: string;
  by: string;
  state: string;
  mode: "own" | "shared";
  poweredBy?: string;
  locked?: true;
  /** Whether this person may message this thread now, and the calm reason when not. */
  access: { canMessage: boolean; reason?: string };
  entries: Array<Omit<FlockEntry, "ref">>;
}

/** The `live` document id of an open member thread: the thread id hashed like a session key, under its own prefix. */
export function flockThreadDoc(threadId: string): string {
  return `${liveHandle(`flock:${threadId}`)}-f`;
}

function clip(text: string): string {
  return text.length > FLOCK_TEXT_MAX ? `${text.slice(0, FLOCK_TEXT_MAX - 1)}…` : text;
}

const rec = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export interface FlockReduction {
  entries: FlockEntry[];
  state: string | null;
  lastSeq: number;
}

/** Folds pond events (any order, any repeats) into rows. Unknown kinds and the timeline kind are ignored. */
export function reduceFlockEvents(prev: FlockReduction, events: unknown[]): FlockReduction {
  const entries = [...prev.entries];
  let state = prev.state;
  let lastSeq = prev.lastSeq;
  const sorted = events
    .map(rec)
    .filter((e): e is Record<string, unknown> => e !== null && typeof e.seq === "number" && Number.isFinite(e.seq))
    .sort((a, b) => (a.seq as number) - (b.seq as number));
  for (const e of sorted) {
    const seq = e.seq as number;
    if (seq <= prev.lastSeq) continue;
    lastSeq = Math.max(lastSeq, seq);
    const text = typeof e.text === "string" ? clip(e.text) : "";
    switch (e.type) {
      case "user":
        entries.push({
          id: seq,
          role: "user",
          text,
          ...(typeof e.byName === "string" && e.byName ? { by: e.byName.slice(0, 100) } : {}),
        });
        break;
      case "agent":
      case "thinking":
        if (text) entries.push({ id: seq, role: e.type, text });
        break;
      case "tool": {
        const label = typeof e.label === "string" ? clip(e.label) : "";
        const ref = typeof e.id === "string" ? e.id : undefined;
        const found = ref ? entries.findIndex((x) => x.role === "tool" && x.ref === ref) : -1;
        const done = e.state === "done" || e.state === "error";
        if (found >= 0) {
          const row = entries[found]!;
          entries[found] = { ...row, text: label || row.text, ...(done ? { done: true as const } : {}) };
        } else if (label) {
          entries.push({
            id: seq,
            role: "tool",
            text: label,
            ...(done ? { done: true as const } : {}),
            ...(ref ? { ref } : {}),
          });
        }
        break;
      }
      case "question":
      case "approval": {
        const body = e.type === "question" ? text : typeof e.label === "string" ? clip(e.label) : "";
        entries.push({
          id: seq,
          role: e.type,
          text: body,
          ...(typeof e.requestId === "string" ? { ref: e.requestId } : {}),
        });
        break;
      }
      case "resolved": {
        const ref = typeof e.requestId === "string" ? e.requestId : null;
        const found = ref
          ? entries.findIndex((x) => (x.role === "question" || x.role === "approval") && x.ref === ref)
          : -1;
        if (found >= 0) entries[found] = { ...entries[found]!, done: true };
        break;
      }
      case "state":
        if (typeof e.state === "string") state = e.state;
        break;
      default:
        break;
    }
  }
  return { entries: entries.slice(-FLOCK_ENTRIES_MAX), state, lastSeq };
}

export function buildFlockThreadDoc(
  pondId: string,
  thread: PhoneFlockThread,
  access: PhoneFlockAccess,
  reduced: FlockReduction,
): FlockThreadDoc {
  return {
    v: 1,
    pond: pondId,
    thread: thread.id,
    title: thread.title,
    by: thread.by,
    state: reduced.state ?? thread.state,
    mode: thread.mode,
    ...(thread.poweredBy ? { poweredBy: thread.poweredBy } : {}),
    ...(thread.locked ? { locked: true as const } : {}),
    access: { canMessage: access.canMessage, ...(access.reason ? { reason: access.reason } : {}) },
    entries: reduced.entries.map((entry) => {
      const row: Omit<FlockEntry, "ref"> & { ref?: string } = { ...entry };
      delete row.ref;
      return row;
    }),
  };
}
