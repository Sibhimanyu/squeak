import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { CloudStore } from "../cloud/store.js";
import type { ChannelDoc } from "../remote/firestore-rest.js";
import { FlotillaRoutes } from "./mount.js";
import { FlotillaService, CLOUD_DOWN } from "./service.js";

const LOCATION = { provider: "firebase", databaseUrl: "https://squeak-test-default-rtdb.firebaseio.com" };

/** One shared in-memory cloud with hooks: per-member refusals (401), outages and slowness, to act out a real relay. */
class World {
  docs = new Map<string, ChannelDoc>();
  /** Devices (by service) whose reads fail with this message. */
  failing = new Map<CloudStore, string>();
  delayMs = 0;
  clock = { t: 1_800_000_000_000 };
  dirs: string[] = [];
  storeFor(label: string): CloudStore & { label: string } {
    const run = async <T>(call: () => T): Promise<T> => {
      const failure = this.failing.get(self);
      if (failure) throw new Error(failure);
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      return call();
    };
    const self: CloudStore & { label: string } = {
      label,
      get: (p) => run(() => this.docs.get(p) ?? null),
      set: (p, doc) => run(() => void this.docs.set(p, doc)),
      list: (c) =>
        run(() =>
          [...this.docs].filter(([k]) => k.startsWith(`${c}/`)).map(([k, doc]) => ({ id: k.slice(c.length + 1), doc })),
        ),
      delete: (p) => run(() => void this.docs.delete(p)),
      watch: () => () => undefined,
    };
    return self;
  }
  mac(name: string, options: { owner?: boolean; budgetMs?: number; nest?: string | null } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pond-states-"));
    this.dirs.push(dir);
    const store = this.storeFor(name);
    const service = new FlotillaService({
      store,
      supportDir: dir,
      displayName: name,
      nest: options.nest === undefined ? `${name}'s Mac` : options.nest,
      ...(options.owner ? { location: LOCATION } : {}),
      storeFor: () => store,
      now: () => this.clock.t,
      ...(options.budgetMs ? { budgetMs: options.budgetMs } : {}),
    });
    return { dir, service, store };
  }
}

const worlds: World[] = [];
afterAll(() => {
  for (const w of worlds) for (const d of w.dirs) fs.rmSync(d, { recursive: true, force: true });
});
const world = (): World => {
  const w = new World();
  worlds.push(w);
  return w;
};

/** An owner, with a member and optionally a viewer already in. */
async function flock(w: World, roles: Array<{ name: string; role: "member" | "viewer" }> = []) {
  const A = w.mac("Sibhi", { owner: true });
  const pond = await A.service.createPond({ name: "Greenroom" });
  const others = [];
  for (const { name, role } of roles) {
    const M = w.mac(name);
    await M.service.join((await A.service.invite(pond.id, role)).code, name);
    const [req] = (await A.service.view(pond.id)).joins;
    await A.service.decideJoin(pond.id, req!.requestId, { approve: true });
    await M.service.refresh(pond.id);
    others.push(M);
  }
  return { A, pondId: pond.id, others };
}

