// The live hub of `squeak-live` (docs/cloud-layer.md, "Live notices"; docs/spec.md, "How a change travels", "Presence is not
// stored"; docs/cloud-spike-2026-11.md, Decision). One open SSE connection per device; the device says which Ponds it watches,
// the hub checks each against the Pond's memberships and sends a short notice {pond, seq, kind} only to the connections that
// hold that subscription. Content never travels here: the device reads /changes after a notice.
//
// What the measured platform forces (spike, Live results): every response ends at about 45 s and the app is never told a client
// went away. So the hub ends each stream itself at MAX_AGE_MS with `event: bye` (the device opens its replacement at about 35 s,
// so two overlap and nothing falls between), heartbeats every 15 s, and presence is "renewed within the last cycle", never a
// socket `close`. Instances do not share memory: notices, removals and presence renewals go through one `fanout` port (one
// Data Streams channel in production, `fanout.js`; an in-memory double in tests), which only instances subscribe to.
//
// Ports: people.isMember(pondId, userId); fanout {publish(text), subscribe(onText) -> unsubscribe}; lastSeen {write(userId, at)}.
const HEARTBEAT_MS = 15_000;
/** The hub ends a stream here (the platform's own cut is about 45 s). */
const MAX_AGE_MS = 40_000;
/** A device is online while its stream was renewed within this long. */
const CYCLE_MS = 45_000;
const SWEEP_MS = 5_000;
/** A membership read is reused this long; a removal does not wait for it (the `rm` message cuts it at once). */
const MEMBER_TTL_MS = 120_000;
const MAX_PONDS = 50;

const POND = /^[A-Za-z0-9_-]{22,64}$/;

