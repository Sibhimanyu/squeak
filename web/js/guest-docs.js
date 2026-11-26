// The checks every reader applies to a pond document it opened (src/flotilla/types.ts): a document that fails is dropped,
// never repaired. Compact ports of the Mac's `readMember`, `readThread`, `readThreadEvent` and the rest.

import { memberIdOf } from "./guest-crypto.js";

const rec = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const s = (v, max = 500) => typeof v === "string" && v.length <= max;
const n = (v) => typeof v === "number" && Number.isFinite(v);

export const MAX_TEXT = 20_000;
export const THREAD_STATES = ["idle", "working", "waiting", "error"];
/** A hold on a question lapses 2 minutes after its last renewal (as on the Mac). */
export const HOLD_MS = 120_000;
/** Online = a presence heartbeat younger than this. */
export const ONLINE_MS = 45_000;
export const PRESENCE_MS = 60_000;
export const MAX_COMMAND_LIFE_MS = 10 * 60_000;

export function readMeta(v) {
  if (!rec(v) || !s(v.id, 64) || !s(v.name, 200) || !s(v.owner, 64) || !s(v.ownerKey, 200) || !n(v.created))
    return null;
  return { id: v.id, name: v.name, owner: v.owner, ownerKey: v.ownerKey, created: v.created };
}

/**
 * What a role may do, in the shape the pages read (src/flotilla/permissions.ts `capsOf`): a Viewer reads; a Member also
 * messages and answers, and `start` means "may start or ask for a Duck or Task" (a Member's always waits for the
 * Owner's approval). There is no per-Member switch.
 */
export function capsOf(role) {
  const base = { see: true, diffs: true, message: true, answer: true, start: true };
  if (role === "viewer") return { ...base, message: false, answer: false, start: false };
  return base;
}

export const MAX_DEVICES_PER_MEMBER = 8;

/**
 * A member's `devices` list as written (docs/ponds.md, "Members are accounts"): well-formed entries only, duplicates and
 * overflow dropped. An entry's id must also equal the id derived from its key: `trustedDevices` checks that (it needs SHA-256).
 */
