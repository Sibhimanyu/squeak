import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { CloudStore } from "../cloud/store.js";
import type { ChannelDoc } from "../remote/firestore-rest.js";
import { FlotillaService } from "./service.js";

const LOCATION = { provider: "firebase", databaseUrl: "https://squeak-test-default-rtdb.firebaseio.com" };
const DAY = 24 * 60 * 60_000;

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
function build(dir: string, name: string, owner: boolean) {
  return new FlotillaService({
    store: shared,
    supportDir: dir,
    displayName: name,
    nest: `${name}-mac`,
    ...(owner ? { location: LOCATION } : {}),
    storeFor: () => shared,
    now: () => clock.t,
  });
}
function mk(name: string, owner = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "invite-states-"));
  dirs.push(dir);
  return { dir, service: build(dir, name, owner) };
}
const pondsJson = (m: { dir: string }) => path.join(m.dir, "flotilla", "ponds.json");

async function setup() {
  const A = mk("Owner", true);
  const pond = await A.service.createPond({ name: "Site", projectId: "proj-Site" });
  return { A, pondId: pond.id };
}
const invitesOf = async (A: ReturnType<typeof mk>, id: string) => (await A.service.view(id)).invites ?? [];

describe("invite states", () => {
  it("a new invite is pending, and an approved one reads accepted", async () => {
    const { A, pondId } = await setup();
    const inv = await A.service.invite(pondId, "member");
    // A pending invite keeps its code and link, so the owner can copy them again.
    expect(await invitesOf(A, pondId)).toEqual([
      expect.objectContaining({
        id: inv.id,
        role: "member",
        state: "pending",
        expiresAt: inv.expiresAt,
        code: inv.code,
        createdAt: clock.t,
      }),
    ]);
    const B = mk("Bea");
    await B.service.join(inv.code);
    const [req] = (await A.service.view(pondId)).joins;
    await A.service.decideJoin(pondId, req!.requestId, { approve: true });
    const after = (await invitesOf(A, pondId))[0]!;
    expect(after).toMatchObject({ state: "accepted", usedBy: "Bea" });
    // Once used, the code and link are not kept.
    expect(after.code).toBeUndefined();
    expect(after.link).toBeUndefined();
  });

  it("a declined join records declined, tells the requester in a fixed sentence, and cannot be retried", async () => {
    const { A, pondId } = await setup();
    const inv = await A.service.invite(pondId, "member");
    const B = mk("Bea");
    await B.service.join(inv.code);
    const [req] = (await A.service.view(pondId)).joins;
    await A.service.decideJoin(pondId, req!.requestId, { approve: false });
    expect((await invitesOf(A, pondId))[0]!.state).toBe("declined");
    expect((await A.service.view(pondId)).ripples.map((r) => r.text)).toContain("turned down Bea's request to join");
    await B.service.refresh(pondId);
    expect((await B.service.view(pondId)).pond).toMatchObject({
      status: "declined",
      statusLine: "Owner declined your request.",
    });
    // Asking again with the same invite is a new request the owner sees and decides (it was not shown before: lost).
    const C = mk("Cy");
    await C.service.join(inv.code);
    expect((await A.service.view(pondId)).joins).toHaveLength(1);
    await expect(A.service.decideJoin(pondId, req!.requestId, { approve: true })).rejects.toThrow(
      /That request is gone/,
    );
  });

  it("a pending join lists with its role, a decline stays listed, and cancelling withdraws the request", async () => {
    const { A, pondId } = await setup();
    const inv = await A.service.invite(pondId, "viewer");
    const B = mk("Bea");
    await B.service.join(inv.code);
    const [mine] = await B.service.list();
    expect(mine).toMatchObject({ id: pondId, status: "pending", requestedRole: "viewer" });
    // Cancel: the owner no longer sees the request, and the pond is gone from the list.
    await B.service.cancelJoin(pondId);
    expect(await B.service.list()).toEqual([]);
    expect((await A.service.view(pondId)).joins).toHaveLength(0);
    await expect(B.service.cancelJoin(pondId)).rejects.toThrow(/no such request/);
    // A declined one stays listed so it can say so, and Remove clears it.
    const inv2 = await A.service.invite(pondId, "member");
    await B.service.join(inv2.code);
    const [req] = (await A.service.view(pondId)).joins;
    await A.service.decideJoin(pondId, req!.requestId, { approve: false });
    await B.service.refresh(pondId);
    expect((await B.service.list())[0]).toMatchObject({ status: "declined" });
    await B.service.cancelJoin(pondId);
    expect(await B.service.list()).toEqual([]);
    // An active pond is never removed this way.
    await expect(A.service.cancelJoin(pondId)).rejects.toThrow(/already in that pond/);
  });

  it("a revoked invite cannot be used, and the owner sees revoked", async () => {
    const { A, pondId } = await setup();
    const inv = await A.service.invite(pondId, "member");
    const B = mk("Bea");
    await B.service.join(inv.code);
    expect(await A.service.revokeInvite(pondId, inv.id)).toEqual({ id: inv.id, state: "revoked" });
    expect((await invitesOf(A, pondId))[0]!.state).toBe("revoked");
    // A request already waiting is dropped; a new one shows greyed, with its sentence, and cannot be approved.
    expect((await A.service.view(pondId)).joins).toHaveLength(0);
    const C = mk("Cy");
    await C.service.join(inv.code);
    const [late] = (await A.service.view(pondId)).joins;
    expect(late).toMatchObject({
      name: "Cy",
      decision: { state: "failed", line: "Invite withdrawn. Ask them to join again." },
    });
    await expect(A.service.decideJoin(pondId, late!.requestId, { approve: true })).rejects.toMatchObject({
      status: 409,
    });
    expect((await A.service.view(pondId)).ripples.map((r) => r.text)).toContain(
      "withdrew the invite Bea was waiting on",
    );
    // Revoking again is harmless; an unknown id is a 404.
    await expect(A.service.revokeInvite(pondId, inv.id)).resolves.toMatchObject({ state: "revoked" });
    await expect(A.service.revokeInvite(pondId, "nope")).rejects.toThrow(/No such invite/);
  });

  it("an accepted invite cannot be revoked", async () => {
    const { A, pondId } = await setup();
    const inv = await A.service.invite(pondId, "member");
    const B = mk("Bea");
    await B.service.join(inv.code);
    const [req] = (await A.service.view(pondId)).joins;
    await A.service.decideJoin(pondId, req!.requestId, { approve: true });
    await expect(A.service.revokeInvite(pondId, inv.id)).rejects.toThrow(/already accepted/);
  });

  it("expiry: pending until the boundary, then expired, refused for joins and persisted", async () => {
    const { A, pondId } = await setup();
    const start = clock.t;
    const inv = await A.service.invite(pondId, "member");
    const B = mk("Bea");
    await B.service.join(inv.code);
    clock.t = inv.expiresAt - 1;
    expect((await invitesOf(A, pondId))[0]!.state).toBe("pending");
    expect((await A.service.view(pondId)).joins).toHaveLength(1);
    clock.t = inv.expiresAt;
    expect((await invitesOf(A, pondId))[0]!.state).toBe("expired");
    // The request stays, greyed, for a day: the owner learns what became of it.
    const [grey] = (await A.service.view(pondId)).joins;
    expect(grey!.decision).toEqual({ state: "failed", line: "Invite expired. Ask them to join again." });
    // The joiner's side is not left waiting: it lapses with the invite.
    await B.service.refresh(pondId);
    expect((await B.service.view(pondId)).pond).toMatchObject({
      status: "expired",
      statusLine: "This invite expired before Owner answered.",
    });
    clock.t = inv.expiresAt + DAY + 1;
    expect((await A.service.view(pondId)).joins).toHaveLength(0);
    clock.t = inv.expiresAt;
    const saved = JSON.parse(fs.readFileSync(pondsJson(A), "utf8")).ponds[pondId].invites[0];
    expect(saved.state).toBe("expired");
    const C = mk("Cy");
    await expect(C.service.join(inv.code)).rejects.toThrow("That invite has expired.");
    await expect(A.service.revokeInvite(pondId, inv.id)).rejects.toThrow(/already expired/);
    expect(inv.expiresAt - start).toBe(DAY);
    clock.t = start;
  });

  it("an invite from before states, with no state or id, still works", async () => {
    const { A, pondId } = await setup();
    const inv = await A.service.invite(pondId, "viewer");
    const file = pondsJson(A);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const i of data.ponds[pondId].invites) {
      delete i.state;
      delete i.id;
    }
    fs.writeFileSync(file, JSON.stringify(data));
    const old = build(A.dir, "Owner", true);
    const B = mk("Bea");
    await B.service.join(inv.code);
    const joins = (await old.view(pondId)).joins;
    expect(joins).toHaveLength(1);
    await old.decideJoin(pondId, joins[0]!.requestId, { approve: true });
    expect((await old.view(pondId)).members).toHaveLength(2);
  });
});
