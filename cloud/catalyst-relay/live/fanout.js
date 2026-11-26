// The fan-out port between `squeak-live` instances (hub.js): `publish(text)` reaches every subscribed instance, `subscribe(onText)`
// returns an unsubscribe. In production it is one internal Data Streams channel (`squeak_live`) that only the instances
// subscribe to (at most five); a device never touches it. The relay publishes notices there after a stamped write
// (functions/squeak_relay/live-notice.js).

/** The in-memory double: one bus, any number of fake instances, delivery asynchronous like a real channel. */
function createMemoryBus() {
  const subs = new Set();
  const deliver = (text) => {
    for (const fn of [...subs]) void Promise.resolve().then(() => fn(text));
  };
  return {
    /** What the relay does: publish from outside every instance. */
    publish: async (text) => deliver(text),
    /** One instance's view of the channel. */
    instance: () => ({
      publish: async (text) => deliver(text),
      subscribe: (fn) => {
        subs.add(fn);
        return () => subs.delete(fn);
      },
    }),
    subscribers: () => subs.size,
  };
}

const STREAM_HOST = /^[a-z0-9-]+-dms\.zoho\.(com|eu|in|com\.au|jp|ca|sa)$/;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const PING_MS = 60_000;
const KEEPALIVE_MS = 15_000;
const STALL_MS = 75_000;

/**
 * Data Streams as the fan-out: one WebSocket subscriber per instance (the same frames the daemon's own subscriber speaks,
 * src/cloud/catalyst-store.ts) and publishing through `publishFn(text)`. Both come from outside: `token()` returns
 * { url, key, wssId } (an AppSail app cannot mint them, so the relay function does, `POST /live/token`), `publishFn` is
 * the relay's `POST /live/publish`. Not run against a live project (docs/cloud-layer.md lists the console steps).
 */
function createDataStreamsFanout({ token, publish: publishFn, socket, log = () => undefined }) {
  const open = socket || ((url) => new WebSocket(url));
  const listeners = new Set();
  let running = false;
  let ws = null;
  let timers = [];
  let retryMs = RETRY_MIN_MS;
  let retry = null;
  let stall = null;
  let generation = 0;

  const clear = () => {
    for (const t of timers) clearInterval(t);
    timers = [];
    if (stall) clearTimeout(stall);
    stall = null;
  };
  const drop = () => {
    clear();
    const s = ws;
    ws = null;
    generation++;
    if (s) {
      s.onmessage = s.onclose = null;
      s.onerror = () => undefined;
      try {
        s.close();
      } catch {
        /* already closed */
      }
    }
  };
  const fail = (why) => {
    drop();
    if (!running) return;
    log(`live fan-out: ${why}; retry in ${retryMs} ms`);
    retry = setTimeout(connect, retryMs);
    retry.unref?.();
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  };
  const feed = (gen) => {
    if (stall) clearTimeout(stall);
    stall = setTimeout(() => gen === generation && fail("stalled"), STALL_MS);
    stall.unref?.();
  };

  async function connect() {
    if (!running) return;
    const gen = ++generation;
    try {
      const t = await token();
      if (gen !== generation) return;
      if (!STREAM_HOST.test(t.url)) throw new Error("unexpected host");
      const s = open(
        `wss://${t.url}/wsconnect?prd=CY&zuid=${encodeURIComponent(t.wssId)}&key=${encodeURIComponent(t.key)}`,
      );
      ws = s;
      s.onerror = () => undefined;
      s.onclose = () => gen === generation && fail("closed");
      s.onmessage = (ev) => {
        if (gen !== generation) return;
        feed(gen);
        frames(s, gen, ev.data);
      };
      feed(gen);
    } catch (e) {
      if (gen === generation) fail(String((e && e.message) || e));
    }
  }

  function frames(s, gen, data) {
    if (typeof data !== "string" || !data.trim()) return;
    let list;
    try {
      list = JSON.parse(data);
    } catch {
      return;
    }
    for (const f of Array.isArray(list) ? list : [list]) {
      if (!f || typeof f !== "object") continue;
      const mtype = String(f.mtype);
      if (mtype === "0") {
        s.send(JSON.stringify({ type: "con", value: "subscribe", streamingId: "0" }));
        clear();
        const beat = (text) => () => gen === generation && ws === s && s.send(text);
        timers = [
          setInterval(beat("-"), KEEPALIVE_MS),
          setInterval(beat(JSON.stringify({ type: "con", value: "ping" })), PING_MS),
        ];
        for (const t of timers) t.unref?.();
        retryMs = RETRY_MIN_MS;
      } else if (mtype === "650" && f.msg && f.msg.opr === "event" && f.msg.data) {
        const d = f.msg.data;
        if (d.streamingId !== undefined) s.send(JSON.stringify({ type: "ack", streamingId: String(d.streamingId) }));
        if (typeof d.data === "string") for (const fn of [...listeners]) fn(d.data);
      } else if (mtype === "-1") {
        drop();
        retryMs = RETRY_MIN_MS;
        retry = setTimeout(connect, 0);
        return;
      } else if (["-5", "-2", "-11", "660", "670"].includes(mtype)) {
        fail(`server said ${mtype}`);
        return;
      }
    }
  }

  return {
    publish: async (text) => publishFn(text),
    subscribe(fn) {
      listeners.add(fn);
      if (!running) {
        running = true;
        void connect();
      }
      return () => {
        listeners.delete(fn);
        if (!listeners.size) {
          running = false;
          if (retry) clearTimeout(retry);
          drop();
        }
      };
    },
  };
}

module.exports = { createMemoryBus, createDataStreamsFanout };
