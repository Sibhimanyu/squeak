// Where a paired browser keeps its keys: IndexedDB, as CryptoKey objects by
// structured clone. Both keys are non-extractable, so even script running on
// this page cannot read their bytes out; and nothing here ever touches
// the other web storage, a URL, a cookie or the DOM. `forget` deletes the whole database.

const DB_NAME = "squeak-web";
const STORE = "kv";
const RECORD = "device";
/** The Macs this browser holds a device for: `{ v: 1, active, legacy, records: { [macId]: record } }`. */
const DEVICES = "devices";
/** The per-Mac caches (see chat-stores.js and app.js), cleared when a Mac is removed from this browser. */
const SCOPED_NAMES = ["prefs", "history", "outbox", "read"];
/** The chat-history cache's records (history-cache.js: its key, index and one record per chat) are per Mac too. */
const CHAT_CACHE_PREFIX = "hc:";

/** The Mac a device record opens: the account's `macId`, else its channel (the same id on a hosted Mac). */
export function macKey(record) {
  for (const name of ["macId", "channelId", "deviceId"]) {
    if (typeof record?.[name] === "string" && record[name]) return record[name];
  }
  return "mac";
}

function openDatabase(factory) {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("storage unavailable"));
  });
}

function done(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export class KeyStore {
  constructor(factory = globalThis.indexedDB) {
    this.factory = factory;
    /** The open Mac's id once `load`/`save`/`activate` has run: the per-Mac caches live under it. */
    this.scope = null;
    this.legacy = null;
  }

  /**
   * The active Mac's record, or null:
   * `{ state: "pending" | "paired", macId, deviceId, deviceName, channelId, project, databaseUrl, macName,
   *    channelKey: CryptoKey, signingKey: CryptoKey, publicKeyX963 }`
   */
  async load() {
    const { active, records } = await this.loadAll();
    return (active && records[active]) || null;
  }

  /**
   * Every Mac this browser holds: `{ active: macId | null, records }`. The single record an older version kept under one key
   * becomes the first entry (its caches stay under their old names: `legacy`), and the old key is emptied.
   */
  async loadAll() {
    const found = await this.#raw(DEVICES);
    if (found && typeof found === "object" && found.records && typeof found.records === "object") {
      this.scope = found.active ?? null;
      this.legacy = found.legacy ?? null;
      return { active: found.active ?? null, records: found.records };
    }
    const old = await this.#raw(RECORD);
    if (old && typeof old === "object") {
      const id = macKey(old);
      const migrated = { v: 1, active: id, legacy: id, records: { [id]: old } };
      await this.#put(DEVICES, migrated);
      await this.#put(RECORD, null);
      this.scope = id;
      this.legacy = id;
      return { active: id, records: migrated.records };
    }
    this.scope = null;
    this.legacy = null;
    return { active: null, records: {} };
  }

  /** Keeps `record` as its Mac's device and makes that Mac the active one. */
  async save(record) {
    const id = macKey(record);
    const current = await this.#index();
    current.records[id] = record;
    current.active = id;
    await this.#put(DEVICES, current);
    this.scope = id;
    this.legacy = current.legacy;
  }

  /** Opens another Mac this browser already holds (false when it holds none by that id). */
  async activate(id) {
    const current = await this.#index();
    if (!current.records[id]) return false;
    current.active = id;
    await this.#put(DEVICES, current);
    this.scope = id;
    this.legacy = current.legacy;
    return true;
  }

  /** Drops one Mac's device and its caches from this browser; the next held Mac (if any) becomes the active one. */
  async remove(id) {
    const current = await this.#index();
    if (!current.records[id]) return current;
    delete current.records[id];
    if (current.active === id) current.active = Object.keys(current.records)[0] ?? null;
    const wasLegacy = current.legacy === id;
    if (wasLegacy) current.legacy = null;
    await this.#put(DEVICES, current);
    for (const name of SCOPED_NAMES) await this.#put(wasLegacy ? name : `${id}/${name}`, null);
    for (const key of await this.#keysWith(wasLegacy ? CHAT_CACHE_PREFIX : `${id}/${CHAT_CACHE_PREFIX}`)) {
      await this.#drop(key);
    }
    this.scope = current.active;
    this.legacy = current.legacy;
    return current;
  }

  async #index() {
    await this.loadAll();
    const found = await this.#raw(DEVICES);
    return found?.records
      ? { v: 1, legacy: null, ...found, records: { ...found.records } }
      : { v: 1, active: null, legacy: null, records: {} };
  }

  /** A name as stored: per Mac once one is open, except the caches an older single-Mac version wrote. */
  #name(name) {
    if (!this.scope || this.scope === this.legacy) return name;
    return SCOPED_NAMES.includes(name) || name.startsWith(CHAT_CACHE_PREFIX) ? `${this.scope}/${name}` : name;
  }

  async #raw(name) {
    const db = await openDatabase(this.factory);
    try {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(name);
      return await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }

  async #put(name, value) {
    const db = await openDatabase(this.factory);
    try {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(value, name);
      await done(transaction);
    } finally {
      db.close();
    }
  }

  /** One named value besides the device record (the chat caches). Null when there is none. */
  read(name) {
    return this.#raw(this.#name(name));
  }

  write(name, value) {
    return this.#put(this.#name(name), value);
  }

  /** Deletes one named value of the open Mac (the chat caches' own records). */
  async delete(name) {
    await this.#drop(this.#name(name));
  }

  async #drop(key) {
    const db = await openDatabase(this.factory);
    try {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).delete(key);
      await done(transaction);
    } finally {
      db.close();
    }
  }

  /** Every stored key starting with `prefix` (a removed Mac's chat-cache records are found this way). */
  async #keysWith(prefix) {
    const db = await openDatabase(this.factory);
    try {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys();
      const keys = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result ?? []);
        request.onerror = () => reject(request.error);
      });
      return keys.filter((key) => typeof key === "string" && key.startsWith(prefix));
    } finally {
      db.close();
    }
  }

  /** Wipes every key and every trace of every Mac from this browser (sign out). */
  forget() {
    this.scope = null;
    this.legacy = null;
    return new Promise((resolve, reject) => {
      const request = this.factory.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve();
    });
  }
}
