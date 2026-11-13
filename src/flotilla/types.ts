/**
 * Ponds (docs/ponds.md): the shapes that cross the wire or the host routes, with the checks every reader
 * applies to a document it opened. A document that fails its check is dropped, never repaired.
 */

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
  /** A seam for Catalyst sign-in; unused today. */
  accountId?: string;
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
  /** Made by the host when a thread is read, never stored in a document (docs/ponds.md, "Thread fields"). */
  asks?: boolean;
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

export interface Ripple {
  id: string;
  at: number;
  /** The member whose key signed it. */
  actor: string;
  /** Never repeats the actor's name: a surface draws "<actorName or You> <text>". */
  text: string;
  /** Written by this Mac on another member's behalf (their answer, their joining): who it is about. */
  onBehalf?: { id: string; name: string };
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
  | ({ type: "changed" } & ChangedFiles);

export type ThreadEvent = ThreadEventBody & { seq: number; at: number };

export const MAX_PATHS = 200;
export const MAX_DIFF_BYTES = 64 * 1024;
export const MAX_TEXT = 20_000;
export const KEEP_EVENTS = 500;

/** The only things a member can ask of a thread's starter. Approving and stopping are not among them. */
export const COMMAND_KINDS = ["message", "steer", "answer", "diff"] as const;
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
  return { id: v.id, at: v.at, actor: v.actor, text: v.text, ...(onBehalf ? { onBehalf } : {}) };
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
  for (const key of ["text", "requestId", "answer", "path"] as const) {
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
