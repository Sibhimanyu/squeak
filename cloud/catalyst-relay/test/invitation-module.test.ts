// The Invitation module at its interface (issue #141): invite, join, decline, withdraw, again, listFor, listForPond, over the
// in-memory tables. Every state an invitation can be in, what each action answers, and the order of the steps inside Join.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fn = new URL("../functions/squeak_relay/", import.meta.url).pathname;
const { createPeople } = require(`${fn}people.js`);
const { createMemoryTables } = require(`${fn}people-memory.js`);
const schema = require(`${fn}people-schema.json`);

const POND = "P".repeat(22);
const DAY = 24 * 60 * 60 * 1000;
const owner = { userId: "u1", email: "owner@example.com" };
const bea = { userId: "u2", email: "Bea@Example.com" };

async function setup(names: { owner?: string } = { owner: "Owner" }) {
  const clock = { t: 1000 };
  const tables = createMemoryTables(schema);
  const people = createPeople({ tables, now: () => clock.t });
  const notices: Array<{ pondId: string; invitee: string }> = [];
  people.onChange(async (n: { pondId: string; invitee: string }) => void notices.push(n));
  await people.upsertAccount({ userId: "u1", email: "owner@example.com", name: names.owner ?? "" });
  await people.upsertAccount({ userId: "u2", email: "bea@example.com", name: "Bea" });
  let n = 0;
  const send = (emails: string[], over: Record<string, unknown> = {}) =>
    people.invite(owner, POND, {
      emails,
      role: "member",
      pondName: "greenroom",
      newInviteId: () => `inv-${++n}`,
      expiresAt: clock.t + 7 * DAY,
      ...over,
    });
  return { clock, tables, people, notices, send };
}
const code = async (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: any) => e.code,
  );

describe("invite: many addresses in one call", () => {
  it("answers one result per address: invited, already-member, already-invited, refused", async () => {
    const { people, send } = await setup();
    await send(["first@example.com"]); // creates the Pond
    await people.addMember({ pondId: POND, userId: "u2", role: "member" });
    const { results } = await send([
      "Bea@example.com", // a member
      "first@example.com", // already invited
      "FIRST@example.com", // a duplicate in the same call is one address
      "nonsense", // not an address
      "new@example.com",
      "other@example.com",
    ]);
    expect(results.map((r: any) => [r.email, r.status])).toEqual([
      ["bea@example.com", "already-member"],
      ["first@example.com", "already-invited"],
      ["nonsense", "refused"],
      ["new@example.com", "invited"],
      ["other@example.com", "invited"],
    ]);
    expect(results[1].invitation).toMatchObject({ state: "pending" }); // the one that is already waiting
    expect(results[2].message).toBe("nonsense is not an email address.");
    expect(results[3].invitation).toMatchObject({
      pondId: POND,
      pondName: "greenroom",
      role: "member",
      state: "pending",
      youAreMember: false,
      email: "new@example.com",
    });
  });

  it("five addresses at once, one of them past the cap, is answered per address", async () => {
    const { send } = await setup();
    const first = await send(Array.from({ length: 8 }, (_, i) => `a${i}@example.com`));
    expect(first.results.every((r: any) => r.status === "invited")).toBe(true); // Owner + 8 = 9
    const { results } = await send(["b0@example.com", "b1@example.com", "b2@example.com"]);
    expect(results.map((r: any) => r.status)).toEqual(["invited", "refused", "refused"]);
    expect(results[1].code).toBe("pond-full");
  });

  it("only the Owner invites into an existing Pond; the first invite creates it", async () => {
    const { people, send } = await setup();
    expect(await people.getPond(POND)).toBeNull();
    await send(["a@example.com"]);
    expect(await people.getPond(POND)).toMatchObject({ ownerUserId: "u1", name: "greenroom" });
    expect(
      await code(
        people.invite({ userId: "u2", email: "bea@example.com" }, POND, {
          emails: ["x@example.com"],
          role: "member",
          newInviteId: () => "z",
          expiresAt: 9e12,
        }),
      ),
    ).toBe("forbidden");
  });
});

