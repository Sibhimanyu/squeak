import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { CloudStore } from "../cloud/store.js";
import type { ChannelDoc } from "../remote/firestore-rest.js";
import { joinWords } from "./join-words.js";
import { RelayRefused, type PondRelay } from "./relay.js";
import { FlotillaService } from "./service.js";

const LOCATION = { provider: "firebase", databaseUrl: "https://squeak-test-default-rtdb.firebaseio.com" };
const docs = new Map<string, ChannelDoc>();
const shared: CloudStore = {
  get: async (p) => docs.get(p) ?? null,
  set: async (p, doc) => void docs.set(p, doc),
  list: async (c) =>
    [...docs].filter(([k]) => k.startsWith(`${c}/`)).map(([k, doc]) => ({ id: k.slice(c.length + 1), doc })),
  delete: async (p) => void docs.delete(p),
  watch: () => () => undefined,
};
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const clock = { t: Date.now() };

/** The relay's short-code table as the two Macs use it (the real one is tested in cloud/catalyst-relay). */
function relayDouble(table: Map<string, Record<string, unknown>>, calls: string[] = []): PondRelay {
  return {
    url: "https://relay.example/server/squeak_relay",
    issue: async () => ({ token: "t", expiresAt: 0 }),
    revoke: async () => undefined,
    shortCreate: async (_pondId, details) => {
      calls.push(JSON.stringify(details));
      const code = `K7P-${table.size}QD`.replace(/0/g, "2");
      table.set(code, details);
      return { code, expiresAt: clock.t + 10 * 60_000 };
    },
    shortRedeem: async (code) => {
      const details = table.get(code);
      if (!details) throw new RelayRefused(404);
      table.delete(code);
      return details;
    },
  };
}
const account = {
  name: () => "Bea Lee",
  email: () => "bea@example.com",
  attest: async () => "ja.token",
  names: async () => ({ names: {} }),
};

function mk(name: string, relay: PondRelay, owner = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "short-invite-"));
  dirs.push(dir);
  const service = new FlotillaService({
    store: shared,
    supportDir: dir,
    displayName: name,
    nest: `${name}-mac`,
    ...(owner ? { location: LOCATION } : {}),
    storeFor: () => shared,
    relay,
    account,
    now: () => clock.t,
  });
  return { dir, service };
}
const pondsJson = (m: { dir: string }) =>
  JSON.parse(fs.readFileSync(path.join(m.dir, "flotilla", "ponds.json"), "utf8")) as {
    ponds: Record<string, { keys: Record<string, string>; current: number; status: string }>;
  };

async function setup() {
  docs.clear();
  const table = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  const A = mk("Owner", relayDouble(table, calls), true);
  const pond = await A.service.createPond({ name: "Site", projectId: "proj-Site" });
  return { A, table, calls, pondId: pond.id };
}

