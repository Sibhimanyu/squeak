/**
 * Ponds (docs/ponds.md): the shapes that cross the wire or the host routes, with the checks every reader
 * applies to a document it opened. A document that fails its check is dropped, never repaired.
 */

import { memberIdOf as memberIdOfKey } from "./crypto.js";
import { readTimelineEvent, type TimelineEvent } from "../native/timeline.js";

export type Role = "owner" | "member" | "viewer";
export const ROLES: readonly Role[] = ["owner", "member", "viewer"];

export type ThreadState = "idle" | "working" | "waiting" | "error";
export const THREAD_STATES: readonly ThreadState[] = ["idle", "working", "waiting", "error"];

/** `pond` / `meta`. The owner's public key is pinned by every invite, so nobody else can speak for the pond. */
export interface PondMeta {
  id: string;
  name: string;
  /** The owner's member id. */
  owner: string;
  ownerKey: string;
  gitRemote?: string;
  created: number;
}

export interface MemberDoc {
  id: string;
  name: string;
  /** P-256, x963, base64. */
  publicKey: string;
  role: Role;
  /** The member's machine; null for a web guest, who has none and cannot start own threads. */
  nest: string | null;
  /** "mac" (default) or "web": a browser with WebCrypto. */
  client?: "mac" | "web";
  addedAt: number;
  /** The account's email: shown under the name and on hover, never a name by itself. Written by an owner's Mac. */
  email?: string;
  /** A seam for Catalyst sign-in; unused today. */
  accountId?: string;
  /**
   * The member's other devices (docs/ponds.md, "Members are accounts"): added by the owner's Mac for a device signed in to
   * the same account as `accountId`. `publicKey` above is device number one. Absent on every older document.
   */
  devices?: MemberDevice[];
  /** The primary key (`publicKey`) was removed on its own; the devices above carry on. Never set without `devices`. */
  primaryRetired?: true;
}

/** One more device of a member: its own key, the same member (permissions, role and caps are the member's). */
export interface MemberDevice {
  /** `memberIdOf(publicKey)`: derived from the key, never claimed. */
  id: string;
  publicKey: string;
  /** The key a pond key is sealed to; equals `publicKey` for every client today. */
  boxKey: string;
  client: "mac" | "web" | "ios";
  nest?: string | null;
  addedAt: number;
}

export const MAX_DEVICES_PER_MEMBER = 8;

/** One device of a member as a flat list: the primary key first, then `devices`, minus a retired primary. */
export function devicesOf(member: MemberDoc): MemberDevice[] {
  const primary: MemberDevice[] = member.primaryRetired
    ? []
    : [
        {
          id: member.id,
          publicKey: member.publicKey,
          boxKey: member.publicKey,
          client: member.client ?? "mac",
          nest: member.nest,
          addedAt: member.addedAt,
        },
      ];
  return [...primary, ...(member.devices ?? [])];
}

/** The keys whose signature counts as this member (undefined member: none). */
export function keysOfMember(member: MemberDoc | undefined | null): string[] {
  return member ? devicesOf(member).map((d) => d.publicKey) : [];
}

/** The member a device key id belongs to: its own id, or one of its devices. */
export function memberOfDevice(members: Map<string, MemberDoc>, deviceId: string): MemberDoc | undefined {
  const direct = members.get(deviceId);
  if (direct && !direct.primaryRetired) return direct;
  for (const m of members.values()) if ((m.devices ?? []).some((d) => d.id === deviceId)) return m;
  return undefined;
}

export interface JoinRequestDoc {
  requestId: string;
  name: string;
  nest: string | null;
  client?: "mac" | "web";
  publicKey: string;
  /** HMAC of the invite's one-time secret over the request id and key. */
  proof: string;
  /** When the request was made (unix ms). Absent on old requests, which count as oldest. */
  at?: number;
}

