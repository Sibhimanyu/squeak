// A signed-in person's Mac (or, with `nest` null, their browser) built the way a daemon builds one (src/flotilla/index.ts):
// HttpPondRelay, HttpPondInvites, CatalystStore, FlotillaService, FlotillaBridge, over any relay (the in-process double or a
// real development relay). No test runner is imported, so the daily smoke (scripts/smoke-people.ts) uses it too.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CatalystStore, type StreamSocket } from "../cloud/catalyst-store.js";
import { createCloudStore } from "../cloud/config.js";
import { FlotillaBridge } from "./bridge.js";
import { HttpPondInvites } from "./invites-port.js";
import { FakeHost } from "./journey-support.js";
import { HttpPondRelay } from "./relay.js";
import { FlotillaService } from "./service.js";

export interface TestUser {
  userId: string;
  email: string;
  name: string;
}

export interface MacInput {
  user: TestUser;
  /** Null: a browser (no Nest). */
  nest: string | null;
  /** Names this device in the request log. */
  label: string;
  /** The per-Mac key the relay's provision route issued. */
  key: string;
  relayUrl: string;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Data Streams as a socket factory; absent, the store opens none (a real relay's stream needs a real socket). */
  socket?: (url: string) => StreamSocket;
  /** Who the Owner's Mac is and whether it is running. */
  owner: { id: string; away: boolean };
  /** Collects the support directory so the caller can remove it. */
  dirs: string[];
}

export type RelayMac = Awaited<ReturnType<typeof buildMac>>;

export async function buildMac(input: MacInput) {
  const { user, nest, label, key, fetch: doFetch, socket, owner } = input;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-relay-"));
  input.dirs.push(dir);
  const location = { provider: "catalyst" as const, relayUrl: input.relayUrl, relayKey: key, hosted: true as const };
  const relay = new HttpPondRelay(input.relayUrl, key, doFetch, true);
  const account = {
    name: () => user.name,
    email: () => user.email,
    names: async (ids: string[]) => relay.names(ids),
  };
  const options = socket ? { fetch: doFetch, socket } : { fetch: doFetch };
  const service = new FlotillaService({
    account,
    store: createCloudStore(location, options),
    supportDir: dir,
    nest,
    location,
    relay,
    invites: new HttpPondInvites(input.relayUrl, key, doFetch, true),
    wakeDebounceMs: 0,
    wakeMinIntervalMs: 0,
    presenceOf: async () => (owner.id ? [{ memberId: owner.id, online: !owner.away }] : []),
    storeFor: (loc, pondToken) => {
      const at = loc as { provider: string; relayUrl: string; relayKey?: string };
      if (pondToken)
        return new CatalystStore({ baseUrl: at.relayUrl, pondToken, fetch: doFetch, ...(socket ? { socket } : {}) });
      if (!("relayKey" in at)) throw new Error("This pond has no access on this Mac yet.");
      return createCloudStore(at as typeof location, options);
    },
  });
  const host = new FakeHost();
  const bridge = new FlotillaBridge(service, host, { flushMs: 60_000 });
  bridge.start();
  return { dir, service, host, bridge, name: user.name, key, relay, userId: user.userId, label };
}
