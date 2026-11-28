import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fn = new URL("../functions/squeak_relay/", import.meta.url).pathname;
const { createPeople, PeopleError, encodeText, decodeText, MAX_MEMBERS } = require(`${fn}people.js`);
const { createMemoryTables } = require(`${fn}people-memory.js`);
const schema = require(`${fn}people-schema.json`);

const POND = "P".repeat(22);
const make = (t = 1000) => {
  const clock = { t };
  const tables = createMemoryTables(schema);
  const people = createPeople({ tables, now: () => clock.t });
  return { people, tables, clock };
};
const code = async (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: any) => e.code,
  );

describe("schema", () => {
  it("makes every unique rule a unique column and lists no system columns", () => {
    const names = schema.tables.map((t: any) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "people_accounts",
        "people_devices",
        "people_push_tokens",
        "people_ponds",
        "people_memberships",
        "people_slots",
        "people_invites",
        "people_invite_locks",
      ]),
    );
    const unique = (t: string, c: string) =>
      schema.tables.find((x: any) => x.name === t).columns.find((x: any) => x.name === c).unique === true;
    expect(unique("people_memberships", "memberKey")).toBe(true);
    expect(unique("people_slots", "slotKey")).toBe(true);
    expect(unique("people_invite_locks", "lockKey")).toBe(true);
    for (const t of schema.tables)
      for (const c of t.columns) expect(["ROWID", "CREATORID", "CREATEDTIME", "MODIFIEDTIME"]).not.toContain(c.name);
  });
});

describe("accounts, devices, push tokens", () => {
  it("keeps the name sign-in gave and updates it, one row per account", async () => {
    const { people, clock } = make();
    await people.upsertAccount({ userId: "u1", email: "Sibhi@Example.com ", name: "Sibhi" });
    clock.t = 2000;
    await people.upsertAccount({ userId: "u1", email: "sibhi@example.com", name: "Sibhi M" });
    expect(await people.getAccount("u1")).toMatchObject({
      userId: "u1",
      email: "sibhi@example.com",
      name: "Sibhi M",
      createdAt: 1000,
      updatedAt: 2000,
    });
    expect((await people.accountByEmail("SIBHI@example.com"))?.userId).toBe("u1");
    expect(await people.getAccount("nobody")).toBeNull();
  });

  it("round-trips emoji names (Data Store would store 4-byte characters as ?)", async () => {
    const { people, tables } = make();
    await people.upsertAccount({ userId: "u1", email: "a@b.co", name: "Ana 🦆 \\ done" });
    expect((await people.getAccount("u1"))?.name).toBe("Ana 🦆 \\ done");
    const raw = await tables.get("people_accounts", "userId", "u1");
    expect(/[\u{10000}-\u{10FFFF}]/u.test(raw.name)).toBe(false);
    expect(decodeText(encodeText("x😀y"))).toBe("x😀y");
  });

  it("registers a device once, lists a person's devices, and refuses another account's device id", async () => {
    const { people } = make();
    await people.addDevice({ deviceId: "d1", userId: "u1", name: "Mac", kind: "mac", publicKey: "pk" });
    await people.addDevice({ deviceId: "d1", userId: "u1", name: "Mac mini", kind: "mac", publicKey: "pk" });
    await people.addDevice({ deviceId: "d2", userId: "u1", name: "Phone", kind: "ios", publicKey: "pk2" });
    expect((await people.devicesOf("u1")).map((d: any) => [d.deviceId, d.name]).sort()).toEqual([
      ["d1", "Mac mini"],
      ["d2", "Phone"],
    ]);
    expect(await code(people.addDevice({ deviceId: "d1", userId: "u2", name: "x", kind: "mac", publicKey: "k" }))).toBe(
      "device-taken",
    );
    expect(
      await code(people.addDevice({ deviceId: "d9", userId: "u1", name: "x", kind: "fridge", publicKey: "k" })),
    ).toBe("invalid");
    await people.removeDevice("d1");
    expect((await people.devicesOf("u1")).map((d: any) => d.deviceId)).toEqual(["d2"]);
  });

  it("keeps one push token per device and drops it with the device", async () => {
    const { people } = make();
    await people.addDevice({ deviceId: "d2", userId: "u1", name: "Phone", kind: "ios", publicKey: "k" });
    await people.setPushToken({ deviceId: "d2", userId: "u1", token: "t1", platform: "ios" });
    await people.setPushToken({ deviceId: "d2", userId: "u1", token: "t2", platform: "ios" });
    expect((await people.pushTokensOf("u1")).map((t: any) => t.token)).toEqual(["t2"]);
    await people.removeDevice("d2");
    expect(await people.pushTokensOf("u1")).toEqual([]);
  });
});