export interface PondThread {
  id: string;
  title: string;
  /** The starter's member id. */
  starter: string;
  starterName: string;
  /** The starter's machine name. */
  nest: string;
  agent: string;
  model: string;
  state: ThreadState;
  private: boolean;
  mode: "own" | "shared";
  /** Local only: never written to the cloud. */
  sessionId?: string;
  updatedAt: number;
  /** The session's permission mode, so a guest can see why a message is refused. */
  permissionMode?: string;
  /** The starter's workspace (worktree) name for this chat; absent on older threads and chats with no workspace. */
  workspace?: string;
  /** That workspace's branch. */
  branch?: string;
  /** Who has taken part: the starter and everyone whose message ran, newest activity first. */
  participants?: ThreadParticipant[];
  /** While `waiting`: what the chat waits on. Only a question can be answered by someone other than the starter. */
  waitingFor?: "approval" | "question";
  /** A thread a member asked this (owner's) Mac to start: who, and the id their Mac made the request under. */
  requester?: { memberId: string; requestId: string };
  /** Made by the host when a thread is read, never stored in a document (docs/ponds.md, "Thread fields"). */
  asks?: boolean;
  /** What a waiting thread waits on (null when it is not waiting): the one field a surface needs for "needs you". */
  waitingOn?: "approval" | "question" | null;
  starterOnline?: boolean;
  nestName?: string;
  stateLine?: string;
}

export interface ThreadParticipant {
  memberId: string;
  name: string;
  /** ISO-8601 time of their latest message (the starter's start, until they write). */
  lastAt: string;
}

export const MAX_PARTICIPANTS = 50;

/** Newest activity first; a member appears once. */
export function sortParticipants(list: ThreadParticipant[]): ThreadParticipant[] {
  return [...list].sort((a, b) => (Date.parse(b.lastAt) || 0) - (Date.parse(a.lastAt) || 0));
}

/** What a Ripple is about, so a surface can filter without reading its words. Absent on older Ripples and unsorted ones. */
export const RIPPLE_KINDS = [
  "finished",
  "failed",
  "needs_you",
  "joined",
  "question",
  "left",
  "invite",
  "archived",
  "created",
  "private",
  "other",
] as const;
export type RippleKind = (typeof RIPPLE_KINDS)[number];

export interface Ripple {
  id: string;
  at: number;
  /** The member whose key signed it. */
  actor: string;
  /** Never repeats the actor's name: a surface draws "<actorName or You> <text>". */
  text: string;
  /** Written by this Mac on another member's behalf (their answer, their joining): who it is about. */
  onBehalf?: { id: string; name: string };
  /** Optional: Ripples written before kinds existed have none. An unknown kind reads as absent. */
  kind?: RippleKind;
  /** The request this Ripple answers (a declined Duck start: the Member's Mac drops that request from its waiting list). */
  ref?: string;
}

export interface Hold {
  requestId: string;
  by: string;
  byName: string;
  until: number;
  /** The wire names for the same thing (`by` / `byName`), added when a view is made. */
  heldBy?: string;
  heldByName?: string;
}

export interface PresenceDoc {
  memberId: string;
  online: boolean;
  viewing?: string;
  typing?: string;
  /** When it was written (absent from an older writer: `until` minus PRESENCE_MS). */
  at?: number;
  until: number;
}

export interface ChangedFiles {
  files: number;
  added: number;
  removed: number;
  /** Up to 200. */
  paths: string[];
  /** A file's diff, up to 64 KB, only when asked through a `diff` command. */
  diff?: { path: string; text: string };
  /** Lines changed per file (from the stat), for the starter's own answers; never put in an event. */
  fileStats?: Array<{ path: string; changes: number }>;
}

export type ThreadEventBody =
  | { type: "user"; by: string; byName?: string; author?: { id: string; name: string }; text: string }
  | { type: "agent"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; label: string; state: "running" | "done" | "error"; id?: string }
  | { type: "question"; requestId: string; text: string; options: string[] }
  | { type: "approval"; requestId: string; label: string }
  | { type: "resolved"; requestId: string }
  | { type: "state"; state: ThreadState }
  | ({ type: "changed" } & ChangedFiles)
  /**
   * One event of the starter's chat timeline, with the host's own `seq` inside (`ev.seq`): a member's Mac reduces
   * these with the same reducer the starter's Mac uses, and a copy it saw twice or out of order changes nothing.
   * The other kinds above stay for Macs that do not know this one.
   */
  | { type: "timeline"; ev: TimelineEvent };

