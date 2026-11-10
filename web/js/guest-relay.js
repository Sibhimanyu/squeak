// The Catalyst relay as a web guest uses it (cloud/catalyst-relay): the same five operations as the Mac's
// `CatalystStore`, with the pond-scoped token in `x-squeak-pond-token`; never a store-wide key, which a guest never holds.
// `PondStream` is the live wake-up: the pond's own Data Streams channel through `POST /pond-stream`, plain JSON text frames
// over a WebSocket (the protocol is the Mac's `StreamHub`, from spikes/catalyst). A notice says only that something in the
// pond changed; the caller re-reads through the store so every check runs. Never acts on a notice's data.

const STREAM_HOST = /^[a-z0-9-]+-dms\.zoho\.(com|eu|in|com\.au|jp|ca|sa)$/;
const KEEPALIVE_MS = 15_000;
const PING_MS = 60_000;
const STALL_MS = 75_000;

/** A relay answered with a status; 401/403 mean the token no longer opens this pond. */
export class RelayError extends Error {
  constructor(verb, status) {
    super(`relay ${verb} failed: ${status}`);
    this.status = status;
  }
}

export class RelayStore {
  /** `token` is a function so a pending guest's join token gives way to the pond token without a new store. */
  constructor({ baseUrl, token, fetch: fetchImpl = (...args) => globalThis.fetch(...args) }) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async call(route, init = {}) {
    return this.fetchImpl(`${this.base}${route}`, {
      ...init,
      headers: { ...(init.headers ?? {}), "x-squeak-pond-token": this.token() },
      signal: AbortSignal.timeout(10_000),
    });
  }

  async get(path) {
    const response = await this.call(`/doc?path=${encodeURIComponent(path)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new RelayError("get", response.status);
    return toDoc((await response.json()).doc);
  }

  async set(path, doc) {
    const response = await this.call(`/doc?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ doc: { box: doc.box, sig: doc.sig, device: doc.device, at: Math.trunc(doc.at) } }),
    });
    if (!response.ok) throw new RelayError("set", response.status);
  }

  async list(collection) {
    const response = await this.call(`/list?prefix=${encodeURIComponent(collection)}`);
    if (!response.ok) throw new RelayError("list", response.status);
    const items = (await response.json()).items;
    if (!Array.isArray(items)) return [];
    return items.flatMap((item) => {
      const doc = toDoc(item?.doc);
      return typeof item?.id === "string" && doc ? [{ id: item.id, doc }] : [];
    });
  }

  async delete(path) {
    const response = await this.call(`/doc?path=${encodeURIComponent(path)}`, { method: "DELETE" });
    if (!response.ok) throw new RelayError("delete", response.status);
  }

  /** The pond's own stream token pair. */
  async streamToken() {
    const name = `sq${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36).slice(-6)}`.slice(0, 20);
    const response = await this.call("/pond-stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new RelayError("stream", response.status);
    const body = await response.json();
    if (typeof body.url !== "string" || typeof body.key !== "string" || typeof body.wssId !== "string") {
      throw new Error("relay stream: unexpected answer");
    }
    return body;
  }
}

function toDoc(value) {
  if (!value || typeof value !== "object" || typeof value.box !== "string") return null;
  const doc = { box: value.box };
  if (typeof value.sig === "string") doc.sig = value.sig;
  if (typeof value.device === "string") doc.device = value.device;
  if (typeof value.at === "number") doc.at = value.at;
  return doc;
}

/**
 * Calls `wake` once now, on every notice, after every (re)connect and every `pollMs` (the safety net). Reconnects by itself
 * with a growing delay. Returns `{ stop() }`. `socket(url)` opens a WebSocket (the browser's by default).
 */
