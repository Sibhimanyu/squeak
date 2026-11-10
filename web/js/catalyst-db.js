// The owner app's Catalyst store: the surface `rtdb.js` gives the channel (get / set / delete / watch / closeAll) over the
// Catalyst relay (cloud/catalyst-relay), with the relay key in `x-squeak-relay`. The guest page's `RelayStore` and
// `watchPond` do the work (same routes, same Data Streams protocol; the owner's token route is `/token`, the guest's
// `/pond-stream`). A notice says only that something changed: listeners get `{ kind: "change" }` and re-read through
// `get`, so every check still runs. One socket serves every listener; a 60 s poll is the safety net.

import { RelayStore, watchPond } from "./guest-relay.js";
import { relayBaseUrl } from "./guest-invite.js";
import { validRelayKey } from "./pairing-link.js";

export class CatalystDb {
  /** `baseUrl` and `key` must pass `relayBaseUrl` / `validRelayKey`; `fetch` and `socket` are injectable for tests. */
  constructor({ baseUrl, key, fetch: fetchImpl, socket, pollMs = 60_000, retryMinMs, retryMaxMs }) {
    const base = relayBaseUrl(baseUrl);
    if (!base || !validRelayKey(key)) throw new Error("not a Catalyst relay");
    this.base = base;
    this.store = new RelayStore({
      baseUrl: base,
      token: () => key,
      header: "x-squeak-relay",
      streamRoute: "/token",
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    this.options = { socket, pollMs, retryMinMs, retryMaxMs };
    this.listeners = new Set();
    this.watcher = null;
  }

  get(path) {
    return this.store.get(path);
  }

  set(path, doc) {
    return this.store.set(path, doc);
  }

  delete(path) {
    return this.store.delete(path);
  }

  list(collection) {
    return this.store.list(collection);
  }

  /**
   * Calls `listener({ kind })` with "open"/"dropped" as the socket lives and "change" on a notice, a (re)connect and
   * every poll. `path` is accepted for the channel's sake: one socket carries every path, so a change under any of
   * them wakes every listener (they re-read what they need). Returns the unsubscribe.
   */
  watch(_path, listener) {
    this.listeners.add(listener);
    if (!this.watcher) this.#start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.closeAll();
    };
  }

  closeAll() {
    this.watcher?.stop();
    this.watcher = null;
    this.listeners.clear();
  }

  #emit(event) {
    for (const listener of [...this.listeners]) listener(event);
  }

  #start() {
    const { socket, pollMs, retryMinMs, retryMaxMs } = this.options;
    this.watcher = watchPond({
      store: this.store,
      pollMs,
      ...(socket ? { socket } : {}),
      ...(retryMinMs ? { retryMinMs } : {}),
      ...(retryMaxMs ? { retryMaxMs } : {}),
      wake: () => this.#emit({ kind: "change", path: "/" }),
      onOpen: () => this.#emit({ kind: "open" }),
      onError: () => this.#emit({ kind: "dropped" }),
    });
  }
}
