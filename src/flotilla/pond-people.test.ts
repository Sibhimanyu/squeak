import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { InviteRecord, InviteState } from "./invites-port.js";
import { AnnouncedInvites, buildPeople, owedLines, POND_CAP } from "./pond-people.js";
import type { MemberView } from "./service.js";

const member = (over: Partial<MemberView>): MemberView => ({
  id: "m1",
  name: "Sibhi",
  email: "sibhi@example.com",
  role: "owner",
  nest: null,
  nestName: null,
  client: "mac",
  online: true,
  you: true,
  ...over,
});
const invite = (state: InviteState, over: Partial<InviteRecord> = {}): InviteRecord => ({
  id: `i-${state}`,
  email: `${state}@example.com`,
  role: "member",
  state,
  invitedBy: "u1",
  createdAt: 1000,
  expiresAt: 9000,
  settledAt: state === "pending" ? 0 : 2000,
  ...over,
});

describe("the People view", () => {
  it("draws the host's members and passes the relay's invites through untouched", () => {
    const invites = (["pending", "declined", "expired", "withdrawn"] as const).map((s) => invite(s));
    const view = buildPeople(
      [
        member({}),
        member({
          id: "m2",
          name: "Asha",
          email: "asha@example.com",
          role: "viewer",
          online: false,
          you: false,
          lastSeenAt: 5,
        }),
      ],
      invites,
    );
    expect(view.cap).toBe(POND_CAP);
    expect(view.members.map((m) => [m.name, m.role, m.online, m.lastSeenAt, m.you])).toEqual([
      ["Sibhi", "owner", true, null, true],
      ["Asha", "viewer", false, 5, false],
    ]);
    expect(view.invites).toEqual(invites);
  });

  it("lists a person who joined in the cloud as Connecting until the Owner's Mac has them as a Member", () => {
    const joined = invite("joined", { email: "bea@example.com", name: "Bea", userId: "u2", role: "viewer" });
    const waiting = buildPeople([member({})], [joined]);
    expect(waiting.members.at(-1)).toEqual({
      id: "acct:u2",
      name: "Bea",
      email: "bea@example.com",
      role: "viewer",
      online: false,
      lastSeenAt: null,
      you: false,
      connecting: true,
    });
    // Once the host holds them (same address, any letter case) they are one row, not two.
    const sealed = buildPeople(
      [member({}), member({ id: "m9", name: "Bea", email: "Bea@Example.com", role: "viewer", you: false })],
      [joined],
    );
    expect(sealed.members.filter((m) => m.name === "Bea")).toHaveLength(1);
    expect(sealed.members.some((m) => m.connecting)).toBe(false);
  });
});

describe("Room lines for invites", () => {
  it("owes one line for a join and one for a decline, and none for pending, withdrawn or expired", () => {
    const all = (["pending", "joined", "declined", "expired", "withdrawn"] as const).map((s) =>
      invite(s, s === "joined" ? { name: "Bea", userId: "u2" } : {}),
    );
    const lines = owedLines(all, {});
    expect(lines.map((l) => [l.state, l.who.name, l.text, l.kind])).toEqual([
      ["joined", "Bea", "joined", "joined"],
      ["declined", "declined@example.com", "declined the invitation", "invite"],
    ]);
    expect(lines[0]!.who.id).toBe("u2");
  });

  it("never tells the same state twice, and a person who joins after declining is told again", () => {
    const declined = invite("declined", { id: "x" });
    expect(owedLines([declined], { x: "declined" })).toEqual([]);
    expect(owedLines([{ ...declined, state: "joined" }], { x: "declined" })).toHaveLength(1);
  });

  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  it("remembers what it told across restarts, per Pond, in a private file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "invite-lines-"));
    dirs.push(dir);
    const first = new AnnouncedInvites(dir);
    first.mark("p1", "i1", "joined");
    first.mark("p1", "i2", "declined");
    first.mark("p2", "i3", "joined");
    const again = new AnnouncedInvites(dir);
    expect(again.of("p1")).toEqual({ i1: "joined", i2: "declined" });
    expect(again.of("p2")).toEqual({ i3: "joined" });
    expect(owedLines([invite("joined", { id: "i1" })], again.of("p1"))).toEqual([]);
    expect(fs.statSync(path.join(dir, "invite-lines.json")).mode & 0o777).toBe(0o600);
    fs.writeFileSync(path.join(dir, "invite-lines.json"), "not json");
    expect(new AnnouncedInvites(dir).of("p1")).toEqual({});
  });
});
