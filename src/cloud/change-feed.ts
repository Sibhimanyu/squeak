/**
 * The daemon's side of the Pond change feed (docs/cloud-layer.md, "Sequence numbers and the change feed"; relay
 * `feed.js`). The first time a Pond's collection is listed, the mirror reads the Pond's current end (`since=head`) and then
 * the collection once; every later list of that Pond is one `GET /changes?since=<cursor>` that is applied to what is held,
 * so reopening a Pond already seen never re-reads a whole kind. One cursor per Pond, one mirror per (Pond, kind).
 *
 * Anything the feed cannot do (an older relay, a token the feed refuses, a bad answer) turns the feed off for that store
 * and every list is the plain list again: the old routes stay, so nothing breaks, it only reads more.
 */
import type { ChannelDoc } from "./store.js";

/** The kinds the relay stamps and records (`FEED_KINDS` in feed.js; a test keeps the two lists equal). */
export const FEED_KINDS: ReadonlySet<string> = new Set([
  "pond",
  "members",
  "joins",
  "threads",
  "tevents",
  "holds",
  "tcmds",
  "keys",
  "room",
  "rposts",
  "rtasks",
  "roomnote",
]);

export interface FeedChange {
  seq: number;
  kind: string;
  id: string;
  /** Null is a delete (or a relay-owned plain document: then `raw` carries it). */
  doc: ChannelDoc | null;
  /** A relay-owned plain-JSON document (the Room's page-out note): not sealed, so it has no `doc`. */
  raw?: unknown;
}

export interface FeedPage {
  changes: FeedChange[];
  next: number;
  more: boolean;
}

export interface FeedMirrorOptions {
  /** One change-feed read, or null when the relay has no feed for this caller. */
  changes(pondId: string, since: number | "head"): Promise<FeedPage | null>;
  /** The plain list of one collection (`channels/<pond>/<kind>`). */
  listPlain(collection: string): Promise<Array<{ id: string; doc: ChannelDoc }>>;
  /** One relay-owned plain document (`channels/<pond>/<kind>/<id>`), or null. */
  getRaw?(path: string): Promise<unknown | null>;
}

type Docs = Array<{ id: string; doc: ChannelDoc }>;

interface PondMirror {
  cursor: number;
  kinds: Map<string, Map<string, ChannelDoc>>;
  /** Relay-owned plain documents asked for by path (`<kind>/<id>`); null when absent. */
  raws: Map<string, unknown>;
  /** Syncs run one at a time per Pond, so two lists never apply the same page twice or out of order. */
  chain: Promise<unknown>;
}

const sorted = (docs: Map<string, ChannelDoc>): Docs =>
  [...docs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, doc]) => ({ id, doc: { ...doc } }));
const RAW_PATH = /^channels\/([^/]+)\/([^/]+)\/([^/]+)$/;
const COLLECTION = /^channels\/([^/]+)\/([^/]+)$/;
/** A page that never ends is a relay fault: stop after this many pages in one sync and answer from what is held. */
const MAX_PAGES = 200;

export class FeedMirror {
  private readonly ponds = new Map<string, PondMirror>();
  private off = false;
  /**
   * Where each Pond's cursor is, for `LiveClient` (live-notices.ts): a notice at or below it is already read. Kept in step
   * with the mirror's own cursors; the live client may also move it forward after waking the Pond's watchers.
   */
  readonly cursors = new Map<string, number>();

  constructor(private readonly options: FeedMirrorOptions) {}

