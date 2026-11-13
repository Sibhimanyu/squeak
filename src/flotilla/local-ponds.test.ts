import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { CloudStore } from "../cloud/store.js";
import type { ChannelDoc } from "../remote/firestore-rest.js";
import { flotillaEnabled } from "./index.js";
import { FlotillaService } from "./service.js";

const LOCATION = { provider: "firebase", databaseUrl: "https://squeak-test-default-rtdb.firebaseio.com" };

/** An in-memory store that counts every call and can be told to fail writes. */
function countingStore() {
  const docs = new Map<string, ChannelDoc>();
  const state = { calls: 0, failWrites: false };
  const store: CloudStore = {
    get: async (p) => (state.calls++, docs.get(p) ?? null),
    set: async (p, doc) => {
      state.calls++;
      if (state.failWrites) throw new Error("offline");
      docs.set(p, doc);
    },
    list: async (c) => (
      state.calls++,
      [...docs].filter(([k]) => k.startsWith(`${c}/`)).map(([k, doc]) => ({ id: k.slice(c.length + 1), doc }))
    ),
    delete: async (p) => void (state.calls++, docs.delete(p)),
    watch: () => () => undefined,
  };
  return { store, state, docs };
}

function make(cloud: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ponds-"));
  const counting = countingStore();
  const service = new FlotillaService({
    store: cloud ? counting.store : null,
    supportDir: dir,
    displayName: "Me",
    nest: "mac",
    ...(cloud ? { location: LOCATION } : {}),
  });
  return { service, ...counting, dir };
}

describe("ponds are on for everyone", () => {
  it("is on unless SQUEAK_FLOTILLA=off", () => {
    expect(flotillaEnabled({})).toBe(true);
    expect(flotillaEnabled({ SQUEAK_FLOTILLA: "on" })).toBe(true);
    expect(flotillaEnabled({ SQUEAK_FLOTILLA: "off" })).toBe(false);
  });
});

describe("local ponds", () => {
  it("work with no cloud and make no network call", async () => {
    const { service, state } = make(false);
    const made = service.ensureLocalPond({ name: "Alpha", projectId: "p1" });
    expect(made.local).toBe(true);
    const list = await service.list();
    expect(list.map((p) => [p.name, p.local, p.memberCount])).toEqual([["Alpha", true, 1]]);
    const view = await service.view(made.id);
    expect(view.members).toHaveLength(1);
    expect(view.cloud).toBe(false);
    service.start();
    service.watch(made.id);
    service.stop();
    expect(state.calls).toBe(0);
    expect(service.ownThreads()).toEqual([]);
    expect(service.pondIds()).toEqual([]);
  });

  it("publish nothing until the first invite", async () => {
    const { service, state, docs } = make(true);
    service.ensureLocalPond({ name: "Alpha", projectId: "p1" });
    await service.list();
    expect(state.calls).toBe(0);
    expect(docs.size).toBe(0);
  });

  it("list a project once: no duplicate for a local, a published or a name-matched pond", async () => {
    const { service } = make(true);
    const a = service.ensureLocalPond({ name: "Alpha", projectId: "p1" });
    expect(service.ensureLocalPond({ name: "Alpha", projectId: "p1" }).id).toBe(a.id);
    const published = await service.createPond({ name: "Beta", projectId: "p2" });
    expect(service.ensureLocalPond({ name: "Beta", projectId: "p2" }).id).toBe(published.id);
    expect(service.hasPondForProject({ projectId: "p2" })).toBe(true);
    // A name alone never finds or makes a pond.
    expect(() => service.ensureLocalPond({ name: "Conductor thing" })).toThrow(/project/);
    expect(service.hasPondForProject({})).toBe(false);
    expect(() => service.ensureLocalPond({ name: "Alpha", projectId: "p1" })).not.toThrow();
    await expect(service.createPond({ name: "Beta again", projectId: "p2" })).rejects.toThrow(/already has a pond/);
    expect((await service.list()).map((p) => p.name).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("leave ponds that are already published exactly as they are", async () => {
    const { service } = make(true);
    const published = await service.createPond({ name: "Beta", projectId: "p2" });
    const list = await service.list();
    expect(list[0]!.id).toBe(published.id);
    expect(list[0]!.local).toBeUndefined();
  });
});

describe("the first invite publishes", () => {
  it("publishes once, then invites; a second invite does not publish again", async () => {
    const { service, docs, state } = make(true);
    const made = service.ensureLocalPond({ name: "Alpha", projectId: "p1", gitRemote: "https://x/y" });
    const first = await service.invite(made.id, "member");
    expect(first.code).toContain("squeak-pond:");
    const paths = [...docs.keys()];
    expect(paths.some((p) => p.endsWith("/pond/meta"))).toBe(true);
    expect(paths.some((p) => p.includes("/members/"))).toBe(true);
    const writes = docs.size;
    await service.invite(made.id, "viewer");
    expect(docs.size).toBe(writes);
    expect((await service.list())[0]!.local).toBeUndefined();
    expect((await service.list()).length).toBe(1);
    expect(state.calls).toBeGreaterThan(0);
  });

  it("a double click makes one pond and one publish", async () => {
    const { service, docs } = make(true);
    const made = service.ensureLocalPond({ name: "Alpha", projectId: "p1" });
    const [a, b] = await Promise.all([service.invite(made.id), service.invite(made.id)]);
    expect(a.code).toBeTruthy();
    expect(b.code).toBeTruthy();
    expect([...docs.keys()].filter((p) => p.endsWith("/pond/meta"))).toHaveLength(1);
    expect(await service.list()).toHaveLength(1);
  });

  it("a failure halfway leaves it local; the retry reuses the same pond", async () => {
    const { service, state, docs } = make(true);
    const made = service.ensureLocalPond({ name: "Alpha", projectId: "p1" });
    state.failWrites = true;
    await expect(service.invite(made.id)).rejects.toThrow(/try again/);
    expect((await service.list())[0]!.local).toBe(true);
    state.failWrites = false;
    const code = await service.invite(made.id);
    expect(code.code).toBeTruthy();
    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(made.id);
    expect([...docs.keys()].filter((p) => p.endsWith("/pond/meta"))).toHaveLength(1);
  });

  it("needs a cloud: a plain sentence and nothing changes", async () => {
    const { service } = make(false);
    const made = service.ensureLocalPond({ name: "Alpha", projectId: "p1" });
    await expect(service.invite(made.id)).rejects.toThrow(/Set up a cloud store/);
    expect((await service.list())[0]!.local).toBe(true);
  });

  it("sharing into a local pond is refused with a plain sentence", async () => {
    const { service } = make(true);
    const made = service.ensureLocalPond({ name: "Alpha", projectId: "p1" });
    await expect(service.setPresence(made.id, {})).rejects.toThrow(/only on this Mac/);
  });
});