export function watchPond({
  store,
  wake,
  pollMs = 60_000,
  socket = (url) => new WebSocket(url),
  retryMinMs = 1_000,
  retryMaxMs = 60_000,
  onError = () => undefined,
}) {
  let stopped = false;
  let generation = 0;
  let current = null;
  let retryMs = retryMinMs;
  let retryTimer = null;
  let stall = null;
  let keep = [];

  const fire = () => {
    if (!stopped) wake();
  };
  const clear = () => {
    for (const t of keep) clearInterval(t);
    keep = [];
    if (stall) clearTimeout(stall);
    stall = null;
  };
  const drop = () => {
    const s = current;
    current = null;
    clear();
    if (!s) return;
    s.onmessage = s.onclose = null;
    s.onerror = () => undefined;
    try {
      s.send(JSON.stringify({ type: "con", value: "unsubscribe" }));
    } catch {
      // Already dead.
    }
    setTimeout(() => {
      try {
        s.close();
      } catch {
        // Already closed.
      }
    }, 50);
  };
  const fail = (error) => {
    onError(error);
    drop();
    if (stopped || retryTimer) return;
    generation += 1;
    const wait = retryMs;
    retryMs = Math.min(retryMs * 2, retryMaxMs);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, wait);
  };
  const feed = (gen) => {
    if (stall) clearTimeout(stall);
    stall = setTimeout(() => {
      if (gen === generation && !stopped) fail(new Error("stream stalled"));
    }, STALL_MS);
  };
  const send = (s, gen, text) => () => {
    if (gen !== generation) return;
    try {
      s.send(text);
    } catch {
      // Noticed by the close.
    }
  };
  const frame = (s, gen, data) => {
    if (typeof data !== "string" || data.trim() === "") return;
    let frames;
    try {
      frames = JSON.parse(data);
    } catch {
      return;
    }
    for (const f of Array.isArray(frames) ? frames : [frames]) {
      if (!f || typeof f !== "object") continue;
      const { mtype, msg } = f;
      switch (String(mtype)) {
        case "0":
          s.send(JSON.stringify({ type: "con", value: "subscribe", streamingId: "0" }));
          keep = [
            setInterval(send(s, gen, "-"), KEEPALIVE_MS),
            setInterval(send(s, gen, JSON.stringify({ type: "con", value: "ping" })), PING_MS),
          ];
          retryMs = retryMinMs;
          fire();
          break;
        case "650": {
          const data2 = msg?.opr === "event" ? msg.data : null;
          if (data2 && (typeof data2.streamingId === "string" || typeof data2.streamingId === "number")) {
            send(s, gen, JSON.stringify({ type: "ack", streamingId: String(data2.streamingId) }))();
          }
          fire();
          break;
        }
        case "-5":
        case "-2":
        case "-11":
        case "-1":
        case "660":
        case "670":
          fail(new Error(`stream: server said ${String(mtype)}`));
          return;
        default:
          break;
      }
    }
  };
  async function connect() {
    if (stopped) return;
    const gen = ++generation;
    try {
      const token = await store.streamToken();
      if (gen !== generation || stopped) return;
      if (!STREAM_HOST.test(token.url)) throw new Error("stream: unexpected host");
      const s = socket(
        `wss://${token.url}/wsconnect?prd=CY&zuid=${encodeURIComponent(token.wssId)}&key=${encodeURIComponent(token.key)}`,
      );
      current = s;
      s.onopen = () => undefined;
      s.onmessage = (event) => {
        if (gen !== generation) return;
        feed(gen);
        frame(s, gen, event.data);
      };
      s.onerror = () => undefined;
      s.onclose = () => {
        if (gen === generation && !stopped) fail(new Error("stream closed"));
      };
      feed(gen);
    } catch (error) {
      if (gen === generation && !stopped) fail(error);
    }
  }

  const poll = setInterval(fire, pollMs);
  setTimeout(fire, 0);
  void connect();
  return {
    stop() {
      stopped = true;
      clearInterval(poll);
      if (retryTimer) clearTimeout(retryTimer);
      generation += 1;
      drop();
    },
  };
}