describe("ponds and memberships", () => {
  it("makes the Owner the first member", async () => {
    const { people } = make();
    await people.createPond({ pondId: POND, ownerUserId: "u1", name: "Squeak 🦆" });
    expect(await people.getPond(POND)).toMatchObject({ pondId: POND, ownerUserId: "u1", name: "Squeak 🦆" });
    expect(await people.isMember(POND, "u1")).toBe(true);
    expect((await people.membersOf(POND)).map((m: any) => [m.userId, m.role])).toEqual([["u1", "owner"]]);
    expect(await code(people.createPond({ pondId: POND, ownerUserId: "u2", name: "again" }))).toBe("pond-exists");
  });

  it("refuses a duplicate membership", async () => {
    const { people } = make();
    await people.createPond({ pondId: POND, ownerUserId: "u1", name: "P" });
    await people.addMember({ pondId: POND, userId: "u2", role: "member" });
    expect(await code(people.addMember({ pondId: POND, userId: "u2", role: "viewer" }))).toBe("already-member");
    expect(await code(people.addMember({ pondId: POND, userId: "u1", role: "member" }))).toBe("already-member");
    expect((await people.membersOf(POND)).length).toBe(2);
  });

  it("refuses the eleventh person even when the adds race", async () => {
    const { people } = make();
    await people.createPond({ pondId: POND, ownerUserId: "u0", name: "P" });
    const results = await Promise.all(
      Array.from({ length: 14 }, (_, i) =>
        code(people.addMember({ pondId: POND, userId: `u${i + 1}`, role: "member" })),
      ),
    );
    expect(results.filter((r) => r === "ok").length).toBe(MAX_MEMBERS - 1);
    expect(results.filter((r) => r === "pond-full").length).toBe(14 - (MAX_MEMBERS - 1));
    expect((await people.membersOf(POND)).length).toBe(MAX_MEMBERS);
  });

  it("frees the slot when someone leaves, keeps who and when, and lets them come back", async () => {
    const { people, clock } = make();
    await people.createPond({ pondId: POND, ownerUserId: "u0", name: "P" });
    for (let i = 1; i < MAX_MEMBERS; i++) await people.addMember({ pondId: POND, userId: `u${i}`, role: "member" });
    expect(await code(people.addMember({ pondId: POND, userId: "late", role: "member" }))).toBe("pond-full");
    clock.t = 5000;
    await people.removeMember({ pondId: POND, userId: "u3", reason: "left" });
    expect(await people.isMember(POND, "u3")).toBe(false);
    expect((await people.membershipOf(POND, "u3"))?.leftAt).toBe(5000);
    expect(await code(people.addMember({ pondId: POND, userId: "late", role: "member" }))).toBe("ok");
    // The one who left is not blocked by the unique rule: it reopens their own row, if there is room.
    expect(await code(people.addMember({ pondId: POND, userId: "u3", role: "viewer" }))).toBe("pond-full");
    await people.removeMember({ pondId: POND, userId: "u4", reason: "removed" });
    expect(await code(people.addMember({ pondId: POND, userId: "u3", role: "viewer" }))).toBe("ok");
    expect((await people.membershipOf(POND, "u3")) as any).toMatchObject({ role: "viewer", leftAt: 0 });
  });

  it("never removes the Owner, and says nothing of strangers", async () => {
    const { people } = make();
    await people.createPond({ pondId: POND, ownerUserId: "u1", name: "P" });
    expect(await code(people.removeMember({ pondId: POND, userId: "u1", reason: "left" }))).toBe("owner");
    expect(await code(people.removeMember({ pondId: POND, userId: "nobody", reason: "left" }))).toBe("not-member");
    expect(await people.isMember(POND, "nobody")).toBe(false);
  });

  it("lists the Ponds an account is in with names, newest membership first", async () => {
    const { people, clock } = make();
    await people.upsertAccount({ userId: "u2", email: "b@x.co", name: "Bea" });
    await people.createPond({ pondId: POND, ownerUserId: "u1", name: "One" });
    clock.t = 3000;
    await people.createPond({ pondId: "Q".repeat(22), ownerUserId: "u1", name: "Two" });
    await people.addMember({ pondId: "Q".repeat(22), userId: "u2", role: "viewer" });
    expect((await people.pondsOf("u1")).map((p: any) => p.name)).toEqual(["Two", "One"]);
    expect((await people.pondsOf("u2")).map((p: any) => [p.name, p.role])).toEqual([["Two", "viewer"]]);
    expect((await people.membersOf("Q".repeat(22))).map((m: any) => m.name)).toEqual(expect.arrayContaining(["Bea"]));
  });
});

