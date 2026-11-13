// The Catalyst relay as a web guest uses it (cloud/catalyst-relay): the same five operations as the Mac's
// `CatalystStore`, with the pond-scoped token in `x-squeak-pond-token`; never a store-wide key, which a guest never holds.
// `PondStream` is the live wake-up: the pond's own Data Streams channel through `POST /pond-stream`, plain JSON text frames
// over a WebSocket (the protocol is the Mac's `StreamHub`, from spikes/catalyst). A notice says only that something in the
// pond changed; the caller re-reads through the store so every check runs. Never acts on a notice's data.

const STREAM_HOST = /^[a-z0-9-]+-dms\.zoho\.(com|eu|in|com\.au|jp|ca|sa)$/;
const KEEPALIVE_MS = 15_000;
const PING_MS = 60_000;
const STALL_MS = 75_000;

/** The browser's fetch, late-bound (so a test can replace it); the page makes no other raw fetch than this file's. */
export const relayFetch = (...args) => globalThis.fetch(...args);

/** A relay answered with a status; 401/403 mean the token no longer opens this pond. */
export class RelayError extends Error {
  constructor(verb, status, code = null) {
    super(`relay ${verb} failed: ${status}`);
    this.status = status;
    /** The relay's `{ "error": "signin" | "email" }` word, when it sent one. */
    this.code = code;
  }
}

/**
 * Who the browser's Catalyst session is, from `GET <relay>/me` (same origin, so the session cookie goes with it):
 * `{ state: "in", user: { userId, email, name } }`, `{ state: "out" }`, or `{ state: "unknown" }` when the relay cannot
 * say (network error, a relay with no accounts, anything but 200 and 401), where the page keeps its name screen.
 */
export async function fetchMe({ baseUrl, fetch: fetchImpl = (...args) => globalThis.fetch(...args), token = null }) {
  try {
    const given = token?.();
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/me`, {
      ...(given ? { headers: { "x-squeak-account": given }, credentials: "omit" } : { credentials: "include" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401) {
      // Signed out is a bare 401 or `{"error":"signin"}`. A 401 that names anything else (a relay with no /me answering
      // with its own token check) cannot tell the page about accounts, so the page keeps its name screen.
      const body = await response.text().catch(() => "x");
      const word = body.trim()
        ? (() => {
            try {
              return JSON.parse(body)?.error;
            } catch {
              return "x";
            }
          })()
        : "signin";
      return { state: word === "signin" ? "out" : "unknown" };
    }
    if (response.status !== 200) return { state: "unknown" };
    const body = await response.json();
    if (typeof body?.userId !== "string" || !body.userId) return { state: "unknown" };
    return {
      state: "in",
      user: {
        userId: body.userId,
        email: typeof body.email === "string" ? body.email : "",
        name: typeof body.name === "string" ? body.name : "",
        ...(typeof body.avatarAt === "number" && body.avatarAt > 0 ? { avatarAt: body.avatarAt } : {}),
      },
    };
  } catch {
    return { state: "unknown" };
  }
}

export class RelayStore {
  /** `token` is a function so a pending guest's join token gives way to the pond token without a new store. */
  constructor({
    baseUrl,
    token,
    header = "x-squeak-pond-token",
    streamRoute = "/pond-stream",
    fetch: fetchImpl = (...args) => globalThis.fetch(...args),
    account = null,
  }) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.token = token;
    /** The header the secret travels in: a guest's pond token, or the owner's `x-squeak-relay` key. */
    this.header = header;
    this.streamRoute = streamRoute;
    this.fetchImpl = fetchImpl;
    /** A function giving this browser's Squeak account token (or null): a page with no session cookie proves its account with it on a join. */
    this.account = account;
  }

  async call(route, init = {}) {
    const account = this.account?.();
    return this.fetchImpl(`${this.base}${route}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        [this.header]: this.token(),
        ...(account ? { "x-squeak-account": account } : {}),
      },
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
      body: JSON.stringify({ doc: wireDoc(doc) }),
    });
    if (!response.ok) {
      const code = await response
        .json()
        .then((b) => (typeof b?.error === "string" ? b.error : null))
        .catch(() => null);
      throw new RelayError("set", response.status, code);
    }
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
    const response = await this.call(this.streamRoute, {
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

/** Only the fields the document has: JSON drops `undefined`, and `Math.trunc(undefined)` would send null. */
function wireDoc(doc) {
  const out = { box: doc.box };
  if (doc.sig !== undefined) out.sig = doc.sig;
  if (doc.device !== undefined) out.device = doc.device;
  if (doc.at !== undefined) out.at = Math.trunc(doc.at);
  return out;
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
 * The opaque tag a hosted relay publishes for a channel: first 22 characters of base64url (no padding) of
 * SHA-256("squeak-notice-v1:" + channelId). Same rule as `noticeTag` in src/cloud/catalyst-store.ts.
 */
export async function noticeTag(channelId) {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(`squeak-notice-v1:${channelId}`)),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 22);
}

const tagCache = new Map();
const cachedTag = (channelId) => {
  if (!tagCache.has(channelId)) tagCache.set(channelId, noticeTag(channelId));
  return tagCache.get(channelId);
};

/**
 * Whether a stream event's data concerns the watched channels. `{"t": tag}` (a hosted relay's opaque notice) wakes only
 * for a watched channel's tag; `{"p": path}`, a notice that cannot be read, or no watched channel wakes as before.
 * Never acts on the data beyond deciding whether to re-read.
 */
export function concerns(raw, channels) {
  const ids = typeof channels === "function" ? channels() : channels;
  if (!Array.isArray(ids) || ids.length === 0) return true;
  let notice = raw;
  if (typeof notice === "string") {
    try {
      notice = JSON.parse(notice);
    } catch {
      return true;
    }
  }
  if (!notice || typeof notice !== "object" || typeof notice.p === "string") return true;
  if (typeof notice.t !== "string") return true;
  return Promise.all(ids.map(cachedTag)).then(
    (tags) => tags.includes(notice.t),
    () => true,
  );
}

/**
 * Calls `wake` once now, on every notice, after every (re)connect and every `pollMs` (the safety net). Reconnects by itself
 * with a growing delay. `channels` (ids, or a function returning them) narrows a tagged notice to those channels.
 * Returns `{ stop() }`. `socket(url)` opens a WebSocket (the browser's by default).
 */
export function watchPond({
  store,
  wake,
  pollMs = 60_000,
  socket = (url) => new WebSocket(url),
  channels = null,
  retryMinMs = 1_000,
  retryMaxMs = 60_000,
  onError = () => undefined,
  onOpen = () => undefined,
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
          if (!stopped) onOpen();
          fire();
          break;
        case "650": {
          const data2 = msg?.opr === "event" ? msg.data : null;
          if (data2 && (typeof data2.streamingId === "string" || typeof data2.streamingId === "number")) {
            send(s, gen, JSON.stringify({ type: "ack", streamingId: String(data2.streamingId) }))();
          }
          const verdict = channels ? concerns(data2?.data, channels) : true;
          if (verdict === true) fire();
          else void verdict.then((yes) => yes && gen === generation && fire());
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
