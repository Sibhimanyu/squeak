import { EventEmitter } from "node:events";

import { logger } from "../utils/logger.js";
import {
  isSqueakLine,
  Room,
  RoomError,
  ROOM_CANVAS_CARDS_MAX,
  ROOM_DETAIL_MAX,
  ROOM_MAX_TEXT,
} from "../native/room.js";
import { AttachmentError, checkAttachments } from "../native/room-attachments.js";
import { blobView, readBlobRefs, type BlobRef } from "./blobs.js";
import { TaskError, type RoomTask, type RoomTasks, type TaskOrigin, type TaskState } from "../native/room-tasks.js";
import type { NativeStore, RoomPostKind } from "../native/store.js";
import { randomId } from "./crypto.js";
import type { Caps } from "./permissions.js";
import { DOC_ID, FlotillaError, type Role } from "./types.js";
import type { FlotillaService } from "./service.js";
import { readMemberAct, type MemberAct, type Ripple } from "./types.js";
import { readStanding, shownName, type Standing } from "./standing.js";

/**
 * The Room reaches Members (docs/ponds.md, "The Room reaches Members"). The Owner's Mac holds the Room; for a shared pond it
 * publishes the Room's posts and its Tasks as sealed documents (kinds `room` and `rtasks`, written only by the Owner), and a
 * Member's Mac reads them and posts through `rposts`, an inbox only the Owner's Mac applies, in order, when it is running.
 * Nothing here decides who may speak beyond the Owner's own switches; it is the same channel, keys and signatures as threads.
 */

/**
 * A queued ask that the cloud did not number (a store with no change feed) waits this long for the Owner's Mac; after that it
 * is dropped unread. One the cloud numbered waits as long as it takes: the order is the cloud's, and it is applied once.
 */
export const ROOM_INBOX_LIFE_MS = 7 * 24 * 3_600_000;
/** What one Member may add to the Room per hour (applied by the Owner's Mac). */
export const ROOM_MEMBER_POSTS_PER_HOUR = 60;
/** What the Room says above its first post once the cloud has paged the oldest out (25 MB cap per Pond). */
export const EARLIER_LINE = "Earlier messages are no longer kept in the cloud";
/** What a Member sees while the Owner's Mac is not running. */
export const ownerOfflineLine = (name: string): string =>
  `${name.trim().split(/\s+/)[0] || "Owner"}'s Mac is offline; Ducks will pick this up when it's back`;

/** A document the port opened and checked: sealed with the pond key, signed by a current member, with what they may do now. */
export interface RoomSignedDoc {
  id: string;
  value: unknown;
  device: string;
  role: Role;
  name: string;
  caps: Caps;
  /** The cloud's number for this document (the Pond's one order); absent on a store with no change feed. */
  seq?: number;
  /** When the writer sealed it. */
  at?: number;
}

/** What `FlotillaService.roomPort` hands over: the only door the Room's documents use. */
export interface RoomPort {
  pondId: string;
  projectId: string | null;
  role: Role;
  me: { id: string; name: string };
  ownerId: string;
  now: () => number;
  /** The Owner's Mac: how a post's author stands now (left, or former once their account is gone); nothing for the rest. */
  standing?: (authorId: string) => Standing | undefined;
  put(kind: string, docId: string, value: unknown): Promise<void>;
  remove(kind: string, docId: string): Promise<void>;
  list(kind: string): Promise<RoomSignedDoc[]>;
  caps(): Promise<Caps>;
  owner(): Promise<{ name: string; online: boolean }>;
  /** Seals picture or file bytes under the current Pond key and keeps them in the cloud for the post document `ref`; the blob id. */
  putBlob(bytes: Buffer, ref: { kind: "room" | "rposts"; doc: string }): Promise<string>;
  /** One blob opened (null when the cloud no longer holds it or this Mac cannot open it). */
  getBlob(id: string): Promise<Buffer | null>;
  /** The relay's note that it paged the oldest posts out of the cloud's Room (25 MB cap), or null. */
  note(): Promise<{ removed: number; before: number; at: number } | null>;
  /** The Owner's Mac: the highest cloud seq of a queued ask it has applied, and a way to move it on. */
  ingested(): number;
  setIngested(seq: number): void;
  /** A Member's Mac: start requests the Owner declined. */
  noteAnswered(requestIds: string[]): void;
}

/** A canvas card as a Member sees it: no folder (that stays on the Owner's Mac), just what the card draws and the wire id. */
export interface RoomCanvasDoc {
  id: string;
  title: string;
  kind: string;
  artboards: number;
}

/** `room`/<post id>: one Room post, written by the Owner's Mac. `seq` is the Owner's own, so every Mac orders alike. */
export interface RoomDoc {
  v: 1;
  seq: number;
  id: string;
  /** `standing`: the person is out of the Pond ("left", or "former" once their account is gone); the name is theirs as it was. */
  author: { kind: "person" | "agent"; id?: string; name: string; standing?: Standing };
  kind: RoomPostKind;
  level: "room";
  text: string;
  /** What a one-line post expands to (a `plan` card's spec and plan). Optional: older documents carry none. */
  detail?: string;
  /** The canvases a Duck's Task made or changed (a `done` line); a Member views them, never edits. */
  canvases?: RoomCanvasDoc[];
  /** The `plan` card a person's comment is on. */
  replyTo?: string;
  /** Pictures and files of a person's message: sealed blobs in the cloud, named by id (docs/cloud-layer.md); never the bytes. */
  blobs?: BlobRef[];
  at: number;
}

