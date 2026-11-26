// The invited person's side on a Mac (#127): invitations come from the relay's record only, Join and Decline change what the
// Mac shows on the relay's answer only, and a Pond joined but not yet opened by the Owner's Mac is a Connecting row.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { ChannelDoc, CloudStore } from "../cloud/store.js";
import { InviteRefused, type Invitation, type InviteRecord, type PondInvites } from "./invites-port.js";
import { named } from "./named-account.test-fixture.js";
import { FlotillaService } from "./service.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const invitation = (over: Partial<Invitation> = {}): Invitation => ({
  id: "i1",
  pondId: "P".repeat(22),
  pondName: "greenroom",
  inviter: "Sibhi",
  role: "member",
  state: "pending",
  expiresAt: 9_000,
  ...over,
});

function make(list: Invitation[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "invitee-"));
  dirs.push(dir);
  const docs = new Map<string, ChannelDoc>();
  const store: CloudStore = {
    get: async (p) => docs.get(p) ?? null,
    set: async (p, doc) => void docs.set(p, doc),
    list: async () => [],
    delete: async () => undefined,
    watch: () => () => undefined,
  };
  const state = { list, reads: 0, refuse: null as InviteRefused | null };
  const settled = (id: string, s: "joined" | "declined"): InviteRecord => ({
    id,
    email: "me@example.com",
    role: "member",
    state: s,
    invitedBy: "u1",
    createdAt: 1,
    expiresAt: 2,
    settledAt: 3,
  });
  const port: PondInvites = {
    create: async () => [],
    list: async () => [],
    resend: async () => Promise.reject(new Error("unused")),
    withdraw: async () => Promise.reject(new Error("unused")),
    again: async () => Promise.reject(new Error("unused")),
    async mine() {
      state.reads += 1;
      return state.list;
    },
    async accept(id) {
      if (state.refuse) throw state.refuse;
      state.list = state.list.map((i) => (i.id === id ? { ...i, state: "joined" as const } : i));
      return settled(id, "joined");
    },
    async decline(id) {
      if (state.refuse) throw state.refuse;
      state.list = state.list.filter((i) => i.id !== id);
      return settled(id, "declined");
    },
  };
  const clock = { t: 1_000_000 };
  const service = new FlotillaService({
    store,
    supportDir: dir,
    account: named("Asha"),
    nest: "mac",
    location: { provider: "firebase", databaseUrl: "https://squeak-test-default-rtdb.firebaseio.com" },
    invites: port,
    now: () => clock.t,
  });
  return { service, state, clock };
}

describe("invitations on the invited person's Mac", () => {
  it("are the relay's record, read at most every ten seconds, and are not Ponds", async () => {
    const { service, state, clock } = make([invitation()]);
    expect(await service.invitations()).toEqual([invitation()]);
    await service.invitations();
    expect(state.reads).toBe(1);
    clock.t += 11_000;
    await service.invitations();
    expect(state.reads).toBe(2);
    expect(await service.list()).toEqual([]);
  });

  it("Join is a Connecting row only once the relay has said yes; a refusal changes nothing and keeps its sentence", async () => {
    const { service, state } = make([invitation()]);
    state.refuse = new InviteRefused("That invitation is no longer open.", 409);
    await expect(service.joinInvitation("i1")).rejects.toMatchObject({
      status: 409,
      message: "That invitation is no longer open.",
    });
    expect((await service.invitations(true)).map((i) => i.state)).toEqual(["pending"]);
    expect(await service.list()).toEqual([]);

    state.refuse = null;
    expect(await service.joinInvitation("i1")).toEqual({ pondId: "P".repeat(22) });
    expect(await service.list()).toEqual([
      expect.objectContaining({
        id: "P".repeat(22),
        name: "greenroom",
        status: "pending",
        connecting: true,
        statusLine: "Connecting: waiting for Sibhi’s Mac",
        ownerName: "Sibhi",
      }),
    ]);
  });

  it("Decline asks nothing and the invitation is gone; a refusal leaves it", async () => {
    const { service, state } = make([invitation(), invitation({ id: "i2", pondId: "Q".repeat(22) })]);
    state.refuse = new InviteRefused("Squeak could not reach the cloud. Try again.", 503);
    await expect(service.declineInvitation("i1")).rejects.toMatchObject({ status: 503 });
    expect((await service.invitations()).map((i) => i.id)).toEqual(["i1", "i2"]);
    state.refuse = null;
    await service.declineInvitation("i1");
    expect((await service.invitations(true)).map((i) => i.id)).toEqual(["i2"]);
    expect(await service.list()).toEqual([]);
  });

  it("a Mac with no cloud has no invitations, and says what is missing instead of pretending", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "invitee-"));
    dirs.push(dir);
    const service = new FlotillaService({ store: null, supportDir: dir, account: named("Asha"), nest: "mac" });
    expect(await service.invitations()).toEqual([]);
    await expect(service.joinInvitation("i1")).rejects.toMatchObject({ status: 503 });
    await expect(service.declineInvitation("i1")).rejects.toMatchObject({ status: 503 });
  });
});
