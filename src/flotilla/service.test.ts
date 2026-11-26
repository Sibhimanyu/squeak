import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { CloudStore } from "../cloud/store.js";
import type { ChannelDoc } from "../cloud/store.js";
import { RelayRefused } from "./relay.js";
import { FlotillaService } from "./service.js";
import { admitMember } from "./admit-member.test-fixture.js";
import { named } from "./named-account.test-fixture.js";

/**
 * The riskiest FlotillaService flows, on one shared in-memory cloud. (More lives beside it: local-ponds, states
 * and the two-Mac e2e; this file adds the restart, retry and failure edges.)
 */
const LOCATION = { provider: "firebase", databaseUrl: "https://squeak-test-default-rtdb.firebaseio.com" };

class Cloud {
  docs = new Map<string, ChannelDoc>();
  failWrites = false;
  failDeletes = false;
  dirs: string[] = [];
  store(): CloudStore {
    return {
      get: async (p) => this.docs.get(p) ?? null,
      set: async (p, doc) => {
        if (this.failWrites) throw new Error("offline");
        this.docs.set(p, doc);
      },
      list: async (c) =>
        [...this.docs].filter(([k]) => k.startsWith(`${c}/`)).map(([k, doc]) => ({ id: k.slice(c.length + 1), doc })),
      delete: async (p) => {
        if (this.failDeletes) throw new Error("offline");
        this.docs.delete(p);
      },
      watch: () => () => undefined,
    };
  }
  /** A Mac; pass the same `dir` to restart it (a new service over the same files). */
  mac(name: string, options: { owner?: boolean; dir?: string; relay?: unknown } = {}) {
    const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-service-"));
    if (!options.dir) this.dirs.push(dir);
    const store = this.store();
    const service = new FlotillaService({
      store: store,
      supportDir: dir,
      account: named(name),
      nest: `${name}'s Mac`,
      ...(options.owner ? { location: LOCATION } : {}),
      storeFor: () => store,
      ...(options.relay ? { relay: options.relay as never } : {}),
    });
    return { dir, service };
  }
  metaDocs(): string[] {
    return [...this.docs.keys()].filter((p) => p.endsWith("/pond/meta"));
  }
}