describe("join: idempotent, membership first, then settle", () => {
  it("joining twice answers the same success", async () => {
    const { people, send } = await setup();
    await send(["bea@example.com"]);
    const first = await people.join(bea, "inv-1");
    const second = await people.join(bea, "inv-1");
    expect(first.pond).toEqual({ pondId: POND, name: "greenroom" });
    expect(second).toEqual({ ...first, invitation: { ...first.invitation } });
    expect(second.invitation).toMatchObject({ state: "joined", youAreMember: true });
    expect((await people.membersOf(POND)).length).toBe(2);
  });

  it("the invite's slot becomes the person's: two people, two slots", async () => {
    const { people, tables, send } = await setup();
    await send(["bea@example.com"]);
    await people.join(bea, "inv-1");
    expect((await tables.all("people_slots")).map((r: any) => r.userId).sort()).toEqual(["u1", "u2"]);
  });

  it("already a Member (added another way) is success, the invite settles and its slot is freed", async () => {
    const { people, tables, send } = await setup();
    await send(["bea@example.com"]);
    await people.addMember({ pondId: POND, userId: "u2", role: "viewer" });
    const done = await people.join(bea, "inv-1");
    expect(done.invitation).toMatchObject({ state: "joined", youAreMember: true });
    expect((await people.membershipOf(POND, "u2")).role).toBe("viewer"); // not demoted or promoted by the invite
    expect((await tables.all("people_slots")).length).toBe(2);
  });

  it("a crash between the steps (membership in, invite still pending) is finished by the next Join", async () => {
    const { people, tables, send } = await setup();
    await send(["bea@example.com"]);
    // The first step happened: the membership holds the slot the invite had. The invite was never settled.
    const held = await tables.get("people_slots", "userId", "invite:inv-1");
    await tables.update("people_slots", "slotKey", held.slotKey, { userId: "u2" });
    await tables.insert("people_memberships", {
      memberKey: `${POND}:u2`,
      pondId: POND,
      userId: "u2",
      role: "member",
      slot: Number(held.slotKey.split(":").pop()),
      joinedAt: 1000,
      leftAt: 0,
      leftReason: "",
    });
    expect((await people.getInvite("inv-1")).state).toBe("pending");
    const done = await people.join(bea, "inv-1");
    expect(done.invitation).toMatchObject({ state: "joined", youAreMember: true });
    expect((await people.getInvite("inv-1")).state).toBe("joined");
    expect((await tables.all("people_slots")).length).toBe(2);
    expect((await people.membersOf(POND)).length).toBe(2);
  });

  it("a half-made membership (row, no slot) from a crash is repaired, not mistaken for being in", async () => {
    const { people, tables, send } = await setup();
    await send(["bea@example.com"]);
    await tables.insert("people_memberships", {
      memberKey: `${POND}:u2`,
      pondId: POND,
      userId: "u2",
      role: "member",
      slot: -1,
      joinedAt: 1000,
      leftAt: 0,
      leftReason: "",
    });
    await people.join(bea, "inv-1");
    expect(await people.isMember(POND, "u2")).toBe(true);
  });

  it("an old invite marked Joined before the membership was added (the old order) is healed by Join", async () => {
    const { people, send } = await setup();
    await send(["bea@example.com"]);
    await people.settleInvite("inv-1", "joined");
    expect(await people.isMember(POND, "u2")).toBe(false);
    expect((await people.join(bea, "inv-1")).invitation).toMatchObject({ state: "joined", youAreMember: true });
  });

  it("someone let in and later removed is not let back in by the old link", async () => {
    const { people, send } = await setup();
    await send(["bea@example.com"]);
    await people.join(bea, "inv-1");
    await people.removeMember({ pondId: POND, userId: "u2", reason: "removed" });
    const e = await people.join(bea, "inv-1").catch((x: any) => x);
    expect(e.code).toBe("was-joined");
    expect(e.invitation).toMatchObject({ state: "joined", youAreMember: false });
  });

  it("withdrawn, declined and expired refuse with one shape: a sentence and the fresh view", async () => {
    const { people, clock, send } = await setup();
    await send(["bea@example.com", "cy@example.com", "di@example.com"]);
    await people.withdraw(owner, POND, "inv-1");
    await people.decline({ userId: "u3", email: "cy@example.com" }, "inv-2");
    clock.t += 8 * DAY;
    const cases: Array<[string, any, string, string]> = [
      ["inv-1", bea, "was-withdrawn", "withdrawn"],
      ["inv-2", { userId: "u3", email: "cy@example.com" }, "was-declined", "declined"],
      ["inv-3", { userId: "u4", email: "di@example.com" }, "was-expired", "expired"],
    ];
    for (const [id, who, wasCode, state] of cases) {
      const e = await people.join(who, id).catch((x: any) => x);
      expect(e.code).toBe(wasCode);
      expect(e.message.length).toBeGreaterThan(10);
      expect(e.invitation).toMatchObject({ inviteId: id, state, youAreMember: false, pondName: "greenroom" });
    }
    expect(await people.isMember(POND, "u2")).toBe(false);
  });

  it("another address is refused and the invite stays pending", async () => {
    const { people, send } = await setup();
    await send(["bea@example.com"]);
    const e = await people.join({ userId: "u9", email: "eve@example.com" }, "inv-1").catch((x: any) => x);
    expect(e.code).toBe("wrong-address");
    expect(e.invitation).toMatchObject({ state: "pending" });
    expect((await people.getInvite("inv-1")).state).toBe("pending");
  });

  it("two Joins at once both succeed and leave one Member", async () => {
    const { people, send } = await setup();
    await send(["bea@example.com"]);
    const both = await Promise.allSettled([people.join(bea, "inv-1"), people.join(bea, "inv-1")]);
    expect(both.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await people.membersOf(POND)).length).toBe(2);
  });
});