export type ThreadEvent = ThreadEventBody & { seq: number; at: number };

export const MAX_PATHS = 200;
export const MAX_DIFF_BYTES = 64 * 1024;
export const MAX_TEXT = 20_000;
export const KEEP_EVENTS = 1200;

/** The only things a member can ask of a thread's starter. Approving and stopping are not among them. */
export const COMMAND_KINDS = ["message", "steer", "answer", "diff", "start", "artifacts", "artifact"] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

export interface CommandDoc {
  id: string;
  kind: CommandKind;
  threadId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  text?: string;
  requestId?: string;
  answer?: string;
  path?: string;
  /** `start` only (a new thread on the owner's Mac): its title, agent and model. `threadId` is empty. No permission mode. */
  title?: string;
  agent?: string;
  model?: string;
}

/** One answer to a `diff` command: written by the starter's Mac beside the thread's events, deleted after `DIFF_RESULT_TTL_MS`. */
export interface DiffResult {
  /** The command's id. */
  id: string;
  threadId: string;
  /** The member who asked (anyone in the pond can read the document; it says who it was for). */
  to: string;
  at: number;
  expiresAt: number;
  /** Always present: what changed, per file (up to 200). */
  files: Array<{ path: string; changes?: number }>;
  summary?: { files: number; added: number; removed: number };
  /** The one file's patch the member asked for, up to `MAX_DIFF_RESULT_BYTES` of text. */
  patch?: { path: string; text: string; truncated: boolean };
}

/**
 * The owner's artifacts for a member (`artifacts` lists, `artifact` fetches one file). Pond-level commands: no thread.
 * Answers are sealed, owner-signed documents in `tevents` (`art-r<command id>`, and `art-r<command id>-<n>` for a file's
 * chunks: a relay document holds under 900 KB, so a file travels in pieces). All of them live `ARTIFACT_RESULT_TTL_MS`.
 */
export const ARTIFACT_RESULT_TTL_MS = 10 * 60_000;
/** Largest file the owner's Mac hands to a member. */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
/** A chunk's raw bytes: base64 twice (the value, then the sealed box) must stay under the relay's 900 KB box. */
export const ARTIFACT_CHUNK_BYTES = 360 * 1024;
export const MAX_ARTIFACT_ITEMS = 150;
/** Files one member may ask for per pond per hour. */
export const ARTIFACT_FETCH_PER_HOUR = 30;
/** An artifact's id on the wire: a hash of its path on the owner's Mac, never the path itself. */
export const ARTIFACT_ID = /^[a-f0-9]{16}$/;

export interface SharedArtifact {
  /** The wire id (see `ARTIFACT_ID`). */
  path: string;
  name: string;
  kind: string;
  duckName?: string;
  branch?: string;
  source: "shown" | "found";
  modifiedAt: number;
  size: number;
}

export interface ArtifactsResult {
  /** The command's id. */
  id: string;
  /** The member who asked. */
  to: string;
  at: number;
  expiresAt: number;
  ownerName?: string;
  items: SharedArtifact[];
  /** A plain sentence when the owner's Mac refused the request (a file gone, too large). */
  error?: string;
  /** Present for an `artifact` command: the file sent, in `chunks` documents. */
  file?: { path: string; name: string; kind: string; size: number; chunks: number; sha256: string };
}

