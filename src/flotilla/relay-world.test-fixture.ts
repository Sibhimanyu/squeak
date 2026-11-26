/* eslint-disable @typescript-eslint/no-explicit-any -- the relay is untyped CommonJS served in-process */
// The real relay (handler.js, with the people tables in memory) served over HTTP in-process, and Macs wired the way a daemon
// builds them (src/flotilla/index.ts): HttpPondRelay, HttpPondInvites, CatalystStore, FlotillaService, FlotillaBridge. Used by
// the journeys that must prove the Owner's Mac and an invited person's Mac agree through the relay's one invite record.
import fs from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";

import { CatalystStore, type StreamSocket } from "../cloud/catalyst-store.js";
import { createCloudStore } from "../cloud/config.js";
import { FlotillaBridge } from "./bridge.js";
import { randomId } from "./crypto.js";
import { HttpPondInvites } from "./invites-port.js";
import { FakeHost } from "./journey-support.js";
import { HttpPondRelay } from "./relay.js";
import { FlotillaService } from "./service.js";

const require = createRequire(import.meta.url);
const fn = new URL("../../cloud/catalyst-relay/functions/squeak_relay/", import.meta.url).pathname;
const { createRelay } = require(`${fn}handler.js`);
const { createPeople } = require(`${fn}people.js`);
const { createMemoryTables } = require(`${fn}people-memory.js`);
const peopleSchema = require(`${fn}people-schema.json`);
const { createServer } = require("../../cloud/catalyst-relay/appsail/server.js");

const RELAY_KEY = "k".repeat(43);
export const BASE = "https://squeak-relay.development.catalystappsail.in";
const SHARED_CHANNEL = "shared-stream-1";

function memoryStore() {
  const rows = new Map<string, string>();
  return {
    ready: async () => true,
    get: async (pk: string, doc: string) => rows.get(`${pk}|${doc}`) ?? null,
    put: async (pk: string, doc: string, json: string) => void rows.set(`${pk}|${doc}`, json),
    del: async (pk: string, doc: string) => void rows.delete(`${pk}|${doc}`),
    list: async (pk: string) =>
      [...rows].filter(([k]) => k.startsWith(`${pk}|`)).map(([k, json]) => ({ doc: k.slice(pk.length + 1), json })),
  };
}

class MemoryStreams {
  readonly sockets = new Set<FakeSocket>();
  private n = 0;
  deps = {
    channelId: async () => SHARED_CHANNEL,
    pondChannelId: async () => null,
    publish: async (id: string, text: string) => {
      for (const s of this.sockets) if (s.channel === id) s.deliver(text, ++this.n);
    },
    token: async (id: string, name: string) => ({ url: "in1-dms.zoho.in", key: `${id}|${name}`, "wss-id": "w1" }),
  };
  socket = (url: string): StreamSocket => new FakeSocket(this, url);
}

class FakeSocket implements StreamSocket {
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  readonly channel: string;
  constructor(
    private readonly hub: MemoryStreams,
    url: string,
  ) {
    this.channel = decodeURIComponent(new URL(url).searchParams.get("key") ?? "").split("|")[0]!;
    hub.sockets.add(this);
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ mtype: "0" }) }), 0);
  }
  send(): void {}
  close(): void {
    this.hub.sockets.delete(this);
  }
  deliver(text: string, n: number): void {
    this.onmessage?.({
      data: JSON.stringify({ mtype: "650", msg: { opr: "event", data: { data: text, streamingId: String(n) } } }),
    });
  }
}

export interface TestUser {
  userId: string;
  email: string;
  name: string;
}

export type RelayMac = Awaited<ReturnType<RelayWorld["mac"]>>;

/** One relay (with people tables and a mail sink), and the Macs signed in to it. `stop()` closes it and removes the files. */
export class RelayWorld {
  readonly sent: Array<{ to: string; subject: string; text: string }> = [];
  private readonly servers: Array<ReturnType<typeof createServer>> = [];
  private readonly dirs: string[] = [];
  private readonly streams = new MemoryStreams();
  deviceUrl = "";
  private functionUrl = "";