describe("decline, withdraw, again", () => {
  it("decline is idempotent; after Join it refuses with the fresh view", async () => {
    const { people, send } = await setup();
    await send(["bea@example.com", "cy@example.com"]);
    expect((await people.decline(bea, "inv-1")).invitation.state).toBe("declined");
    expect((await people.decline(bea, "inv-1")).invitation.state).toBe("declined");
    await people.join({ userId: "u3", email: "cy@example.com" }, "inv-2");
    const e = await people.decline({ userId: "u3", email: "cy@example.com" }, "inv-2").catch((x: any) => x);
    expect(e.code).toBe("was-joined");
    expect(e.invitation).toMatchObject({ state: "joined", youAreMember: true });
  });

  it("withdraw is idempotent for the Owner of that Pond only; a joined invite refuses with its view", async () => {
    const { people, send } = await setup();
    await send(["bea@example.com", "cy@example.com"]);
    expect((await people.withdraw(owner, POND, "inv-1")).invitation).toMatchObject({ state: "withdrawn" });
    expect((await people.withdraw(owner, POND, "inv-1")).invitation).toMatchObject({ state: "withdrawn" });
    await people.join({ userId: "u3", email: "cy@example.com" }, "inv-2");
    const e = await people.withdraw(owner, POND, "inv-2").catch((x: any) => x);
    expect([e.code, e.invitation.state]).toEqual(["not-pending", "joined"]);
    expect(await code(people.withdraw({ userId: "u2", email: "bea@example.com" }, POND, "inv-1"))).toBe("forbidden");
    expect(await code(people.withdraw(owner, POND, "nope"))).toBe("no-invite");
  });

  it("again makes a new pending invite from a finished one and answers its view; not while pending or joined", async () => {
    const { people, send } = await setup();
    await send(["bea@example.com", "cy@example.com"]);
    const input = { newInviteId: () => "inv-9", expiresAt: 1000 + 7 * DAY };
    expect(await code(people.again(owner, POND, "inv-1", input))).toBe("still-pending");
    await people.withdraw(owner, POND, "inv-1");
    const made = await people.again(owner, POND, "inv-1", { ...input, role: "viewer" });
    expect(made.invitation).toMatchObject({ inviteId: "inv-9", state: "pending", role: "viewer" });
    expect(await people.getInvite("inv-1")).toBeNull();
    await people.join({ userId: "u3", email: "cy@example.com" }, "inv-2");
    expect(await code(people.again(owner, POND, "inv-2", input))).toBe("joined");
  });
});