describe("invites", () => {
  const inv = (over: Record<string, unknown> = {}) => ({
    inviteId: "i1",
    pondId: POND,
    email: "Bea@Example.com",
    role: "member",
    invitedBy: "u1",
    expiresAt: 10_000,
    ...over,
  });

  it("refuses a second pending invite for the same address in the same Pond, in any letter case", async () => {
    const { people } = make();
    await people.createPond({ pondId: POND, ownerUserId: "u1", name: "P" });
    await people.createInvite(inv());
    expect(await code(people.createInvite(inv({ inviteId: "i2", email: " bea@example.com" })))).toBe("invite-pending");
    // Another address, or the same address in another Pond, is fine.
    expect(await code(people.createInvite(inv({ inviteId: "i3", email: "cy@example.com" })))).toBe("ok");
    await people.createPond({ pondId: "Q".repeat(22), ownerUserId: "u1", name: "Q" });
    expect(await code(people.createInvite(inv({ inviteId: "i4", pondId: "Q".repeat(22) })))).toBe("ok");
    expect([(await people.getInvite("i1"))?.state, (await people.getInvite("i3"))?.state]).toEqual([
      "pending",
      "pending",
    ]);
  });

  it("refuses the same invite id twice", async () => {
    const { people } = make();
    await people.createPond({ pondId: POND, ownerUserId: "u1", name: "P" });
    await people.createInvite(inv());
    expect(await code(people.createInvite(inv({ email: "other@example.com" })))).toBe("invite-exists");
    // and the failed try left no lock behind
    expect(await code(people.createInvite(inv({ inviteId: "i9", email: "other@example.com" })))).toBe("ok");
  });

  it("frees the address when the invite is settled, and settles only a pending one", async () => {
    const { people, clock } = make();
    await people.createPond({ pondId: POND, ownerUserId: "u1", name: "P" });
    await people.createInvite(inv());
    clock.t = 2000;
    await people.settleInvite("i1", "declined");
    expect(await people.getInvite("i1")).toMatchObject({ state: "declined", settledAt: 2000 });
    expect(await code(people.settleInvite("i1", "joined"))).toBe("not-pending");
    expect(await code(people.settleInvite("i1", "pending"))).toBe("invalid");
    expect(await code(people.createInvite(inv({ inviteId: "i2" })))).toBe("ok");
    expect(await code(people.settleInvite("ghost", "withdrawn"))).toBe("no-invite");
  });

  it("lets a new invite replace one that has expired, and shows the old one as expired", async () => {
    const { people, clock } = make();
    await people.createPond({ pondId: POND, ownerUserId: "u1", name: "P" });
    await people.createInvite(inv());
    clock.t = 10_000;
    expect(await code(people.createInvite(inv({ inviteId: "i2", expiresAt: 20_000 })))).toBe("ok");
    expect((await people.getInvite("i1"))?.state).toBe("expired");
    expect((await people.getInvite("i2"))?.state).toBe("pending");
  });

  it("validates its input", async () => {
    const { people } = make();
    await people.createPond({ pondId: POND, ownerUserId: "u1", name: "P" });
    expect(await code(people.createInvite(inv({ email: "not an email" })))).toBe("invalid");
    expect(await code(people.createInvite(inv({ role: "owner" })))).toBe("invalid");
    expect(await code(people.createInvite(inv({ expiresAt: 5 })))).toBe("invalid");
    expect(await code(people.createInvite(inv({ pondId: "nope" })))).toBe("invalid");
    expect(await code(people.createInvite(inv({ pondId: "Z".repeat(22) })))).toBe("no-pond");
    expect(PeopleError).toBeDefined();
  });
});

describe("clean start", () => {
  it("clears Ponds, memberships, slots and invites and keeps accounts and devices", async () => {
    const { people, tables } = make();
    await people.upsertAccount({ userId: "u1", email: "a@b.co", name: "A" });
    await people.addDevice({ deviceId: "d1", userId: "u1", name: "Mac", kind: "mac", publicKey: "k" });
    await people.createPond({ pondId: POND, ownerUserId: "u1", name: "P" });
    await people.addMember({ pondId: POND, userId: "u2", role: "member" });
    await people.createInvite({
      inviteId: "i1",
      pondId: POND,
      email: "c@d.co",
      role: "member",
      invitedBy: "u1",
      expiresAt: 99_999,
    });
    const pondIds = await people.pondIds();
    expect(pondIds).toEqual([POND]);
    const counts = await people.cleanStart();
    expect(counts).toMatchObject({ ponds: 1, memberships: 2, invites: 1 });
    expect(await people.getPond(POND)).toBeNull();
    expect(await people.pondsOf("u1")).toEqual([]);
    expect(await tables.all("people_slots")).toEqual([]);
    expect(await tables.all("people_invite_locks")).toEqual([]);
    expect(await people.getAccount("u1")).not.toBeNull();
    expect((await people.devicesOf("u1")).length).toBe(1);
    // and the same Pond id and address are free again
    await people.createPond({ pondId: POND, ownerUserId: "u1", name: "P" });
    expect(await people.isMember(POND, "u2")).toBe(false);
  });
});
