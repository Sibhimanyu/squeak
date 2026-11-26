import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { ChannelDoc, CloudStore } from "../cloud/store.js";
import { cleanStartRequested } from "./index.js";
import { FlotillaService } from "./service.js";
import { named } from "./named-account.test-fixture.js";

const LOCATION = { provider: "firebase", databaseUrl: "https://squeak-test-default-rtdb.firebaseio.com" };

function memoryStore() {
  const docs = new Map<string, ChannelDoc>();
  const store: CloudStore = {
    get: async (p) => docs.get(p) ?? null,
    set: async (p, doc) => void docs.set(p, doc),
    list: async (c) =>
      [...docs].filter(([k]) => k.startsWith(`${c}/`)).map(([k, doc]) => ({ id: k.slice(c.length + 1), doc })),
    delete: async (p) => void docs.delete(p),
    watch: () => () => undefined,
  };
  return { store, docs };
}
const open = (dir: string, cloud: boolean, store: CloudStore) =>
  new FlotillaService({
    store: cloud ? store : null,
    supportDir: dir,
    account: named("Me"),
    nest: "mac",
    ...(cloud ? { location: LOCATION } : {}),
  });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "clean-start-"));
/** The raw record, for what a test must plant or read that the service does not show. */
type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const raw = (s: FlotillaService, id: string): Raw =>
  (s as unknown as { pondsFile: { data: { ponds: Record<string, Raw> } } }).pondsFile.data.ponds[id]!;

describe("clean start on the Owner's Mac", () => {
  it("makes a shared Pond local again with its project, name and key, and writes nothing to the cloud", async () => {
    const dir = tmp();
    const { store, docs } = memoryStore();
    const service = open(dir, true, store);
    const shared = await service.createPond({ name: "Alpha", projectId: "p1" });
    await service.prepareFirstInvite(shared.id);
    expect((await service.list())[0]!.local).toBeUndefined();
    const key = raw(service, shared.id).keys["1"];
    const written = docs.size;

    const result = service.startClean();

    expect(result).toEqual({ madeLocal: 1, dropped: 0 });
    const [pond] = await service.list();
    expect(pond).toMatchObject({ id: shared.id, name: "Alpha", projectId: "p1", local: true, memberCount: 1 });
    expect(raw(service, shared.id)).toMatchObject({ local: true, location: null, issued: {} });
    expect(raw(service, shared.id).keys["1"]).toBe(key);
    expect(service.sharedPondOfProject("p1")).toBeNull();
    expect(service.hasPondForProject({ projectId: "p1" })).toBe(true);
    expect(docs.size).toBe(written);
    // A fresh Mac process reads the same: the change is saved.
    expect((await open(dir, true, store).list())[0]!.local).toBe(true);
  });

  it("keeps the Pond's Ducks (its threads) and an already local Pond exactly as they are", async () => {
    const { store } = memoryStore();
    const service = open(tmp(), true, store);
    const shared = await service.createPond({ name: "Alpha", projectId: "p1" });
    raw(service, shared.id).threads["t1"] = { id: "t1", state: "idle", private: false };
    const local = service.ensureLocalPond({ name: "Beta", projectId: "p2" });
    const before = JSON.stringify(raw(service, local.id));

    service.startClean();

    expect(raw(service, shared.id).threads["t1"]).toMatchObject({ id: "t1" });
    expect(JSON.stringify(raw(service, local.id))).toBe(before);
  });

  it("lets the same Pond be invited into the cloud again afterwards", async () => {
    const { store, docs } = memoryStore();
    const service = open(tmp(), true, store);
    const shared = await service.createPond({ name: "Alpha", projectId: "p1" });
    service.startClean();
    docs.clear(); // the cloud was wiped
    await service.prepareFirstInvite(shared.id);
    expect((await service.list())[0]!.local).toBeUndefined();
  });

  it("forgets Ponds this Mac only joined, and a Pond that cannot be local", async () => {
    const { store } = memoryStore();
    const service = open(tmp(), true, store);
    const mine = await service.createPond({ name: "Mine", projectId: "p1" });
    const theirs = await service.createPond({ name: "Theirs", projectId: "p2" });
    Object.assign(raw(service, theirs.id), { role: "member", kind: "joined", projectId: undefined });
    const projectless = await service.createPond({ name: "Orphan", projectId: "p3" });
    delete raw(service, projectless.id).projectId;

    expect(service.startClean()).toEqual({ madeLocal: 1, dropped: 2 });
    expect((await service.list()).map((p) => p.id)).toEqual([mine.id]);
  });

  it("runs once: a second call changes nothing, even after a Pond is shared again", async () => {
    const { store } = memoryStore();
    const dir = tmp();
    const service = open(dir, true, store);
    const shared = await service.createPond({ name: "Alpha", projectId: "p1" });
    expect(service.startClean()).toEqual({ madeLocal: 1, dropped: 0 });
    await service.prepareFirstInvite(shared.id);
    expect(service.startClean()).toEqual({ madeLocal: 0, dropped: 0 });
    expect(open(dir, true, store).startClean()).toEqual({ madeLocal: 0, dropped: 0 });
    expect((await service.list())[0]!.local).toBeUndefined();
  });

  it("works with no cloud set up", async () => {
    const service = open(tmp(), false, memoryStore().store);
    service.ensureLocalPond({ name: "Alpha", projectId: "p1" });
    expect(service.startClean()).toEqual({ madeLocal: 0, dropped: 0 });
  });
});

describe("cleanStartRequested", () => {
  it("is off unless SQUEAK_CLEAN_START=on", () => {
    expect(cleanStartRequested({})).toBe(false);
    expect(cleanStartRequested({ SQUEAK_CLEAN_START: "off" })).toBe(false);
    expect(cleanStartRequested({ SQUEAK_CLEAN_START: "on" })).toBe(true);
  });
});
