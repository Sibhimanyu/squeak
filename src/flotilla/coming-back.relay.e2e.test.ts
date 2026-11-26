// Regressions the People journey (people-journey.relay.e2e.test.ts) found, each on its own over the real relay: a removed device
// must see the new invitation and be let back in; a Pond a person left must not come back as "Connecting"; and when the Owner's Mac
// deletes a Pond the cloud's people records end with it, so a browser reads it as gone too.
import { afterAll, describe, expect, it } from "vitest";

import { RelayWorld, type RelayMac } from "./relay-world.test-fixture.js";
import { ownerHost } from "./room-host.test-fixture.js";

process.env.SQUEAK_POND_OWN_THREADS = "on";

const worlds: RelayWorld[] = [];
afterAll(() => worlds.forEach((w) => w.stop()));

const sibhi = { userId: "u-sibhi", email: "sibhi@example.com", name: "Sibhi" };
const asha = { userId: "u-asha", email: "asha@example.com", name: "Asha" };

/** A relay of its own, an Owner with a Pond, and Asha's browser let in. */
async function pondWithAsha() {
  const world = await RelayWorld.start();
  worlds.push(world);
  const owner = await world.mac(sibhi);
  world.owner.id = owner.service.me.id;
  const host = ownerHost(owner.service, "Sibhi", world.dirs);
  const pondId = (await owner.service.createPond({ name: "greenroom", projectId: host.project.id })).id;
  const device = await world.mac(asha, null);
  await owner.service.inviteEmails(pondId, [asha.email], "member");
  const [invite] = await device.service.invitations(true);
  await device.service.joinInvitation(invite!.id);
  await letIn(owner, device, pondId);
  return { world, owner, device, pondId };
}

async function letIn(owner: RelayMac, device: RelayMac, pondId: string) {
  await owner.service.refresh(pondId);
  await device.service.invitations(true);
  await new Promise((r) => setTimeout(r, 100));
  await owner.service.refresh(pondId);
  await device.service.refresh(pondId);
  expect((await device.service.view(pondId)).me.role).toBe("member");
}

describe("coming back after being removed", () => {
  it("the device that was removed sees the new invitation, joins it and is let in again", async () => {
    const { owner, device, pondId } = await pondWithAsha();
    const member = (await owner.service.view(pondId)).members.find((m) => m.name === "Asha")!;
    await owner.service.removeMember(pondId, member.id);
    await device.service.refresh(pondId).catch(() => undefined);
    expect((await device.service.list()).find((p) => p.id === pondId)?.status).toBe("removed");

    await owner.service.inviteEmails(pondId, [asha.email], "member");
    const waiting = await device.service.invitations(true);
    expect(waiting.map((i) => [i.pondId, i.state])).toEqual([[pondId, "pending"]]);
    await device.service.joinInvitation(waiting[0]!.id);
    expect((await device.service.list()).find((p) => p.id === pondId)).toMatchObject({ connecting: true });
    await letIn(owner, device, pondId);
    expect((await device.service.list()).find((p) => p.id === pondId)?.status).toBe("active");
  });

  it("a second device that was removed with the first is added back by the account's own sync", async () => {
    const { world, owner, device, pondId } = await pondWithAsha();
    const second = await world.mac(asha, "Asha-mac");
    expect(await second.service.syncAccountPonds()).toBe(1);
    await owner.service.refresh(pondId);
    await second.service.refresh(pondId);
    const member = (await owner.service.view(pondId)).members.find((m) => m.name === "Asha")!;
    await owner.service.removeMember(pondId, member.id);
    await second.service.refresh(pondId).catch(() => undefined);
    expect((await second.service.list()).find((p) => p.id === pondId)?.status).toBe("removed");

    await owner.service.inviteEmails(pondId, [asha.email], "member");
    const [again] = await device.service.invitations(true);
    await device.service.joinInvitation(again!.id);
    await letIn(owner, device, pondId);
    expect(await second.service.syncAccountPonds()).toBe(1);
    await owner.service.refresh(pondId);
    await second.service.refresh(pondId);
    expect((await second.service.view(pondId)).me.role).toBe("member");
  });
});

describe("leaving", () => {
  it("the Pond is gone from the device's list, not back as Connecting from an invitation it read earlier", async () => {
    const { owner, device, pondId } = await pondWithAsha();
    await device.service.invitations(); // the cached read still names the joined invitation
    await device.service.leave(pondId);
    await owner.service.refresh(pondId);
    expect((await device.service.list()).some((p) => p.id === pondId)).toBe(false);
    expect(await device.service.invitations()).toEqual([]);
  });
});

describe("the Owner's Mac deletes the Pond", () => {
  it("ends the cloud's people records: a Member's account reads no feed and the overview marks it deleted", async () => {
    const { world, owner, device, pondId } = await pondWithAsha();
    (owner.service as unknown as { options: { deleteGraceMs: number } }).options.deleteGraceMs = 0;
    const token = await world.accountToken(asha);
    expect((await world.web(token, `/changes?pond=${pondId}&since=0`)).status).toBe(200);
    await owner.service.deletePond(pondId);
    expect((await world.web(token, `/changes?pond=${pondId}&since=0`)).status).toBe(403);
    // The week's record of it: the overview says it was deleted, so a browser need not guess from a refused read.
    const overview = (await (await world.web(token, "/account/overview")).json()) as {
      ponds: Array<{ pondId: string; deleted?: boolean }>;
    };
    expect(overview.ponds.find((p) => p.pondId === pondId)).toMatchObject({ deleted: true });
    await device.service.refresh(pondId).catch(() => undefined);
    expect((await device.service.list()).find((p) => p.id === pondId)).toMatchObject({ status: "removed" });
  });
});
