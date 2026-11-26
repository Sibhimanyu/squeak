// Invite, accept, the Owner's Mac pass, the invitee reads the Room (#127, and the key gap #126 left): over the REAL relay.
// The cloud holds a membership the moment the invitee joins; only the Owner's Mac can make that person a Member document and
// seal the Pond key to their devices. Until it does, the invitee sees "Connecting: waiting for <Owner>'s Mac".
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { session } from "./journey-support.js";
import { RelayWorld, type RelayMac } from "./relay-world.test-fixture.js";

process.env.SQUEAK_POND_OWN_THREADS = "on";

let world: RelayWorld;
beforeAll(async () => {
  world = await RelayWorld.start();
});
afterAll(() => world.stop());

const sibhi = { userId: "u-sibhi", email: "sibhi@example.com", name: "Sibhi" };
const asha = { userId: "u-asha", email: "asha@example.com", name: "Asha" };

/** The Owner's Mac pass the relay's notice wakes. */
const pass = (owner: RelayMac, pondId: string) => owner.service.refresh(pondId);

describe("an invited person is let in by the Owner's Mac", () => {
  let owner: RelayMac;
  let invitee: RelayMac;
  let pondId = "";
  let inviteId = "";

  beforeAll(async () => {
    owner = await world.mac(sibhi);
    invitee = await world.mac(asha);
    pondId = (
      await owner.service.createPond({ name: "greenroom", projectId: "p1", gitRemote: "git@github.com:a/g.git" })
    ).id;
  });

  it("the invitee's Mac reads the invitation from the relay's record: Pond, who invited, role", async () => {
    const results = (await owner.service.inviteEmails(pondId, ["asha@example.com"], "viewer")).results;
    expect(results[0]).toMatchObject({ ok: true });
    const waiting = await invitee.service.invitations(true);
    expect(waiting).toEqual([
      expect.objectContaining({ pondName: "greenroom", inviter: "Sibhi", role: "viewer", state: "pending" }),
    ]);
    inviteId = waiting[0]!.id;
    // An invitation is not a row of the Pond list.
    expect(await invitee.service.list()).toEqual([]);
  });

  it("Join changes state on the relay's answer: the Pond is Connecting, waiting for the Owner's Mac", async () => {
    expect(await invitee.service.joinInvitation(inviteId)).toEqual({ pondId });
    expect(await invitee.service.list()).toEqual([
      expect.objectContaining({
        id: pondId,
        name: "greenroom",
        status: "pending",
        connecting: true,
        statusLine: "Connecting: waiting for Sibhi’s Mac",
      }),
    ]);
    // The Owner's People list already counts the person, as Connecting.
    const people = await owner.service.people(pondId);
    expect(people.members.find((p) => p.email === "asha@example.com")).toMatchObject({
      connecting: true,
      role: "viewer",
    });
  });

  it("the Owner's Mac pass writes the Member document and seals the key to the device that asks", async () => {
    await pass(owner, pondId); // woken by the relay's notice: opens the Pond to the account (no Member document yet)
    expect((await owner.service.view(pondId)).members.map((x) => x.name)).toEqual(["Sibhi"]);
    await invitee.service.invitations(true); // the next read asks for this device
    await new Promise((r) => setTimeout(r, 100));
    await pass(owner, pondId); // woken by the device request: Member document, key sealed to the device
    await invitee.service.refresh(pondId);
    const view = await invitee.service.view(pondId);
    expect(view.me.role).toBe("viewer");
    expect(view.members.map((x) => x.name).sort()).toEqual(["Asha", "Sibhi"]);
    expect((await invitee.service.list())[0]).toMatchObject({ id: pondId, status: "active" });
    expect((await owner.service.view(pondId)).members.find((x) => x.name === "Asha")).toMatchObject({ role: "viewer" });
  });

  it("the invitee reads the Room: the Owner's shared Duck, with who started it", async () => {
    owner.host.sessions.set("a1", session("a1", { title: "Owner duck" }));
    owner.host.say("a1", "user/text", { text: "Start" }, "user");
    const shared = (await owner.bridge.share(pondId, "a1")).id;
    await owner.bridge.flush();
    const seen = (await invitee.service.threads(pondId)).find((t) => t.id === shared)!;
    expect(seen).toMatchObject({ mode: "shared", starterName: "Sibhi" });
  });

  it("a role change then applies to the person, and Remove too; the old invite does not let them back in", async () => {
    const ashaId = (await owner.service.view(pondId)).members.find((x) => x.name === "Asha")!.id;
    await owner.service.changeRole(pondId, ashaId, "member");
    await invitee.service.refresh(pondId);
    expect((await invitee.service.view(pondId)).me.role).toBe("member");
    await owner.service.removeMember(pondId, ashaId);
    await pass(owner, pondId);
    await pass(owner, pondId);
    expect((await owner.service.view(pondId)).members.map((x) => x.name)).toEqual(["Sibhi"]);
  });

  it("Decline removes the invitation with no question, and the Owner's record says declined", async () => {
    const bea = { userId: "u-bea", email: "bea@example.com", name: "Bea" };
    await owner.service.inviteEmails(pondId, ["bea@example.com"], "member");
    const b = await world.mac(bea);
    const [one] = await b.service.invitations(true);
    await b.service.declineInvitation(one!.id);
    expect(await b.service.invitations(true)).toEqual([]);
    const people = await owner.service.people(pondId);
    expect(people.invites.find((i) => i.email === "bea@example.com")).toMatchObject({ state: "declined" });
  });
});
