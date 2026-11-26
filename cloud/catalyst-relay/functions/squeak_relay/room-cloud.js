// The Room in the cloud (docs/spec.md, "Cloud": What the cloud keeps; ADR 0005; issue #122). The whole Room is kept sealed: the
// Owner's posts (`room`) and every Member's own signed posts (`rposts`), all stamped by the Pond's feed, so every Member reads
// a post at once and in the one order whether or not the Owner's Mac is running. The relay cannot read them, so it keeps the
// Room under a byte cap per Pond and pages out the OLDEST by seq when it grows past it, leaving a plain note a reader shows
// ("Earlier messages are no longer kept in the cloud").
//
// The size is a counter row, not a scan: no transactions here, so two writers can both add and an overwrite is counted twice.
// That only ever overcounts, and the overcount is repaired the one time it matters: when the counter passes the cap the Room is
// measured exactly, and only a Room that really is over the cap loses posts.
//
// Relay-owned rows: `roombytes/<pond>` (the counter, not under channels/, so no path reaches it) and
// `channels/<pond>/roomnote/trim` (the note: plain JSON, written by the relay only, stamped into the feed so it reaches every
// device, readable by every Member).
const CAP_BYTES = 25 * 1024 * 1024;
/** After a page-out the Room is brought down to this share of the cap, so the next posts do not page out again at once. */
const KEEP_SHARE = 0.9;
const ROOM_KINDS = ["room", "rposts"];
const COUNTER_PK = "roombytes";
const NOTE_KIND = "roomnote";
const NOTE_DOC = "trim";

/** `createRoomCloud({ store, feed, capBytes? })`: `wrote()` after a Room document is stored; `note()` reads the page-out note. */
function createRoomCloud({ store, feed, capBytes = CAP_BYTES }) {
  const kindPk = (channel, kind) => `channels/${channel}/${kind}`;
  const seqOf = (json) => {
    try {
      const n = Number(JSON.parse(json).seq);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  };

  async function measure(channel) {
    const rows = [];
    for (const kind of ROOM_KINDS)
      for (const r of await store.list(kindPk(channel, kind)))
        rows.push({ kind, doc: r.doc, seq: seqOf(r.json), bytes: Buffer.byteLength(r.json) });
    rows.sort((a, b) => a.seq - b.seq || (a.doc < b.doc ? -1 : a.doc > b.doc ? 1 : 0));
    return { rows, total: rows.reduce((n, r) => n + r.bytes, 0) };
  }

  async function readCounter(channel) {
    const raw = await store.get(COUNTER_PK, channel);
    if (raw === null || raw === undefined) return null;
    try {
      const n = Number(JSON.parse(raw).bytes);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }
  const writeCounter = (channel, bytes) => store.put(COUNTER_PK, channel, JSON.stringify({ bytes }));

  /** Pages out the oldest posts until the Room is under KEEP_SHARE of the cap; returns what it did, or null when it fits. */
  async function trim(channel) {
    const { rows, total } = await measure(channel);
    if (total <= capBytes) {
      await writeCounter(channel, total);
      return null;
    }
    let left = total;
    let removed = 0;
    let before = 0;
    for (const r of rows) {
      if (left <= capBytes * KEEP_SHARE) break;
      // A tombstone in the feed first (so every mirror drops the post), then the row.
      await feed.append(channel, { kind: r.kind, id: r.doc, doc: null });
      await store.del(kindPk(channel, r.kind), r.doc);
      left -= r.bytes;
      removed += 1;
      before = Math.max(before, r.seq);
    }
    await writeCounter(channel, left);
    const earlier = await readNote(channel);
    const note = {
      v: 1,
      removed: (earlier ? earlier.removed : 0) + removed,
      before: Math.max(before, earlier ? earlier.before : 0),
      at: Date.now(),
    };
    // The note is stamped like any content, so a device that follows the feed learns of the page-out without asking.
    await feed.append(channel, { kind: NOTE_KIND, id: NOTE_DOC, doc: note });
    await store.put(kindPk(channel, NOTE_KIND), NOTE_DOC, JSON.stringify(note));
    return { removed, left };
  }

  /** The page-out note (`{v, removed, before, at}`), or null when nothing was ever paged out. */
  async function readNote(channel) {
    const raw = await store.get(kindPk(channel, NOTE_KIND), NOTE_DOC);
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  return {
    isRoomKind: (kind) => ROOM_KINDS.includes(kind),
    /** Counts a stored Room document of `bytes`; when the Pond's Room passes the cap, pages out the oldest. */
    async wrote(channel, bytes) {
      if (!feed.enabled) return null;
      let counted = await readCounter(channel);
      if (counted === null) counted = (await measure(channel)).total;
      else counted += bytes;
      if (counted <= capBytes) {
        await writeCounter(channel, counted);
        return null;
      }
      return trim(channel);
    },
    note: readNote,
    /** Clean start: the counter and the note go with the Pond. */
    async wipe(channel) {
      await store.del(COUNTER_PK, channel).catch(() => undefined);
      await store.del(kindPk(channel, NOTE_KIND), NOTE_DOC).catch(() => undefined);
    },
  };
}

module.exports = { createRoomCloud, CAP_BYTES, NOTE_KIND, NOTE_DOC, COUNTER_PK };
