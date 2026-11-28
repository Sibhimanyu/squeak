import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { sealAt, signedText, signText } from "./crypto.js";
import {
  canMap,
  capsOf,
  CAN_ACTIONS,
  decide,
  DEFAULT_POLICY,
  effectivePolicy,
  memberPolicyView,
  POND_ACTIONS,
  readPolicy,
  START_FROM_ROOM,
  TALK_IN_ROOM,
  THREAD_ACTIONS,
  type Action,
  type Actor,
  type Context,
  type PondPolicy,
} from "./permissions.js";
import { FlotillaService } from "./service.js";
import type { Role } from "./types.js";
import { admitMember } from "./admit-member.test-fixture.js";
import { named } from "./named-account.test-fixture.js";

const actor = (role: Role, memberId: string): Actor => ({ kind: "human", memberId, role });
const owner = actor("owner", "O");
const member = actor("member", "M");
const other = actor("member", "N");
const viewer = actor("viewer", "V");
const thread = (starter: string, isPrivate = false): Context => ({ thread: { starter, private: isPrivate } });
// The thread tables below ask under the "direct" policy, where talking to a Duck is the role's alone; the Pond policy's own
// matrix (reachDucks, startDucks, overrides) is the next describe.
const DIRECT: PondPolicy = { reachDucks: "direct", startDucks: "members-approval" };
const ok = (a: Actor, action: Action, c: Context = {}, policy: PondPolicy = DIRECT) => decide(a, action, c, policy).ok;
const can = (a: Actor, action: Action, c: Context = {}, policy: PondPolicy = DIRECT) => decide(a, action, c, policy);

describe("pond role", () => {
  it("only the owner invites and removes members", () => {
    for (const a of ["invite", "remove-member"] as const) {
      expect(ok(owner, a)).toBe(true);
      expect(ok(member, a)).toBe(false);
      expect(ok(viewer, a)).toBe(false);
    }
  });
  it("viewers watch; members and owners start threads on their own machine", () => {
    expect(ok(viewer, "view-pond")).toBe(true);
    expect(ok(viewer, "start-thread")).toBe(false);
    expect(ok(member, "start-thread")).toBe(true);
    expect(ok(owner, "start-thread")).toBe(true);
  });
  it("system and runtime actors only look", () => {
    for (const kind of ["system", "runtime"] as const) {
      const a: Actor = { kind, memberId: "O", role: "owner" };
      expect(ok(a, "view-pond")).toBe(true);
      expect(ok(a, "invite")).toBe(false);
      expect(ok(a, "message-duck", thread("O"))).toBe(false);
    }
  });
});

const everything = (b: boolean) => Object.fromEntries(THREAD_ACTIONS.map((a) => [a, b])) as Record<string, boolean>;
const onlyWatching = { ...everything(false), "view-thread": true, "request-diff": true };
const talks = { ...onlyWatching, "message-duck": true, "answer-question": true, "request-diff": true };

describe("thread authority: role x action x starter x private", () => {
  const rows: Array<[string, Actor, Record<string, boolean>]> = [
    // Approving edits, shell and destructive actions, pushing and Stop are the Owner's on every Duck in the Pond.
    ["owner (not the starter)", owner, { ...everything(true), "set-private": false }],
    ["member (not the starter)", other, talks],
    ["viewer", viewer, onlyWatching],
    // A Member who started a Duck (their own Mac, or asked for on the Owner's) still never approves or stops.
    ["member who is the starter", member, { ...talks, "set-private": true }],
  ];
  for (const [who, a, expected] of rows) {
    it(`${who} on an open thread`, () => {
      for (const action of THREAD_ACTIONS) {
        expect(ok(a, action, thread("M")), `${who} ${action}`).toBe(expected[action]);
      }
    });
  }
  it("a private thread is the starter's alone, for every role", () => {
    for (const a of [owner, other, viewer]) {
      for (const action of THREAD_ACTIONS) expect(ok(a, action, thread("M", true)), action).toBe(false);
      expect(can(a, "view-thread", thread("M", true))).toEqual({ ok: false, reason: "no such thread" });
    }
    for (const action of ["view-thread", "set-private", "message-duck", "answer-question", "request-diff"] as const) {
      expect(ok(member, action, thread("M", true))).toBe(true);
    }
  });
  it("the Owner approves edits and stops on every Duck, including one a Member started; a Member and a Viewer never", () => {
    const acts = ["approve-edit", "approve-shell", "approve-destructive", "push-git", "stop"] as const;
    for (const action of acts) {
      expect(ok(owner, action, thread("M")), `owner ${action}`).toBe(true);
      expect(ok(owner, action, thread("O")), `owner ${action} on their own`).toBe(true);
      expect(ok(member, action, thread("M")), `starting member ${action}`).toBe(false);
      expect(ok(other, action, thread("M")), `member ${action}`).toBe(false);
      expect(ok(viewer, action, thread("M")), `viewer ${action}`).toBe(false);
    }
  });
  it("an agent never approves, pushes or stops, even for its starter", () => {
    const agent: Actor = { kind: "agent", memberId: "M", role: "member" };
    for (const a of ["approve-edit", "approve-shell", "approve-destructive", "push-git", "stop"] as const) {
      expect(ok(agent, a, thread("M"))).toBe(false);
    }
    expect(ok(agent, "message-duck", thread("M"))).toBe(true);
  });
  it("a thread action without a thread is refused", () => {
    expect(ok(owner, "message-duck")).toBe(false);
  });
  it("names fixed reasons", () => {
    expect(can(viewer, "message-duck", thread("M"))).toEqual({ ok: false, reason: "viewers only watch" });
    expect(can(member, "approve-shell", thread("M"))).toEqual({ ok: false, reason: "Only the Owner can do that." });
  });
});