export function readArtifactsResult(v: unknown): ArtifactsResult | null {
  if (!rec(v) || !rec(v.artifacts)) return null;
  const r = v.artifacts;
  if (!s(r.id, 80) || !s(r.to, 64) || !n(r.at) || !n(r.expiresAt) || !Array.isArray(r.items)) return null;
  const items: SharedArtifact[] = [];
  for (const i of r.items.slice(0, MAX_ARTIFACT_ITEMS)) {
    if (!rec(i) || !s(i.path, 16) || !ARTIFACT_ID.test(i.path) || !s(i.name, 300) || !s(i.kind, 20)) continue;
    if (!n(i.modifiedAt) || !n(i.size) || (i.source !== "shown" && i.source !== "found")) continue;
    items.push({
      path: i.path,
      name: i.name,
      kind: i.kind,
      source: i.source,
      modifiedAt: i.modifiedAt,
      size: i.size,
      ...(s(i.duckName, 120) ? { duckName: i.duckName } : {}),
      ...(s(i.branch, 200) ? { branch: i.branch } : {}),
    });
  }
  const f = r.file;
  const file =
    rec(f) &&
    s(f.path, 16) &&
    ARTIFACT_ID.test(f.path) &&
    s(f.name, 300) &&
    s(f.kind, 20) &&
    n(f.size) &&
    n(f.chunks) &&
    f.size <= MAX_ARTIFACT_BYTES &&
    f.chunks >= 0 &&
    f.chunks <= Math.ceil(MAX_ARTIFACT_BYTES / ARTIFACT_CHUNK_BYTES) &&
    s(f.sha256, 64)
      ? { path: f.path, name: f.name, kind: f.kind, size: f.size, chunks: f.chunks, sha256: f.sha256 }
      : undefined;
  return {
    id: r.id,
    to: r.to,
    at: r.at,
    expiresAt: r.expiresAt,
    ...(s(r.ownerName, 120) ? { ownerName: r.ownerName } : {}),
    items,
    ...(s(r.error, 200) ? { error: r.error } : {}),
    ...(file ? { file } : {}),
  };
}

/** One piece of a file: `{ chunk: { id, n, data } }`, `data` base64 of up to `ARTIFACT_CHUNK_BYTES` bytes. */
export function readArtifactChunk(v: unknown): { id: string; n: number; data: string } | null {
  if (!rec(v) || !rec(v.chunk)) return null;
  const c = v.chunk;
  if (!s(c.id, 80) || !n(c.n) || !s(c.data, 700_000)) return null;
  return { id: c.id, n: c.n, data: c.data };
}

export const MAX_DIFF_RESULT_BYTES = 1024 * 1024;
export const DIFF_RESULT_TTL_MS = 10 * 60_000;
/** Threads one member may ask an owner's Mac to start in an hour. */
export const START_PER_HOUR = 10;

export function readDiffResult(v: unknown): DiffResult | null {
  if (!rec(v) || !rec(v.result)) return null;
  const r = v.result;
  if (!s(r.id, 80) || !s(r.threadId, 80) || !s(r.to, 64) || !n(r.at) || !n(r.expiresAt) || !Array.isArray(r.files))
    return null;
  const files: DiffResult["files"] = [];
  for (const f of r.files.slice(0, MAX_PATHS)) {
    if (rec(f) && s(f.path, 500)) files.push({ path: f.path, ...(n(f.changes) ? { changes: f.changes } : {}) });
  }
  const sum = r.summary;
  const patch = r.patch;
  return {
    id: r.id,
    threadId: r.threadId,
    to: r.to,
    at: r.at,
    expiresAt: r.expiresAt,
    files,
    ...(rec(sum) && n(sum.files) && n(sum.added) && n(sum.removed)
      ? { summary: { files: sum.files, added: sum.added, removed: sum.removed } }
      : {}),
    ...(rec(patch) && s(patch.path, 500) && s(patch.text, MAX_DIFF_RESULT_BYTES)
      ? { patch: { path: patch.path, text: patch.text, truncated: patch.truncated === true } }
      : {}),
  };
}

export const MAX_COMMAND_LIFE_MS = 10 * 60_000;
export const MAX_SKEW_MS = 2 * 60_000;
/** A hold on a question lapses this long after its last renewal. */
export const HOLD_MS = 2 * 60_000;
export const PRESENCE_MS = 60_000;
/** A member is online while their presence heartbeat is younger than this. */
export const ONLINE_MS = 45_000;

const rec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const s = (v: unknown, max = 500): v is string => typeof v === "string" && v.length <= max;
const n = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Document ids the stores accept (`[A-Za-z0-9_-]{1,80}`). */
export const DOC_ID = /^[A-Za-z0-9_-]{1,80}$/;
export const POND_ID = /^[A-Za-z0-9_-]{22,64}$/;

export const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);

