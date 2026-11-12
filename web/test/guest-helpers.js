/* A fake Catalyst relay for the web guest's tests: the real relay handler (cloud/catalyst-relay) in process over an
   in-memory store, reached through a fetch() that logs every request, and Node's real FlotillaService as the owner. */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { guestInviteBase } from "../../src/cloud/config.js";
import { CatalystStore } from "../../src/cloud/catalyst-store.js";
import { FlotillaService } from "../../src/flotilla/service.js";
import { HttpPondRelay } from "../../src/flotilla/relay.js";

const require = createRequire(import.meta.url);
const { createRelay } = require("../../cloud/catalyst-relay/functions/squeak_relay/handler.js");

export const KEY = "relay-key-".padEnd(43, "k");
export const RELAY_URL = "https://squeak.catalystserverless.in/server/squeak_relay";

export function fakeRelay() {
  const rows = new Map();
  const requests = [];
  const published = [];
  const deps = {
    key: KEY,
    store: {
      ready: async () => true,
      get: async (pk, doc) => rows.get(`${pk}|${doc}`) ?? null,
      put: async (pk, doc, json) => void rows.set(`${pk}|${doc}`, json),
      del: async (pk, doc) => void rows.delete(`${pk}|${doc}`),
      list: async (pk) =>
        [...rows].filter(([k]) => k.startsWith(`${pk}|`)).map(([k, json]) => ({ doc: k.split("|")[1], json })),
    },
    streams: {
      channelId: async () => "chan",
      pondChannelId: async () => "pond-chan",
      publish: async (channel, text) => void published.push({ channel, text }),
      token: async (_id, name) => ({ url: "in1-dms.zoho.in", key: `tok-${name}`, "wss-id": "w1" }),
    },
  };
  const handler = createRelay(deps);
  const fetchLike = async (url, init = {}) => {
    const u = new URL(url);
    requests.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ?? "" });
    const req = new EventEmitter();
    req.method = init.method ?? "GET";
    req.url = u.pathname + u.search;
    req.headers = Object.fromEntries(Object.entries(init.headers ?? {}));
    let status = 0;
    let text = "";
    const res = { writeHead: (s) => (status = s), end: (t) => (text = t ?? "") };
    const done = handler(req, res);
    // A macrotask, so a handler that awaits (an identity lookup) before it reads the body still gets every event.
    setTimeout(() => {
      if (typeof init.body === "string") req.emit("data", Buffer.from(init.body));
      req.emit("end");
    });
    await done;
    return new Response(status === 204 ? null : text || "{}", { status });
  };
  return { fetch: fetchLike, rows, requests, published };
}

const dirs = [];
export const cleanup = () => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
};
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "web-guest-"));
  dirs.push(d);
  return d;
};

const nostore = {
  get: async () => null,
  set: async () => undefined,
  list: async () => [],
  delete: async () => undefined,
  watch: () => () => undefined,
};

/** A Mac (owner or member) as the engine runs it, over the fake relay. */
export function mac(relay, name, { owner = false, now } = {}) {
  const location = { provider: "catalyst", relayUrl: RELAY_URL, relayKey: KEY };
  const store = new CatalystStore({ baseUrl: RELAY_URL, relayKey: KEY, fetch: relay.fetch });
  const storeFor = (loc, token) =>
    token
      ? new CatalystStore({ baseUrl: loc.relayUrl, pondToken: token, fetch: relay.fetch })
      : new CatalystStore({ baseUrl: loc.relayUrl, relayKey: loc.relayKey, fetch: relay.fetch });
  return new FlotillaService({
    store: owner ? store : nostore,
    supportDir: tmp(),
    displayName: name,
    nest: `${name}-mac`,
    ...(owner
      ? {
          location,
          relay: new HttpPondRelay(RELAY_URL, KEY, relay.fetch),
          inviteLinkBase: guestInviteBase({ appUrl: new URL(RELAY_URL).origin }),
        }
      : {}),
    storeFor,
    ...(now ? { now } : {}),
  });
}