export function readDevices(list) {
  const out = [];
  const seen = new Set();
  for (const d of list.slice(0, MAX_DEVICES_PER_MEMBER)) {
    if (!rec(d) || !s(d.id, 64) || !s(d.publicKey, 200) || !s(d.boxKey, 200) || !n(d.addedAt)) continue;
    if (d.client !== "mac" && d.client !== "web" && d.client !== "ios") continue;
    if (!(d.nest === undefined || d.nest === null || s(d.nest, 100))) continue;
    if (seen.has(d.id)) continue;
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

/** The member with only the devices whose id is derived from their key (a document that claims another id is not trusted). */
export async function trustedDevices(member) {
  if (!member.devices) return member;
  const devices = [];
  for (const d of member.devices) if ((await memberIdOf(d.publicKey).catch(() => null)) === d.id) devices.push(d);
  return { ...member, devices };
}

/** One member's keys as a flat list: the first key (unless retired), then `devices`. */
export function devicesOf(member) {
  const primary = member.primaryRetired
    ? []
    : [{ id: member.id, publicKey: member.publicKey, boxKey: member.publicKey, client: member.client ?? "web" }];
  return [...primary, ...(member.devices ?? [])];
}

/** The keys whose signature counts as this member (none for an unknown member). */
export const keysOfMember = (member) => (member ? devicesOf(member).map((d) => d.publicKey) : []);

/** The member a device key id belongs to: its own id, or one of its devices. */
export function memberOfDevice(members, deviceId) {
  const direct = members.get(deviceId);
  if (direct && !direct.primaryRetired) return direct;
  for (const m of members.values()) if ((m.devices ?? []).some((d) => d.id === deviceId)) return m;
  return undefined;
}

export function readMember(v) {
  if (!rec(v) || !s(v.id, 64) || !s(v.name, 100) || !s(v.publicKey, 200)) return null;
  if (!["owner", "member", "viewer"].includes(v.role)) return null;
  if (!(v.nest === null || s(v.nest, 100)) || (v.client !== undefined && v.client !== "mac" && v.client !== "web")) {
    return null;
  }
  if (!n(v.addedAt)) return null;
  const withDevices = Array.isArray(v.devices) && v.devices.length > 0;
  return {
    id: v.id,
    name: v.name,
    publicKey: v.publicKey,
    role: v.role,
    nest: v.nest,
    client: v.client,
    addedAt: v.addedAt,
    ...(withDevices ? { devices: readDevices(v.devices) } : {}),
    ...(withDevices && v.primaryRetired === true ? { primaryRetired: true } : {}),
  };
}

export function readThread(v) {
  if (
    !rec(v) ||
    !s(v.id, 80) ||
    !s(v.title, 300) ||
    !s(v.starter, 64) ||
    !s(v.starterName, 100) ||
    !s(v.nest, 100) ||
    !s(v.agent, 40) ||
    !s(v.model, 100) ||
    !THREAD_STATES.includes(v.state) ||
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
    state: v.state,
    private: v.private,
    mode: v.mode,
    updatedAt: v.updatedAt,
    permissionMode: typeof v.permissionMode === "string" ? v.permissionMode : undefined,
    waitingFor: v.waitingFor === "approval" || v.waitingFor === "question" ? v.waitingFor : undefined,
  };
}

export function readRipple(v) {
  if (!rec(v) || !s(v.id, 80) || !n(v.at) || !s(v.actor, 64) || !s(v.text, 500)) return null;
  return { id: v.id, at: v.at, actor: v.actor, text: v.text };
}

export function readHold(v) {
  if (!rec(v) || !s(v.requestId, 80) || !s(v.by, 64) || !s(v.byName, 100) || !n(v.until)) return null;
  return { requestId: v.requestId, by: v.by, byName: v.byName, until: v.until };
}

export function readPresence(v) {
  if (!rec(v) || !s(v.memberId, 64) || typeof v.online !== "boolean" || !n(v.until)) return null;
  return {
    memberId: v.memberId,
    online: v.online,
    until: v.until,
    at: n(v.at) ? v.at : undefined,
    viewing: s(v.viewing, 80) && v.viewing ? v.viewing : undefined,
  };
}

// The Room (docs/ponds.md, "The Room reaches Members"): ports of `readRoomDoc`, `readRoomTaskDoc` in src/flotilla/room-sync.ts.
export const ROOM_MAX_TEXT = 500;
const POST_KINDS = ["working", "done", "needs", "message", "handoff", "plan"];
const ROOM_DETAIL_MAX = 4000;
const ROOM_CANVAS_CARDS_MAX = 6;
const TASK_STATES = ["waiting", "working", "blocked", "done", "dropped"];
const DOC_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** A canvas card on a done line, as a Member sees it: no folder, just what the card draws and its wire id. */
function readCanvasDocs(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const c of v) {
    if (!rec(c) || !s(c.id, 80) || !c.id || !s(c.title, 200) || !s(c.kind, 40)) continue;
    if (!n(c.artboards) || !Number.isInteger(c.artboards) || c.artboards < 0) continue;
    out.push({ id: c.id, title: c.title, kind: c.kind, artboards: c.artboards });
    if (out.length >= ROOM_CANVAS_CARDS_MAX) break;
  }
  return out;
}

/** `room`/<post id>: a post the Owner's Mac wrote. */
export function readRoomDoc(v) {
  if (!rec(v) || v.v !== 1 || !n(v.seq) || !Number.isInteger(v.seq) || v.seq < 1) return null;
  if (!s(v.id, 80) || !DOC_ID.test(v.id) || !s(v.text, ROOM_MAX_TEXT * 4) || !n(v.at)) return null;
  if (typeof v.kind !== "string" || !POST_KINDS.includes(v.kind) || v.level !== "room") return null;
  const a = v.author;
  if (!rec(a) || (a.kind !== "person" && a.kind !== "agent") || !s(a.name, 100) || !a.name) return null;
  if (a.id !== undefined && !s(a.id, 80)) return null;
  // The newer fields are optional, and a wrong one drops only itself: the post still reads.
  const detail =
    typeof v.detail === "string" && v.detail.trim() && v.detail.length <= ROOM_DETAIL_MAX * 2 ? v.detail : "";
  const replyTo = typeof v.replyTo === "string" && DOC_ID.test(v.replyTo) ? v.replyTo : "";
  const canvases = readCanvasDocs(v.canvases);
  return {
    v: 1,
    seq: v.seq,
    id: v.id,
    author: { kind: a.kind, ...(typeof a.id === "string" ? { id: a.id } : {}), name: a.name },
    kind: v.kind,
    level: "room",
    text: v.text,
    ...(detail ? { detail } : {}),
    ...(canvases.length > 0 ? { canvases } : {}),
    ...(replyTo ? { replyTo } : {}),
    at: v.at,
  };
}

/** A Task's document id: its id with every character a path cannot hold made a dash. */
export const taskDocId = (id) => id.replace(/[^A-Za-z0-9_-]/g, "-");

/** `rtasks`/<task id>: a Task as Members see it. */
export function readRoomTaskDoc(v) {
  if (!rec(v) || v.v !== 1 || !s(v.id, 80) || !v.id || !s(v.messageId, 80)) return null;
  if (!s(v.title, 300) || !s(v.text, 4000) || typeof v.state !== "string" || !TASK_STATES.includes(v.state))
    return null;
  if (!n(v.createdAt) || !n(v.updatedAt)) return null;
  if (v.parentTaskId !== undefined && !s(v.parentTaskId, 80)) return null;
  if (v.result !== undefined && !s(v.result, 1000)) return null;
  return {
    v: 1,
    id: v.id,
    messageId: v.messageId,
    title: v.title,
    text: v.text,
    state: v.state,
    ...(typeof v.parentTaskId === "string" && v.parentTaskId ? { parentTaskId: v.parentTaskId } : {}),
    ...(typeof v.result === "string" && v.result ? { result: v.result } : {}),
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

export function readThreadEvent(v) {
  if (!rec(v) || !n(v.seq) || !n(v.at) || typeof v.type !== "string") return null;
  const base = { seq: v.seq, at: v.at };
  switch (v.type) {
    case "user":
      return s(v.by, 64) && s(v.text, MAX_TEXT)
        ? { ...base, type: "user", by: v.by, text: v.text, byName: s(v.byName, 100) ? v.byName : undefined }
        : null;
    case "agent":
    case "thinking":
      return s(v.text, MAX_TEXT) ? { ...base, type: v.type, text: v.text } : null;
    case "tool":
      return s(v.label, 300) && ["running", "done", "error"].includes(v.state)
        ? { ...base, type: "tool", label: v.label, state: v.state, id: s(v.id, 100) ? v.id : undefined }
        : null;
    case "question":
      return s(v.requestId, 80) && s(v.text, MAX_TEXT) && Array.isArray(v.options) && v.options.every((o) => s(o, 300))
        ? { ...base, type: "question", requestId: v.requestId, text: v.text, options: v.options }
        : null;
    case "approval":
      return s(v.requestId, 80) && s(v.label, 300)
        ? { ...base, type: "approval", requestId: v.requestId, label: v.label }
        : null;
    case "resolved":
      return s(v.requestId, 80) ? { ...base, type: "resolved", requestId: v.requestId } : null;
    case "state":
      return THREAD_STATES.includes(v.state) ? { ...base, type: "state", state: v.state } : null;
    case "changed":
      return n(v.files) && n(v.added) && n(v.removed) && Array.isArray(v.paths)
        ? { ...base, type: "changed", files: v.files, added: v.added, removed: v.removed }
        : null;
    default:
      return null;
  }
}
