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
import { TaskError, type RoomTask, type RoomTasks, type TaskOrigin, type TaskState } from "../native/room-tasks.js";
import type { NativeStore, RoomPostKind } from "../native/store.js";
import { randomId } from "./crypto.js";
import type { Caps } from "./permissions.js";
import { DOC_ID, FlotillaError, type Role } from "./types.js";
import type { FlotillaService } from "./service.js";

/**
 * The Room reaches Members (docs/ponds.md, "The Room reaches Members"). The Owner's Mac holds the Room; for a shared pond it
 * publishes the Room's posts and its Tasks as sealed documents (kinds `room` and `rtasks`, written only by the Owner), and a
 * Member's Mac reads them and posts through `rposts`, an inbox only the Owner's Mac applies, in order, when it is running.
 * Nothing here decides who may speak beyond the Owner's own switches; it is the same channel, keys and signatures as threads.
 */

/** Posts kept in the cloud: the newest. The Mac's own store keeps the rest. */
export const ROOM_CLOUD_POSTS = 200;
/** A Member's post waits this long for the Owner's Mac; after that it is dropped unread. */
export const ROOM_INBOX_LIFE_MS = 7 * 24 * 3_600_000;
/** What one Member may add to the Room per hour (applied by the Owner's Mac). */
export const ROOM_MEMBER_POSTS_PER_HOUR = 60;
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
}

