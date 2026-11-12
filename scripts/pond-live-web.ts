// A WEB guest (the real web/js GuestPond, in Node) joining a pond over the real Catalyst relay (cloud.json), then every
// document of the test pond deleted. Owner = a FlotillaService identity. Run: npx tsx scripts/pond-live-web.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CatalystStore } from "../src/cloud/catalyst-store.js";
import { activeLocation, createCloudStore, readCloudConfig } from "../src/cloud/config.js";
import type { CloudLocation } from "../src/cloud/location.js";
import { HttpPondRelay } from "../src/flotilla/relay.js";
import { FlotillaService } from "../src/flotilla/service.js";
// @ts-expect-error plain JS modules of the web app
import { GuestPond } from "../web/js/guest-pond.js";
// @ts-expect-error plain JS
import { readInvite } from "../web/js/guest-invite.js";
// @ts-expect-error plain JS
import { KeyStore } from "../web/js/key-store.js";
// @ts-expect-error plain JS
import { fakeIndexedDB } from "../web/test/helpers.js";

// The owner is what the daemon is: the config's ACTIVE location (a signed-in Mac is "hosted": its own x-squeak-mac-key
// and a tenant-checked channel claim, not the operator's relay key). SQUEAK_LIVE_LEGACY=1 uses the operator's key instead.
const config = readCloudConfig(path.join(os.homedir(), "Library/Application Support/squeak"))!;
const legacy = process.env.SQUEAK_LIVE_LEGACY === "1";
const ownerLoc = (
  legacy
    ? {
        provider: "catalyst",
        relayUrl: `${config.catalyst!.appUrl}/server/squeak_relay`,
        relayKey: config.catalyst!.relayKey!,
      }
    : activeLocation(config, null)
) as CloudLocation;
if (ownerLoc.provider !== "catalyst") throw new Error("the active location is not Catalyst");
const RELAY = ownerLoc.relayUrl;
console.log(`owner location: ${legacy ? "legacy relay key" : ownerLoc.hosted ? "hosted (mac key)" : "relay key"}`);
const storeFor = (loc: unknown, token?: string | null) => {
  if (token) return new CatalystStore({ baseUrl: (loc as { relayUrl: string }).relayUrl, pondToken: token });
  return createCloudStore(loc as CloudLocation);
};
const ms = async <T>(label: string, f: () => Promise<T>): Promise<T> => {
  const t = Date.now();
  try {
    const r = await f();
    console.log(`ok  ${label} (${Date.now() - t} ms)`);
    return r;
  } catch (e) {
    console.log(`ERR ${label} (${Date.now() - t} ms): ${(e as Error).message}`);
    throw e;
  }
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pond-live-web-"));
const owner = new FlotillaService({
  store: storeFor(ownerLoc),
  supportDir: dir,
  displayName: "Owner",
  nest: "owner-mac",
  storeFor,
  location: ownerLoc,
  relay: new HttpPondRelay(RELAY, ownerLoc.relayKey, undefined, ownerLoc.hosted === true),
});
// The browser's fetch: logs every relay call the guest makes.
const guestFetch = async (raw: string, init: RequestInit = {}) => {
  const url = new URL(raw, new URL(RELAY).origin).href; // a same-origin relative URL, as a browser resolves it
  const res = await fetch(url, init);
  const p = new URL(url).searchParams.get("path") ?? new URL(url).searchParams.get("prefix") ?? new URL(url).pathname;
  console.log(`    guest ${init.method ?? "GET"} ${p.replace(/channels\/[^/]+\//, "")} -> ${res.status}`);
  return res;
};
let pondId = "";
let code = 1;
try {
  pondId = (await ms("create pond", () => owner.createPond({ name: "Live web test" }))).id;
  const inv = await ms("invite viewer", () => owner.invite(pondId, "viewer"));
  const parsed = readInvite(inv.link ?? inv.code, Date.now(), new URL(RELAY).origin);
  if (!parsed.ok) throw new Error(`guest cannot read invite: ${parsed.reason}`);
  const vault = new KeyStore(fakeIndexedDB());
  const guest = await ms("guest join", () => GuestPond.join(parsed.invite, "Webby", { vault, fetch: guestFetch }));
  const joins = await ms("owner view joins", async () => (await owner.view(pondId)).joins);
  console.log("    joins:", JSON.stringify(joins.map((j) => ({ id: j.requestId, name: j.name, client: j.client }))));
  if (joins.length !== 1) throw new Error(`expected 1 join, got ${joins.length}`);
  await ms("owner approve", () => owner.decideJoin(pondId, joins[0]!.requestId, { approve: true }));
  const status = await ms("guest refresh", () => guest.refresh());
  console.log("    guest status:", status);
  if (status !== "active") throw new Error(`guest status ${status}, wanted active`);
  const v = await ms("guest reads pond", () => guest.view());
  console.log("    pond:", v.pond.name, "members:", v.members.map((m: { name: string }) => m.name).join(", "));
  code = 0;
} catch (e) {
  console.log("FAIL", (e as Error).stack ?? e);
} finally {
  if (pondId) {
    const s = storeFor(ownerLoc);
    let n = 0;
    for (const kind of [
      "pond",
      "members",
      "joins",
      "joinids",
      "threads",
      "tevents",
      "presence",
      "holds",
      "tcmds",
      "ripples",
      "keys",
    ]) {
      for (const { id } of await s.list(`channels/${pondId}/${kind}`).catch(() => [])) {
        await s.delete(`channels/${pondId}/${kind}/${id}`).catch(() => undefined);
        n++;
      }
    }
    console.log(`cleanup: deleted ${n} documents of the test pond`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}
