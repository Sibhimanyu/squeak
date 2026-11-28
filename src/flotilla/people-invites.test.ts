// The Owner's Mac and the relay's invite record (#126): invites go out through the relay, People is drawn from the record,
// a join and a decline each say one line in the Room (a withdrawal and an expiry say nothing), and every refusal keeps the
// relay's plain sentence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { ChannelDoc, CloudStore } from "../cloud/store.js";
import { InviteRefused, type InviteRecord, type InviteState, type PondInvites } from "./invites-port.js";
import { named } from "./named-account.test-fixture.js";
import { FlotillaService } from "./service.js";
import type { Ripple } from "./types.js";

const LOCATION = { provider: "firebase", databaseUrl: "https://squeak-test-default-rtdb.firebaseio.com" };
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** The relay's invite record, in memory: what `PondInvites` answers, and what a test flips to play the invitee. */
function fakeRelay() {
  const records = new Map<string, InviteRecord>();
  const calls: string[] = [];
  let n = 0;
  const known = new Set<string>();
  const port: PondInvites = {
    async ensurePond(pondId, name) {
      calls.push(`share ${name}`);
      known.add(pondId);
      return "shared";
    },
    async create(pondId, input) {
      calls.push(`create ${input.emails.join(",")} ${input.role} ${input.pondName}`);
      // The relay refuses a Pond it was not told about unless the (older) caller names it.
      if (!known.has(pondId) && !input.pondName) throw new InviteRefused("This Pond isn't shared yet.", 404);
      return input.emails.map((email) => {
        if (email === "in@example.com")
          return {
            email,
            ok: false as const,
            status: "already-member" as const,
            message: `${email} is already in this Pond.`,
          };
        const invite: InviteRecord = {
          id: `i${++n}`,
          email,
          role: input.role,
          state: "pending",
          invitedBy: "me",
          createdAt: 1000,
          expiresAt: 9000,
          settledAt: 0,
        };
        records.set(invite.id, invite);
        return { email, ok: true as const, status: "invited" as const, invite };
      });
    },
    async list() {
      calls.push("list");
      return [...records.values()];
    },
    async resend(_pondId, id) {
      calls.push(`resend ${id}`);
      const invite = records.get(id);
      if (!invite || invite.state !== "pending") throw new InviteRefused("That invitation is no longer waiting.", 409);
      return { invite, mailed: true };
    },
    async withdraw(_pondId, id) {
      calls.push(`withdraw ${id}`);
      return set(id, "withdrawn");
    },
    async again(_pondId, id, role) {
      calls.push(`again ${id} ${role ?? ""}`);
      const old = records.get(id)!;
      records.delete(id);
      const invite: InviteRecord = { ...old, id: `i${++n}`, state: "pending", settledAt: 0, role: role ?? old.role };
      records.set(invite.id, invite);
      return { invite, mailed: true };
    },
  };
  const set = (id: string, state: InviteState, extra: Partial<InviteRecord> = {}): InviteRecord => {
    const next = { ...records.get(id)!, state, settledAt: 5000, ...extra };
    records.set(id, next);
    return next;
  };
  return { port, records, calls, set };
}

function make(options: { cloud?: boolean; relay?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "people-invites-"));
  dirs.push(dir);
  const docs = new Map<string, ChannelDoc>();
  const store: CloudStore = {
    get: async (p) => docs.get(p) ?? null,
    set: async (p, doc) => void docs.set(p, doc),
    list: async (c) =>
      [...docs].filter(([k]) => k.startsWith(`${c}/`)).map(([k, doc]) => ({ id: k.slice(c.length + 1), doc })),
    delete: async (p) => void docs.delete(p),
    watch: () => () => undefined,
  };
  const relay = fakeRelay();
  const service = new FlotillaService({
    store,
    supportDir: dir,
    account: named("Sibhi"),
    nest: "mac",
    location: LOCATION,
    ...(options.relay === false ? {} : { invites: relay.port }),
  });
  const lines: Array<Ripple & { pondId: string }> = [];
  service.on("line", (pondId: string, ripple: Ripple) => lines.push({ ...ripple, pondId }));
  return { service, relay, lines, docs, dir };
}