describe("roles", () => {
  it("there is no per-Member switch: caps come from the role alone, and a Member's start waits for the Owner", () => {
    expect(capsOf("member")).toEqual({ see: true, diffs: true, message: true, answer: true, start: true });
    expect(capsOf("viewer")).toEqual({ see: true, diffs: true, message: false, answer: false, start: false });
    expect(capsOf("owner").start).toBe(true);
  });
  it("a Viewer cannot post, message, answer or start anything", () => {
    for (const a of ["start-thread", "message-duck", "answer-question"] as const) {
      expect(ok(viewer, a, thread("O")), a).toBe(false);
    }
  });
  it("a Member messages and answers on a Duck that is not Private, and never reaches a Private one", () => {
    expect(ok(member, "message-duck", thread("O"))).toBe(true);
    expect(ok(member, "answer-question", thread("O"))).toBe(true);
    expect(ok(member, "message-duck", thread("O", true))).toBe(false);
    expect(ok(viewer, "view-thread", thread("O", true))).toBe(false);
  });
});

describe("holds over a store", () => {
  let rtdb: FakeRtdb;
  let url: string;
  const dirs: string[] = [];
  beforeAll(async () => {
    rtdb = new FakeRtdb();
    url = await rtdb.start();
  });
  afterAll(async () => {
    await rtdb.stop();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  const mac = (name: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-perm-"));
    dirs.push(dir);
    const service = new FlotillaService({
      store: new RtdbRest(url),
      supportDir: dir,
      account: named(name),
      nest: name + "-mac",
    });
    return { service, dir };
  };
  async function joinAs(A: ReturnType<typeof mac>, B: ReturnType<typeof mac>, pondId: string, role: Role) {
    await admitMember(A.service, B.service, pondId, role as "member" | "viewer");
    await B.service.refresh(pondId);
  }

  it("regression: a viewer cannot hold a question against the people who can answer it", async () => {
    const A = mac("Sibhi2");
    const V = mac("Vera2");
    const pond = await A.service.createPond({ name: "P2", projectId: "proj-P2" });
    await joinAs(A, V, pond.id, "viewer");
    await expect(V.service.hold(pond.id, "q1")).rejects.toThrow(/read but not send/);

    // A hold document signed by the viewer's own key is not honoured either.
    const p = JSON.parse(fs.readFileSync(path.join(V.dir, "flotilla", "ponds.json"), "utf8")).ponds[pond.id];
    const identity = JSON.parse(fs.readFileSync(path.join(V.dir, "flotilla", "identity.json"), "utf8")).identity;
    const docPath = `channels/${pond.id}/holds/q1`;
    const hold = { requestId: "q1", by: V.service.me.id, byName: "Vera", until: Date.now() + 30_000 };
    const box = `${p.current}.${sealAt(p.keys[String(p.current)], docPath, hold)}`;
    await new RtdbRest(url).set(docPath, {
      box,
      sig: signText(identity.privateKey, signedText(docPath, box)),
      device: V.service.me.id,
      at: Date.now(),
    });
    expect(await A.service.heldBy(pond.id, "q1")).toBeNull();
    expect((await A.service.hold(pond.id, "q1")).ok).toBe(true);
  });
});

describe("Pond policy: decide(actor, action, ctx, policy)", () => {
  const room: PondPolicy = { reachDucks: "room", startDucks: "room" };
  const pol = (reachDucks: PondPolicy["reachDucks"], startDucks: PondPolicy["startDucks"]): PondPolicy => ({
    reachDucks,
    startDucks,
  });
  const REACH = ["room", "direct"] as const;
  const START = ["room", "members-approval", "members"] as const;

  it("defaults are Room first: reachDucks room, startDucks room", () => {
    expect(DEFAULT_POLICY).toEqual({ reachDucks: "room", startDucks: "room" });
    expect(readPolicy(undefined)).toEqual(DEFAULT_POLICY);
    expect(readPolicy({ reachDucks: "nonsense", startDucks: 4 })).toEqual(DEFAULT_POLICY);
  });

  it("the Owner's actions are the Owner's alone, under every policy", () => {
    const ownerOnly = [
      "invite",
      "remove-member",
      "change-role",
      "rename-pond",
      "delete-pond",
      "approve-start",
      "set-policy",
    ] as const;
    for (const reach of REACH) {
      for (const start of START) {
        for (const action of ownerOnly) {
          expect(ok(owner, action, {}, pol(reach, start)), `owner ${action}`).toBe(true);
          expect(ok(member, action, {}, pol(reach, start)), `member ${action}`).toBe(false);
          expect(ok(viewer, action, {}, pol(reach, start)), `viewer ${action}`).toBe(false);
        }
      }
    }
    expect(can(member, "set-policy", {}, room)).toEqual({ ok: false, reason: "Only the Owner can do that." });
  });

  it("a Viewer reads only: no Room post, no Task, no Duck, no message, under every policy", () => {
    for (const reach of REACH) {
      for (const start of START) {
        for (const action of ["post-room", "make-task", "start-duck", "start-thread"] as const) {
          expect(ok(viewer, action, {}, pol(reach, start)), `${reach}/${start} ${action}`).toBe(false);
        }
        expect(ok(viewer, "message-duck", thread("O"), pol(reach, start))).toBe(false);
        expect(ok(viewer, "view-pond", {}, pol(reach, start))).toBe(true);
      }
    }
  });

  it("post-room: Owner and Member post in the Room under every policy", () => {
    for (const reach of REACH) {
      for (const start of START) {
        expect(ok(owner, "post-room", {}, pol(reach, start))).toBe(true);
        expect(ok(member, "post-room", {}, pol(reach, start))).toBe(true);
      }
    }
  });

  it("message-duck: a Member's direct message is refused under reachDucks room, allowed under direct", () => {
    expect(can(member, "message-duck", thread("O"), pol("room", "room"))).toEqual({
      ok: false,
      reason: TALK_IN_ROOM,
    });
    expect(ok(member, "message-duck", thread("O"), pol("direct", "room"))).toBe(true);
    // The Owner is never held back, and neither is a Member on a Duck they started themselves.
    expect(ok(owner, "message-duck", thread("M"), pol("room", "room"))).toBe(true);
    expect(ok(member, "message-duck", thread("M"), pol("room", "room"))).toBe(true);
    // Answering a Duck's question is not reaching it: it stays open.
    expect(ok(member, "answer-question", thread("O"), pol("room", "room"))).toBe(true);
  });

  it("start-duck: refused directly under room, approval under members-approval, free under members; the Room's decider always may", () => {
    const direct = (policy: PondPolicy) => can(member, "start-duck", { via: "direct" }, policy);
    expect(direct(pol("room", "room"))).toEqual({ ok: false, reason: START_FROM_ROOM });
    expect(direct(pol("direct", "members-approval"))).toEqual({ ok: true, approval: true });
    expect(direct(pol("direct", "members"))).toEqual({ ok: true });
    // No `via` is a direct ask.
    expect(can(member, "start-duck", {}, pol("room", "room")).ok).toBe(false);
    const viaRoom = (policy: PondPolicy) => can(member, "start-duck", { via: "room" }, policy);
    expect(viaRoom(pol("room", "room"))).toEqual({ ok: true });
    expect(viaRoom(pol("room", "members-approval"))).toEqual({ ok: true, approval: true });
    expect(viaRoom(pol("room", "members"))).toEqual({ ok: true });
    for (const start of START) {
      expect(can(owner, "start-duck", { via: "direct" }, pol("room", start))).toEqual({ ok: true });
    }
  });

  it("make-task: a Member's Task waits only under members-approval", () => {
    expect(can(member, "make-task", {}, pol("room", "room"))).toEqual({ ok: true });
    expect(can(member, "make-task", {}, pol("room", "members-approval"))).toEqual({ ok: true, approval: true });
    expect(can(member, "make-task", {}, pol("room", "members"))).toEqual({ ok: true });
    expect(can(owner, "make-task", {}, pol("room", "members-approval"))).toEqual({ ok: true });
  });

  it("per-person overrides win over the Pond's setting, for that person only", () => {
    const policy: PondPolicy = {
      reachDucks: "room",
      startDucks: "room",
      overrides: { M: { reachDucks: "direct", startDucks: "members" }, N: { startDucks: "members-approval" } },
    };
    expect(ok(member, "message-duck", thread("O"), policy)).toBe(true);
    expect(ok(other, "message-duck", thread("O"), policy)).toBe(false);
    expect(can(member, "start-duck", { via: "direct" }, policy)).toEqual({ ok: true });
    expect(can(other, "start-duck", { via: "direct" }, policy)).toEqual({ ok: true, approval: true });
    // The other way round: the Pond is open, one person is held to the Room.
    const open: PondPolicy = { reachDucks: "direct", startDucks: "members", overrides: { M: { reachDucks: "room" } } };
    expect(ok(member, "message-duck", thread("O"), open)).toBe(false);
    expect(ok(other, "message-duck", thread("O"), open)).toBe(true);
    expect(effectivePolicy(policy, "N")).toEqual({ reachDucks: "room", startDucks: "members-approval" });
    expect(effectivePolicy(policy, "nobody")).toEqual({ reachDucks: "room", startDucks: "room" });
    // An override cannot lift what only the Owner may do, nor a Viewer's read-only place.
    const wide = { reachDucks: "direct", startDucks: "members" } as const;
    const lifted: PondPolicy = { ...room, overrides: { M: wide, V: wide } };
    expect(ok(member, "set-policy", {}, lifted)).toBe(false);
    expect(ok(member, "approve-edit", thread("O"), lifted)).toBe(false);
    expect(ok({ ...viewer, memberId: "V" }, "message-duck", thread("O"), lifted)).toBe(false);
    expect(ok({ ...viewer, memberId: "V" }, "start-duck", { via: "direct" }, lifted)).toBe(false);
  });

  it("an agent is inside the Pond: reachDucks does not hold it, and it never approves", () => {
    const agent: Actor = { kind: "agent", memberId: "M", role: "member" };
    expect(ok(agent, "message-duck", thread("O"), room)).toBe(true);
    expect(ok(agent, "approve-edit", thread("O"), room)).toBe(false);
    expect(ok(agent, "set-policy", {}, room)).toBe(false);
  });

  it("every action is decided for every role under every policy (the matrix has no hole)", () => {
    const actions: Action[] = [...POND_ACTIONS, ...THREAD_ACTIONS];
    for (const a of [owner, member, other, viewer]) {
      for (const action of actions) {
        for (const policy of [room, DIRECT, pol("direct", "members")]) {
          const verdict = decide(a, action, thread("O"), policy);
          expect(typeof verdict.ok, `${a.role} ${action}`).toBe("boolean");
          if (!verdict.ok) expect(verdict.reason.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("me.can: every action is true or the sentence that says why not", () => {
    const m = canMap(member, room);
    expect(m["post-room"]).toBe(true);
    expect(m["message-duck"]).toBe(TALK_IN_ROOM);
    expect(m["start-duck"]).toBe(START_FROM_ROOM);
    expect(m["set-policy"]).toBe("Only the Owner can do that.");
    expect(canMap(viewer, room)["post-room"]).toBe("viewers only watch");
    for (const action of CAN_ACTIONS) expect(canMap(owner, room)[action], action).toBe(true);
    // A person with an override reads their own answer.
    const policy: PondPolicy = { ...room, overrides: { M: { reachDucks: "direct" } } };
    expect(canMap(member, policy)["message-duck"]).toBe(true);
    expect(canMap(other, policy)["message-duck"]).toBe(TALK_IN_ROOM);
  });

  it("the per-person view says which setting is their own", () => {
    const policy: PondPolicy = { ...room, overrides: { M: { reachDucks: "direct" } } };
    expect(memberPolicyView(policy, "M")).toEqual({
      reachDucks: "direct",
      startDucks: "room",
      custom: { reachDucks: true, startDucks: false },
    });
    expect(memberPolicyView(policy, "N").custom).toEqual({ reachDucks: false, startDucks: false });
  });

  it("readPolicy keeps only well-formed overrides", () => {
    const read = readPolicy({
      reachDucks: "direct",
      startDucks: "members",
      overrides: { M: { reachDucks: "room", junk: 1 }, N: { reachDucks: "bad" }, O: "x", P: null },
    });
    expect(read).toEqual({ reachDucks: "direct", startDucks: "members", overrides: { M: { reachDucks: "room" } } });
  });
});
