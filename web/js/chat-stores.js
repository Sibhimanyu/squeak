// What the browser keeps of a chat between visits, in the same IndexedDB as
// its keys (key-store.js), so "Forget this browser" deleting that database
// wipes every trace of it. The iPhone's HistoryStore and OutboxStore.
//
// - History: per chat, the last non-empty history the Mac sent, so a chat
//   opens whole in its first frame. At most 30 chats, least recently written
//   dropped first. Writes are coalesced to one a second.
// - Outbox: sends not settled (waiting on the Mac, refused, unconfirmed), so
//   a reload cannot make a message vanish or read as delivered. Older than a
//   day is dropped, at most 50 kept.
//
// After `dispose()` (which Forget calls before deleting the database) nothing
// is written again: a late write would bring the database back from the dead.

export const MAX_CHATS = 30;
export const MAX_AGE_MS = 24 * 60 * 60_000;
export const MAX_ENTRIES = 50;
const HISTORY = "history";
const OUTBOX = "outbox";
const READ = "read";
export const MAX_READ = 300;

export class Persisted {
  constructor(kv, name) {
    this.kv = kv;
    this.name = name;
    this.disposed = false;
    this.chain = Promise.resolve();
  }

  /** Writes `value` after whatever write is running, never after dispose. */
  write(value) {
    this.chain = this.chain
      .catch(() => undefined)
      .then(() => (this.disposed ? undefined : this.kv.write(this.name, value)));
    return this.chain;
  }

  /** Stops writing and waits out the write in flight. */
  async dispose() {
    this.disposed = true;
    await this.chain.catch(() => undefined);
  }
}

export class HistoryStore extends Persisted {
  constructor(kv, { now = () => Date.now(), delayMs = 1_000, timers = globalThis } = {}) {
    super(kv, HISTORY);
    this.now = now;
    this.delayMs = delayMs;
    this.timers = timers;
    this.chats = [];
    this.timer = null;
  }

  /** Everything stored, as `{ [key]: history }`; empty when nothing is, or when it cannot be read. */
  async load() {
    try {
      const file = await this.kv.read(HISTORY);
      if (file?.v === 1 && Array.isArray(file.chats)) {
        this.chats = file.chats
          .filter((chat) => chat && typeof chat.key === "string" && Array.isArray(chat.history))
          .sort((a, b) => b.at - a.at)
          .slice(0, MAX_CHATS);
      }
    } catch {
      this.chats = [];
    }
    return Object.fromEntries(this.chats.map((chat) => [chat.key, chat.history]));
  }

  /** Remembers a chat's history. Empty history and an unchanged one are ignored. */
  record(history, key) {
    if (this.disposed || !Array.isArray(history) || history.length === 0) return;
    const i = this.chats.findIndex((chat) => chat.key === key);
    const text = JSON.stringify(history);
    if (i >= 0) {
      if (JSON.stringify(this.chats[i].history) === text) return;
      this.chats.splice(i, 1);
    }
    this.chats.unshift({ key, at: this.now(), history });
    if (this.chats.length > MAX_CHATS) this.chats.length = MAX_CHATS;
    this.#schedule();
  }

  #schedule() {
    if (this.timer !== null) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  /** Writes now; for tests and for the tab going to the background. */
  flush() {
    this.timers.clearTimeout(this.timer);
    this.timer = null;
    return this.write({ v: 1, chats: this.chats });
  }

  async dispose() {
    this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.chats = [];
    await super.dispose();
  }
}

export class OutboxStore extends Persisted {
  constructor(kv, { now = () => Date.now() } = {}) {
    super(kv, OUTBOX);
    this.now = now;
    this.entries = [];
  }

  /** Everything unsettled, oldest first. */
  async load() {
    try {
      const file = await this.kv.read(OUTBOX);
      if (file?.v === 1 && Array.isArray(file.entries)) {
        this.entries = file.entries.filter(
          (entry) =>
            entry &&
            typeof entry.key === "string" &&
            typeof entry.text === "string" &&
            this.now() - entry.at < MAX_AGE_MS,
        );
      }
    } catch {
      this.entries = [];
    }
    return this.entries;
  }

  /** Replaces what is kept with these (the caller's whole unsettled set), written at once. */
  replace(next) {
    if (this.disposed) return;
    const entries = next.slice(-MAX_ENTRIES);
    if (JSON.stringify(entries) === JSON.stringify(this.entries)) return;
    this.entries = entries;
    void this.write({ v: 1, entries }).catch(() => undefined);
  }

  async dispose() {
    this.entries = [];
    await super.dispose();
  }
}

/**
 * When each chat was last looked at (ms), so a reply that came after is "new"
 * (the iPhone's `replySeen`). Kept in the same database as the keys, so Forget
 * wipes it; the newest 300 chats, written a moment after a change.
 */
export class ReadStore extends Persisted {
  constructor(kv, { now = () => Date.now(), delayMs = 500, timers = globalThis } = {}) {
    super(kv, READ);
    this.now = now;
    this.delayMs = delayMs;
    this.timers = timers;
    /** chat key -> ms; insertion order is oldest first. */
    this.seen = new Map();
    this.timer = null;
  }

  async load() {
    try {
      const file = await this.kv.read(READ);
      if (file?.v === 1 && Array.isArray(file.seen)) {
        for (const entry of file.seen) {
          if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "number") {
            this.seen.set(entry[0], entry[1]);
          }
        }
      }
    } catch {
      this.seen = new Map();
    }
    return this.seen;
  }

  has(key) {
    return this.seen.has(key);
  }

  /** You looked at the chat: what it said so far is read. Also the start of caring about its next reply. */
  markSeen(key, at = this.now()) {
    if (this.disposed) return;
    this.seen.delete(key);
    this.seen.set(key, at);
    while (this.seen.size > MAX_READ) this.seen.delete(this.seen.keys().next().value);
    this.#schedule();
  }

  /** A chat seen working is one you are waiting on: its next reply is news, if you had no mark yet. */
  watchIfNew(key) {
    if (!this.seen.has(key)) this.markSeen(key);
  }

  #schedule() {
    if (this.timer !== null) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  flush() {
    this.timers.clearTimeout(this.timer);
    this.timer = null;
    return this.write({ v: 1, seen: [...this.seen] });
  }

  async dispose() {
    this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.seen = new Map();
    await super.dispose();
  }
}