/** `rposts`/<time-ordered id>: a Member's message waiting for the Owner's Mac. Signed by the Member's key. */
export interface RoomInboxDoc {
  v: 1;
  id: string;
  text: string;
  at: number;
  /** A comment on this `plan` card (a Room post id); the Owner's Mac delivers it to that Duck like the Owner's own comment. */
  replyTo?: string;
  /** The Member's pictures and files, sealed blobs in the cloud (`text` may then be empty). */
  blobs?: BlobRef[];
  /** Present for "Make task": the Room message to make a Task from (`text` is then empty). */
  task?: { messageId: string };
  /** A Member's other asks, which wait in the same queue (`text` is empty): leaving, ending a device, a Duck. */
  act?: MemberAct;
}

/** `rtasks`/<task id>: a Task as Members see it (no discussion, no place, no Duck's chat). Written by the Owner's Mac. */
export interface RoomTaskDoc {
  v: 1;
  id: string;
  messageId: string;
  title: string;
  text: string;
  state: TaskState;
  /** Set while the Task waits for the Owner's approval (a Member made it without the start permission). */
  needsApproval?: { name: string };
  parentTaskId?: string;
  result?: string;
  createdAt: number;
  updatedAt: number;
}

const rec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const POST_KINDS: readonly string[] = ["working", "done", "needs", "message", "handoff", "plan"];
const TASK_STATES: readonly string[] = ["waiting", "working", "blocked", "done", "dropped"];

export function readRoomDoc(v: unknown): RoomDoc | null {
  if (!rec(v) || v.v !== 1 || !num(v.seq) || !Number.isInteger(v.seq) || v.seq < 1) return null;
  if (!str(v.id, 80) || !DOC_ID.test(v.id) || !str(v.text, ROOM_MAX_TEXT * 4) || !num(v.at)) return null;
  if (typeof v.kind !== "string" || !POST_KINDS.includes(v.kind) || v.level !== "room") return null;
  const a = v.author;
  if (!rec(a) || (a.kind !== "person" && a.kind !== "agent") || !str(a.name, 100) || !a.name) return null;
  if (a.id !== undefined && !str(a.id, 80)) return null;
  // The newer fields are optional, and a wrong one drops only itself: the post still reads.
  const detail =
    typeof v.detail === "string" && v.detail.trim() && v.detail.length <= ROOM_DETAIL_MAX * 2 ? v.detail : "";
  const replyTo = typeof v.replyTo === "string" && DOC_ID.test(v.replyTo) && v.replyTo.length <= 80 ? v.replyTo : "";
  const canvases = readCanvasDocs(v.canvases);
  const blobs = readBlobRefs(v.blobs);
  return {
    v: 1,
    seq: v.seq,
    id: v.id,
    author: {
      kind: a.kind,
      ...(typeof a.id === "string" ? { id: a.id } : {}),
      name: a.name,
      ...(readStanding(a.standing) ? { standing: readStanding(a.standing)! } : {}),
    },
    kind: v.kind as RoomPostKind,
    level: "room",
    text: v.text,
    ...(detail ? { detail } : {}),
    ...(canvases.length > 0 ? { canvases } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(blobs.length > 0 ? { blobs } : {}),
    at: v.at,
  };
}

function readCanvasDocs(v: unknown): RoomCanvasDoc[] {
  if (!Array.isArray(v)) return [];
  const out: RoomCanvasDoc[] = [];
  for (const c of v) {
    if (!rec(c) || !str(c.id, 80) || !c.id || !str(c.title, 200) || !str(c.kind, 40)) continue;
    if (!num(c.artboards) || !Number.isInteger(c.artboards) || c.artboards < 0) continue;
    out.push({ id: c.id, title: c.title, kind: c.kind, artboards: c.artboards });
    if (out.length >= ROOM_CANVAS_CARDS_MAX) break;
  }
  return out;
}

export function readInboxDoc(v: unknown): RoomInboxDoc | null {
  if (!rec(v) || v.v !== 1 || !str(v.id, 80) || !DOC_ID.test(v.id) || !str(v.text, ROOM_MAX_TEXT * 4) || !num(v.at)) {
    return null;
  }
  const act = readMemberAct(v);
  if (act) return { v: 1, id: v.id, text: "", at: v.at, act };
  if (v.task !== undefined) {
    if (!rec(v.task) || !str(v.task.messageId, 80) || !v.task.messageId) return null;
    return { v: 1, id: v.id, text: "", at: v.at, task: { messageId: v.task.messageId } };
  }
  const replyTo = typeof v.replyTo === "string" && DOC_ID.test(v.replyTo) && v.replyTo.length <= 80 ? v.replyTo : "";
  const blobs = readBlobRefs(v.blobs);
  return {
    v: 1,
    id: v.id,
    text: v.text,
    at: v.at,
    ...(replyTo ? { replyTo } : {}),
    ...(blobs.length > 0 ? { blobs } : {}),
  };
}

/** A Task's id is `task:<uuid>` on the Owner's Mac; the document id is the same with every character a path cannot hold made a dash. */
export const taskDocId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, "-");

