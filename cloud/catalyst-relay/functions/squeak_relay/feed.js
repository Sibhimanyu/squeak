// The Pond change feed (docs/cloud-layer.md, "Sequence numbers and the change feed"; ADR 0005; spec: Cloud, "Every write gets
// a sequence number"). Every content write in a Pond gets the Pond's next `seq`, and a device asks "what changed since N".
//
// The counter. Catalyst NoSQL and Data Store have no transactions and no conditional update, but a unique key refuses a
// second insert. So the seq IS a row: `feed/<pondId>` / `<seq, 12 digits>` holds the change itself, and a writer takes
// seq n by inserting row n, which only one writer can do. A refused insert means someone else took n: the writer finds
// the end of the log and tries the next number. Properties, all from that one rule:
//   - unique: two writers never hold the same seq (the store refuses the second insert);
//   - gapless and in order: a writer tries n only after the rows below n were seen to exist (the walk to the end of the
//     log reads them, and the hint below is written only after its row), so a reader that has seen seq 7 has seen 1..6;
//   - atomic with the content: the row carries the whole document, so a reader never sees a seq whose document is not
//     there yet (no "pending" state to skip).
// `feedhead/<pondId>` is a lower-bound hint, written every HINT_EVERY seqs, only so finding the end of the log reads a few
// rows instead of all of them. A stale or lost hint costs reads, never correctness.
//
// The store port (index.js, tests): claim(pk, doc, json) -> true, or false when the row exists (insert only, never an
// overwrite); range(pk, afterDoc|null, limit) -> [{doc, json}] strictly after afterDoc, ascending by doc. A store without
// both has no feed: writes go unstamped and /changes answers 404, so every older deployment behaves as before.
const FEED_PK = "feed";
const HEAD_PK = "feedhead";
const PAD = 12;
const HINT_EVERY = 8;
const PAGE = 100;
const MAX_TRIES = 40;

const pad = (n) => String(n).padStart(PAD, "0");
/** The content kinds of a Pond channel: the ones that are stamped and appear in the feed (relay-owned kinds, history and Mac-channel kinds do not). */
const FEED_KINDS = new Set([
  "pond",
  "members",
  "joins",
  "threads",
  "tevents",
  "presence",
  "holds",
  "tcmds",
  "ripples",
  "keys",
  "grants",
  "tasks",
  "claims",
  "locks",
  "room",
  "rposts",
  "rtasks",
]);

function createFeed(store) {
  const enabled = typeof store.claim === "function" && typeof store.range === "function";
  const pk = (pondId) => `${FEED_PK}/${pondId}`;

  /** The highest seq in the log, found by walking forward from `from` (a seq known to exist, or 0). */
  async function endFrom(pondId, from) {
    let h = from;
    for (;;) {
      const rows = await store.range(pk(pondId), h === 0 ? null : pad(h), PAGE);
      if (!rows.length) return h;
      h = Number(rows[rows.length - 1].doc);
      if (rows.length < PAGE) return h;
    }
  }
  async function head(pondId) {
    const hint = Number(await store.get(HEAD_PK, pondId)) || 0;
    return endFrom(pondId, hint);
  }

  /** Takes the Pond's next seq for { kind, id, doc|null }; returns it, or null when the store has no feed. */
  async function append(pondId, change) {
    if (!enabled) return null;
    let n = (await head(pondId)) + 1;
    for (let tries = 0; tries < MAX_TRIES; tries++) {
      const row = JSON.stringify({ seq: n, kind: change.kind, id: change.id, doc: change.doc ?? null, at: Date.now() });
      if (await store.claim(pk(pondId), pad(n), row)) {
        if (n % HINT_EVERY === 0) await store.put(HEAD_PK, pondId, String(n)).catch(() => undefined);
        return n;
      }
      n = (await endFrom(pondId, n)) + 1;
    }
    throw Object.assign(new Error("seq contention"), { status: 503 });
  }

  /** { changes: [{seq, kind, id, doc|null}], next, more }: at most `limit` changes after `since`; `since` "head" asks only for the end. */
  async function changes(pondId, since, limit) {
    if (since === "head") return { changes: [], next: await head(pondId), more: false };
    const take = Math.min(Math.max(Math.floor(limit) || PAGE, 1), PAGE);
    const rows = await store.range(pk(pondId), since === 0 ? null : pad(since), take + 1);
    const page = rows.slice(0, take).map((r) => {
      const c = JSON.parse(r.json);
      return { seq: c.seq, kind: c.kind, id: c.id, doc: c.doc };
    });
    return { changes: page, next: page.length ? page[page.length - 1].seq : since, more: rows.length > take };
  }

  /** Clean start: the log and its hint. */
  async function wipe(pondId) {
    let n = 0;
    for (const r of await store.list(pk(pondId))) {
      await store.del(pk(pondId), r.doc);
      n++;
    }
    await store.del(HEAD_PK, pondId);
    return n;
  }

  return { enabled, append, changes, head, wipe };
}

module.exports = { createFeed, FEED_KINDS, FEED_PK, HEAD_PK };