describe("views and lists", () => {
  it("listFor drops everything but pending, and joined ones the Owner's Mac has not opened yet", async () => {
    const { people, send, clock } = await setup();
    await send(["bea@example.com"]);
    await people.createPond({ pondId: "Q".repeat(22), ownerUserId: "u1", name: "second" });
    await people.createInvite({
      inviteId: "old-1",
      pondId: "Q".repeat(22),
      email: "bea@example.com",
      role: "member",
      invitedBy: "u1",
      expiresAt: clock.t + 7 * DAY,
    });
    expect((await people.listFor(bea)).map((v: any) => [v.inviteId, v.state, v.pondName]).sort()).toEqual([
      ["inv-1", "pending", "greenroom"],
      ["old-1", "pending", "second"],
    ]);
    await people.join(bea, "inv-1");
    // Joined but the Pond is not yet listed for the account: still drawn (as Connecting).
    expect(
      (await people.listFor(bea, { isListed: async () => false })).map((v: any) => [v.inviteId, v.state]),
    ).toContainEqual(["inv-1", "joined"]);
    // Listed: it is the person's Pond now, the invitation goes.
    expect((await people.listFor(bea, { isListed: async () => true })).map((v: any) => v.inviteId)).not.toContain(
      "inv-1",
    );
    await people.decline(bea, "old-1");
    expect((await people.listFor(bea, { isListed: async () => true })).length).toBe(0);
  });

  it("expiry is applied in one place: a lapsed invite reads expired in every view", async () => {
    const { people, send, clock } = await setup();
    await send(["bea@example.com"]);
    clock.t += 7 * DAY + 1;
    expect(await people.listFor(bea)).toEqual([]);
    expect((await people.listForPond(owner, POND))[0]).toMatchObject({ state: "expired" });
  });

  it("listForPond is the Owner's: one view per address, newest first, with the person's account when there is one", async () => {
    const { people, send, clock } = await setup();
    await send(["bea@example.com"]);
    clock.t += 1000;
    await send(["cy@example.com"]);
    const list = await people.listForPond(owner, POND);
    expect(list.map((v: any) => v.email)).toEqual(["cy@example.com", "bea@example.com"]);
    expect(list[1]).toMatchObject({ userId: "u2", name: "Bea", invitedBy: "u1" });
    expect(await code(people.listForPond({ userId: "u2", email: "bea@example.com" }, POND))).toBe("forbidden");
    expect(await people.listForPond(owner, "Z".repeat(22))).toEqual([]);
  });

  it("the invitee's view carries no address and no id of the Owner", async () => {
    const { people, send } = await setup();
    await send(["bea@example.com"]);
    const [v] = await people.listFor(bea);
    expect(Object.keys(v).sort()).toEqual(
      ["createdAt", "expiresAt", "inviteId", "inviter", "pondId", "pondName", "role", "state", "youAreMember"].sort(),
    );
  });
});

describe("names", () => {
  it("a name is never overwritten with an empty one", async () => {
    const { people } = await setup();
    await people.upsertAccount({ userId: "u1", email: "owner@example.com", name: "" });
    await people.upsertAccount({ userId: "u1", email: "owner@example.com", name: "   " });
    expect((await people.getAccount("u1")).name).toBe("Owner");
    await people.upsertAccount({ userId: "u1", email: "owner@example.com", name: "Ola" });
    expect((await people.getAccount("u1")).name).toBe("Ola");
  });

  it("the inviter shows as their name, else their email masked, never Someone", async () => {
    const named = await setup({ owner: "Owner" });
    await named.send(["bea@example.com"]);
    expect((await named.people.listFor(bea))[0].inviter).toEqual({ name: "Owner" });
    const unnamed = await setup({ owner: "" });
    await unnamed.send(["bea@example.com"]);
    const [v] = await unnamed.people.listFor(bea);
    expect(v.inviter.name).toBe("o***@e***.com");
    expect(JSON.stringify(v)).not.toContain("Someone");
  });
});

describe("notices", () => {
  it("every change tells the invitee's account, or the address's hash before an account exists", async () => {
    const { people, send, notices } = await setup();
    await send(["bea@example.com", "new@example.com"]);
    expect(notices.map((n) => n.invitee)).toEqual(["u2", expect.stringMatching(/^e-[A-Za-z0-9_-]{43}$/)]);
    notices.length = 0;
    await people.join(bea, "inv-1");
    await people.withdraw(owner, POND, "inv-2");
    expect(notices.map((n) => n.pondId)).toEqual([POND, POND]);
    notices.length = 0;
    await people.join({ userId: "u9", email: "eve@example.com" }, "inv-1").catch(() => undefined);
    expect(notices).toEqual([]); // a refusal changes nothing
  });
});
