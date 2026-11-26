// The Room's cloud format, in one module (docs/ponds.md, "The Room reaches Members"; the daemon's twin is
// src/flotilla/room-sync.ts, which imports Node modules and so cannot be shared). When the format changes this is the only file
// that has to follow: the rest of the web app reads `RoomPost`, `RoomTask` and writes through `inboxDoc`, `taskRequestDoc` and
// `startDuckDoc`.
//
// As of #122: the Room is kept whole in the cloud and ordered by the cloud's own `seq` (the feed row's, which replaces any `seq`
// inside a document). Kind `room`: the Owner's posts, Duck lines and Pond lines (a message from "Squeak"), signed by the Owner's
// Mac. Kind `rposts`: every Member's own signed document, readable by every Member at once: a message `{v, id, text, at, replyTo?}`,
// or an ask for the Owner's Mac (`task:{messageId}`, `start:{...}`, `leave`, `removeDevice`), which is not a post. Kind `rtasks`:
// Tasks. Kind `roomnote` (`trim`): the relay's plain note that it paged the oldest out (25 MB cap per Pond).

export type PostKind = "working" | "done" | "needs" | "message" | "handoff" | "plan";
const POST_KINDS: readonly string[] = ["working", "done", "needs", "message", "handoff", "plan"];
export type TaskState = "waiting" | "working" | "blocked" | "done" | "dropped";
const TASK_STATES: readonly string[] = ["waiting", "working", "blocked", "done", "dropped"];

/** The kinds this module reads and the one it writes. */
export const ROOM_READ_KINDS: readonly string[] = ["room", "rtasks", "rposts", "roomnote"];
export const ROOM_WRITE_KIND = "rposts";
/** What the Room says above its first post once the cloud has paged the oldest out (`EARLIER_LINE` in room-sync.ts). */
export const EARLIER_LINE = "Earlier messages are no longer kept in the cloud";

export interface RoomPost {
  id: string;
  /** The order the Room reads in. */
  seq: number;
  author: { kind: "person" | "agent"; id: string | null; name: string };
  kind: PostKind;
  text: string;
  detail: string | null;
  /** Canvases a Duck made: the web names them and says "Open on your Mac". */
  canvases: { id: string; title: string; kind: string }[];
  replyTo: string | null;
  at: number;
}

export interface RoomTask {
  id: string;
  messageId: string;
  title: string;
  state: TaskState;
  /** Set while the Task waits for the Owner's approval (a Member made it). */
  approver: string | null;
  result: string | null;
  updatedAt: number;
}

const rec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** One `room` document. `feedSeq` orders a post whose document carries no `seq` of its own (a later format). */
export function readRoomPost(value: unknown, feedSeq: number): RoomPost | null {
  if (!rec(value) || !str(value["id"], 80) || !value["id"] || !str(value["text"], 80_000) || !num(value["at"]))
    return null;
  const kind = value["kind"];
  const author = value["author"];
  if (typeof kind !== "string" || !POST_KINDS.includes(kind)) return null;
  if (!rec(author) || (author["kind"] !== "person" && author["kind"] !== "agent")) return null;
  if (!str(author["name"], 100) || !author["name"]) return null;
  const canvases = Array.isArray(value["canvases"])
    ? value["canvases"].flatMap((c) =>
        rec(c) && str(c["id"], 80) && str(c["title"], 200) && str(c["kind"], 40)
          ? [{ id: c["id"], title: c["title"], kind: c["kind"] }]
          : [],
      )
    : [];
  return {
    id: value["id"],
    // The cloud's number is the one order everyone draws; the document's own `seq` is only the Owner's.
    seq: feedSeq,
    author: { kind: author["kind"], id: str(author["id"], 80) ? author["id"] : null, name: author["name"] },
    kind: kind as PostKind,
    text: value["text"],
    detail: str(value["detail"], 80_000) && value["detail"].trim() ? value["detail"] : null,
    canvases,
    replyTo: str(value["replyTo"], 80) && value["replyTo"] ? value["replyTo"] : null,
    at: value["at"],
  };
}

/**
 * A Member's `rposts` message as a Room post (`from` is the member the document's signature names). An ask (Make task, a Duck,
 * leaving, ending a device) is not a post: null.
 */
export function readMemberPost(value: unknown, feedSeq: number, from: { id: string; name: string }): RoomPost | null {
  if (!rec(value) || value["v"] !== 1 || !str(value["id"], 80) || !value["id"]) return null;
  if (!str(value["text"], 80_000) || !value["text"].trim() || !num(value["at"])) return null;
  for (const ask of ["task", "start", "leave", "removeDevice"]) if (value[ask] !== undefined) return null;
  return {
    id: value["id"],
    seq: feedSeq,
    author: { kind: "person", id: from.id, name: from.name },
    kind: "message",
    text: value["text"],
    detail: null,
    canvases: [],
    replyTo: str(value["replyTo"], 80) && value["replyTo"] ? value["replyTo"] : null,
    at: value["at"],
  };
}

export function readRoomTask(value: unknown): RoomTask | null {
  if (!rec(value) || !str(value["id"], 80) || !value["id"] || !str(value["messageId"], 80)) return null;
  if (!str(value["title"], 300) || typeof value["state"] !== "string" || !TASK_STATES.includes(value["state"]))
    return null;
  if (!num(value["updatedAt"])) return null;
  const approval = value["needsApproval"];
  return {
    id: value["id"],
    messageId: value["messageId"],
    title: value["title"],
    state: value["state"] as TaskState,
    approver: rec(approval) && str(approval["name"], 100) ? approval["name"] : null,
    result: str(value["result"], 1000) && value["result"] ? value["result"] : null,
    updatedAt: value["updatedAt"],
  };
}

/** A Member's Room message as the Owner's Mac reads it (`RoomInboxDoc`). `id` is time ordered so the inbox drains oldest first. */
export function inboxDoc(id: string, text: string, at: number, replyTo?: string): Record<string, unknown> {
  return { v: 1, id, text, at, ...(replyTo ? { replyTo } : {}) };
}

/** "Make task" from a Room message (`RoomInboxDoc.task`): the Owner's Mac makes the Task, with approval for a Member. */
export function taskRequestDoc(id: string, messageId: string, at: number): Record<string, unknown> {
  return { v: 1, id, text: "", at, task: { messageId } };
}

/** A Duck a person asks the Owner's Mac to start: one `rposts` ask that waits for it (`MemberAct.start`). */
export function startDuckDoc(
  id: string,
  at: number,
  start: { requestId: string; text: string; agent: "claude" | "codex"; model: string },
): Record<string, unknown> {
  return { v: 1, id, text: "", at, start };
}

/** A Member's message is its own `rposts` document and is never published a second time: its Room post id is the document id. */
export const roomPostIdOf = (inboxId: string): string => inboxId;

/** Whether Make task applies to a post: someone's words, not a Duck's state line. */
export const canMakeTask = (post: RoomPost): boolean => post.kind === "message" && post.author.kind === "person";
