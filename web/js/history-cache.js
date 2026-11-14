// The browser's chat-history cache (docs/remote-channel.md, "History cache"), the web twin of the iPhone's
// ChatHistoryStore: per chat, the messages this browser has read, so a chat opens from storage and only what came
// after its newest message is asked of the Mac (`history` with `after`).
//
// Each chat is one IndexedDB value in the same database as the keys (key-store.js), sealed with AES-256-GCM under a
// random non-extractable key that is made once and kept in that database too, so "Forget this browser" deleting the
// database removes the key and every chat with it. The records are named by a hash of the chat key, so storage
// holds neither a word of a chat nor which chats exist. At most 200 chats and 50 MB of sealed text are kept,
// least recently opened first out. Writes are coalesced to one a second, and nothing is written after `dispose()`.

export const MAX_CACHED_CHATS = 200;
export const MAX_CACHED_BYTES = 50 * 1024 * 1024;
export const MAX_CACHED_ENTRIES = 1000;
/** Entries asked for in one delta page. */
export const DELTA_PAGE = 50;

const KEY = "hc:key";
const INDEX = "hc:index";
const LEGACY = "history";
const chatName = (hash) => `hc:c:${hash}`;

async function hashOf(text) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class HistoryCache {
  /** `kv` is a KeyStore (read/write/delete by name). */
  constructor(
    kv,
    {
      now = () => Date.now(),
      delayMs = 1_000,
      timers = globalThis,
      maxChats = MAX_CACHED_CHATS,
      maxBytes = MAX_CACHED_BYTES,
    } = {},
  ) {
    this.kv = kv;
    this.now = now;
    this.delayMs = delayMs;
    this.timers = timers;
    this.maxChats = maxChats;
    this.maxBytes = maxBytes;
    this.disposed = false;
    this.index = [];
    this.pending = new Map();
    this.timer = null;
    this.chain = Promise.resolve();
    this.cryptoKey = null;
  }

  async #key() {
    if (this.cryptoKey) return this.cryptoKey;
    let key = await this.kv.read(KEY);
    if (!key) {
      key = await globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      if (!this.disposed) await this.kv.write(KEY, key);
    }
    this.cryptoKey = key;
    return key;
  }

  async #seal(value) {
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(value));
    const ct = await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, await this.#key(), plain);
    return { iv, ct };
  }

  async #open(record) {
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: record.iv },
      await this.#key(),
      record.ct,
    );
    return JSON.parse(new TextDecoder().decode(plain));
  }

  /** The index, and the most recently opened chats' histories as `{ [key]: history }`. Drops the old plaintext cache. */
  async load(limit = 20) {
    const out = {};
    try {
      const file = await this.kv.read(INDEX);
      if (file?.v === 1 && Array.isArray(file.chats)) {
        this.index = file.chats.filter((c) => c && typeof c.h === "string").sort((a, b) => b.at - a.at);
      }
      if ((await this.kv.read(LEGACY)) && !this.disposed) await this.kv.delete(LEGACY);
      for (const chat of this.index.slice(0, limit)) {
        const got = await this.#read(chat.h);
        if (got) out[got.key] = got.history;
      }
    } catch {
      this.index = [];
    }
    return out;
  }

  async #read(hash) {
    try {
      const record = await this.kv.read(chatName(hash));
      if (!record) return null;
      const value = await this.#open(record);
      return value && typeof value.key === "string" && Array.isArray(value.history) ? value : null;
    } catch {
      return null;
    }
  }

  /** One chat's held history (marks it opened), or null. */
  async get(key) {
    if (this.disposed) return null;
    const hash = await hashOf(key);
    const got = await this.#read(hash);
    if (!got || got.key !== key) return null;
    const entry = this.index.find((c) => c.h === hash);
    if (entry) {
      entry.at = this.now();
      this.#schedule();
    }
    return got.history;
  }

  /** Remembers a chat's history (newest entries only). Empty history is ignored. Returns at once. */
  record(history, key) {
    if (this.disposed || !Array.isArray(history) || history.length === 0) return;
    this.pending.set(key, history.slice(-MAX_CACHED_ENTRIES));
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
    this.chain = this.chain.catch(() => undefined).then(() => (this.disposed ? undefined : this.#flush()));
    return this.chain;
  }

  async #flush() {
    const batch = [...this.pending];
    this.pending.clear();
    for (const [key, history] of batch) {
      if (this.disposed) return;
      const hash = await hashOf(key);
      const record = await this.#seal({ v: 1, key, history });
      if (this.disposed) return;
      await this.kv.write(chatName(hash), record);
      const size = record.ct.byteLength;
      const entry = this.index.find((c) => c.h === hash);
      if (entry) Object.assign(entry, { at: this.now(), size });
      else this.index.push({ h: hash, at: this.now(), size });
    }
    this.index.sort((a, b) => b.at - a.at);
    let bytes = this.index.reduce((sum, c) => sum + (c.size ?? 0), 0);
    while (this.index.length > this.maxChats || bytes > this.maxBytes) {
      const dropped = this.index.pop();
      if (!dropped) break;
      bytes -= dropped.size ?? 0;
      await this.kv.delete(chatName(dropped.h));
    }
    if (!this.disposed) await this.kv.write(INDEX, { v: 1, chats: this.index });
  }

  /** Deletes every cached chat and the key (sign out, forget). The caller then disposes. */
  async wipe() {
    this.pending.clear();
    this.timers.clearTimeout(this.timer);
    this.timer = null;
    await this.chain.catch(() => undefined);
    for (const chat of this.index) await this.kv.delete(chatName(chat.h));
    this.index = [];
    await this.kv.delete(INDEX);
    await this.kv.delete(KEY);
    this.cryptoKey = null;
  }

  async dispose() {
    this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.disposed = true;
    await this.chain.catch(() => undefined);
  }
}

