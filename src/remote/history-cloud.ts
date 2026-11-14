import crypto from "node:crypto";
import { condenseHistory, liveHandle, type HistoryEntry } from "./live-turn.js";
import { readHistoryAfter, HISTORY_DELTA_PAGE_MAX, type TranscriptReader } from "./history-delta.js";

/**
 * "History cache" Layer 2, the Mac side (docs/remote-channel.md): the Mac keeps a sealed copy of its recent chats in
 * Squeak's cloud, so a phone or browser can read history while the Mac sleeps, and a new device has something to open.
 * It is sealed with the channel key like every channel document, so the server holds opaque boxes only.
 *
 * Layout under `channels/<id>/hist/`:
 *   idx             the index: for each chat, its pages (oldest first, each named by the id of its first entry), the id
 *                   of its newest entry, and when it last moved. The only document that wakes readers.
 *   <handle>-<id>   one page: up to 50 entries (as a history page shows them: clipped text, no images), oldest first,
 *                   named by the chat's handle and the cursor of its first entry, so it lines up with Layer 1's cursor.
 *
 * Written incrementally: a chat's newest page grows, a full page is never rewritten. Retention is 30 days, a chat keeps at
 * most `HIST_CHAT_PAGES` pages, and a chat that is archived, closed or gone has its pages deleted.
 */

export const HIST_INDEX_DOC = "idx";
export const HIST_PAGE_ENTRIES = HISTORY_DELTA_PAGE_MAX;
/** Pages kept per chat (the newest): 350 entries. */
export const HIST_CHAT_PAGES = 7;
export const HIST_MAX_CHATS = 100;
export const HIST_RETENTION_MS = 30 * 24 * 3600_000;
/** Chats brought up to date in one run, so a first upload spreads over passes instead of holding one. */
const CHATS_PER_RUN = 6;
const READ_STEP = 120;
/** Raw messages read looking for a chat's newest entries, at most (a chat this long still gets its newest). */
const READ_MAX = 4000;

export interface HistPageRef {
  /** The id of the page's first entry (the page doc is `<handle>-<f>`). */
  f: string;
  /** The last entry's time (ms), 0 when undated. */
  t: number;
}
export interface HistChat {
  key: string;
  pages: HistPageRef[];
  /** The id of the chat's newest entry held. */
  newest: string;
  /** The chat's first message is in the oldest page. */
  complete: boolean;
  /** The chat's lastActivityAt (ms) when this was written. */
  act: number;
}
export interface HistIndex {
  v: 1;
  chats: HistChat[];
  seq: number;
  at: number;
}
export interface HistPage {
  v: 1;
  key: string;
  first: string;
  entries: HistoryEntry[];
  seq: number;
}

export function histPageDoc(key: string, first: string): string {
  return `${liveHandle(key)}-${first}`;
}

/** The relay's `hist` documents for one channel, as the sync needs them (a fake in tests). */
export interface HistStore {
  get(doc: string): Promise<string | null>;
  put(doc: string, box: string): Promise<void>;
  delete(doc: string): Promise<void>;
}

export interface HistCandidate {
  key: string;
  /** lastActivityAt, ms. */
  activityAt: number;
  read: TranscriptReader;
}

export interface HistorySyncDeps {
  store: HistStore;
  seal(value: unknown): string;
  open<T>(box: string): T | null;
  candidates(): HistCandidate[];
  now(): number;
  nextSeq(): number;
}