const clouds: Cloud[] = [];
const cloud = (): Cloud => {
  const c = new Cloud();
  clouds.push(c);
  return c;
};
afterAll(() => {
  for (const c of clouds) for (const d of c.dirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("a local pond publishes once and survives a restart", () => {
  it("a Mac restarted between a failed publish and the retry still has one pond, then one meta document", async () => {
    const c = cloud();
    const first = c.mac("Sibhi", { owner: true });
    const made = first.service.ensureLocalPond({ name: "Alpha", projectId: "p1" });
    c.failWrites = true;
    await expect(first.service.prepareFirstInvite(made.id)).rejects.toThrow(/try again/);
    expect(c.metaDocs()).toEqual([]);

    // Restart: same files, new service. The pond is still local and ensureLocalPond finds it, not a second.
    c.failWrites = false;
    const again = c.mac("Sibhi", { owner: true, dir: first.dir });
    expect(again.service.ensureLocalPond({ name: "Alpha", projectId: "p1" }).id).toBe(made.id);
    expect((await again.service.list()).map((p) => [p.id, p.local])).toEqual([[made.id, true]]);

    await again.service.prepareFirstInvite(made.id);
    await again.service.prepareFirstInvite(made.id);
    expect(c.metaDocs()).toHaveLength(1);
    expect((await again.service.list()).map((p) => [p.id, p.local])).toEqual([[made.id, undefined]]);
    // Once published, ensureLocalPond still returns that same pond.
    expect(again.service.ensureLocalPond({ name: "Alpha", projectId: "p1" }).id).toBe(made.id);
  });
});

describe("a member leaves", () => {
  it("is forgotten here and removed on the owner's Mac; their own cloud failure leaves them in, not half out", async () => {
    const c = cloud();
    const A = c.mac("Sibhi", { owner: true });
    const pond = await A.service.createPond({ name: "Greenroom", projectId: "proj-G" });
    const B = c.mac("Aarav");
    await admitMember(A.service, B.service, pond.id, "member");
    await B.service.refresh(pond.id);

    // The cloud refuses the leave note: the pond is not forgotten, so the person can try again.
    c.failWrites = true;
    await expect(B.service.leave(pond.id)).rejects.toThrow();
    c.failWrites = false;
    expect((await B.service.list()).map((p) => p.id)).toEqual([pond.id]);

    await B.service.leave(pond.id);
    expect(await B.service.list()).toEqual([]);
    await A.service.refresh(pond.id);
    expect((await A.service.view(pond.id)).members.map((m) => m.name)).toEqual(["Sibhi"]);
    // An owner cannot leave, and a pond already forgotten is refused plainly.
    await expect(A.service.leave(pond.id)).rejects.toThrow(/delete it instead/);
    await expect(B.service.leave(pond.id)).rejects.toThrow();
  });
});

describe("a left pond is not asked for again, across a restart", () => {
  it("holds for 24 hours on disk, and ends early when the account stops listing the pond", async () => {
    const c = cloud();
    const A = c.mac("Sibhi", { owner: true });
    const pond = await A.service.createPond({ name: "Greenroom", projectId: "proj-G" });
    const B = c.mac("Aarav");
    await admitMember(A.service, B.service, pond.id, "member");
    await B.service.refresh(pond.id);
    await B.service.leave(pond.id);

    let clock = 1_000_000;
    const asked: string[] = [];
    const relayFor = () =>
      ({
        accountPonds: async () => [{ pondId: pond.id, name: "Greenroom", ownerKey: "k" }],
        requestDevice: async (r: { pondId: string }) => {
          asked.push(r.pondId);
          throw new Error("refused");
        },
      }) as never;
    const restart = () => {
      const store = c.store();
      return new FlotillaService({
        store,
        supportDir: B.dir,
        nest: "Aarav's Mac",
        storeFor: () => store,
        relay: relayFor(),
        now: () => clock,
      });
    };
    // The leave was made with the real clock; a restarted service reads the stored time.
    const stored = JSON.parse(fs.readFileSync(path.join(B.dir, "flotilla", "ponds.json"), "utf8")) as {
      leftUntil: Record<string, number>;
    };
    expect(stored.leftUntil[pond.id]).toBeGreaterThan(Date.now());
    clock = Date.now();

    await restart().syncAccountPonds();
    expect(asked).toEqual([]);
    clock += 25 * 60 * 60_000;
    await restart().syncAccountPonds();
    expect(asked).toEqual([pond.id]);
    expect(JSON.parse(fs.readFileSync(path.join(B.dir, "flotilla", "ponds.json"), "utf8")).leftUntil).toBeUndefined();
  });

  it("tells the account's relay, and another device of the account drops the pond on its next sync", async () => {
    const c = cloud();
    const A = c.mac("Sibhi", { owner: true });
    const pond = await A.service.createPond({ name: "Greenroom", projectId: "proj-G" });
    const left: string[] = [];
    const B = c.mac("Aarav", { relay: { leaveAccountPond: async (id: string) => void left.push(id) } });
    await admitMember(A.service, B.service, pond.id, "member");
    await B.service.refresh(pond.id);
    // Another device of the account: the relay lists the pond as left; it is dropped and never asked for.
    const asked: string[] = [];
    const other = c.mac("Aarav", {
      dir: B.dir,
      relay: {
        accountPonds: async () => [{ pondId: pond.id, name: "Greenroom", ownerKey: "k", left: true }],
        requestDevice: async (r: { pondId: string }) => {
          asked.push(r.pondId);
          throw new Error("refused");
        },
      },
    });
    expect((await other.service.directoryRecords()).map((r) => r.id)).toContain(pond.id);
    await other.service.syncAccountPonds();
    expect((await other.service.directoryRecords()).map((r) => r.id)).not.toContain(pond.id);
    expect(asked).toEqual([]);
    // The leaving device writes the leave at account level; an older relay refusing it changes nothing.
    await B.service.leave(pond.id);
    expect(left).toEqual([pond.id]);
  });

  it("a relay without the leave route leaves the leave to the owner's Mac", async () => {
    const c = cloud();
    const A = c.mac("Sibhi", { owner: true });
    const pond = await A.service.createPond({ name: "Greenroom", projectId: "proj-G" });
    const B = c.mac("Aarav", {
      relay: {
        leaveAccountPond: async () => {
          throw new Error("404");
        },
      },
    });
    await admitMember(A.service, B.service, pond.id, "member");
    await B.service.refresh(pond.id);
    await expect(B.service.leave(pond.id)).resolves.toBeUndefined();
  });

  it("a leave the cloud did not confirm leaves the Member in the Pond with one sentence, and works on the next try (#130)", async () => {
    const c = cloud();
    const A = c.mac("Sibhi", { owner: true });
    const pond = await A.service.createPond({ name: "Greenroom", projectId: "proj-G" });
    let down = true;
    const B = c.mac("Aarav", {
      relay: {
        leaveAccountPond: async () => {
          if (down) throw new RelayRefused(503);
        },
      },
    });
    await admitMember(A.service, B.service, pond.id, "member");
    await B.service.refresh(pond.id);
    await expect(B.service.leave(pond.id)).rejects.toThrow(/couldn't confirm leaving/);
    expect((await B.service.list()).map((p) => p.id)).toContain(pond.id);
    down = false;
    await B.service.leave(pond.id);
    expect((await B.service.list()).map((p) => p.id)).not.toContain(pond.id);
  });

  it("is dropped once the owner's removal is seen (the pond is no longer listed)", async () => {
    const c = cloud();
    const A = c.mac("Sibhi", { owner: true });
    const pond = await A.service.createPond({ name: "Greenroom", projectId: "proj-G" });
    const B = c.mac("Aarav");
    await admitMember(A.service, B.service, pond.id, "member");
    await B.service.refresh(pond.id);
    await B.service.leave(pond.id);
    const store = c.store();
    const service = new FlotillaService({
      store,
      supportDir: B.dir,
      nest: "Aarav's Mac",
      storeFor: () => store,
      relay: {
        accountPonds: async () => [],
        requestDevice: async () => {
          throw new Error("refused");
        },
      } as never,
    });
    await service.syncAccountPonds();
    expect(JSON.parse(fs.readFileSync(path.join(B.dir, "flotilla", "ponds.json"), "utf8")).leftUntil).toBeUndefined();
  });
});

describe("ensureLocalPond never makes a second pond for a project", () => {
  it("is idempotent across calls, a rename and a restart, and a different project gets its own", async () => {
    const c = cloud();
    const m = c.mac("Sibhi", { owner: true });
    const a = m.service.ensureLocalPond({ name: "Alpha", projectId: "p1" });
    expect(m.service.ensureLocalPond({ name: "Alpha renamed", projectId: "p1" }).id).toBe(a.id);
    const restarted = c.mac("Sibhi", { owner: true, dir: m.dir });
    expect(restarted.service.ensureLocalPond({ name: "Alpha", projectId: "p1" }).id).toBe(a.id);
    const other = restarted.service.ensureLocalPond({ name: "Beta", projectId: "p2" });
    expect(other.id).not.toBe(a.id);
    expect((await restarted.service.list()).length).toBe(2);
    // Making a pond for a project that has a local one adopts it (publishes the same pond), never a second.
    expect((await restarted.service.createPond({ name: "Alpha 2", projectId: "p1" })).id).toBe(a.id);
    expect((await restarted.service.list()).length).toBe(2);
    await expect(restarted.service.createPond({ name: "Alpha 3", projectId: "p1" })).rejects.toThrow(
      /already has a pond/,
    );
  });
});