  /** The documents of a collection, newest state, through the feed when it can; `null` when the caller should list plainly. */
  async list(collection: string): Promise<Array<{ id: string; doc: ChannelDoc }> | null> {
    const m = COLLECTION.exec(collection);
    if (this.off || !m || !FEED_KINDS.has(m[2]!)) return null;
    const pondId = m[1]!;
    const kind = m[2]!;
    let pond = this.ponds.get(pondId);
    if (!pond) {
      pond = { cursor: -1, kinds: new Map(), raws: new Map(), chain: Promise.resolve() };
      this.ponds.set(pondId, pond);
    }
    const mirror = pond;
    const run = mirror.chain.then(() => this.read(mirror, pondId, collection, kind));
    mirror.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Several collections of one Pond (and relay-owned plain documents by path) from one feed read: what a whole page needs, so
   * the page costs one `GET /changes` and not one per kind. Always synced first, so nothing is older than the call. Null when
   * the caller should read them one by one (not the feed's kinds, several Ponds, or the feed is off).
   */
  async listMany(collections: string[], rawPaths: string[] = []): Promise<{ lists: Docs[]; raws: unknown[] } | null> {
    if (this.off || collections.length === 0) return null;
    const parsed = collections.map((c) => COLLECTION.exec(c));
    const pondId = parsed[0]?.[1];
    if (!pondId || parsed.some((m) => !m || m[1] !== pondId || !FEED_KINDS.has(m[2]!))) return null;
    const rawKeys = rawPaths.map((p) => RAW_PATH.exec(p));
    if (
      rawKeys.some((m) => !m || m[1] !== pondId || !FEED_KINDS.has(m[2]!)) ||
      (rawPaths.length && !this.options.getRaw)
    )
      return null;
    let pond = this.ponds.get(pondId);
    if (!pond) {
      pond = { cursor: -1, kinds: new Map(), raws: new Map(), chain: Promise.resolve() };
      this.ponds.set(pondId, pond);
    }
    const mirror = pond;
    const run = mirror.chain.then(() =>
      this.readSeveral(
        mirror,
        pondId,
        parsed.map((m, i) => ({ collection: collections[i]!, kind: m![2]! })),
        rawPaths.map((path, i) => ({ path, key: `${rawKeys[i]![2]}/${rawKeys[i]![3]}` })),
      ),
    );
    mirror.chain = run.catch(() => undefined);
    return run;
  }

  private async readSeveral(
    pond: PondMirror,
    pondId: string,
    wanted: Array<{ collection: string; kind: string }>,
    raws: Array<{ path: string; key: string }>,
  ): Promise<{ lists: Docs[]; raws: unknown[] } | null> {
    if (this.off) return null;
    if (pond.cursor < 0) {
      const head = await this.options.changes(pondId, "head");
      if (!head) return this.turnOff();
      pond.cursor = head.next;
      this.cursors.set(pondId, pond.cursor);
    } else if (!(await this.sync(pond, pondId))) {
      return this.turnOff();
    }
    // Anything first asked for now is seeded from the cloud once, then the cursor replays whatever the seed also saw.
    let seeded = false;
    for (const { collection, kind } of wanted) {
      if (pond.kinds.has(kind)) continue;
      const rows = await this.options.listPlain(collection);
      pond.kinds.set(kind, new Map(rows.map(({ id, doc }) => [id, doc])));
      seeded = true;
    }
    for (const { path, key } of raws) {
      if (pond.raws.has(key)) continue;
      pond.raws.set(key, (await this.options.getRaw!(path)) ?? null);
      seeded = true;
    }
    if (seeded && !(await this.sync(pond, pondId))) return this.turnOff();
    return {
      lists: wanted.map(({ kind }) => sorted(pond.kinds.get(kind)!)),
      raws: raws.map(({ key }) => pond.raws.get(key) ?? null),
    };
  }

  private async read(
    pond: PondMirror,
    pondId: string,
    collection: string,
    kind: string,
  ): Promise<Array<{ id: string; doc: ChannelDoc }> | null> {
    if (this.off) return null;
    if (pond.cursor < 0) {
      // The end first, then the list: anything written between the two is read twice (the list, then the feed), never missed.
      const head = await this.options.changes(pondId, "head");
      if (!head) return this.turnOff();
      pond.cursor = head.next;
      this.cursors.set(pondId, pond.cursor);
    } else if (!(await this.sync(pond, pondId))) {
      return this.turnOff();
    }
    let docs = pond.kinds.get(kind);
    if (!docs) {
      // A kind first listed now: the feed up to here was not applied to it, so the plain list seeds it, and the cursor
      // (already at or before this list) replays whatever the list also saw.
      docs = new Map((await this.options.listPlain(collection)).map(({ id, doc }) => [id, doc]));
      pond.kinds.set(kind, docs);
      if (!(await this.sync(pond, pondId))) return this.turnOff();
    }
    return sorted(docs);
  }

  /** Applies every change after the cursor to the kinds held; false when the feed answered nothing usable. */
  private async sync(pond: PondMirror, pondId: string): Promise<boolean> {
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.options.changes(pondId, pond.cursor);
      if (!result) return false;
      for (const change of result.changes) {
        const rawKey = `${change.kind}/${change.id}`;
        if (pond.raws.has(rawKey)) pond.raws.set(rawKey, change.doc === null ? (change.raw ?? null) : null);
        const docs = pond.kinds.get(change.kind);
        if (!docs) continue;
        // The stored document carries its seq; the feed's row (the document as written) does not, so it is put back here.
        if (change.doc) docs.set(change.id, { ...change.doc, seq: change.seq });
        else docs.delete(change.id);
      }
      pond.cursor = Math.max(pond.cursor, result.next);
      this.cursors.set(pondId, pond.cursor);
      if (!result.more) return true;
    }
    return true;
  }

  private turnOff(): null {
    this.off = true;
    this.ponds.clear();
    this.cursors.clear();
    return null;
  }

  /** Forgets one Pond (it was left or reset): its next list starts from the head again. */
  forget(pondId: string): void {
    this.ponds.delete(pondId);
    this.cursors.delete(pondId);
  }
}