describe("a removed member is told", () => {
  it("a removed member's hold neither crashes the pond page nor outlives them", async () => {
    const w = world();
    const { A, pondId, others } = await flock(w, [{ name: "Aarav", role: "member" }]);
    const [B] = others;
    await B!.service.hold(pondId, "q1");
    expect((await A.service.view(pondId)).holds).toEqual([
      expect.objectContaining({ requestId: "q1", heldBy: B!.service.me.id, heldByName: "Aarav" }),
    ]);
    await A.service.removeMember(pondId, B!.service.me.id);
    const view = await A.service.view(pondId);
    expect(view.offline).toBeUndefined();
    expect(view.holds).toEqual([]);
    expect(w.docs.has(`channels/${pondId}/holds/q1`)).toBe(false);
  });

  it("a hold signed by a key that is no member reads as nothing (it used to throw)", async () => {
    const w = world();
    const { A, pondId, others } = await flock(w, [{ name: "Aarav", role: "member" }]);
    await others[0]!.service.hold(pondId, "q1");
    // The owner's removal is interrupted before it can clean up the hold.
    const hold = w.docs.get(`channels/${pondId}/holds/q1`)!;
    await A.service.removeMember(pondId, others[0]!.service.me.id);
    w.docs.set(`channels/${pondId}/holds/q1`, hold);
    const view = await A.service.view(pondId);
    expect(view.offline).toBeUndefined();
    expect(view.holds).toEqual([]);
  });

  it("the relay's 401 on a removed member becomes status removed, in list and view, never a raw error", async () => {
    const w = world();
    const { A, pondId, others } = await flock(w, [{ name: "Aarav", role: "member" }]);
    const B = others[0]!;
    await A.service.removeMember(pondId, B.service.me.id);
    // On Catalyst the revoked token is refused by every call.
    w.failing.set(B.store, "catalyst list failed: 401");
    const [row] = await B.service.list();
    expect(row).toMatchObject({ status: "removed", statusLine: "You were removed from Greenroom." });
    expect(row!.offline).toBeUndefined();
    const view = await B.service.view(pondId);
    expect(view.pond.status).toBe("removed");
  });

  it("a removed pond stays listed until Remove, and Remove forgets it", async () => {
    const w = world();
    const { A, pondId, others } = await flock(w, [{ name: "Aarav", role: "member" }]);
    const B = others[0]!;
    await A.service.removeMember(pondId, B.service.me.id);
    await B.service.refresh(pondId);
    expect((await B.service.list()).map((p) => p.status)).toEqual(["removed"]);
    await B.service.forget(pondId);
    expect(await B.service.list()).toEqual([]);
    await expect(A.service.forget(pondId)).rejects.toThrow(/Leave it first/);
  });

  it("a member who has not yet picked up a rotated key is not told they were removed", async () => {
    const w = world();
    const { A, pondId, others } = await flock(w, [
      { name: "Aarav", role: "member" },
      { name: "Chitra", role: "member" },
    ]);
    const [B, C] = others;
    // Remove B; C has not refreshed. C's old key reads nothing, but the new key is waiting for it in its keys document.
    await A.service.removeMember(pondId, B!.service.me.id);
    const view = await C!.service.view(pondId);
    expect(view.pond.status).toBe("active");
    expect(view.members.map((m) => m.name).sort()).toEqual(["Chitra", "Sibhi"]);
  });
});