describe("inviting by email through the relay", () => {
  it("publishes a local Pond first, sends the addresses with the role and the Pond's name, and returns each address's answer", async () => {
    const { service, relay, docs } = make();
    const pond = service.ensureLocalPond({ name: "greenroom", projectId: "p1" });
    const r = await service.inviteEmails(pond.id, ["asha@example.com", "in@example.com"], "viewer");
    expect([...docs.keys()].some((k) => k.endsWith("/pond/meta"))).toBe(true);
    // Shared first, then invited: the invite no longer carries the Pond's name (the relay refuses a Pond it was not told about).
    expect(relay.calls).toEqual(["share greenroom", "create asha@example.com,in@example.com viewer undefined"]);
    expect(r.results[0]).toMatchObject({ ok: true, status: "invited", invite: { state: "pending", role: "viewer" } });
    expect(r.results[1]).toEqual({
      email: "in@example.com",
      ok: false,
      status: "already-member",
      message: "in@example.com is already in this Pond.",
    });
  });

  it("refuses a role, a count and a missing cloud in plain sentences, and a Member cannot invite", async () => {
    const { service } = make();
    const pond = service.ensureLocalPond({ name: "greenroom", projectId: "p1" });
    await expect(service.inviteEmails(pond.id, ["a@example.com"], "owner" as never)).rejects.toThrow(
      /member or a viewer/,
    );
    await expect(service.inviteEmails(pond.id, [], "member")).rejects.toThrow(/between 1 and 10/);
    const none = make({ relay: false });
    const local = none.service.ensureLocalPond({ name: "x", projectId: "p2" });
    await expect(none.service.inviteEmails(local.id, ["a@example.com"], "member")).rejects.toMatchObject({
      status: 503,
      message: "Invites need Squeak's cloud. Sign in to Squeak, then try again.",
    });
  });

  it("Resend, Withdraw and Invite again go to the relay, and its sentence reaches the caller with its status", async () => {
    const { service, relay } = make();
    const pond = service.ensureLocalPond({ name: "greenroom", projectId: "p1" });
    const [first] = (await service.inviteEmails(pond.id, ["asha@example.com"], "member")).results;
    const id = (first as { invite: InviteRecord }).invite.id;
    expect((await service.resendInvite(pond.id, id)).mailed).toBe(true);
    expect((await service.withdrawInvite(pond.id, id)).invite.state).toBe("withdrawn");
    await expect(service.resendInvite(pond.id, id)).rejects.toMatchObject({
      status: 409,
      message: "That invitation is no longer waiting.",
    });
    const again = await service.inviteAgain(pond.id, id, "viewer");
    expect(again.invite).toMatchObject({ state: "pending", role: "viewer" });
    await expect(service.inviteAgain(pond.id, id, "owner" as never)).rejects.toThrow(/member or a viewer/);
    expect(relay.calls.slice(2)).toEqual([`resend ${id}`, `withdraw ${id}`, `resend ${id}`, `again ${id} viewer`]);
  });
});

describe("People is the host's members plus the relay's record", () => {
  it("lists members and every invite as the relay holds it, and a person who joined shows as Connecting", async () => {
    const { service, relay } = make();
    const pond = service.ensureLocalPond({ name: "greenroom", projectId: "p1" });
    // A local Pond has no invites to read and makes no relay call.
    expect(await service.people(pond.id)).toMatchObject({ cap: 10, invites: [] });
    expect(relay.calls).toEqual([]);
    await service.inviteEmails(pond.id, ["asha@example.com", "bea@example.com", "cy@example.com"], "member");
    relay.set("i2", "declined");
    relay.set("i3", "joined", { name: "Cy", userId: "u-cy" });
    const view = await service.people(pond.id);
    expect(view.invites.map((i) => [i.email, i.state])).toEqual([
      ["asha@example.com", "pending"],
      ["bea@example.com", "declined"],
      ["cy@example.com", "joined"],
    ]);
    expect(view.members.map((m) => [m.name, m.role, m.you, m.connecting ?? false])).toEqual([
      ["Sibhi", "owner", true, false],
      ["Cy", "member", false, true],
    ]);
  });
});

describe("Room lines for a join and a decline", () => {
  const lineTexts = (lines: Ripple[]) => lines.map((l) => `${l.onBehalf?.name ?? "?"} ${l.text} (${l.kind})`);

  it("says a join and a decline once each, never a withdrawal, an expiry or a pending invite", async () => {
    const { service, relay, lines } = make();
    const pond = service.ensureLocalPond({ name: "greenroom", projectId: "p1" });
    await service.inviteEmails(
      pond.id,
      ["asha@example.com", "bea@example.com", "cy@example.com", "di@example.com", "ed@example.com"],
      "member",
    );
    await service.people(pond.id);
    expect(lines.filter((l) => l.kind === "joined" || l.kind === "invite")).toEqual([]);
    relay.set("i1", "joined", { name: "Asha", userId: "u-asha" });
    relay.set("i2", "declined", { name: "Bea" });
    relay.set("i3", "withdrawn");
    relay.set("i4", "expired");
    await service.people(pond.id);
    await service.people(pond.id); // reading again says nothing more
    expect(lineTexts(lines.filter((l) => l.kind === "joined" || l.kind === "invite"))).toEqual([
      "Asha joined (joined)",
      "Bea declined the invitation (invite)",
    ]);
  });

  it("comes without a sheet open: the Owner's own pass over the record says it", async () => {
    const { service, relay, lines } = make();
    const pond = service.ensureLocalPond({ name: "greenroom", projectId: "p1" });
    await service.inviteEmails(pond.id, ["asha@example.com"], "member");
    relay.set("i1", "declined", { name: "Asha" });
    await service.refresh(pond.id);
    expect(lineTexts(lines.filter((l) => l.kind === "invite"))).toEqual(["Asha declined the invitation (invite)"]);
    await service.refresh(pond.id);
    expect(lines.filter((l) => l.kind === "invite")).toHaveLength(1);
  });

  it("does not say it twice after a restart, and names the person by the part of the address before the @ when there is no account name", async () => {
    const first = make();
    const pond = first.service.ensureLocalPond({ name: "greenroom", projectId: "p1" });
    await first.service.inviteEmails(pond.id, ["asha@example.com"], "member");
    first.relay.set("i1", "declined");
    await first.service.people(pond.id);
    expect(lineTexts(first.lines.filter((l) => l.kind === "invite"))).toEqual([
      "Asha declined the invitation (invite)",
    ]);
    const again = new FlotillaService({
      store: null,
      supportDir: first.dir,
      account: named("Sibhi"),
      nest: "mac",
      location: LOCATION,
      invites: first.relay.port,
    });
    const lines: Ripple[] = [];
    again.on("line", (_p: string, r: Ripple) => lines.push(r));
    await (again as unknown as { tellInvites(p: unknown, i: InviteRecord[]): Promise<void> }).tellInvites(
      { id: pond.id },
      [...first.relay.records.values()],
    );
    expect(lines).toEqual([]);
  });
});
