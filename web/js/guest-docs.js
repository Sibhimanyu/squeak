// The checks every reader applies to a pond document it opened (src/flotilla/types.ts): a document that fails is dropped,
// never repaired. Compact ports of the Mac's `readMember`, `readThread`, `readThreadEvent` and the rest.

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

export function readMember(v) {
  if (!rec(v) || !s(v.id, 64) || !s(v.name, 100) || !s(v.publicKey, 200)) return null;
  if (!["owner", "member", "viewer"].includes(v.role)) return null;
  if (!(v.nest === null || s(v.nest, 100)) || (v.client !== undefined && v.client !== "mac" && v.client !== "web")) {
    return null;
  }
  if (!n(v.addedAt)) return null;
  return {
    id: v.id,
    name: v.name,
    publicKey: v.publicKey,
    role: v.role,
    nest: v.nest,
    client: v.client,
    addedAt: v.addedAt,
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
    viewing: s(v.viewing, 80) && v.viewing ? v.viewing : undefined,
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