/** The cursor to ask the Mac for what came after: the newest held entry's id, or null (an older Mac sends none). */
export function newestCursor(history) {
  const id = history?.at?.(-1)?.id;
  return typeof id === "string" && /^[1-9]\d{0,15}$/.test(id) ? id : null;
}

const same = (a, b) => (a.id && b.id ? a.id === b.id : a.role === b.role && a.at === b.at && a.text === b.text);

/** What the Mac's `HistoryDelta` document says, or null when it is not for this chat and cursor. */
export function readDelta(value, key, after) {
  if (!value || typeof value !== "object" || value.v !== 1 || value.key !== key || value.after !== after) return null;
  const entries = (Array.isArray(value.entries) ? value.entries : [])
    .filter((e) => e && (e.role === "user" || e.role === "assistant") && typeof e.text === "string")
    .map((e) => {
      const out = { role: e.role, text: e.text, at: typeof e.at === "string" ? e.at : null };
      if (typeof e.id === "string" && e.id !== "") out.id = e.id;
      if (typeof e.workBefore === "number" && e.workBefore > 0) out.workBefore = e.workBefore;
      return out;
    });
  return {
    entries,
    nextAfter: typeof value.nextAfter === "string" ? value.nextAfter : null,
    reset: value.reset === true,
  };
}

/**
 * The held history with a delta joined to its tail, minus what is already held. A `reset` page does not join the
 * cursor, so it replaces the tail from its first entry on (what lay before it stays; the live push and "Earlier"
 * cover the middle). `more` is true when the Mac has another page.
 */
export function applyDelta(held, delta) {
  if (delta.reset) {
    const first = delta.entries[0];
    const i = first ? held.findIndex((e) => same(e, first)) : -1;
    return { history: i >= 0 ? [...held.slice(0, i), ...delta.entries] : delta.entries, more: false };
  }
  const fresh = delta.entries.filter((e) => !held.some((h) => same(h, e)));
  return {
    history: [...held, ...fresh].slice(-MAX_CACHED_ENTRIES),
    more: delta.nextAfter !== null && fresh.length > 0,
  };
}
