// Test doubles: a Realtime Database that answers REST and Server-Sent Events
// from memory, and an IndexedDB just big enough for KeyStore.

const encoder = new TextEncoder();

/** A fetch() that behaves like the channel's slice of the Realtime Database. */
export function fakeDatabase() {
  const docs = new Map();
  const streams = new Set();
  const log = [];

  const notify = (changedPath) => {
    for (const stream of streams) {
      if (changedPath === stream.path || changedPath.startsWith(`${stream.path}/`)) {
        const rel = changedPath.slice(stream.path.length) || "/";
        stream.push(`event: put\ndata: ${JSON.stringify({ path: rel, data: docs.get(changedPath) ?? null })}\n\n`);
      }
    }
  };

  const valueAt = (path) => {
    if (docs.has(path)) return docs.get(path);
    const children = {};
    for (const [key, value] of docs) {
      if (key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/"))
        children[key.slice(path.length + 1)] = value;
    }
    return Object.keys(children).length ? children : null;
  };

  async function fetchImpl(url, init = {}) {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname.replace(/^\//, "").replace(/\.json$/, ""));
    const method = init.method ?? "GET";
    log.push({ method, url, headers: init.headers ?? {} });
    if (method === "GET" && init.headers?.accept === "text/event-stream") {
      let controller;
      const stream = new ReadableStream({
        start(c) {
          controller = c;
        },
        cancel() {
          streams.delete(entry);
        },
      });
      const entry = { path, push: (text) => controller.enqueue(encoder.encode(text)) };
      streams.add(entry);
      init.signal?.addEventListener("abort", () => {
        streams.delete(entry);
        try {
          controller.error(new DOMException("aborted", "AbortError"));
        } catch {
          // already closed
        }
      });
      entry.push(`event: put\ndata: ${JSON.stringify({ path: "/", data: valueAt(path) })}\n\n`);
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (method === "GET") return Response.json(valueAt(path));
    if (method === "PUT") {
      docs.set(path, JSON.parse(init.body));
      notify(path);
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE") {
      docs.delete(path);
      notify(path);
      return new Response(null, { status: 204 });
    }
    return new Response("nope", { status: 400 });
  }

  return { fetch: fetchImpl, docs, streams, log };
}

/** An IndexedDB with one object store and structured-clone values, as KeyStore uses it. */
export function fakeIndexedDB() {
  const databases = new Map();
  const later = (fn) => queueMicrotask(fn);
  return {
    databases,
    open(name) {
      const request = {};
      later(() => {
        let data = databases.get(name);
        const fresh = !data;
        if (fresh) databases.set(name, (data = new Map()));
        const db = {
          createObjectStore() {},
          close() {},
          transaction() {
            const tx = {
              objectStore: () => ({
                put(value, key) {
                  data.set(key, structuredClone(value));
                  later(() => tx.oncomplete?.());
                },
                get(key) {
                  const get = {};
                  later(() => {
                    get.result = data.has(key) ? structuredClone(data.get(key)) : undefined;
                    get.onsuccess?.();
                  });
                  return get;
                },
              }),
            };
            return tx;
          },
        };
        request.result = db;
        if (fresh) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
    deleteDatabase(name) {
      const request = {};
      later(() => {
        databases.delete(name);
        request.onsuccess?.();
      });
      return request;
    },
  };
}
