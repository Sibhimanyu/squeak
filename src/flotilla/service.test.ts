import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { CloudStore } from "../cloud/store.js";
import type { ChannelDoc } from "../remote/firestore-rest.js";
import { FlotillaService } from "./service.js";

/**
 * The riskiest FlotillaService flows, on one shared in-memory cloud. (More lives beside it: local-ponds, states,
 * invite-states and the two-Mac e2e; this file adds the restart, retry and failure edges.)
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
  mac(name: string, options: { owner?: boolean; dir?: string } = {}) {
    const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-service-"));
    if (!options.dir) this.dirs.push(dir);
    const store = this.store();
    const service = new FlotillaService({
      store,
      supportDir: dir,
      displayName: name,
      nest: `${name}'s Mac`,
      ...(options.owner ? { location: LOCATION } : {}),
      storeFor: () => store,
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
    await expect(first.service.invite(made.id, "member")).rejects.toThrow(/try again/);
    expect(c.metaDocs()).toEqual([]);

    // Restart: same files, new service. The pond is still local and ensureLocalPond finds it, not a second.
    c.failWrites = false;
    const again = c.mac("Sibhi", { owner: true, dir: first.dir });
    expect(again.service.ensureLocalPond({ name: "Alpha", projectId: "p1" }).id).toBe(made.id);
    expect((await again.service.list()).map((p) => [p.id, p.local])).toEqual([[made.id, true]]);

    const invite = await again.service.invite(made.id, "member");
    expect(invite.code).toBeTruthy();
    await again.service.invite(made.id, "viewer");
    expect(c.metaDocs()).toHaveLength(1);
    expect((await again.service.list()).map((p) => [p.id, p.local])).toEqual([[made.id, undefined]]);
    // Once published, ensureLocalPond still returns that same pond.
    expect(again.service.ensureLocalPond({ name: "Alpha", projectId: "p1" }).id).toBe(made.id);
  });
});

describe("invite, join, approve", () => {
  it("a join is pending until the owner approves, one request per Mac; a decline never makes a member", async () => {
    const c = cloud();
    const A = c.mac("Sibhi", { owner: true });
    const pond = await A.service.createPond({ name: "Greenroom", projectId: "proj-G" });
    const B = c.mac("Aarav");
    const D = c.mac("Dana");
    // (Two requests on one invite show once, the newest: each person gets their own invite.)
    expect(await B.service.join((await A.service.invite(pond.id, "member")).code)).toMatchObject({
      pondId: pond.id,
      status: "pending",
    });
    expect(await D.service.join((await A.service.invite(pond.id, "member")).code)).toMatchObject({
      pondId: pond.id,
      status: "pending",
    });

    const joins = (await A.service.view(pond.id)).joins;
    expect(joins.map((j) => j.name).sort()).toEqual(["Aarav", "Dana"]);
    // Nobody but the owner decides.
    await expect(B.service.decideJoin(pond.id, joins[0]!.requestId, { approve: true })).rejects.toThrow();

    const aarav = joins.find((j) => j.name === "Aarav")!;
    const dana = joins.find((j) => j.name === "Dana")!;
    await A.service.decideJoin(pond.id, aarav.requestId, { approve: true });
    await A.service.decideJoin(pond.id, dana.requestId, { approve: false });
    await B.service.refresh(pond.id);
    await D.service.refresh(pond.id);

    expect((await B.service.view(pond.id)).me.role).toBe("member");
    expect((await A.service.view(pond.id)).members.map((m) => m.name).sort()).toEqual(["Aarav", "Sibhi"]);
    expect((await A.service.view(pond.id)).joins).toEqual([]);
    expect((await D.service.view(pond.id)).me?.role).not.toBe("member");
  });
});

describe("a guest leaves", () => {
  it("is forgotten here and removed on the owner's Mac; their own cloud failure leaves them in, not half out", async () => {
    const c = cloud();
    const A = c.mac("Sibhi", { owner: true });
    const pond = await A.service.createPond({ name: "Greenroom", projectId: "proj-G" });
    const B = c.mac("Aarav");
    await B.service.join((await A.service.invite(pond.id, "member")).code);
    const [req] = (await A.service.view(pond.id)).joins;
    await A.service.decideJoin(pond.id, req!.requestId, { approve: true });
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
