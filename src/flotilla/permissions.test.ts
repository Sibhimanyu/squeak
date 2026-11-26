import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { sealAt, signedText, signText } from "./crypto.js";
import { can, capsOf, THREAD_ACTIONS, type Action, type Actor, type Context } from "./permissions.js";
import { FlotillaService } from "./service.js";
import type { Role } from "./types.js";
import { named, verifying } from "./named-account.test-fixture.js";

const actor = (role: Role, memberId: string): Actor => ({ kind: "human", memberId, role });
const owner = actor("owner", "O");
const member = actor("member", "M");
const other = actor("member", "N");
const viewer = actor("viewer", "V");
const thread = (starter: string, isPrivate = false): Context => ({ thread: { starter, private: isPrivate } });
const ok = (a: Actor, action: Action, c: Context = {}) => can(a, action, c).ok;

describe("pond role", () => {
  it("only the owner invites, decides joins and removes members", () => {
    for (const a of ["invite", "decide-join", "remove-member"] as const) {
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
      expect(ok(a, "message", thread("O"))).toBe(false);
    }
  });
});

const everything = (b: boolean) => Object.fromEntries(THREAD_ACTIONS.map((a) => [a, b])) as Record<string, boolean>;
const onlyWatching = { ...everything(false), "view-thread": true, "request-diff": true };
const talks = { ...onlyWatching, message: true, "answer-question": true, "request-diff": true };

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
    for (const action of ["view-thread", "set-private", "message", "answer-question", "request-diff"] as const) {
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
    expect(ok(agent, "message", thread("M"))).toBe(true);
  });
  it("a thread action without a thread is refused", () => {
    expect(ok(owner, "message")).toBe(false);
  });
  it("names fixed reasons", () => {
    expect(can(viewer, "message", thread("M"))).toEqual({ ok: false, reason: "viewers only watch" });
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
    for (const a of ["start-thread", "message", "answer-question"] as const) {
      expect(ok(viewer, a, thread("O")), a).toBe(false);
    }
  });
  it("a Member messages and answers on a Duck that is not Private, and never reaches a Private one", () => {
    expect(ok(member, "message", thread("O"))).toBe(true);
    expect(ok(member, "answer-question", thread("O"))).toBe(true);
    expect(ok(member, "message", thread("O", true))).toBe(false);
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
      store: verifying(new RtdbRest(url)),
      supportDir: dir,
      account: named(name),
      nest: name + "-mac",
      inviteLinkBase: "https://x.test/join",
    });
    return { service, dir };
  };
  async function joinAs(A: ReturnType<typeof mac>, B: ReturnType<typeof mac>, pondId: string, role: Role) {
    await B.service.join((await A.service.invite(pondId, role as "member" | "viewer")).code);
    for (const j of (await A.service.view(pondId)).joins)
      await A.service.decideJoin(pondId, j.requestId, { approve: true });
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