describe("short invite codes", () => {
  it("an owner makes one: a code, ten minutes, and the relay is given no pond key", async () => {
    const { A, pondId, calls } = await setup();
    const key = pondsJson(A).ponds[pondId]!.keys["1"]!;
    const made = await A.service.invite(pondId, "member", undefined, { short: true });
    expect(made.short).toMatch(/^[2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3}$/);
    expect(made.expiresAt).toBe(clock.t + 10 * 60_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain(key);
    const sent = JSON.parse(calls[0]!) as Record<string, unknown>;
    expect(Object.keys(sent)).not.toContain("k");
    expect(Object.keys(sent)).not.toContain("kv");
    expect(sent).toMatchObject({ v: 1, p: pondId, r: "member" });
    const [inv] = (await A.service.view(pondId)).invites!;
    expect(inv).toMatchObject({ id: made.id, state: "pending", short: made.short, shortExpiresAt: made.expiresAt });
    expect(inv!.code).toBeUndefined();
    // the code lapses from the owner's list when its ten minutes do
    clock.t += 10 * 60_000 + 1;
    expect(((await A.service.view(pondId)).invites ?? [])[0]!.short).toBeUndefined();
    clock.t -= 10 * 60_000 + 1;
  });

  it("is refused where there is no relay, and a bad body never makes one", async () => {
    docs.clear();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "short-invite-"));
    dirs.push(dir);
    const bare = new FlotillaService({
      store: shared,
      supportDir: dir,
      displayName: "O",
      nest: "o",
      location: LOCATION,
      storeFor: () => shared,
      now: () => clock.t,
    });
    const pond = await bare.createPond({ name: "S", projectId: "p" });
    await expect(bare.invite(pond.id, "member", undefined, { short: true })).rejects.toThrow(
      /Short codes need Squeak's cloud/,
    );
  });

  it("a joiner by short code holds no pond key until the owner approves, then gets it sealed to their key", async () => {
    const { A, table, pondId } = await setup();
    const made = await A.service.invite(pondId, "member", undefined, { short: true });
    const B = mk("Bea", relayDouble(table));
    // lower case and no dash: how a person types it
    await B.service.join(made.short.toLowerCase().replace("-", ""));
    expect(table.size).toBe(0); // spent
    expect(pondsJson(B).ponds[pondId]).toMatchObject({ status: "pending", keys: {}, current: 0 });

    const [req] = (await A.service.view(pondId)).joins;
    expect(req).toBeDefined();
    await B.service.refresh(pondId);
    expect(pondsJson(B).ponds[pondId]!.keys).toEqual({});
    expect(docs.has(`channels/${pondId}/keys/${B.service.identity.id}`)).toBe(false);

    await A.service.decideJoin(pondId, req!.requestId, { approve: true });
    expect(docs.has(`channels/${pondId}/keys/${B.service.identity.id}`)).toBe(true);
    await B.service.refresh(pondId);
    const mine = pondsJson(B).ponds[pondId]!;
    expect(mine.status).toBe("active");
    expect(mine.keys["1"]).toBe(pondsJson(A).ponds[pondId]!.keys["1"]);
    expect(mine.current).toBe(1);
    const view = await B.service.view(pondId);
    expect(view.pond.status).toBe("active");
    expect(view.members.map((m) => m.name).sort()).toContain("Bea Lee");
  });

  it("the owner's approval screen and the joiner's waiting screen show the same three words", async () => {
    const { A, table, pondId } = await setup();
    const made = await A.service.invite(pondId, "member", undefined, { short: true });
    const B = mk("Bea", relayDouble(table));
    await B.service.join(made.short);
    const [req] = (await A.service.view(pondId)).joins;
    const [mine] = await B.service.list();
    expect(req!.words).toHaveLength(3);
    expect(mine!.words).toEqual(req!.words);
    const ownerKey = pondsJson(A) && A.service.identity.publicKey;
    expect(req!.words).toEqual(joinWords(ownerKey, B.service.identity.publicKey, pondId));
    // a relay that swapped the owner's key in the details: the request is sealed to the wrong key, so no approval is offered
    const C = mk("Cy", relayDouble(table));
    const again = await A.service.invite(pondId, "member", undefined, { short: true });
    const forged = table.get(again.short)!;
    table.set(again.short, { ...forged, o: C.service.identity.publicKey });
    await C.service.join(again.short);
    expect((await C.service.list())[0]!.words).not.toEqual(joinWords(ownerKey, C.service.identity.publicKey, pondId));
    expect((await A.service.view(pondId)).joins.map((j) => j.name)).not.toContain("Cy");
  });

  it("a code the relay does not know, or a locked-out account, says so in plain sentences", async () => {
    const { table } = await setup();
    const B = mk("Bea", relayDouble(table));
    await expect(B.service.join("K7P-4QD")).rejects.toMatchObject({
      status: 404,
      message: /isn't valid, or it has expired/,
    });
    const limited = relayDouble(table);
    limited.shortRedeem = async () => {
      throw new RelayRefused(429);
    };
    await expect(mk("Cy", limited).service.join("K7P-4QD")).rejects.toMatchObject({ status: 429 });
    const signedOut = relayDouble(table);
    signedOut.shortRedeem = async () => {
      throw new RelayRefused(401);
    };
    await expect(mk("Di", signedOut).service.join("K7P-4QD")).rejects.toMatchObject({ status: 401 });
    expect(await B.service.list()).toEqual([]);
  });

  it("the long invite still works, keeps its key in the code, and its join carries words too", async () => {
    const { A, table, pondId } = await setup();
    const inv = await A.service.invite(pondId, "member");
    expect(inv.code.startsWith("squeak-pond:")).toBe(true);
    const B = mk("Bea", relayDouble(table));
    await B.service.join(inv.code);
    expect(Object.keys(pondsJson(B).ponds[pondId]!.keys)).toEqual(["1"]);
    const [req] = (await A.service.view(pondId)).joins;
    expect(req!.words).toEqual((await B.service.list())[0]!.words);
  });
});
