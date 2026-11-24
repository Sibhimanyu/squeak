// The Room as a web page says it (docs/ponds.md, "The Room reaches Members"). Everything here is decided apart from the
// page so tests can run it, as guest-model.js does for threads; guest-room-view.js only draws.

/** The kind labels the Mac's Room uses (`RoomPresentation.kindLabel`); a plain message has none. */
export const ROOM_KIND_LABEL = { working: "working on", done: "done", needs: "needs you", handoff: "handoff" };

/** What a Task's state says (the Mac's Task card words). */
export const TASK_WORDS = {
  waiting: "Waiting for a duck",
  working: "A duck is on it",
  blocked: "Blocked",
  done: "Done",
  dropped: "Dropped",
};

/** Shown while the Owner's Mac is not running (the sentence the Mac and the host use, word for word). */
export const ownerOfflineLine = (name) =>
  `${String(name).trim().split(/\s+/)[0] || "Owner"}'s Mac is offline; Ducks will pick this up when it's back`;

/** A duck's line, collapsed: the first sentence (or 90 characters), with whether there is more to expand. */
export function duckLine(text, max = 90) {
  const full = String(text).trim();
  const flat = full.replace(/\s+/g, " ");
  const stop = flat.search(/[.!?](\s|$)/);
  const first = stop >= 0 && stop + 1 <= max ? flat.slice(0, stop + 1) : flat;
  const summary = first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
  return { summary, more: summary !== full };
}

/**
 * The Room's rows, oldest first: a person's message is a bubble (theirs, or the viewer's own); a Duck's post is a collapsed
 * line that expands; a Task sits under the message that made it as a card with its state. A message this browser wrote that
 * the Owner's Mac has not applied yet is a pending row at the end (it becomes its post by id: `m-<doc id>`).
 */
export function roomRows(room, meId, pending = []) {
  const bySource = new Map();
  for (const t of room.tasks) {
    if (!bySource.has(t.messageId)) bySource.set(t.messageId, []);
    bySource.get(t.messageId).push(t);
  }
  const ids = new Set(room.posts.map((p) => p.id));
  const rows = [];
  const card = (t) => ({ kind: "task", id: `task-${t.id}`, task: t, words: TASK_WORDS[t.state], at: t.createdAt });
  for (const p of room.posts) {
    const label = ROOM_KIND_LABEL[p.kind] ?? null;
    if (p.author.kind === "agent") {
      const line = duckLine(p.text);
      rows.push({
        kind: "duck",
        id: p.id,
        who: p.author.name,
        label,
        attention: p.kind === "needs",
        summary: line.summary,
        text: p.text,
        more: line.more,
        at: p.at,
      });
    } else {
      rows.push({
        kind: "person",
        id: p.id,
        who: p.author.name,
        mine: p.author.id === meId,
        label,
        attention: p.kind === "needs",
        text: p.text,
        at: p.at,
      });
    }
    for (const t of bySource.get(p.id) ?? []) rows.push(card(t));
  }
  // A Task whose message left the Room (only the newest are kept) still shows, last.
  for (const t of room.tasks) if (!ids.has(t.messageId)) rows.push(card(t));
  for (const p of pending) {
    if (ids.has(`m-${p.id}`)) continue;
    rows.push({ kind: "person", id: `pending-${p.id}`, who: "You", mine: true, text: p.text, at: p.at, pending: p });
  }
  return rows;
}

/** The pending messages still waiting for the Owner's Mac (those whose post is in the Room are done). */
export const stillPending = (pending, room) => pending.filter((p) => !room.posts.some((x) => x.id === `m-${p.id}`));

/** What the Room's composer says when it is closed (a viewer, messaging switched off), else null. */
export const roomBlock = (room) => (room.canPost ? null : (room.blockedLine ?? "You can read the Room but not post."));