export function readRoomTaskDoc(v: unknown): RoomTaskDoc | null {
  if (!rec(v) || v.v !== 1 || !str(v.id, 80) || !v.id || !str(v.messageId, 80)) return null;
  if (!str(v.title, 300) || !str(v.text, 4000) || typeof v.state !== "string" || !TASK_STATES.includes(v.state)) {
    return null;
  }
  if (!num(v.createdAt) || !num(v.updatedAt)) return null;
  if (v.parentTaskId !== undefined && !str(v.parentTaskId, 80)) return null;
  const na = v.needsApproval;
  if (na !== undefined && (!rec(na) || !str(na.name, 100))) return null;
  if (v.result !== undefined && !str(v.result, 1000)) return null;
  return {
    v: 1,
    id: v.id,
    messageId: v.messageId,
    title: v.title,
    text: v.text,
    state: v.state as TaskState,
    ...(rec(na) && typeof na.name === "string" ? { needsApproval: { name: na.name } } : {}),
    ...(typeof v.parentTaskId === "string" && v.parentTaskId ? { parentTaskId: v.parentTaskId } : {}),
    ...(typeof v.result === "string" && v.result ? { result: v.result } : {}),
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

/** The Owner's Mac: a Room post as a document, or null for one Members do not see (Squeak's own lines, Duck-to-Duck talk). */
export function roomDocOf(
  row: {
    seq: number;
    id: string;
    authorKind: string;
    authorId: string | null;
    authorName: string;
    kind: RoomPostKind;
    level: string;
    text: string;
    at: number;
    detail?: string | null;
    replyTo?: string | null;
    /** JSON, `RoomCanvasCard[]`. */
    canvases?: string | null;
  },
  ownerId?: string,
  /** `attached`: the post has pictures or files (a post of only a picture has no text); `blobs`: their cloud references, once uploaded. */
  opts: {
    attached?: boolean;
    blobs?: BlobRef[];
    standing?: ((authorId: string) => Standing | undefined) | undefined;
  } = {},
): RoomDoc | null {
  // A line Squeak says about the Pond (someone joined, left, was removed) travels as a message from Squeak.
  const line = row.authorKind === "squeak" && row.id.startsWith("ln-");
  if (row.level !== "room" || (row.authorKind !== "person" && row.authorKind !== "agent" && !line)) return null;
  const blobs = opts.blobs ?? [];
  if (!DOC_ID.test(row.id) || (!row.text && !opts.attached && blobs.length === 0)) return null;
  const canvases = canvasDocsOf(row.canvases);
  return {
    v: 1,
    seq: row.seq,
    id: row.id,
    author: {
      kind: line ? "agent" : (row.authorKind as "person" | "agent"),
      // A Duck's id is its chat's id on the Owner's Mac: it stays there. A person's is their member id.
      // The Owner's own posts are stored as "owner" (this Mac's room); everyone else knows them by their member id.
      ...(row.authorId && row.authorKind === "person"
        ? { id: row.authorId === "owner" && ownerId ? ownerId : row.authorId }
        : {}),
      name: row.authorName.slice(0, 100),
      // A person who left or was removed: their post stays, and every reader marks it.
      ...(row.authorKind === "person" && row.authorId && opts.standing?.(row.authorId)
        ? { standing: opts.standing(row.authorId)! }
        : {}),
    },
    kind: row.kind,
    level: "room",
    text: row.text.slice(0, ROOM_MAX_TEXT * 4),
    ...(row.detail ? { detail: row.detail.slice(0, ROOM_DETAIL_MAX * 2) } : {}),
    ...(canvases.length > 0 ? { canvases } : {}),
    ...(row.replyTo && DOC_ID.test(row.replyTo) ? { replyTo: row.replyTo } : {}),
    ...(blobs.length > 0 ? { blobs } : {}),
    at: row.at,
  };
}

/** A done line's canvas cards for the cloud: the folder is dropped, the wire id stays. */
function canvasDocsOf(raw: string | null | undefined): RoomCanvasDoc[] {
  if (!raw) return [];
  try {
    return readCanvasDocs(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

export function taskDocOf(t: RoomTask): RoomTaskDoc | null {
  if (t.proposed || !t.id || t.id.length > 80) return null;
  return {
    v: 1,
    id: t.id,
    messageId: t.messageId.slice(0, 80),
    title: t.title.slice(0, 300),
    text: t.text.slice(0, 4000),
    state: t.state,
    ...(t.approval && t.state === "waiting" ? { needsApproval: { name: t.approval.name } } : {}),
    ...(t.parentTaskId ? { parentTaskId: t.parentTaskId.slice(0, 80) } : {}),
    ...(t.result ? { result: t.result.slice(0, 1000) } : {}),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

/** What a Member's Mac draws: the same shape as the Owner's Room page, plus who is away. */
export interface MemberRoomPage {
  /** `attachments`: a post's pictures and files in the Owner's own Room shape, each fetched from the cloud when viewed. */
  posts: Array<RoomDoc & { toSessionId?: undefined; attachments?: Array<BlobRef & { url: string }> }>;
  latestSeq: number;
  threads: [];
  turns: [];
  tasks: RoomTaskDoc[];
  /** Set while the Owner's Mac is not running: the one sentence the Room shows. */
  ownerOffline?: { line: string };
  /** False when the Owner turned off messaging for this Member: the Room is read-only. */
  canPost: boolean;
  /** Set when the cloud paged the oldest posts out (25 MB cap): the one sentence the Room shows above its first post. */
  earlier?: { line: string };
}

export interface RoomSyncOptions {
  service: FlotillaService;
  room: Room;
  jobs: RoomTasks;
  store: NativeStore;
  now?: () => number;
  /** How long a burst of Room changes waits before it is published (default 400 ms). */
  debounceMs?: number;
}

/** Emits `member` (pond id) when a Member's Mac read something new in the Room. */
export class RoomSync extends EventEmitter {
  private readonly now: () => number;
  private readonly debounceMs: number;
  /** Per pond: the post ids already in the cloud (posts never change) and when the cloud was last compared. */
  private readonly published = new Map<string, Set<string>>();
  /** Per pond: Members' post ids (`m-<doc id>`) the cloud numbered. Those are already in the Room as the Member's own document. */
  private readonly inboxPosts = new Map<string, Set<string>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly slots = new Map<string, number[]>();
  private detach: Array<() => void> = [];

  constructor(private readonly o: RoomSyncOptions) {
    super();
    this.setMaxListeners(0);
    this.now = o.now ?? Date.now;
    this.debounceMs = o.debounceMs ?? 400;
  }

  start(): void {
    const onPost = (row: { projectId: string }): void => this.changed(row.projectId);
    const onTask = (f: { projectId: string }): void => this.changed(f.projectId);
    const onPass = (pondId: string): Promise<void> => this.pass(pondId);
    // What happened in the Pond (someone joined, left, was removed): said in the Room, where every Member reads it.
    const onLine = (pondId: string, ripple: Ripple): void => this.line(pondId, ripple);
    this.o.room.on("post", onPost);
    this.o.jobs.on("job", onTask);
    this.o.service.on("pass", onPass);
    this.o.service.on("line", onLine);
    // Someone left, was removed or came back: their posts are written again with (or without) the mark. A Pond this device is
    // out of keeps nothing in memory.
    const onDeparted = (pondId: string): void => {
      this.published.delete(pondId);
      this.inboxPosts.delete(pondId);
      const project = this.o.service.projectOfPond?.(pondId);
      if (project) this.changed(project);
    };
    const onWiped = (pondId: string): void => {
      this.published.delete(pondId);
      this.inboxPosts.delete(pondId);
      this.slots.delete(pondId);
    };
    this.o.service.on("departed", onDeparted);
    this.o.service.on("wiped", onWiped);
    this.detach.push(
      () => this.o.service.off("departed", onDeparted),
      () => this.o.service.off("wiped", onWiped),
      () => this.o.service.off("line", onLine),
      () => this.o.room.off("post", onPost),
      () => this.o.jobs.off("job", onTask),
      () => this.o.service.off("pass", onPass),
    );
  }

  stop(): void {
    for (const off of this.detach) off();
    this.detach = [];
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Resolves when everything queued so far has been applied and published (tests). */
  async idle(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    const ponds = [...this.timers.keys()];
    this.timers.clear();
    for (const id of ponds) await this.enqueue(id, () => this.publish(id));
    await Promise.all([...this.chains.values()]);
  }

  // ---- the Owner's Mac ----

  /** A Room post or Task changed on this Mac: publish soon (a burst is one write pass). */
  private changed(projectId: string): void {
    const pondId = this.o.service.sharedPondOfProject(projectId);
    if (!pondId || this.timers.has(pondId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(pondId);
      void this.enqueue(pondId, () => this.publish(pondId)).catch(() => undefined);
    }, this.debounceMs);
    timer.unref?.();
    this.timers.set(pondId, timer);
  }

  /** After a refresh: the Owner's Mac applies the inbox then publishes; a Member's Mac tells its open Room to look. */
  private async pass(pondId: string): Promise<void> {
    try {
      let role: Role;
      try {
        role = this.o.service.roomPort(pondId).role;
      } catch {
        return; // a local pond, or one this Mac is not in yet
      }
      if (role === "owner") {
        await this.enqueue(pondId, async () => {
          await this.drain(pondId);
          if (!this.published.has(pondId)) await this.publish(pondId);
        });
      } else {
        this.emit("member", pondId);
      }
    } catch (error) {
      logger.warn("room sync pass failed", { pond: pondId, error: error instanceof Error ? error.message : "failed" });
    }
  }

  /** One at a time per pond: a second listing must see the first one's deletions, or a post is applied twice. */
  private enqueue(pondId: string, run: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(pondId) ?? Promise.resolve();
    const next = prev.then(run, run);
    this.chains.set(
      pondId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private inbox(pondId: string): Set<string> {
    let set = this.inboxPosts.get(pondId);
    if (!set) this.inboxPosts.set(pondId, (set = new Set()));
    return set;
  }

  /** The Room says what happened in the Pond (the Owner's Mac only; a Member's Mac has no say in it). */
  private line(pondId: string, ripple: Ripple): void {
    let port: RoomPort;
    try {
      port = this.o.service.roomPort(pondId);
    } catch {
      return; // a local pond: no Members to tell
    }
    if (port.role !== "owner" || !port.projectId || !this.o.store.getProject(port.projectId)) return;
    const who = ripple.onBehalf?.name ?? port.me.name;
    const text = ripple.text.toLowerCase().startsWith(`${who.toLowerCase()} `) ? ripple.text : `${who} ${ripple.text}`;
    try {
      this.o.room.post({
        projectId: port.projectId,
        // A declined Duck request keeps the request's id in the line, so the Member's Mac can stop saying "Waiting".
        id: ripple.ref ? `ln-dec-${ripple.ref}` : `ln-${ripple.id}`,
        author: { kind: "squeak", name: "Squeak" },
        kind: "message",
        level: "room",
        text: text.slice(0, ROOM_MAX_TEXT),
        at: ripple.at,
      });
    } catch (error) {
      if (!(error instanceof RoomError)) throw error;
    }
  }

  /** Posts a Member added in the hour up to `at`, counting this one: the limit is by the Member's own clock, so a backlog applied late is not cut short. */
  private takeSlot(pondId: string, memberId: string, at: number): boolean {
    const key = `${pondId}:${memberId}`;
    const recent = (this.slots.get(key) ?? []).filter((t) => at - t < 3_600_000 && t <= at);
    if (recent.length >= ROOM_MEMBER_POSTS_PER_HOUR) {
      this.slots.set(key, recent);
      return false;
    }
    recent.push(at);
    this.slots.set(key, recent);
    return true;
  }

  /**
   * Applies the Members' queued asks, in the cloud's order (seq; the Member's own time on a store with no feed): a message goes
   * through the Room's own post path as post `m-<doc id>` (so a replay can never post twice), "Make task" through the Task rules, a
   * leave, a device removal or a Duck request through the service. Nothing is deleted: a numbered document stays (it is the
   * Member's post in the cloud's Room) and the Owner's Mac remembers how far it has applied. A refused ask (not a member, a
   * viewer, messaging switched off, over the hourly limit, empty) is skipped quietly.
   */
  async drain(pondId: string): Promise<number> {
    const port = this.o.service.roomPort(pondId);
    if (port.role !== "owner" || !port.projectId || !this.o.store.getProject(port.projectId)) return 0;
    const cursor = port.ingested();
    const waiting: Array<{ doc: RoomInboxDoc; from: RoomSignedDoc; seq: number | undefined }> = [];
    for (const signed of await port.list("rposts")) {
      const doc = readInboxDoc(signed.value);
      // Leaving, ending a device and a Duck request are applied by the service itself (`applyQueuedActs`), on its own cursor.
      if (doc?.act) continue;
      if (!doc || doc.id !== signed.id) {
        if (signed.seq === undefined) await port.remove("rposts", signed.id).catch(() => undefined);
        continue;
      }
      if (signed.seq !== undefined) this.inbox(pondId).add(`m-${signed.id}`);
      if (signed.seq !== undefined && signed.seq <= cursor) continue;
      waiting.push({ doc, from: signed, seq: signed.seq });
    }
    const numbered = waiting.every((w) => w.seq !== undefined);
    waiting.sort((a, b) =>
      numbered ? a.seq! - b.seq! : a.doc.at - b.doc.at || (a.doc.id < b.doc.id ? -1 : a.doc.id > b.doc.id ? 1 : 0),
    );
    let applied = 0;
    for (const { doc, from, seq } of waiting) {
      const now = this.now();
      if (from.device === port.ownerId) {
        // The Owner's own key never queues an ask.
      } else if (
        from.role !== "viewer" &&
        from.caps.message &&
        (seq !== undefined || now - doc.at <= ROOM_INBOX_LIFE_MS) &&
        this.takeSlot(pondId, from.device, doc.at)
      ) {
        const origin: TaskOrigin = { memberId: from.device, name: from.name, canStart: from.role === "owner" };
        if (doc.task) {
          // "Make task": the Owner's Task rules, with the approval gate for a Member without the start permission.
          try {
            this.o.jobs.fromMessage(port.projectId, doc.task.messageId, undefined, origin);
            applied += 1;
          } catch (error) {
            if (!(error instanceof TaskError)) throw error;
          }
        } else {
          const postId = `m-${doc.id}`;
          const files = await this.fetchFiles(port, doc.blobs);
          try {
            this.o.jobs.withMemberPost(postId, origin, () =>
              this.o.room.post({
                projectId: port.projectId!,
                id: postId,
                author: { kind: "person", id: from.device, name: from.name },
                kind: "message",
                level: "room",
                text: doc.text,
                ...(files.length > 0 ? { attachments: files } : {}),
                ...(doc.replyTo ? { replyTo: doc.replyTo } : {}),
                // The Member's own time, never later than now.
                at: Math.min(doc.at, now),
              }),
            );
            applied += 1;
          } catch (error) {
            if (!(error instanceof RoomError)) throw error;
          }
        }
      }
      if (seq !== undefined) port.setIngested(seq);
      else await port.remove("rposts", doc.id).catch(() => undefined);
    }
    if (applied > 0) await this.publish(pondId);
    return applied;
  }

  /**
   * Writes the whole Room and its Tasks to the cloud; a post already there is not written again. A Member's own posts are not
   * written when the cloud numbered them: they are already there, as the Member's signed documents. The cloud pages out the oldest past its cap, and
   * after it has, a post older than the oldest one it still holds is not sent again.
   */
  async publish(pondId: string): Promise<void> {
    const port = this.o.service.roomPort(pondId);
    if (port.role !== "owner" || !port.projectId || !this.o.store.getProject(port.projectId)) return;
    const projectId = port.projectId;
    const known = this.published.get(pondId) ?? new Set<string>();
    const first = !this.published.has(pondId);
    const rows = this.o.store.roomPosts(projectId, { since: 0, limit: 1_000_000 }).filter((r) => !isSqueakLine(r));
    const attached = this.o.room.attachments.forPosts(
      projectId,
      rows.map((r) => r.id),
    );
    let floor = 0;
    if (first) {
      for (const d of await port.list("rposts")) if (d.seq !== undefined) this.inbox(pondId).add(`m-${d.id}`);
      // First time since this Mac started: learn what the cloud already holds, so a restart rewrites nothing it need not.
      const want = new Map<string, string>();
      for (const row of rows) {
        const doc = roomDocOf(row, port.ownerId, { attached: attached.has(row.id), standing: port.standing });
        if (doc) want.set(doc.id, JSON.stringify(doc));
      }
      const held = await port.list("room");
      for (const d of held) {
        // A copy of a post the Member's own signed document already carries (written while they were out of the Pond, marked
        // "(left)") goes: the Member's document is the post, and it carries no mark once they are back.
        if (this.inbox(pondId).has(d.id)) {
          await port.remove("room", d.id).catch(() => undefined);
          continue;
        }
        const read = readRoomDoc(d.value);
        // A document written before detail, canvases or replyTo travelled is not what the Room holds now: it is written again.
        if (
          !want.has(d.id) ||
          // The blob references are not compared: each upload makes new ids, and the pictures are not sent again on a restart.
          (read &&
            JSON.stringify({ ...read, seq: 0, blobs: undefined }) ===
              JSON.stringify({ ...JSON.parse(want.get(d.id)!), seq: 0, blobs: undefined }))
        )
          known.add(d.id);
      }
      if (await port.note().catch(() => null)) {
        const times = [
          ...held.map((d) => readRoomDoc(d.value)?.at),
          ...(await port.list("rposts")).map((d) => d.at),
        ].filter((t): t is number => typeof t === "number");
        if (times.length > 0) floor = Math.min(...times);
      }
    }
    const keep = new Set<string>();
    const inboxIds = this.inbox(pondId);
    for (const row of rows) {
      const doc = roomDocOf(row, port.ownerId, { attached: attached.has(row.id), standing: port.standing });
      // A Member's post the cloud numbered is in the cloud already, as their own signed document: not written twice.
      if (!doc || inboxIds.has(doc.id)) continue;
      keep.add(doc.id);
      if (known.has(doc.id) || doc.at < floor) continue;
      const views = attached.get(row.id);
      if (views && views.length > 0) {
        // Pictures first, so the post never names a blob that is not there. One the cloud refuses (too big, the Pond is
        // full, no bucket yet) stays on this Mac; a post of only that picture has nothing to say and is not sent.
        const refs: BlobRef[] = [];
        for (const v of views) {
          const found = this.o.room.attachments.read(projectId, v.id);
          if (!found) continue;
          const ref = await this.upload(port, "room", doc.id, found.bytes, v);
          if (ref) refs.push(ref);
        }
        if (refs.length > 0) doc.blobs = refs;
        else if (!doc.text) {
          known.add(doc.id);
          continue;
        }
      }
      await port.put("room", doc.id, doc);
      known.add(doc.id);
    }
    // A post that left the Room (cleared) leaves the cloud too; the cloud's own paging is not ours to repeat.
    for (const id of [...known]) {
      if (keep.has(id)) continue;
      await port.remove("room", id).catch(() => undefined);
      known.delete(id);
    }
    const tasks = new Map<string, RoomTaskDoc>();
    for (const t of this.o.jobs.list(projectId)) {
      const doc = taskDocOf(t);
      if (doc) tasks.set(taskDocId(doc.id), doc);
    }
    const current = new Map<string, string>();
    for (const d of await port.list("rtasks")) {
      const read = readRoomTaskDoc(d.value);
      if (read) current.set(d.id, JSON.stringify(read));
      else current.set(d.id, "");
    }
    for (const [id, doc] of tasks) {
      if (current.get(id) === JSON.stringify(doc)) continue;
      await port.put("rtasks", id, doc);
    }
    for (const id of current.keys()) if (!tasks.has(id)) await port.remove("rtasks", id).catch(() => undefined);
    this.published.set(pondId, known);
  }

  // ---- a Member's Mac ----

  /**
   * The Room as the cloud holds it: the Owner's posts and every Member's own posts, in the cloud's one order, whether or not the
   * Owner's Mac is running (when it is away, Members still read each other at once). Never the Owner's own pond.
   */
  async page(pondId: string, opts: { since?: number; before?: number; limit?: number } = {}): Promise<MemberRoomPage> {
    const port = this.o.service.roomPort(pondId);
    if (port.role === "owner") throw new FlotillaError("That is your own Room: read it from the pond.", 400);
    const caps = await port.caps();
    const limit = Math.min(200, Math.max(1, opts.limit ?? 100));
    const [roomDocs, taskDocs, inboxDocs, owner, note] = await Promise.all([
      port.list("room"),
      port.list("rtasks"),
      port.list("rposts"),
      port.owner().catch(() => null),
      port.note().catch(() => null),
    ]);
    const entries: Array<{ post: RoomDoc; seq: number | undefined }> = [];
    const have = new Set<string>();
    const declined: string[] = [];
    for (const d of roomDocs) {
      const doc = readRoomDoc(d.value);
      // Only the Owner's Mac writes the Room: a Member's own document here is ignored, whatever it says.
      if (!doc || doc.id !== d.id || d.device !== port.ownerId) continue;
      have.add(doc.id);
      if (doc.id.startsWith("ln-dec-")) declined.push(doc.id.slice("ln-dec-".length));
      entries.push({ post: doc, seq: d.seq });
    }
    for (const d of inboxDocs) {
      const doc = readInboxDoc(d.value);
      // A Member's message is a post as it stands; their other asks (a Task, leaving, a Duck) are not Room lines.
      if (!doc || doc.id !== d.id || doc.task || doc.act || (!doc.text && !doc.blobs) || d.device === port.ownerId)
        continue;
      const id = `m-${doc.id}`;
      if (have.has(id)) continue; // an older Owner's Mac also published it: that copy is the one
      entries.push({
        post: {
          v: 1,
          seq: 0,
          id,
          author: { kind: "person", id: d.device, name: d.name },
          kind: "message",
          level: "room",
          text: doc.text,
          ...(doc.replyTo ? { replyTo: doc.replyTo } : {}),
          ...(doc.blobs ? { blobs: doc.blobs } : {}),
          at: doc.at,
        },
        seq: d.seq,
      });
    }
    if (declined.length > 0) port.noteAnswered(declined);
    const numbered = entries.every((e) => e.seq !== undefined);
    // With no cloud numbers: by time, then the Owner's own order for its posts, then id.
    const own = (e: { post: RoomDoc; seq: number | undefined }): number =>
      e.post.id.startsWith("m-") ? Number.MAX_SAFE_INTEGER : e.post.seq;
    entries.sort((a, b) =>
      numbered
        ? a.seq! - b.seq!
        : a.post.at - b.post.at || own(a) - own(b) || (a.post.id < b.post.id ? -1 : a.post.id > b.post.id ? 1 : 0),
    );
    const all: RoomDoc[] = entries.map((e, i) => ({ ...e.post, seq: numbered ? e.seq! : i + 1 }));
    const latestSeq = all.length ? all[all.length - 1]!.seq : 0;
    let posts: RoomDoc[];
    if (opts.since !== undefined) posts = all.filter((p) => p.seq > opts.since!).slice(0, limit);
    else posts = all.filter((p) => p.seq < (opts.before ?? Number.MAX_SAFE_INTEGER)).slice(-limit);
    // A person who left reads "<name> (left)" (or "Former member"): the mark was written with the post by the Owner's Mac.
    const marked = posts.map((p) =>
      p.author.standing ? { ...p, author: { ...p.author, name: shownName(p.author.name, p.author.standing) } } : p,
    );
    const shown = marked.map((p) => (p.blobs ? { ...p, attachments: p.blobs.map((b) => blobView(pondId, b)) } : p));
    const tasks: RoomTaskDoc[] = [];
    for (const d of taskDocs) {
      const doc = readRoomTaskDoc(d.value);
      if (doc && taskDocId(doc.id) === d.id && d.device === port.ownerId) tasks.push(doc);
    }
    tasks.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return {
      posts: shown,
      latestSeq,
      threads: [],
      turns: [],
      tasks,
      ...(owner && !owner.online ? { ownerOffline: { line: ownerOfflineLine(owner.name) } } : {}),
      ...(note ? { earlier: { line: EARLIER_LINE } } : {}),
      canPost: caps.message && port.role !== "viewer",
    };
  }

  /**
   * A Member's message: signed and written to the inbox. It shows in the Room when the Owner's Mac applies it (at once when
   * that Mac is running); while it is away the post waits in the cloud, in order, and `offline` says so.
   */
  async post(
    pondId: string,
    text: unknown,
    replyTo?: unknown,
    /** Pictures and files as the Mac sends them (`{name, data}` base64, as the Owner's Room takes): sealed here, kept in the cloud as blobs. */
    attachments?: unknown,
  ): Promise<{ id: string; offline: boolean; line?: string }> {
    const port = this.o.service.roomPort(pondId);
    if (port.role === "owner") throw new FlotillaError("That is your own Room: post from the pond.", 400);
    if (port.role === "viewer") throw new FlotillaError("A viewer can only watch.", 403);
    let clean: string;
    let checked: ReturnType<typeof checkAttachments>;
    try {
      checked = checkAttachments(attachments);
      // A picture or file alone is a message: the text may be empty then.
      clean = checked.length > 0 && typeof text === "string" && !text.trim() ? "" : Room.cleanText(text, "message");
    } catch (error) {
      if (error instanceof RoomError || error instanceof AttachmentError) throw new FlotillaError(error.message, 400);
      throw error;
    }
    if (replyTo !== undefined && (typeof replyTo !== "string" || !DOC_ID.test(replyTo) || replyTo.length > 80)) {
      throw new FlotillaError("replyTo must be a Room card id");
    }
    const at = this.now();
    const id = `${at.toString(36).padStart(9, "0")}-${randomId(6)}`;
    const blobs: BlobRef[] = [];
    for (const c of checked) {
      // A refusal (too big, the Pond is full) is said plainly and nothing is posted: the Member decides what to send instead.
      const ref = await this.upload(port, "rposts", id, c.bytes, c, true);
      if (ref) blobs.push(ref);
    }
    const doc: RoomInboxDoc = {
      v: 1,
      id,
      text: clean,
      at,
      ...(replyTo ? { replyTo } : {}),
      ...(blobs.length > 0 ? { blobs } : {}),
    };
    await port.put("rposts", id, doc);
    const owner = await port.owner().catch(() => null);
    return owner && !owner.online ? { id, offline: true, line: ownerOfflineLine(owner.name) } : { id, offline: false };
  }

  /**
   * Seals one picture or file and keeps it in the cloud for the post document `docId`; its reference for the post. A refusal of the
   * cloud (too big, the Pond is full, no bucket yet) is `null` and logged, or, with `loud`, the plain sentence as an error.
   */
  private async upload(
    port: RoomPort,
    kind: "room" | "rposts",
    docId: string,
    bytes: Buffer,
    meta: {
      kind: "image" | "file";
      name: string;
      mime: string;
      width?: number | undefined;
      height?: number | undefined;
    },
    loud = false,
  ): Promise<BlobRef | null> {
    try {
      const id = await port.putBlob(bytes, { kind, doc: docId });
      return {
        id,
        kind: meta.kind,
        name: meta.name,
        mime: meta.mime,
        size: bytes.length,
        ...(meta.width && meta.height ? { width: meta.width, height: meta.height } : {}),
      };
    } catch (error) {
      if (!(error instanceof FlotillaError) || error.extra.blob !== "refused") throw error;
      if (loud) throw error;
      logger.warn("a picture stays on this Mac", { pond: port.pondId, error: error.message });
      return null;
    }
  }

  /** A post's blobs as the Room takes attachments (`{name, data}`): the ones the cloud still holds and this Mac can open. */
  private async fetchFiles(
    port: RoomPort,
    blobs: BlobRef[] | undefined,
  ): Promise<Array<{ name: string; data: string }>> {
    const out: Array<{ name: string; data: string }> = [];
    for (const b of blobs ?? []) {
      const bytes = await port.getBlob(b.id).catch(() => null);
      if (bytes) out.push({ name: b.name, data: bytes.toString("base64") });
    }
    return out;
  }

  /**
   * One picture or file of a post, fetched from the cloud when someone views it (a Member's Mac; the Owner's own Room holds them
   * on disk). Found by its id among the posts' references, so a blob that no post names is never handed out. Null when the cloud
   * paged it out.
   */
  async blob(pondId: string, blobId: string): Promise<{ ref: BlobRef; bytes: Buffer } | null> {
    const port = this.o.service.roomPort(pondId);
    let ref: BlobRef | undefined;
    for (const kind of ["room", "rposts"]) {
      for (const d of await port.list(kind)) {
        const doc = kind === "room" ? readRoomDoc(d.value) : readInboxDoc(d.value);
        ref = doc?.blobs?.find((b) => b.id === blobId);
        if (ref) break;
      }
      if (ref) break;
    }
    if (!ref) return null;
    const bytes = await port.getBlob(blobId);
    return bytes ? { ref, bytes } : null;
  }

  /**
   * "Make task" from a Member's Mac: the same sealed inbox as a message. The Owner's Mac makes the Task when it applies it; a
   * Member without the start permission gets a Task that waits for the Owner's approval.
   */
  async makeTask(pondId: string, messageId: unknown): Promise<{ id: string; offline: boolean; line?: string }> {
    const port = this.o.service.roomPort(pondId);
    if (port.role === "owner") throw new FlotillaError("That is your own Room: make the task from the pond.", 400);
    if (port.role === "viewer") throw new FlotillaError("A viewer can only watch.", 403);
    if (typeof messageId !== "string" || !messageId || messageId.length > 80) {
      throw new FlotillaError("messageId must be a Room message id");
    }
    const at = this.now();
    const id = `${at.toString(36).padStart(9, "0")}-${randomId(6)}`;
    const doc: RoomInboxDoc = { v: 1, id, text: "", at, task: { messageId } };
    await port.put("rposts", id, doc);
    const owner = await port.owner().catch(() => null);
    return owner && !owner.online ? { id, offline: true, line: ownerOfflineLine(owner.name) } : { id, offline: false };
  }

  /** Calls `onChange` whenever this Mac's pond pass ran (something may have changed). Returns the unsubscribe. */
  watch(pondId: string, onChange: () => void): () => void {
    const listener = (id: string): void => {
      if (id === pondId) onChange();
    };
    this.on("member", listener);
    return () => this.off("member", listener);
  }
}
