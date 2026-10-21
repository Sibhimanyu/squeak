// The channel's documents in Firebase's Realtime Database over REST, and its
// change stream over Server-Sent Events read with fetch: no SDK. Mirrors
// src/remote/rtdb-rest.ts and RealtimeDatabase.swift.

import { databaseOrigin } from "./pairing-link.js";

const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 5_000;
/** Keep-alives arrive every 30s; 45s of silence means the stream is dead. */
export const STALL_MS = 45_000;

/** Splits a text/event-stream body into `{ name, data }` events. */
export async function* readEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let name = "message";
  let data = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (data.length > 0 || name !== "message") yield { name, data: data.join("\n") };
          name = "message";
          data = [];
        } else if (line.startsWith("event:")) {
          name = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** `{ box, sig?, device?, at? }` or null: anything else in a node is not a document. */
export function toDoc(value) {
  if (!value || typeof value !== "object" || typeof value.box !== "string") return null;
  const doc = { box: value.box };
  if (typeof value.sig === "string") doc.sig = value.sig;
  if (typeof value.device === "string") doc.device = value.device;
  if (typeof value.at === "number") doc.at = value.at;
  return doc;
}

export class RtdbClient {
  /** `databaseUrl` must pass `databaseOrigin`; `fetchImpl` is injectable for tests. */
  constructor(databaseUrl, fetchImpl = (...args) => globalThis.fetch(...args)) {
    const origin = databaseOrigin(databaseUrl);
    if (!origin) throw new Error("not a Realtime Database URL");
    this.base = origin;
    this.fetch = fetchImpl;
    /** path -> { listeners, stop } : one connection per path, however many listen. */
    this.streams = new Map();
  }

  url(path, query) {
    const clean = path
      .split("/")
      .filter(Boolean)
      .map((part) => encodeURIComponent(part))
      .join("/");
    return `${this.base}/${clean}.json${query ? `?${query}` : ""}`;
  }

  async get(path) {
    const response = await this.fetch(this.url(path), { signal: AbortSignal.timeout(10_000), cache: "no-store" });
    await ensureOk(response, "get");
    return toDoc(await response.json());
  }

  async set(path, doc) {
    const body = { box: doc.box };
    if (doc.sig !== undefined) body.sig = doc.sig;
    if (doc.device !== undefined) body.device = doc.device;
    if (doc.at !== undefined) body.at = Math.trunc(doc.at);
    const response = await this.fetch(this.url(path, "print=silent"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    await ensureOk(response, "set");
  }

  async delete(path) {
    const response = await this.fetch(this.url(path, "print=silent"), {
      method: "DELETE",
      signal: AbortSignal.timeout(10_000),
    });
    await ensureOk(response, "delete");
  }

  /**
   * Calls `listener(event)` for each change at or under `path` (`event.path`
   * is relative to it), and `{ kind: "open" | "dropped" | "heard" }` as the
   * connection lives. It says only *that* something changed: the caller reads
   * what it needs through `get`, so every check still runs on what it reads.
   * One connection per path, shared by every listener (the database speaks
   * HTTP/1.1 and a browser allows six per host). Returns the unsubscribe.
   */
  watch(path, listener) {
    let shared = this.streams.get(path);
    if (!shared) {
      shared = { listeners: new Set(), stop: null };
      shared.stop = this.#connectLoop(path, shared);
      this.streams.set(path, shared);
    }
    shared.listeners.add(listener);
    return () => {
      shared.listeners.delete(listener);
      if (shared.listeners.size === 0) {
        shared.stop();
        this.streams.delete(path);
      }
    };
  }

  /** Closes every stream (a hidden tab holds none). */
  closeAll() {
    for (const shared of this.streams.values()) shared.stop();
    this.streams.clear();
  }

  #connectLoop(path, shared) {
    let stopped = false;
    let controller = null;
    let retryMs = RETRY_MIN_MS;
    let retryTimer = null;
    const emit = (event) => {
      for (const listener of [...shared.listeners]) listener(event);
    };
    const run = async () => {
      controller = new AbortController();
      const current = controller;
      let stall = null;
      const feed = () => {
        clearTimeout(stall);
        stall = setTimeout(() => current.abort(), STALL_MS);
      };
      try {
        const response = await this.fetch(this.url(path), {
          headers: { accept: "text/event-stream" },
          signal: current.signal,
          cache: "no-store",
        });
        await ensureOk(response, "watch");
        if (!response.body) throw new Error("no stream");
        retryMs = RETRY_MIN_MS;
        emit({ kind: "open" });
        feed();
        for await (const event of readEvents(response.body)) {
          feed();
          emit({ kind: "heard" });
          if (event.name === "put" || event.name === "patch") {
            let at = "/";
            try {
              at = JSON.parse(event.data)?.path ?? "/";
            } catch {
              // An event we cannot read still means "something changed".
            }
            emit({ kind: "change", path: String(at) });
          } else if (event.name === "cancel" || event.name === "auth_revoked") {
            throw new Error(event.name);
          }
        }
        throw new Error("stream ended");
      } catch {
        if (!stopped) emit({ kind: "dropped" });
      } finally {
        clearTimeout(stall);
      }
      if (!stopped) {
        retryTimer = setTimeout(run, retryMs);
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }
    };
    void run();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      controller?.abort();
    };
  }
}

async function ensureOk(response, verb) {
  if (!response.ok) throw new Error(`database ${verb} failed (${response.status})`);
}
