// This browser's device key. The web is a device like any other (docs/ponds.md, "Members are accounts"): it holds a P-256 key
// pair (one to sign, one to open boxes sealed to it), the Owner's Mac seals each Pond key to the public half, and the private
// half never leaves the browser. It lives in IndexedDB as non-extractable CryptoKeys (structured-cloned, so the browser can use
// them but no script can read the bytes). One key set per account on this browser.

import { deviceIdOf, exportPublic, generateDeviceKeys, type DeviceKeys } from "../../../src/shared/member-box.js";

export interface KeyVault {
  load(userId: string): Promise<DeviceKeys | null>;
  save(userId: string, keys: DeviceKeys): Promise<void>;
}

/** A device key plus what the relay and the Owner's Mac need to know about it. */
export interface DeviceIdentity {
  keys: DeviceKeys;
  /** Signing public key (x963 base64): the device's `publicKey`. */
  publicKey: string;
  /** Box public key: where Pond keys are sealed to. */
  boxKey: string;
  /** `memberIdOf(publicKey)`. */
  deviceId: string;
}

const DB = "squeak-device";
const STORE = "keys";

const wrap = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexeddb"));
  });

export function createIdbVault(factory: IDBFactory): KeyVault {
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const request = factory.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("indexeddb"));
    });
  return {
    async load(userId) {
      const db = await open();
      try {
        const found = (await wrap(db.transaction(STORE).objectStore(STORE).get(userId))) as DeviceKeys | undefined;
        return found?.sign && found.box ? found : null;
      } finally {
        db.close();
      }
    },
    async save(userId, keys) {
      const db = await open();
      try {
        await wrap(db.transaction(STORE, "readwrite").objectStore(STORE).put(keys, userId));
      } finally {
        db.close();
      }
    },
  };
}

/** Where IndexedDB is not available (a locked-down browser): the key lasts until the tab closes. */
export function createMemoryVault(): KeyVault {
  const held = new Map<string, DeviceKeys>();
  return {
    load: async (userId) => held.get(userId) ?? null,
    save: async (userId, keys) => void held.set(userId, keys),
  };
}

export const defaultVault = (): KeyVault =>
  typeof indexedDB === "undefined" ? createMemoryVault() : createIdbVault(indexedDB);

/** This browser's key for the account: made once, kept. A vault that cannot be read or written falls back to a key for this tab. */
export async function loadIdentity(vault: KeyVault, userId: string): Promise<DeviceIdentity> {
  let keys: DeviceKeys | null;
  try {
    keys = await vault.load(userId);
  } catch {
    keys = null;
  }
  if (!keys) {
    keys = await generateDeviceKeys();
    try {
      await vault.save(userId, keys);
    } catch {
      // kept in memory for this tab
    }
  }
  const publicKey = await exportPublic(keys.sign.publicKey);
  return { keys, publicKey, boxKey: await exportPublic(keys.box.publicKey), deviceId: await deviceIdOf(publicKey) };
}