function createHub(deps) {
  const people = deps.people;
  const fanout = deps.fanout;
  const lastSeen = deps.lastSeen || { write: async () => undefined };
  const now = deps.now || Date.now;
  const instance = deps.instanceId || Math.random().toString(36).slice(2);
  const log = deps.log || (() => undefined);
  const maxAge = deps.maxAgeMs || MAX_AGE_MS;
  const cycle = deps.cycleMs || CYCLE_MS;

  /** Open connections: { id, userId, deviceId, ponds:Set, send(event, data|null), end() }. */
  const conns = new Set();
  const byPond = new Map();
  /** deviceId -> { userId, at, own }: `own` is true on the instance that took the latest renewal, which alone writes last seen. */
  const devices = new Map();
  /** `${pond}:${user}` -> time of the last membership read that said yes. */
  const members = new Map();
  let unsubscribe = null;
  let sweeper = null;
  let seq = 0;

  const add = (map, key, conn) => {
    let s = map.get(key);
    if (!s) map.set(key, (s = new Set()));
    s.add(conn);
  };
  const remove = (map, key, conn) => {
    const s = map.get(key);
    if (!s) return;
    s.delete(conn);
    if (!s.size) map.delete(key);
  };

  async function isMember(pondId, userId) {
    const key = `${pondId}:${userId}`;
    const at = members.get(key);
    if (at !== undefined && now() - at < MEMBER_TTL_MS) return true;
    const yes = POND.test(pondId) && (await people.isMember(pondId, userId));
    if (yes) members.set(key, now());
    else members.delete(key);
    return yes;
  }

  const publish = async (msg) => {
    try {
      await fanout.publish(JSON.stringify({ ...msg, i: instance }));
    } catch {
      log("live: fan-out publish failed");
    }
  };

  /** Ends a connection: `bye` first when the hub is rotating it, and always out of every index. */
  function finish(conn, bye) {
    if (conn.closed) return;
    conn.closed = true;
    for (const t of conn.timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    conns.delete(conn);
    for (const p of conn.ponds) remove(byPond, p, conn);
    conn.ponds.clear();
    try {
      if (bye) conn.send("bye", {});
      conn.end();
    } catch {
      log("live: connection already gone");
    }
  }

  /** Opens a stream for a device. Resolves with the connection; Ponds the account is not in are refused (listed in `hello`). */
  async function open({ userId, deviceId, ponds, send, end }) {
    const wanted = [...new Set(ponds)].slice(0, MAX_PONDS);
    const accepted = [];
    const refused = [];
    for (const p of wanted) ((await isMember(p, userId)) ? accepted : refused).push(p);
    const conn = { id: ++seq, userId, deviceId, ponds: new Set(accepted), send, end, timers: [], closed: false };
    conns.add(conn);
    for (const p of accepted) add(byPond, p, conn);
    // The device is here: this renewal is what presence rests on.
    devices.set(deviceId, { userId, at: now(), own: true });
    void publish({ t: "pr", dev: deviceId, user: userId, at: now() });
    conn.timers.push(setInterval(() => send(null, null), HEARTBEAT_MS));
    conn.timers.push(setTimeout(() => finish(conn, true), maxAge));
    for (const t of conn.timers) t.unref?.();
    send("hello", { ponds: accepted, refused, maxAgeMs: maxAge, heartbeatMs: HEARTBEAT_MS });
    return conn;
  }

  /** Drops the Pond subscription of every connection of that account at once, and tells the device. */
  function cut(pondId, userId) {
    members.delete(`${pondId}:${userId}`);
    for (const c of [...(byPond.get(pondId) ?? [])]) {
      if (c.userId !== userId) continue;
      c.ponds.delete(pondId);
      remove(byPond, pondId, c);
      c.send("removed", { pond: pondId });
    }
  }

  /** One message from the channel: deliver it to the connections it is for. */
  function receive(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || msg.i === instance) return; // this instance's own echo
    switch (msg.t) {
      case "n": // a change was stamped: {t, pond, seq, kind}
        if (typeof msg.pond === "string" && Number.isInteger(msg.seq))
          for (const c of [...(byPond.get(msg.pond) ?? [])])
            c.send("notice", { pond: msg.pond, seq: msg.seq, kind: msg.kind });
        break;
      case "ty": // typing: passed on, never stored
        for (const c of [...(byPond.get(msg.pond) ?? [])])
          if (c.userId !== msg.user) c.send("typing", { pond: msg.pond, user: msg.user });
        break;
      case "rm": // someone left or was removed
        cut(msg.pond, msg.user);
        break;
      case "pr": {
        const had = devices.get(msg.dev);
        if (!had || had.at <= msg.at) devices.set(msg.dev, { userId: msg.user, at: msg.at, own: false });
        break;
      }
      default:
        break;
    }
  }

  /** The user is typing in a Pond they watch: told to the others on every instance. */
  async function typing(userId, pondId) {
    if (!(await isMember(pondId, userId))) return false;
    receive(JSON.stringify({ t: "ty", pond: pondId, user: userId }));
    await publish({ t: "ty", pond: pondId, user: userId });
    return true;
  }

  const online = (rec) => now() - rec.at <= cycle;

  /** Devices not renewed for a whole cycle have lapsed: last seen is written once, by the instance that saw the last renewal. */
  function sweep() {
    for (const [dev, rec] of devices) {
      if (online(rec)) continue;
      devices.delete(dev);
      if (!rec.own) continue;
      const another = [...devices.values()].some((r) => r.userId === rec.userId && online(r));
      if (!another)
        void Promise.resolve(lastSeen.write(rec.userId, rec.at)).catch(() => log("live: last seen not written"));
    }
  }

  const presenceOf = (userId) => {
    const live = [...devices.values()].filter((r) => r.userId === userId && online(r));
    return { online: live.length > 0, devices: live.length };
  };

  function start() {
    if (!unsubscribe) unsubscribe = fanout.subscribe(receive);
    if (!sweeper) {
      sweeper = setInterval(sweep, SWEEP_MS);
      sweeper.unref?.();
    }
  }

  function stop() {
    unsubscribe?.();
    unsubscribe = null;
    if (sweeper) clearInterval(sweeper);
    sweeper = null;
    for (const c of [...conns]) finish(c, true);
  }

  return {
    open,
    finish,
    receive,
    typing,
    sweep,
    presenceOf,
    start,
    stop,
    stats: () => ({ connections: conns.size, devices: devices.size }),
  };
}

module.exports = { createHub, HEARTBEAT_MS, MAX_AGE_MS, CYCLE_MS, MEMBER_TTL_MS };