describe("a join that cannot be answered does not wait forever", () => {
  it("a revoked invite (the relay refuses the join token) leaves no pending pond and says so", async () => {
    const w = world();
    const A = w.mac("Sibhi", { owner: true });
    const pond = await A.service.createPond({ name: "Greenroom" });
    const { code } = await A.service.invite(pond.id, "member");
    const B = w.mac("Dev");
    w.failing.set(B.store, "catalyst set failed: 401");
    await expect(B.service.join(code, "Dev")).rejects.toThrow("That invite is no longer valid. Ask for a new one.");
    expect(await B.service.list()).toEqual([]);
    w.failing.set(B.store, "fetch failed");
    await expect(B.service.join(code, "Dev")).rejects.toThrow(/wasn't sent/);
    expect(await B.service.list()).toEqual([]);
  });

  it("an invite revoked while the request waits ends the joiner's wait as revoked", async () => {
    const w = world();
    const A = w.mac("Sibhi", { owner: true });
    const pond = await A.service.createPond({ name: "Greenroom" });
    const { code } = await A.service.invite(pond.id, "member");
    const B = w.mac("Farah");
    await B.service.join(code, "Farah");
    w.failing.set(B.store, "catalyst list failed: 401");
    await B.service.refresh(pond.id);
    const [row] = await B.service.list();
    expect(row).toMatchObject({ status: "revoked", statusLine: "Sibhi withdrew this invite." });
  });

  it("a request on an invite that lapsed is expired, with the owner's name once it is known", async () => {
    const w = world();
    const A = w.mac("Sibhi", { owner: true });
    const pond = await A.service.createPond({ name: "Greenroom" });
    const { code } = await A.service.invite(pond.id, "member");
    const B = w.mac("Hari");
    await B.service.join(code, "Hari");
    await B.service.refresh(pond.id);
    expect((await B.service.list())[0]).toMatchObject({
      status: "pending",
      statusLine: "Waiting for Sibhi to approve you as a member.",
    });
    w.clock.t += 25 * 60 * 60_000;
    await B.service.refresh(pond.id);
    expect((await B.service.list())[0]).toMatchObject({
      status: "expired",
      statusLine: "This invite expired before Sibhi answered.",
    });
  });

  it("a declined request says so with the owner's name, and a new request after it reaches the owner", async () => {
    const w = world();
    const A = w.mac("Sibhi", { owner: true });
    const pond = await A.service.createPond({ name: "Greenroom" });
    const { code } = await A.service.invite(pond.id, "member");
    const B = w.mac("Dev");
    await B.service.join(code, "Dev");
    const [req] = (await A.service.view(pond.id)).joins;
    expect(req).toMatchObject({ name: "Dev", client: "mac", nest: "Dev's Mac", requestedAt: expect.any(Number) });
    await A.service.decideJoin(pond.id, req!.requestId, { approve: false });
    await B.service.refresh(pond.id);
    expect((await B.service.list())[0]).toMatchObject({ status: "declined", statusLine: "Sibhi declined your request." });
    await B.service.join(code, "Dev");
    expect((await A.service.view(pond.id)).joins).toHaveLength(1);
    expect((await B.service.list())[0]).toMatchObject({ status: "pending" });
  });
});

describe("the relay is slow or gone", () => {
  it("no raw transport error reaches a caller, and a pond never read gives one fixed sentence", async () => {
    const w = world();
    const { pondId, others } = await flock(w, [{ name: "Veena", role: "viewer" }]);
    const V = others[0]!;
    w.failing.set(V.store, "fetch failed");
    await expect(V.service.view(pondId)).rejects.toThrow(CLOUD_DOWN);
    await expect(V.service.hold(pondId, "q")).rejects.toThrow(/Viewers|reach|read-only/);
    const [row] = await V.service.list();
    expect(row!.status).toBe("active");
  });

  it("an offline list serves the last good read with asOf and the sentence; writes say read-only; recovery clears it", async () => {
    const w = world();
    const { A, pondId } = await flock(w, [{ name: "Aarav", role: "member" }]);
    await A.service.view(pondId);
    await A.service.list();
    w.failing.set(A.store, "fetch failed");
    const [row] = await A.service.list();
    expect(row).toMatchObject({ offline: true, offlineLine: expect.stringMatching(/^Can't reach Squeak's cloud\. Showing what was here at \d\d:\d\d\.$/) });
    expect(row!.asOf).toBeTypeOf("number");
    const stale = await A.service.view(pondId);
    expect(stale).toMatchObject({ offline: true });
    expect(stale.pond.offlineLine).toBe(row!.offlineLine);
    await expect(A.service.ripple(pondId, "x")).rejects.toMatchObject({ status: 503 });
    // The relay is back: a write goes through with no read first.
    w.failing.delete(A.store);
    w.clock.t += 11_000;
    await expect(A.service.ripple(pondId, "back")).resolves.toBeTypeOf("string");
  });

  it("a slow relay is answered from the last good read inside the budget, and the read still lands", async () => {
    const w = world();
    const A = w.mac("Sibhi", { owner: true, budgetMs: 40 });
    const pond = await A.service.createPond({ name: "Greenroom" });
    await A.service.view(pond.id);
    w.delayMs = 120;
    const t = Date.now();
    const [row] = await A.service.list();
    expect(Date.now() - t).toBeLessThan(110);
    expect(row).toMatchObject({ offline: true });
    const view = await A.service.view(pond.id);
    expect(view.offline).toBe(true);
    w.delayMs = 0;
  });

  it("a pond view reads its independent lists together and skips tasks and locks unless asked", async () => {
    const w = world();
    const { A, pondId } = await flock(w, [{ name: "Aarav", role: "member" }]);
    const seen: string[] = [];
    const real = A.store.list;
    A.store.list = async (c) => {
      seen.push(c.split("/").slice(2).join("/"));
      return real(c);
    };
    const view = await A.service.view(pondId);
    expect(view.tasks).toBeUndefined();
    expect(seen).not.toContain("tasks");
    expect(seen).not.toContain("locks");
    expect(seen.filter((k) => k === "members")).toHaveLength(1);
  });
});

describe("the pond's people", () => {
  it("online is a heartbeat under 45 s; lastSeenAt is the beat; the owner changes a role, and the member sees it", async () => {
    const w = world();
    const { A, pondId, others } = await flock(w, [{ name: "Aarav", role: "member" }]);
    const B = others[0]!;
    await B.service.setPresence(pondId, { viewing: "pond" });
    let members = (await A.service.view(pondId)).members;
    expect(members.find((m) => m.name === "Aarav")).toMatchObject({
      online: true,
      client: "mac",
      nestName: "Aarav's Mac",
      lastSeenAt: w.clock.t,
    });
    w.clock.t += 46_000;
    members = (await A.service.view(pondId)).members;
    expect(members.find((m) => m.name === "Aarav")!.online).toBe(false);
    expect(members.find((m) => m.you)!.online).toBe(true);
    await A.service.changeRole(pondId, B.service.me.id, "viewer");
    await B.service.refresh(pondId);
    expect((await B.service.view(pondId)).me.role).toBe("viewer");
    await expect(B.service.changeRole(pondId, A.service.me.id, "member")).rejects.toThrow(/Only an owner/);
    await expect(A.service.changeRole(pondId, A.service.me.id, "viewer")).rejects.toThrow(/can't be changed/);
    expect((await A.service.view(pondId)).ripples[0]).toMatchObject({ text: "made Aarav a viewer", actorName: "Sibhi" });
  });

  it("a member leaves: the owner's Mac removes them and the pond forgets", async () => {
    const w = world();
    const { A, pondId, others } = await flock(w, [{ name: "Aarav", role: "member" }]);
    const B = others[0]!;
    await B.service.leave(pondId);
    expect(await B.service.list()).toEqual([]);
    await A.service.refresh(pondId);
    expect((await A.service.view(pondId)).members.map((m) => m.name)).toEqual(["Sibhi"]);
    await expect(A.service.leave(pondId)).rejects.toThrow(/delete it instead/);
  });

  it("the owner renames the pond for everyone", async () => {
    const w = world();
    const { A, pondId, others } = await flock(w, [{ name: "Aarav", role: "member" }]);
    await A.service.renamePond(pondId, "Backstage");
    await others[0]!.service.refresh(pondId);
    expect((await others[0]!.service.list())[0]!.name).toBe("Backstage");
    await expect(others[0]!.service.renamePond(pondId, "Mine")).rejects.toThrow(/Only an owner/);
  });

  it("deleting the pond ends it for everyone and clears the cloud", async () => {
    const w = world();
    const { A, pondId, others } = await flock(w, [{ name: "Aarav", role: "member" }]);
    await A.service.deletePond(pondId);
    expect(await A.service.list()).toEqual([]);
    expect([...w.docs.keys()].filter((k) => k.startsWith(`channels/${pondId}/`))).toEqual([]);
    await others[0]!.service.refresh(pondId);
    expect((await others[0]!.service.list())[0]).toMatchObject({ status: "removed" });
    await expect(others[0]!.service.deletePond(pondId)).rejects.toThrow();
  });

  it("a project tied to a shared pond is not removed from under it", async () => {
    const w = world();
    const A = w.mac("Sibhi", { owner: true });
    const local = A.service.ensureLocalPond({ name: "Alpha", projectId: "p1" });
    expect(A.service.projectRemovalBlock("p1")).toBeNull();
    A.service.projectRemoved("p1");
    expect(await A.service.list()).toEqual([]);
    const again = A.service.ensureLocalPond({ name: "Alpha", projectId: "p1" });
    expect(again.id).not.toBe(local.id);
    await A.service.createPond({ name: "Alpha", projectId: "p1" });
    expect(A.service.projectRemovalBlock("p1")).toMatch(/Delete the pond Alpha first/);
  });
});

describe("threads and messages", () => {
  it("says who runs what, whether it asks, whether the starter is online, and one line for the state", async () => {
    const w = world();
    const { A, pondId, others } = await flock(w, [{ name: "Aarav", role: "member" }]);
    const B = others[0]!;
    const t = await B.service.publishThread(pondId, {
      sessionId: "s1",
      title: "Fix login",
      agent: "claude",
      model: "m",
      mode: "own",
      permissionMode: "default",
      state: "working",
    });
    await B.service.setPresence(pondId, {});
    let [thread] = (await A.service.view(pondId)).threads;
    expect(thread).toMatchObject({
      id: t.id,
      mode: "own",
      private: false,
      asks: true,
      starterOnline: true,
      starterName: "Aarav",
      nestName: "Aarav's Mac",
      stateLine: "Working on Aarav's Mac",
    });
    w.clock.t += 50_000;
    [thread] = (await A.service.view(pondId)).threads;
    expect(thread).toMatchObject({ starterOnline: false, stateLine: "Aarav's Mac is offline" });
    await B.service.updateThread(pondId, t.id, { state: "working", permissionMode: "bypassPermissions" });
    [thread] = (await A.service.view(pondId)).threads;
    expect(thread!.asks).toBe(false);
  });

  it("a waiting thread says what it waits on, and only a question counts for a member", async () => {
    const w = world();
    const { A, pondId, others } = await flock(w, [{ name: "Aarav", role: "member" }]);
    const B = others[0]!;
    const t = await B.service.publishThread(pondId, { sessionId: "s1", title: "T", agent: "claude", model: "m", mode: "own" });
    await B.service.setPresence(pondId, {});
    await B.service.updateThread(pondId, t.id, { state: "waiting", waitingFor: "approval" });
    let view = await A.service.view(pondId);
    expect(view.threads[0]!.stateLine).toBe("Waiting for Aarav to approve an edit");
    expect(view.threads[0]!.waitingOn).toBe("approval");
    expect(view.pond.needsYou).toBe(0);
    await B.service.updateThread(pondId, t.id, { state: "waiting", waitingFor: "question" });
    view = await A.service.view(pondId);
    expect(view.threads[0]!.stateLine).toBe("Waiting for an answer");
    expect(view.threads[0]!.waitingOn).toBe("question");
    expect(view.pond.needsYou).toBe(1);
  });

  it("private threads leave nothing in the Ripples, and sharing one later removes its title again", async () => {
    const w = world();
    const { A, pondId } = await flock(w);
    await A.service.publishThread(pondId, { sessionId: "s1", title: "Secret plan", agent: "claude", model: "m", mode: "shared", private: true });
    expect((await A.service.view(pondId)).ripples.map((r) => r.text).join("|")).not.toContain("Secret plan");
    const shown = await A.service.publishThread(pondId, { sessionId: "s2", title: "Open plan", agent: "claude", model: "m", mode: "shared" });
    expect((await A.service.view(pondId)).ripples.map((r) => r.text)).toContain("shared Open plan");
    await A.service.setThreadPrivate(pondId, shown.id, true);
    expect((await A.service.view(pondId)).ripples.map((r) => r.text).join("|")).not.toContain("Open plan");
  });

  it("Ripples never repeat the actor: older ones lose a leading name, and one written for a member names them", async () => {
    const w = world();
    const { A, pondId, others } = await flock(w, [{ name: "Aarav", role: "member" }]);
    await A.service.ripple(pondId, "Sibhi did a thing");
    const texts = (await A.service.view(pondId)).ripples.map((r) => `${r.actorName}: ${r.text}`);
    expect(texts).toContain("Sibhi: did a thing");
    expect(texts).toContain("Aarav: joined");
    expect(texts).toContain("Sibhi: made the pond");
    expect(others).toHaveLength(1);
  });

  it("a hold lapses 2 minutes after its last renewal, names its holder, and a viewer cannot take one", async () => {
    const w = world();
    const { A, pondId, others } = await flock(w, [
      { name: "Aarav", role: "member" },
      { name: "Veena", role: "viewer" },
    ]);
    const [B, V] = others;
    expect(await B!.service.hold(pondId, "q1")).toEqual({ ok: true, heldBy: "Aarav" });
    expect(await A.service.hold(pondId, "q1")).toEqual({ ok: false, heldBy: "Aarav" });
    w.clock.t += 119_000;
    expect((await A.service.view(pondId)).holds).toHaveLength(1);
    w.clock.t += 2_000;
    expect((await A.service.view(pondId)).holds).toHaveLength(0);
    expect(await A.service.hold(pondId, "q1")).toEqual({ ok: true, heldBy: "Sibhi" });
    await expect(V!.service.hold(pondId, "q1")).rejects.toThrow("Viewers can read but not send.");
  });
});

describe("names and authors", () => {
  it("joining uses the typed name in that pond only; the Mac's own name is untouched; the invite response has an id", async () => {
    const w = world();
    const A = w.mac("Sibhi", { owner: true });
    const pond = await A.service.createPond({ name: "Greenroom" });
    const inv = await A.service.invite(pond.id, "member");
    expect(inv.id).toBeTypeOf("string");
    const B = w.mac("Aarav");
    await B.service.join(inv.code, "Aarav at work");
    expect(B.service.me.name).toBe("Aarav");
    const [req] = (await A.service.view(pond.id)).joins;
    expect(req!.name).toBe("Aarav at work");
    await A.service.decideJoin(pond.id, req!.requestId, { approve: true });
    await B.service.refresh(pond.id);
    expect(B.service.me.name).toBe("Aarav");
    expect((await B.service.view(pond.id)).me.name).toBe("Aarav at work");
    expect((await B.service.hold(pond.id, "q1")).heldBy).toBe("Aarav at work");
    expect((await B.service.list())[0]).toMatchObject({ ownerName: "Sibhi" });
  });

  it("only a teammate's message carries an author; the starter's own do not", async () => {
    const w = world();
    const { A, pondId, others } = await flock(w, [{ name: "Aarav", role: "member" }]);
    const t = await A.service.publishThread(pondId, { sessionId: "s1", title: "T", agent: "claude", model: "m", mode: "shared" });
    const first = A.service.allocSeq(pondId, t.id, 2);
    await A.service.publishEvents(pondId, t.id, [
      { type: "user", by: A.service.me.id, byName: "Sibhi", text: "mine", seq: first, at: 1 },
      { type: "user", by: others[0]!.service.me.id, byName: "Aarav", text: "theirs", seq: first + 1, at: 2 },
    ]);
    const { events } = await others[0]!.service.readEvents(pondId, t.id, 0);
    expect(events[0]).not.toHaveProperty("author");
    expect(events[1]).toMatchObject({ author: { id: others[0]!.service.me.id, name: "Aarav" } });
  });
});

describe("the routes", () => {
  it("role, leave, rename, delete and forget take strict bodies; presence too", async () => {
    const w = world();
    const { A, pondId, others } = await flock(w, [{ name: "Aarav", role: "member" }]);
    const routes = new FlotillaRoutes({
      service: A.service,
      bridge: null as never,
      remoteOf: async () => null,
      startOwn: async () => ({ sessionId: "" }),
    });
    const call = async (method: string, parts: string[], body: Record<string, unknown> = {}) => {
      let out: { status: number; body: unknown } = { status: 0, body: null };
      await routes.handle({
        req: null as never,
        res: null as never,
        method,
        parts,
        url: new URL("http://x/"),
        body: async () => body,
        json: (status, b) => (out = { status, body: b }),
      });
      return out;
    };
    const bId = others[0]!.service.me.id;
    expect(await call("POST", ["ponds", pondId, "members", bId, "role"], { role: "owner" })).toMatchObject({ status: 400 });
    expect(await call("POST", ["ponds", pondId, "members", bId, "role"], { role: "viewer", x: 1 })).toMatchObject({ status: 400 });
    expect(await call("POST", ["ponds", pondId, "members", bId, "role"], { role: "viewer" })).toMatchObject({ status: 200 });
    expect(await call("POST", ["ponds", pondId, "presence"], { viewing: 3 })).toMatchObject({ status: 400 });
    expect(await call("POST", ["ponds", pondId, "presence"], { viewing: "pond" })).toMatchObject({ status: 200 });
    expect(await call("POST", ["ponds", pondId, "rename"], { name: "New", extra: 1 })).toMatchObject({ status: 400 });
    expect(await call("POST", ["ponds", pondId, "rename"], { name: "New" })).toMatchObject({ status: 200 });
    expect(await call("POST", ["ponds", pondId, "forget"], { pondId })).toMatchObject({ status: 409 });
    expect(await call("POST", ["ponds", pondId, "leave"], { pondId })).toMatchObject({ status: 409 });
    expect(await call("POST", ["ponds", pondId, "delete"], {})).toMatchObject({ status: 400 });
    expect(await call("POST", ["ponds", pondId, "delete"], { pondId })).toMatchObject({ status: 200 });
    expect(await call("GET", ["ponds"])).toMatchObject({ status: 200, body: { ponds: [] } });
  });
});