  static async start(): Promise<RelayWorld> {
    const w = new RelayWorld();
    const common = {
      key: RELAY_KEY,
      store: memoryStore(),
      streams: w.streams.deps,
      hosted: true,
      sharedNotice: true,
      log: () => {},
      usageCache: new Map(),
      ownerCache: new Map(),
      people: createPeople({ tables: createMemoryTables(peopleSchema) }),
      mail: { send: async (m: { to: string; subject: string; text: string }) => void w.sent.push(m) },
    };
    const asFunction = (req: any, res: any) => {
      const who = req.headers["x-test-user"];
      const user = who ? (JSON.parse(String(who)) as TestUser) : null;
      return createRelay({ ...common, currentUser: async () => user })(req, res);
    };
    const asAppSail = (req: any, res: any) => createRelay({ ...common, currentUser: async () => null })(req, res);
    w.functionUrl = await w.listen(createServer({ handle: asFunction, log: () => {} }));
    w.deviceUrl = await w.listen(createServer({ handle: asAppSail, log: () => {}, noCatalystUsers: true }));
    return w;
  }

  private async listen(server: ReturnType<typeof createServer>) {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    this.servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  stop(): void {
    for (const s of this.servers) {
      s.closeAllConnections?.();
      s.close();
    }
    for (const d of this.dirs) fs.rmSync(d, { recursive: true, force: true });
  }

  /** The daemon's `fetch` for a Catalyst address: the https relay URL goes to the local server. */
  private toLocal = (input: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(input);
    return fetch(`${this.deviceUrl}${u.pathname}${u.search}`, init);
  };

  private async signIn(user: TestUser): Promise<string> {
    const tokenRes = await fetch(`${this.functionUrl}/account/app-token`, {
      method: "POST",
      headers: { "x-test-user": JSON.stringify(user), "content-type": "application/json" },
      body: "{}",
    });
    expect(tokenRes.status).toBe(200);
    const { token } = (await tokenRes.json()) as { token: string };
    const provisioned = await fetch(`${this.deviceUrl}/account/macs/provision`, {
      method: "POST",
      headers: { "x-squeak-account": token, "content-type": "application/json" },
      body: JSON.stringify({ macId: `mac${randomId(16)}`, name: `${user.name}'s Mac` }),
    });
    expect(provisioned.status).toBe(200);
    return ((await provisioned.json()) as { key: string }).key;
  }

  /** A signed-in person's Mac (or, with `nest` null, their browser): the same objects a daemon builds. */
  async mac(user: TestUser, nest: string | null = `${user.name}-mac`) {
    const key = await this.signIn(user);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-relay-"));
    this.dirs.push(dir);
    const doFetch = this.toLocal;
    const location = { provider: "catalyst" as const, relayUrl: BASE, relayKey: key, hosted: true as const };
    const relay = new HttpPondRelay(BASE, key, doFetch, true);
    const account = {
      name: () => user.name,
      email: () => user.email,
      names: async (ids: string[]) => relay.names(ids),
    };
    const service = new FlotillaService({
      account,
      store: createCloudStore(location, { fetch: doFetch, socket: this.streams.socket }),
      supportDir: dir,
      nest,
      location,
      relay,
      invites: new HttpPondInvites(BASE, key, doFetch, true),
      wakeDebounceMs: 0,
      wakeMinIntervalMs: 0,
      storeFor: (loc, pondToken) => {
        const at = loc as { provider: string; relayUrl: string; relayKey?: string };
        if (pondToken)
          return new CatalystStore({
            baseUrl: at.relayUrl,
            pondToken,
            fetch: doFetch,
            socket: this.streams.socket,
          });
        if (!("relayKey" in at)) throw new Error("This pond has no access on this Mac yet.");
        return createCloudStore(at as typeof location, { fetch: doFetch, socket: this.streams.socket });
      },
    });
    const host = new FakeHost();
    const bridge = new FlotillaBridge(service, host, { flushMs: 60_000 });
    bridge.start();
    return { dir, service, host, bridge, name: user.name, key, relay, userId: user.userId };
  }
}
