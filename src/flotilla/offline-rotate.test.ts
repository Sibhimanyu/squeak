import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CloudStore } from "../cloud/store.js";
import { FakeRtdb } from "../remote/fake-rtdb.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { FlotillaService, OFFLINE_WRITE } from "./service.js";
import { FlotillaError } from "./types.js";

let rtdb: FakeRtdb;
let url: string;
const dirs: string[] = [];
beforeAll(async () => {
  rtdb = new FakeRtdb();
  url = await rtdb.start();
});
afterAll(async () => {
  await rtdb.stop();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** A store that can be cut off, as a dead network, a 429 or a 5xx would. */
function flaky(inner: CloudStore): CloudStore & { down: boolean } {
  const down = (): never => {
    throw new Error("relay unreachable (429)");
  };
  const store = {
    down: false,
    get: async (p: string) => (store.down ? down() : inner.get(p)),
    set: async (p: string, d: never) => (store.down ? down() : inner.set(p, d)),
    list: async (c: string) => (store.down ? down() : inner.list(c)),
    delete: async (p: string) => (store.down ? down() : inner.delete(p)),
    watch: (p: string, f: () => void) => inner.watch(p, f),
  };
  return store;
}

function mac(name: string, nest: string | null = name + "-mac") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-off-"));
  dirs.push(dir);
  const store = flaky(new RtdbRest(url));
  const service = new FlotillaService({
    store,
    supportDir: dir,
    displayName: name,
    nest,
    inviteLinkBase: "https://x.test/join",
  });
  return { dir, store, service };
}

async function join(owner: ReturnType<typeof mac>, guest: ReturnType<typeof mac>, pondId: string, name: string) {
  const { link } = await owner.service.invite(pondId, "member");
  await guest.service.join(link!, name);
  const requestId = (await owner.service.view(pondId)).joins.find((j) => j.name === name)!.requestId;
  await owner.service.decideJoin(pondId, requestId, { approve: true });
  await guest.service.refresh(pondId);
}

describe("offline pond details", () => {
  it("serves the last known pond, flagged offline with asOf, and refuses writes", async () => {
    const A = mac("Sibhi");
    const pond = await A.service.createPond({ name: "Website", gitRemote: "git@github.com:acme/site.git" });
    await A.service.ripple(pond.id, "Hello pond");
    const live = await A.service.view(pond.id);
    expect(live.offline).toBeUndefined();
    expect((await A.service.list())[0]!.offline).toBeUndefined();

    A.store.down = true;
    const view = await A.service.view(pond.id);
    expect(view.offline).toBe(true);
    expect(typeof view.asOf).toBe("number");
    expect(view.pond).toMatchObject({ offline: true, name: "Website" });
    expect(view.members.map((m) => m.name)).toEqual(["Sibhi"]);
    expect(view.ripples.map((r) => r.text)).toContain("Hello pond");
    const listed = await A.service.list();
    expect(listed[0]).toMatchObject({ id: pond.id, offline: true, memberCount: 1 });
    await expect(A.service.ripple(pond.id, "nope")).rejects.toThrow(OFFLINE_WRITE);
    await expect(A.service.rotateKey(pond.id)).rejects.toThrow(OFFLINE_WRITE);

    A.store.down = false;
    const back = await A.service.view(pond.id);
    expect(back.offline).toBeUndefined();
    await A.service.ripple(pond.id, "back online");
  });

  it("with no snapshot the outage is still an error", async () => {
    const A = mac("Sibhi");
    const pond = await A.service.createPond({ name: "Fresh" });
    // A new service on the same files but a fresh snapshot: delete it.
    fs.rmSync(path.join(A.dir, "flotilla", "snapshot.json"), { force: true });
    const B = new FlotillaService({
      store: ((A.store.down = true), A.store),
      supportDir: A.dir,
      displayName: "Sibhi",
      nest: "x",
    });
    await expect(B.view(pond.id)).rejects.toThrow();
  });

  it("is metadata only, 0600, and survives a restart; no message bodies", async () => {
    const A = mac("Sibhi");
    const pond = await A.service.createPond({ name: "Docs" });
    await A.service.view(pond.id);
    const file = path.join(A.dir, "flotilla", "snapshot.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toContain("sessionId");
    expect(text).not.toContain("privateKey");
    // The pond key never goes in it.
    const key = JSON.parse(fs.readFileSync(path.join(A.dir, "flotilla", "ponds.json"), "utf8")).ponds[pond.id].keys[
      "1"
    ];
    expect(text).not.toContain(key);

    A.store.down = true;
    const restarted = new FlotillaService({ store: A.store, supportDir: A.dir, displayName: "Sibhi", nest: "x" });
    expect((await restarted.view(pond.id)).offline).toBe(true);
  });

  it("drops a removed pond from the cache", async () => {
    const A = mac("Sibhi");
    const pond = await A.service.createPond({ name: "Gone" });
    await A.service.view(pond.id);
    const file = path.join(A.dir, "flotilla", "snapshot.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).ponds[pond.id]).toBeTruthy();
    A.service.forgetPond(pond.id);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).ponds[pond.id]).toBeUndefined();

    const B = mac("Aarav");
    const p2 = await A.service.createPond({ name: "Shared" });
    await join(A, B, p2.id, "Aarav");
    await B.service.view(p2.id);
    expect(
      JSON.parse(fs.readFileSync(path.join(B.dir, "flotilla", "snapshot.json"), "utf8")).ponds[p2.id],
    ).toBeTruthy();
    await A.service.removeMember(p2.id, B.service.me.id);
    await B.service.refresh(p2.id);
    expect((await B.service.view(p2.id)).pond.status).toBe("removed");
    expect(
      JSON.parse(fs.readFileSync(path.join(B.dir, "flotilla", "snapshot.json"), "utf8")).ponds[p2.id],
    ).toBeUndefined();
  });
});

describe("rotating the pond key", () => {
  it("members still read after; the Ripples line is posted; non-owners are refused", async () => {
    const A = mac("Sibhi");
    const B = mac("Aarav");
    const pond = await A.service.createPond({ name: "Rot" });
    await join(A, B, pond.id, "Aarav");
    const keysOf = (m: ReturnType<typeof mac>) =>
      JSON.parse(fs.readFileSync(path.join(m.dir, "flotilla", "ponds.json"), "utf8")).ponds[pond.id];
    expect(keysOf(A).current).toBe(1);

    await expect(B.service.rotateKey(pond.id)).rejects.toMatchObject({ status: 403 });
    await A.service.rotateKey(pond.id);
    expect(keysOf(A).current).toBe(2);
    await B.service.refresh(pond.id);
    expect(keysOf(B).current).toBe(2);
    const view = await B.service.view(pond.id);
    expect(view.members.map((m) => m.name).sort()).toEqual(["Aarav", "Sibhi"]);
    expect(view.ripples.map((r) => r.text)).toContain("changed the pond key");
    expect(rtdb.tree.get(`channels/${pond.id}/pond/meta`)!.box.startsWith("2.")).toBe(true);
  });

  it("removeDevice removes that Mac's key and rotates; a lost device cannot read after", async () => {
    const A = mac("Sibhi");
    const B = mac("Aarav");
    const C = mac("Vera");
    const pond = await A.service.createPond({ name: "Lost" });
    await join(A, B, pond.id, "Aarav");
    await join(A, C, pond.id, "Vera");
    const oldKey = JSON.parse(fs.readFileSync(path.join(B.dir, "flotilla", "ponds.json"), "utf8")).ponds[pond.id].keys[
      "1"
    ];

    await expect(A.service.removeDevice(pond.id, B.service.me.id, "not-the-key")).rejects.toMatchObject({
      status: 404,
    });
    await expect(C.service.removeDevice(pond.id, B.service.me.id, B.service.me.id)).rejects.toBeInstanceOf(
      FlotillaError,
    );
    await A.service.removeDevice(pond.id, B.service.me.id, B.service.me.id);

    await B.service.refresh(pond.id);
    expect((await B.service.view(pond.id)).pond.status).toBe("removed");
    const keys = JSON.parse(fs.readFileSync(path.join(B.dir, "flotilla", "ponds.json"), "utf8")).ponds[pond.id].keys;
    expect(Object.keys(keys)).toEqual(["1"]);
    expect(oldKey).toBe(keys["1"]);
    await C.service.refresh(pond.id);
    const view = await C.service.view(pond.id);
    expect(view.members.map((m) => m.name).sort()).toEqual(["Sibhi", "Vera"]);
    expect(view.ripples.map((r) => r.text)).toContain("removed Aarav's Mac");
  });
});