export function readMeta(v: unknown): PondMeta | null {
  if (!rec(v) || !s(v.id, 64) || !s(v.name, 200) || !s(v.owner, 64) || !s(v.ownerKey, 200) || !n(v.created))
    return null;
  if (v.gitRemote !== undefined && !s(v.gitRemote, 500)) return null;
  return {
    id: v.id,
    name: v.name,
    owner: v.owner,
    ownerKey: v.ownerKey,
    created: v.created,
    ...(v.gitRemote ? { gitRemote: v.gitRemote as string } : {}),
  };
}

export function readMember(v: unknown): MemberDoc | null {
  if (!rec(v) || !s(v.id, 64) || !s(v.name, 100) || !s(v.publicKey, 200) || !isRole(v.role)) return null;
  if (!(v.nest === null || s(v.nest, 100)) || (v.client !== undefined && v.client !== "mac" && v.client !== "web"))
    return null;
  if (!n(v.addedAt)) return null;
  return {
    id: v.id,
    name: v.name,
    publicKey: v.publicKey,
    role: v.role,
    nest: v.nest,
    ...(v.client ? { client: v.client } : {}),
    addedAt: v.addedAt,
    ...(typeof v.accountId === "string" ? { accountId: v.accountId } : {}),
    ...(s(v.email, 200) ? { email: v.email as string } : {}),
    ...(Array.isArray(v.devices) && v.devices.length > 0 ? { devices: readDevices(v.devices) } : {}),
    ...(v.primaryRetired === true && Array.isArray(v.devices) && v.devices.length > 0
      ? { primaryRetired: true as const }
      : {}),
  };
}

function readDevices(list: unknown[]): MemberDevice[] {
  const out: MemberDevice[] = [];
  const seen = new Set<string>();
  for (const d of list.slice(0, MAX_DEVICES_PER_MEMBER)) {
    if (!rec(d) || !s(d.id, 64) || !s(d.publicKey, 200) || !s(d.boxKey, 200) || !n(d.addedAt)) continue;
    if (d.client !== "mac" && d.client !== "web" && d.client !== "ios") continue;
    if (!(d.nest === undefined || d.nest === null || s(d.nest, 100))) continue;
    // An id is derived from the key: a document that claims another is not trusted.
    if (memberIdOfKey(d.publicKey) !== d.id || seen.has(d.id)) continue;
    seen.add(d.id);
    out.push({
      id: d.id,
      publicKey: d.publicKey,
      boxKey: d.boxKey,
      client: d.client,
      ...(d.nest !== undefined ? { nest: d.nest } : {}),
      addedAt: d.addedAt,
    });
  }
  return out;
}

/** What the relay writes beside a pond when a device of a member's account asks to be added (relay-owned, plain JSON). */
export interface DeviceRequestDoc {
  reqId: string;
  userId: string;
  email: string;
  name: string;
  publicKey: string;
  boxKey: string;
  client: "mac" | "web" | "ios";
  nest: string | null;
  at: number;
}

/** The relay's note that an account removed a device (relay-owned, plain JSON, in the Pond's `devreqs`). */
export function readDeviceGone(v: unknown): { deviceId: string; userId: string } | null {
  if (!rec(v) || v.v !== 1 || v.gone !== true || !s(v.reqId, 64) || !s(v.userId, 64)) return null;
  return { deviceId: v.reqId, userId: v.userId };
}

export function readDeviceRequest(v: unknown): DeviceRequestDoc | null {
  if (!rec(v) || v.v !== 1 || !s(v.reqId, 64) || !s(v.userId, 64) || !s(v.publicKey, 200) || !s(v.boxKey, 200))
    return null;
  if (!n(v.at) || (v.client !== "mac" && v.client !== "web" && v.client !== "ios")) return null;
  if (!(v.nest === null || s(v.nest, 100))) return null;
  return {
    reqId: v.reqId,
    userId: v.userId,
    email: typeof v.email === "string" ? v.email.slice(0, 200) : "",
    name: typeof v.name === "string" ? v.name.slice(0, 100) : "",
    publicKey: v.publicKey,
    boxKey: v.boxKey,
    client: v.client,
    nest: v.nest,
    at: v.at,
  };
}