/** What `FlotillaService.roomPort` hands over: the only door the Room's documents use. */
export interface RoomPort {
  pondId: string;
  projectId: string | null;
  role: Role;
  me: { id: string; name: string };
  ownerId: string;
  now: () => number;
  put(kind: string, docId: string, value: unknown): Promise<void>;
  remove(kind: string, docId: string): Promise<void>;
  list(kind: string): Promise<RoomSignedDoc[]>;
  caps(): Promise<Caps>;
  owner(): Promise<{ name: string; online: boolean }>;
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
  author: { kind: "person" | "agent"; id?: string; name: string };
  kind: RoomPostKind;
  level: "room";
  text: string;
  /** What a one-line post expands to (a `plan` card's spec and plan). Optional: older documents carry none. */
  detail?: string;
  /** The canvases a Duck's Task made or changed (a `done` line); a Member views them, never edits. */
  canvases?: RoomCanvasDoc[];
  /** The `plan` card a person's comment is on. */
  replyTo?: string;
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
  /** Present for "Make task": the Room message to make a Task from (`text` is then empty). */
  task?: { messageId: string };
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
  return {
    v: 1,
    seq: v.seq,
    id: v.id,
    author: { kind: a.kind, ...(typeof a.id === "string" ? { id: a.id } : {}), name: a.name },
    kind: v.kind as RoomPostKind,
    level: "room",
    text: v.text,
    ...(detail ? { detail } : {}),
    ...(canvases.length > 0 ? { canvases } : {}),
    ...(replyTo ? { replyTo } : {}),
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
  if (v.task !== undefined) {
    if (!rec(v.task) || !str(v.task.messageId, 80) || !v.task.messageId) return null;
    return { v: 1, id: v.id, text: "", at: v.at, task: { messageId: v.task.messageId } };
  }
  const replyTo = typeof v.replyTo === "string" && DOC_ID.test(v.replyTo) && v.replyTo.length <= 80 ? v.replyTo : "";
  return { v: 1, id: v.id, text: v.text, at: v.at, ...(replyTo ? { replyTo } : {}) };
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
): RoomDoc | null {
  if (row.level !== "room" || (row.authorKind !== "person" && row.authorKind !== "agent")) return null;
  if (!DOC_ID.test(row.id) || !row.text) return null;
  const canvases = canvasDocsOf(row.canvases);
  return {
    v: 1,
    seq: row.seq,
    id: row.id,
    author: {
      kind: row.authorKind,
      // A Duck's id is its chat's id on the Owner's Mac: it stays there. A person's is their member id.
      // The Owner's own posts are stored as "owner" (this Mac's room); everyone else knows them by their member id.
      ...(row.authorId && row.authorKind === "person"
        ? { id: row.authorId === "owner" && ownerId ? ownerId : row.authorId }
        : {}),
      name: row.authorName.slice(0, 100),
    },
    kind: row.kind,
    level: "room",
    text: row.text.slice(0, ROOM_MAX_TEXT * 4),
    ...(row.detail ? { detail: row.detail.slice(0, ROOM_DETAIL_MAX * 2) } : {}),
    ...(canvases.length > 0 ? { canvases } : {}),
    ...(row.replyTo && DOC_ID.test(row.replyTo) ? { replyTo: row.replyTo } : {}),
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
  posts: Array<RoomDoc & { toSessionId?: undefined }>;
  latestSeq: number;
  threads: [];
  turns: [];
  tasks: RoomTaskDoc[];
  /** Set while the Owner's Mac is not running: the one sentence the Room shows. */
  ownerOffline?: { line: string };
  /** False when the Owner turned off messaging for this Member: the Room is read-only. */
  canPost: boolean;
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
    // A new pond key (someone was removed): what is in the cloud is sealed with the old one, so all of it is written again.
    const onRotated = (pondId: string): void => {
      this.published.delete(pondId);
      void this.enqueue(pondId, () => this.publish(pondId, true)).catch(() => undefined);
    };
    this.o.room.on("post", onPost);
    this.o.jobs.on("job", onTask);
    this.o.service.on("pass", onPass);
    this.o.service.on("rotated", onRotated);
    this.detach.push(
      () => this.o.service.off("rotated", onRotated),
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

  private takeSlot(pondId: string, memberId: string): boolean {
    const key = `${pondId}:${memberId}`;
    const now = this.now();
    const recent = (this.slots.get(key) ?? []).filter((at) => now - at < 3_600_000);
    if (recent.length >= ROOM_MEMBER_POSTS_PER_HOUR) {
      this.slots.set(key, recent);
      return false;
    }
    recent.push(now);
    this.slots.set(key, recent);
    return true;
  }

  /**
   * Applies the Members' waiting posts, oldest first (by the time the Member wrote them, ties by id), each through the
   * Room's own post path, then deletes them. A post that is refused (not a member, a viewer, messaging switched off, too old,
   * empty) is dropped quietly; the same post id can never land twice.
   */
  async drain(pondId: string): Promise<number> {
    const port = this.o.service.roomPort(pondId);
    if (port.role !== "owner" || !port.projectId || !this.o.store.getProject(port.projectId)) return 0;
    const waiting: Array<{ doc: RoomInboxDoc; from: RoomSignedDoc; docId: string }> = [];
    for (const signed of await port.list("rposts")) {
      const doc = readInboxDoc(signed.value);
      if (doc && doc.id === signed.id) waiting.push({ doc, from: signed, docId: signed.id });
      else await port.remove("rposts", signed.id).catch(() => undefined);
    }
    waiting.sort((a, b) => a.doc.at - b.doc.at || (a.docId < b.docId ? -1 : a.docId > b.docId ? 1 : 0));
    let applied = 0;
    for (const { doc, from } of waiting) {
      const now = this.now();
      const fine =
        from.device !== port.ownerId &&
        from.role !== "viewer" &&
        from.caps.message &&
        now - doc.at <= ROOM_INBOX_LIFE_MS &&
        this.takeSlot(pondId, from.device);
      const origin: TaskOrigin = { memberId: from.device, name: from.name, canStart: from.role === "owner" };
      if (fine && doc.task) {
        // "Make task": the Owner's Task rules, with the approval gate for a Member without the start permission.
        try {
          this.o.jobs.fromMessage(port.projectId, doc.task.messageId, undefined, origin);
          applied += 1;
        } catch (error) {
          if (!(error instanceof TaskError)) throw error;
        }
      } else if (fine) {
        const postId = `m-${doc.id}`;
        try {
          this.o.jobs.withMemberPost(postId, origin, () =>
            this.o.room.post({
              projectId: port.projectId!,
              id: postId,
              author: { kind: "person", id: from.device, name: from.name },
              kind: "message",
              level: "room",
              text: doc.text,
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
      await port.remove("rposts", doc.id).catch(() => undefined);
    }
    if (applied > 0) await this.publish(pondId);
    return applied;
  }

  /** Writes the Room's newest posts and its Tasks to the cloud; posts already there are not written again. */
  async publish(pondId: string, all = false): Promise<void> {
    const port = this.o.service.roomPort(pondId);
    if (port.role !== "owner" || !port.projectId || !this.o.store.getProject(port.projectId)) return;
    const projectId = port.projectId;
    const known = all ? new Set<string>() : (this.published.get(pondId) ?? new Set<string>());
    // First time since this Mac started: learn what the cloud already holds, so a restart rewrites nothing it need not.
    const first = !all && !this.published.has(pondId);
    const rows = this.o.store.roomPosts(projectId, { limit: ROOM_CLOUD_POSTS }).filter((r) => !isSqueakLine(r));
    if (first) {
      // A document written before detail, canvases or replyTo travelled is not what the Room holds now: it is written again.
      const want = new Map<string, string>();
      for (const row of rows) {
        const doc = roomDocOf(row, port.ownerId);
        if (doc) want.set(doc.id, JSON.stringify(doc));
      }
      for (const d of await port.list("room")) {
        const read = readRoomDoc(d.value);
        if (!want.has(d.id) || (read && JSON.stringify(read) === want.get(d.id))) known.add(d.id);
      }
    }
    const keep = new Set<string>();
    for (const row of rows) {
      const doc = roomDocOf(row, port.ownerId);
      if (!doc) continue;
      keep.add(doc.id);
      if (known.has(doc.id)) continue;
      await port.put("room", doc.id, doc);
      known.add(doc.id);
    }
    // The cloud keeps only the newest: whatever left the window (or the Room) goes.
    if (all) for (const d of await port.list("room")) if (!keep.has(d.id)) known.add(d.id);
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
      if (!all && current.get(id) === JSON.stringify(doc)) continue;
      await port.put("rtasks", id, doc);
    }
    for (const id of current.keys()) if (!tasks.has(id)) await port.remove("rtasks", id).catch(() => undefined);
    this.published.set(pondId, known);
  }

  // ---- a Member's Mac ----

  /** The Room as the Owner's Mac last published it, plus whether that Mac is running. Never the Owner's own pond. */
  async page(pondId: string, opts: { since?: number; before?: number; limit?: number } = {}): Promise<MemberRoomPage> {
    const port = this.o.service.roomPort(pondId);
    if (port.role === "owner") throw new FlotillaError("That is your own Room: read it from the pond.", 400);
    const caps = await port.caps();
    const limit = Math.min(200, Math.max(1, opts.limit ?? 100));
    const [roomDocs, taskDocs, owner] = await Promise.all([
      port.list("room"),
      port.list("rtasks"),
      port.owner().catch(() => null),
    ]);
    const all: RoomDoc[] = [];
    for (const d of roomDocs) {
      const doc = readRoomDoc(d.value);
      // Only the Owner's Mac writes the Room: a Member's own document here is ignored, whatever it says.
      if (doc && doc.id === d.id && d.device === port.ownerId) all.push(doc);
    }
    all.sort((a, b) => a.seq - b.seq);
    const latestSeq = all.length ? all[all.length - 1]!.seq : 0;
    let posts: RoomDoc[];
    if (opts.since !== undefined) posts = all.filter((p) => p.seq > opts.since!).slice(0, limit);
    else posts = all.filter((p) => p.seq < (opts.before ?? Number.MAX_SAFE_INTEGER)).slice(-limit);
    const tasks: RoomTaskDoc[] = [];
    for (const d of taskDocs) {
      const doc = readRoomTaskDoc(d.value);
      if (doc && taskDocId(doc.id) === d.id && d.device === port.ownerId) tasks.push(doc);
    }
    tasks.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return {
      posts,
      latestSeq,
      threads: [],
      turns: [],
      tasks,
      ...(owner && !owner.online ? { ownerOffline: { line: ownerOfflineLine(owner.name) } } : {}),
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
  ): Promise<{ id: string; offline: boolean; line?: string }> {
    const port = this.o.service.roomPort(pondId);
    if (port.role === "owner") throw new FlotillaError("That is your own Room: post from the pond.", 400);
    if (port.role === "viewer") throw new FlotillaError("A viewer can only watch.", 403);
    let clean: string;
    try {
      clean = Room.cleanText(text, "message");
    } catch (error) {
      if (error instanceof RoomError) throw new FlotillaError(error.message, 400);
      throw error;
    }
    if (replyTo !== undefined && (typeof replyTo !== "string" || !DOC_ID.test(replyTo) || replyTo.length > 80)) {
      throw new FlotillaError("replyTo must be a Room card id");
    }
    const at = this.now();
    const id = `${at.toString(36).padStart(9, "0")}-${randomId(6)}`;
    const doc: RoomInboxDoc = { v: 1, id, text: clean, at, ...(replyTo ? { replyTo } : {}) };
    await port.put("rposts", id, doc);
    const owner = await port.owner().catch(() => null);
    return owner && !owner.online ? { id, offline: true, line: ownerOfflineLine(owner.name) } : { id, offline: false };
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