const entryTime = (entry: HistoryEntry): number => {
  const t = entry.at ? Date.parse(entry.at) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** The chat's newest condensed entries (at most `max`), oldest first, and whether the start of the chat was reached. */
export function readRecentEntries(read: TranscriptReader, max: number): { entries: HistoryEntry[]; complete: boolean } {
  const raw = new Map<number, ReturnType<TranscriptReader>["messages"][number]>();
  let before: number | null = null;
  let complete = false;
  let enough = false;
  while (raw.size < READ_MAX) {
    const result = read(READ_STEP, before);
    for (const message of result.messages) {
      const cursor = Number(message.cursor);
      if (message.cursor && Number.isFinite(cursor)) raw.set(cursor, message);
    }
    const next: number | null = result.nextBefore ? Number(result.nextBefore) : null;
    if (next === null || result.messages.length === 0 || (before !== null && next >= before)) {
      complete = true;
      break;
    }
    before = next;
    // Condensing merges runs, so count entries now and then rather than messages.
    const ordered = [...raw.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m);
    if (condenseHistory(ordered, max + 1).length > max) {
      enough = true;
      break;
    }
  }
  const ordered = [...raw.entries()].sort((a, b) => a[0] - b[0]).map(([, m]) => m);
  const all = condenseHistory(ordered, Number.MAX_SAFE_INTEGER);
  const entries = all.filter((e) => e.id).slice(-max);
  return { entries, complete: complete && !enough && all.length <= max };
}

/** Splits entries into pages of `HIST_PAGE_ENTRIES`, oldest first. */
export function chunkPages(entries: HistoryEntry[]): HistoryEntry[][] {
  const pages: HistoryEntry[][] = [];
  for (let i = 0; i < entries.length; i += HIST_PAGE_ENTRIES) pages.push(entries.slice(i, i + HIST_PAGE_ENTRIES));
  return pages;
}

export class HistoryCloudSync {
  private index: HistIndex | null = null;
  private loaded = false;
  private running = false;
  /** Set when the account's cap answered: nothing more is tried until `retryAt`. */
  private retryAt = 0;

  constructor(private readonly deps: HistorySyncDeps) {}

  /** The index as last read or written, for tests and status. */
  current(): HistIndex | null {
    return this.index;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const box = await this.deps.store.get(HIST_INDEX_DOC);
    const index = box ? this.deps.open<HistIndex>(box) : null;
    this.index = index && index.v === 1 && Array.isArray(index.chats) ? index : { v: 1, chats: [], seq: 0, at: 0 };
    this.loaded = true;
  }

  /** Brings the cloud copy up to date, a few chats at a time. Never throws; a failure waits for the next run. */
  async run(): Promise<{ wrote: number; dropped: number; more: boolean } | null> {
    if (this.running || this.deps.now() < this.retryAt) return null;
    this.running = true;
    try {
      await this.load();
      return await this.pass();
    } catch (error) {
      if (error instanceof HistCapError) this.retryAt = this.deps.now() + 3600_000;
      else this.retryAt = this.deps.now() + 60_000;
      return null;
    } finally {
      this.running = false;
    }
  }

  private async pass(): Promise<{ wrote: number; dropped: number; more: boolean }> {
    const index = this.index!;
    const now = this.deps.now();
    const wanted = this.deps
      .candidates()
      .filter((c) => now - c.activityAt <= HIST_RETENTION_MS)
      .sort((a, b) => b.activityAt - a.activityAt)
      .slice(0, HIST_MAX_CHATS);
    const wantedKeys = new Set(wanted.map((c) => c.key));
    const doomed: string[] = [];
    let changed = false;
    // Chats no longer wanted (archived, closed, gone, older than a month): their pages go after the index stops naming them.
    const kept: HistChat[] = [];
    for (const chat of index.chats) {
      if (wantedKeys.has(chat.key)) kept.push(chat);
      else {
        for (const page of chat.pages) doomed.push(histPageDoc(chat.key, page.f));
        changed = true;
      }
    }
    index.chats = kept;
    const byKey = new Map(kept.map((c) => [c.key, c]));
    let wrote = 0;
    let more = false;
    for (const candidate of wanted) {
      const held = byKey.get(candidate.key);
      if (held && held.act >= candidate.activityAt) {
        // Quiet since last time: only the month's retention can touch it.
        const kept = held.pages.filter((p) => p.t === 0 || now - p.t <= HIST_RETENTION_MS);
        if (kept.length !== held.pages.length) {
          for (const p of held.pages) if (!kept.includes(p)) doomed.push(histPageDoc(held.key, p.f));
          held.pages = kept;
          changed = true;
        }
        continue;
      }
      if (wrote >= CHATS_PER_RUN) {
        more = true;
        continue;
      }
      const result = await this.syncChat(candidate, held ?? null);
      wrote += 1;
      changed = true;
      doomed.push(...result.doomed);
      if (!held) {
        index.chats.push(result.chat);
        byKey.set(result.chat.key, result.chat);
      } else Object.assign(held, result.chat);
      const chat = byKey.get(candidate.key)!;
      if (chat.pages.length === 0) {
        index.chats = index.chats.filter((c) => c !== chat);
        byKey.delete(candidate.key);
      }
    }
    if (changed) {
      index.seq = this.deps.nextSeq();
      index.at = now;
      await this.deps.store.put(HIST_INDEX_DOC, this.deps.seal(index));
    }
    // The index no longer names these; a reader that holds the old index finds a page gone and re-reads it.
    const live = new Set(index.chats.flatMap((c) => c.pages.map((p) => histPageDoc(c.key, p.f))));
    let dropped = 0;
    for (const doc of new Set(doomed)) {
      if (live.has(doc)) continue;
      await this.deps.store.delete(doc);
      dropped += 1;
    }
    return { wrote, dropped, more };
  }

  /** Writes what changed in one chat: its newest page and any new ones. Returns the chat's new index entry. */
  private async syncChat(
    candidate: HistCandidate,
    held: HistChat | null,
  ): Promise<{ chat: HistChat; doomed: string[] }> {
    const now = this.deps.now();
    const doomed: string[] = [];
    let entries: HistoryEntry[] = [];
    let complete = false;
    let pages: HistPageRef[] = [];
    let fresh = true;
    let unchanged: { doc: string; len: number } | null = null;
    if (held && held.pages.length > 0) {
      const tail = held.pages[held.pages.length - 1]!;
      const added = this.entriesAfter(candidate.read, held.newest);
      const tailBox = added ? await this.deps.store.get(histPageDoc(candidate.key, tail.f)) : null;
      const tailPage = tailBox ? this.deps.open<HistPage>(tailBox) : null;
      if (added && tailPage && Array.isArray(tailPage.entries)) {
        fresh = false;
        unchanged = { doc: histPageDoc(candidate.key, tail.f), len: tailPage.entries.length };
        const seen = new Set(tailPage.entries.map((e) => e.id));
        entries = [...tailPage.entries, ...added.filter((e) => !seen.has(e.id))];
        pages = held.pages.slice(0, -1);
        complete = held.complete;
      }
    }
    if (fresh) {
      // Nothing held, or the cursor is out of reach (the chat moved on a lot): rebuild from the chat's newest.
      for (const page of held?.pages ?? []) doomed.push(histPageDoc(candidate.key, page.f));
      const recent = readRecentEntries(candidate.read, HIST_CHAT_PAGES * HIST_PAGE_ENTRIES);
      entries = recent.entries;
      complete = recent.complete;
      pages = [];
    }
    for (const chunk of chunkPages(entries)) {
      const first = chunk[0]!.id!;
      const doc = histPageDoc(candidate.key, first);
      if (unchanged && unchanged.doc === doc && unchanged.len === chunk.length) {
        pages.push({ f: first, t: entryTime(chunk[chunk.length - 1]!) });
        continue;
      }
      const page: HistPage = { v: 1, key: candidate.key, first, entries: chunk, seq: this.deps.nextSeq() };
      await this.deps.store.put(doc, this.deps.seal(page));
      pages.push({ f: first, t: entryTime(chunk[chunk.length - 1]!) });
    }
    // The page cap: the oldest whole pages go, and the chat no longer reaches its start.
    while (pages.length > HIST_CHAT_PAGES) {
      const gone = pages.shift()!;
      doomed.push(histPageDoc(candidate.key, gone.f));
      complete = false;
    }
    // A month's retention drops old pages (the chat then does not reach its start either).
    while (pages.length > 0 && pages[0]!.t > 0 && now - pages[0]!.t > HIST_RETENTION_MS) {
      const gone = pages.shift()!;
      doomed.push(histPageDoc(candidate.key, gone.f));
      complete = false;
    }
    const newest = entries.length > 0 ? entries[entries.length - 1]!.id! : (held?.newest ?? "");
    return { chat: { key: candidate.key, pages, newest, complete, act: candidate.activityAt }, doomed };
  }

  /** Entries after `cursor`, oldest first; null when the cursor is out of reach (rebuild instead). */
  private entriesAfter(read: TranscriptReader, cursor: string): HistoryEntry[] | null {
    const after = Number(cursor);
    if (!Number.isFinite(after)) return null;
    const out: HistoryEntry[] = [];
    let from = after;
    for (let i = 0; i < 12; i++) {
      const delta = readHistoryAfter(read, from, HIST_PAGE_ENTRIES);
      if (delta.reset) return null;
      out.push(...delta.entries.filter((e) => e.id));
      if (!delta.nextAfter) return out;
      from = Number(delta.nextAfter);
    }
    return null;
  }

  /** Deletes the whole cloud copy (the setting turned off, the account unlinked, the channel reset). */
  async purge(): Promise<void> {
    await this.load().catch(() => undefined);
    const index = this.index;
    if (index) {
      for (const chat of index.chats)
        for (const page of chat.pages) await this.deps.store.delete(histPageDoc(chat.key, page.f));
    }
    await this.deps.store.delete(HIST_INDEX_DOC);
    this.index = { v: 1, chats: [], seq: 0, at: 0 };
    this.loaded = true;
  }
}

/** The relay answered 413 {error:"cap"}: the account's history is full. */
export class HistCapError extends Error {}

export interface RelayHistOptions {
  baseUrl: string;
  /** This Mac's own key (`x-squeak-mac-key`) or the operator's relay key. */
  key: string;
  keyHeader: string;
  channel: string;
  /** The channel's history write token (`x-squeak-hist`). */
  token: string;
  fetch?: typeof fetch;
}

/** `hist` documents through the relay: GET by id, PUT and DELETE with the write token. */
export function relayHistStore(options: RelayHistOptions): HistStore & { register(previous?: string): Promise<void> } {
  const base = options.baseUrl.replace(/\/+$/, "");
  const f = options.fetch ?? fetch;
  const url = (doc: string) => `${base}/doc?path=${encodeURIComponent(`channels/${options.channel}/hist/${doc}`)}`;
  const headers = (json: boolean): Record<string, string> => ({
    [options.keyHeader]: options.key,
    "x-squeak-hist": options.token,
    ...(json ? { "content-type": "application/json" } : {}),
  });
  return {
    async get(doc) {
      const response = await f(url(doc), {
        method: "GET",
        headers: headers(false),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`history get ${response.status}`);
      const body = (await response.json()) as { doc?: { box?: unknown } };
      return typeof body.doc?.box === "string" ? body.doc.box : null;
    },
    async put(doc, box) {
      const response = await f(url(doc), {
        method: "PUT",
        headers: headers(true),
        body: JSON.stringify({ doc: { box, at: Date.now() } }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 413) throw new HistCapError("history cap");
      if (!response.ok) throw new Error(`history put ${response.status}`);
    },
    async delete(doc) {
      const response = await f(url(doc), {
        method: "DELETE",
        headers: headers(false),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`history delete ${response.status}`);
    },
    async register(previous) {
      const response = await f(`${base}/account/macs/hist-token`, {
        method: "POST",
        headers: { [options.keyHeader]: options.key, "content-type": "application/json" },
        body: JSON.stringify({ channel: options.channel, token: options.token, ...(previous ? { previous } : {}) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`history token ${response.status}`);
    },
  };
}

/** A fresh write token: 43 URL-safe characters, as the relay requires. */
export function newHistToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}