export function readJoinRequest(v: unknown): JoinRequestDoc | null {
  if (!rec(v) || !s(v.requestId, 80) || !s(v.name, 100) || !s(v.publicKey, 200) || !s(v.proof, 200)) return null;
  if (!(v.nest === null || s(v.nest, 100)) || (v.client !== undefined && v.client !== "mac" && v.client !== "web"))
    return null;
  return {
    requestId: v.requestId,
    name: v.name,
    nest: v.nest,
    publicKey: v.publicKey,
    proof: v.proof,
    ...(v.client ? { client: v.client } : {}),
    ...(typeof v.at === "number" && Number.isFinite(v.at) ? { at: v.at } : {}),
  };
}

export function readThread(v: unknown): PondThread | null {
  if (
    !rec(v) ||
    !s(v.id, 80) ||
    !s(v.title, 300) ||
    !s(v.starter, 64) ||
    !s(v.starterName, 100) ||
    !s(v.nest, 100) ||
    !s(v.agent, 40) ||
    !s(v.model, 100) ||
    !THREAD_STATES.includes(v.state as ThreadState) ||
    typeof v.private !== "boolean" ||
    (v.mode !== "own" && v.mode !== "shared") ||
    !n(v.updatedAt)
  ) {
    return null;
  }
  return {
    id: v.id,
    title: v.title,
    starter: v.starter,
    starterName: v.starterName,
    nest: v.nest,
    agent: v.agent,
    model: v.model,
    state: v.state as ThreadState,
    private: v.private,
    mode: v.mode,
    updatedAt: v.updatedAt,
    ...(typeof v.permissionMode === "string" ? { permissionMode: v.permissionMode } : {}),
    ...(s(v.workspace, 200) ? { workspace: v.workspace } : {}),
    ...(s(v.branch, 250) ? { branch: v.branch } : {}),
    ...(Array.isArray(v.participants) ? { participants: readParticipants(v.participants) } : {}),
    ...(v.waitingFor === "approval" || v.waitingFor === "question" ? { waitingFor: v.waitingFor } : {}),
    ...(rec(v.requester) && s(v.requester.memberId, 64) && s(v.requester.requestId, 80)
      ? { requester: { memberId: v.requester.memberId, requestId: v.requester.requestId } }
      : {}),
  };
}

function readParticipants(list: unknown[]): ThreadParticipant[] {
  const out: ThreadParticipant[] = [];
  for (const p of list.slice(0, MAX_PARTICIPANTS)) {
    if (rec(p) && s(p.memberId, 64) && s(p.name, 100) && s(p.lastAt, 40))
      out.push({ memberId: p.memberId, name: p.name, lastAt: p.lastAt });
  }
  return sortParticipants(out);
}

export function readRipple(v: unknown): Ripple | null {
  if (!rec(v) || !s(v.id, 80) || !n(v.at) || !s(v.actor, 64) || !s(v.text, 500)) return null;
  const who = v.onBehalf;
  const onBehalf = rec(who) && s(who.id, 64) && s(who.name, 100) ? { id: who.id, name: who.name } : null;
  const kind = (RIPPLE_KINDS as readonly unknown[]).includes(v.kind) ? (v.kind as RippleKind) : null;
  return {
    id: v.id,
    at: v.at,
    actor: v.actor,
    text: v.text,
    ...(onBehalf ? { onBehalf } : {}),
    ...(kind ? { kind } : {}),
    ...(s(v.ref, 80) ? { ref: v.ref as string } : {}),
  };
}

export function readHold(v: unknown): Hold | null {
  if (!rec(v) || !s(v.requestId, 80) || !s(v.by, 64) || !s(v.byName, 100) || !n(v.until)) return null;
  return { requestId: v.requestId, by: v.by, byName: v.byName, until: v.until };
}

export function readPresence(v: unknown): PresenceDoc | null {
  if (!rec(v) || !s(v.memberId, 64) || typeof v.online !== "boolean" || !n(v.until)) return null;
  return {
    memberId: v.memberId,
    online: v.online,
    until: v.until,
    ...(n(v.at) ? { at: v.at } : {}),
    ...(s(v.viewing, 80) && v.viewing ? { viewing: v.viewing } : {}),
    ...(s(v.typing, 80) && v.typing ? { typing: v.typing } : {}),
  };
}

