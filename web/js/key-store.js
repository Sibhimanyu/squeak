// Where a paired browser keeps its keys: IndexedDB, as CryptoKey objects by
// structured clone. Both keys are non-extractable, so even script running on
// this page cannot read their bytes out; and nothing here ever touches
// the other web storage, a URL, a cookie or the DOM. `forget` deletes the whole database.

const DB_NAME = "squeak-web";
const STORE = "kv";
const RECORD = "device";

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
  }

  /**
   * The saved record, or null:
   * `{ state: "pending" | "paired", deviceId, deviceName, channelId, project, databaseUrl, macName,
   *    channelKey: CryptoKey, signingKey: CryptoKey, publicKeyX963 }`
   */
  async load() {
    const db = await openDatabase(this.factory);
    try {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(RECORD);
      return await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }

  async save(record) {
    const db = await openDatabase(this.factory);
    try {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(record, RECORD);
      await done(transaction);
    } finally {
      db.close();
    }
  }

  /** One named value besides the device record (the chat caches). Null when there is none. */
  async read(name) {
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

  async write(name, value) {
    const db = await openDatabase(this.factory);
    try {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(value, name);
      await done(transaction);
    } finally {
      db.close();
    }
  }

  /** Wipes every key and every trace of the pairing from this browser. */
  forget() {
    return new Promise((resolve, reject) => {
      const request = this.factory.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve();
    });
  }
}