export function readThreadEvent(v: unknown): ThreadEvent | null {
  if (!rec(v) || !n(v.seq) || !n(v.at) || typeof v.type !== "string") return null;
  const base = { seq: v.seq, at: v.at };
  switch (v.type) {
    case "user":
      return s(v.by, 64) && s(v.text, MAX_TEXT)
        ? {
            ...base,
            type: "user",
            by: v.by,
            text: v.text,
            ...(s(v.byName, 100) ? { byName: v.byName, author: { id: v.by, name: v.byName } } : {}),
          }
        : null;
    case "agent":
    case "thinking":
      return s(v.text, MAX_TEXT) ? { ...base, type: v.type, text: v.text } : null;
    case "tool":
      return s(v.label, 300) && (v.state === "running" || v.state === "done" || v.state === "error")
        ? { ...base, type: "tool", label: v.label, state: v.state, ...(s(v.id, 100) ? { id: v.id } : {}) }
        : null;
    case "question":
      return s(v.requestId, 80) && s(v.text, MAX_TEXT) && Array.isArray(v.options) && v.options.every((o) => s(o, 300))
        ? { ...base, type: "question", requestId: v.requestId, text: v.text, options: v.options as string[] }
        : null;
    case "approval":
      return s(v.requestId, 80) && s(v.label, 300)
        ? { ...base, type: "approval", requestId: v.requestId, label: v.label }
        : null;
    case "resolved":
      return s(v.requestId, 80) ? { ...base, type: "resolved", requestId: v.requestId } : null;
    case "state":
      return THREAD_STATES.includes(v.state as ThreadState)
        ? { ...base, type: "state", state: v.state as ThreadState }
        : null;
    case "timeline": {
      const ev = readTimelineEvent(v.ev);
      return ev ? { ...base, type: "timeline", ev } : null;
    }
    case "changed": {
      if (!n(v.files) || !n(v.added) || !n(v.removed) || !Array.isArray(v.paths)) return null;
      if (!v.paths.every((p) => s(p, 500)) || v.paths.length > MAX_PATHS) return null;
      const diff =
        rec(v.diff) && s(v.diff.path, 500) && s(v.diff.text, MAX_DIFF_BYTES)
          ? { path: v.diff.path, text: v.diff.text }
          : undefined;
      return {
        ...base,
        type: "changed",
        files: v.files,
        added: v.added,
        removed: v.removed,
        paths: v.paths as string[],
        ...(diff ? { diff } : {}),
      };
    }
    default:
      return null;
  }
}

/** Unknown kinds (`approve`, `stop`, anything) are not commands: null. */
export function readCommand(v: unknown): CommandDoc | null {
  if (!rec(v) || !s(v.id, 80) || !(COMMAND_KINDS as readonly unknown[]).includes(v.kind) || !s(v.threadId, 80))
    return null;
  if (!n(v.issuedAt) || !n(v.expiresAt) || !s(v.nonce, 80) || v.nonce.length < 8) return null;
  for (const key of ["text", "requestId", "answer", "path", "title", "agent", "model"] as const) {
    if (v[key] !== undefined && !s(v[key], MAX_TEXT)) return null;
  }
  const cmd: CommandDoc = {
    id: v.id,
    kind: v.kind as CommandKind,
    threadId: v.threadId,
    issuedAt: v.issuedAt,
    expiresAt: v.expiresAt,
    nonce: v.nonce,
  };
  if (typeof v.text === "string") cmd.text = v.text;
  if (typeof v.requestId === "string") cmd.requestId = v.requestId;
  if (typeof v.answer === "string") cmd.answer = v.answer;
  if (typeof v.path === "string") cmd.path = v.path;
  if (typeof v.title === "string") cmd.title = v.title.slice(0, 200);
  if (typeof v.agent === "string") cmd.agent = v.agent.slice(0, 40);
  if (typeof v.model === "string") cmd.model = v.model.slice(0, 100);
  return cmd;
}

export class FlotillaError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
