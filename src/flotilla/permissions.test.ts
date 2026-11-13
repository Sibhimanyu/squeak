import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { sealAt, signedText, signText } from "./crypto.js";
import {
  can,
  defaultGrant,
  readGrant,
  THREAD_ACTIONS,
  type Action,
  type Actor,
  type Context,
  type MachineGrant,
} from "./permissions.js";
import { FlotillaService } from "./service.js";
import type { Role } from "./types.js";

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
const onlyWatching = { ...everything(false), "view-thread": true };
const talks = { ...onlyWatching, message: true, "answer-question": true, "request-diff": true };

describe("thread authority: role x action x starter x private", () => {
  const rows: Array<[string, Actor, Record<string, boolean>]> = [
    ["owner (not the starter)", owner, talks],
    ["member (not the starter)", other, talks],
    ["viewer", viewer, onlyWatching],
    ["the starter", member, everything(true)],
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
    for (const action of THREAD_ACTIONS) expect(ok(member, action, thread("M", true))).toBe(true);
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
    expect(can(owner, "approve-shell", thread("M"))).toEqual({
      ok: false,
      reason: "Only the thread's starter can do that.",
    });
  });
});

describe("machine grants", () => {
  const grant = (over: Partial<MachineGrant> = {}): MachineGrant => ({
    ...defaultGrant("M"),
    allowAgents: true,
    maxAgents: 2,
    providers: ["claude"],
    ...over,
  });
  const nest = (g?: MachineGrant, extra: Record<string, unknown> = {}): Context => ({
    nest: { owner: "M", ...(g ? { grant: g } : {}), ...extra },
  });

  it("by default only the Nest's owner runs agents there", () => {
    expect(defaultGrant("M")).toMatchObject({ allowAgents: false, maxAgents: 0, providers: [], shell: "deny" });
    expect(ok(member, "run-agent", nest())).toBe(true);
    expect(ok(member, "run-shell", nest())).toBe(true);
    for (const a of [owner, other]) {
      expect(ok(a, "run-agent", nest())).toBe(false);
      expect(ok(a, "run-shell", nest())).toBe(false);
      expect(ok(a, "start-thread", nest())).toBe(false);
    }
    expect(can(other, "run-agent", nest())).toEqual({ ok: false, reason: "That machine's owner has not shared it." });
  });
  it("a grant lets others run its providers, up to its limit", () => {
    expect(ok(other, "run-agent", nest(grant(), { provider: "claude" }))).toBe(true);
    expect(ok(other, "run-agent", nest(grant(), { provider: "codex" }))).toBe(false);
    expect(ok(other, "run-agent", nest(grant(), { provider: "claude", runningForOthers: 1 }))).toBe(true);
    expect(ok(other, "run-agent", nest(grant(), { provider: "claude", runningForOthers: 2 }))).toBe(false);
    expect(ok(other, "run-agent", nest(grant({ allowAgents: false }), { provider: "claude" }))).toBe(false);
  });
  it("the owner's own machine ignores its own limits", () => {
    expect(ok(member, "run-agent", nest(grant({ maxAgents: 0 }), { provider: "codex", runningForOthers: 9 }))).toBe(
      true,
    );
  });
  it("shell follows the policy, and `ask` is not `allow`", () => {
    expect(ok(other, "run-shell", nest(grant({ shell: "allow" })))).toBe(true);
    expect(ok(other, "run-shell", nest(grant({ shell: "ask" })))).toBe(false);
    expect(ok(other, "run-shell", nest(grant({ shell: "deny" })))).toBe(false);
    expect(ok(other, "run-shell", nest(grant({ allowAgents: false, shell: "allow" })))).toBe(false);
  });
  it("viewers never run anything, granted or not", () => {
    expect(ok(viewer, "run-agent", nest(grant({ shell: "allow" }), { provider: "claude" }))).toBe(false);
    expect(ok(viewer, "run-shell", nest(grant({ shell: "allow" })))).toBe(false);
  });
  it("stopping what runs on a machine: its owner or the thread's starter", () => {
    const ctx: Context = { nest: { owner: "M" }, thread: { starter: "N", private: false } };
    expect(ok(member, "stop-remote", ctx)).toBe(true);
    expect(ok(other, "stop-remote", ctx)).toBe(true);
    expect(ok(owner, "stop-remote", ctx)).toBe(false);
    expect(ok(viewer, "stop-remote", ctx)).toBe(false);
  });
  it("readGrant drops anything out of shape", () => {
    expect(readGrant(grant())).toEqual(grant());
    expect(readGrant({ ...grant(), maxAgents: -1 })).toBeNull();
    expect(readGrant({ ...grant(), maxAgents: 1.5 })).toBeNull();
    expect(readGrant({ ...grant(), maxAgents: 999 })).toBeNull();
    expect(readGrant({ ...grant(), shell: "yes" })).toBeNull();
    expect(readGrant({ ...grant(), allowAgents: "true" })).toBeNull();
    expect(readGrant({ ...grant(), providers: ["Bad Name"] })).toBeNull();
    expect(readGrant(null)).toBeNull();
    expect(readGrant({ ...grant(), providers: ["claude", "claude"] })!.providers).toEqual(["claude"]);
  });
});

describe("grants and holds over a store", () => {
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
      displayName: name,
      nest: name + "-mac",
      inviteLinkBase: "https://x.test/join",
    });
    return { service, dir };
  };
  async function joinAs(A: ReturnType<typeof mac>, B: ReturnType<typeof mac>, pondId: string, role: Role) {
    await B.service.join((await A.service.invite(pondId, role as "member" | "viewer")).code, B.service.me.name);
    for (const j of (await A.service.view(pondId)).joins)
      await A.service.decideJoin(pondId, j.requestId, { approve: true });
    await B.service.refresh(pondId);
  }

  it("a Nest's owner writes its grant; default otherwise; nobody writes another's", async () => {
    const A = mac("Sibhi");
    const B = mac("Aarav");
    const pond = await A.service.createPond({ name: "P" });
    await joinAs(A, B, pond.id, "member");

    expect(await B.service.machineGrant(pond.id, A.service.me.id)).toMatchObject({
      allowAgents: false,
      owner: A.service.me.id,
    });
    const written = await A.service.setMachineGrant(pond.id, {
      allowAgents: true,
      maxAgents: 2,
      providers: ["claude"],
      shell: "ask",
    });
    expect(await B.service.machineGrant(pond.id, A.service.me.id)).toEqual(written);

    await B.service.setMachineGrant(pond.id, { allowAgents: true, maxAgents: 5, providers: ["codex"], shell: "allow" });
    expect(await A.service.machineGrant(pond.id, A.service.me.id)).toEqual(written);
    expect((await A.service.machineGrant(pond.id, B.service.me.id)).providers).toEqual(["codex"]);
    await expect(
      A.service.setMachineGrant(pond.id, { allowAgents: true, maxAgents: 500, providers: [], shell: "allow" }),
    ).rejects.toThrow(/not a machine grant/);

    // A grant document under A's id signed by B is not A's: it is ignored, A's own stays.
    const stolen = JSON.parse(fs.readFileSync(path.join(B.dir, "flotilla", "ponds.json"), "utf8")).ponds[pond.id];
    const identity = JSON.parse(fs.readFileSync(path.join(B.dir, "flotilla", "identity.json"), "utf8")).identity;
    const docPath = `channels/${pond.id}/grants/${A.service.me.id}`;
    const box = `${stolen.current}.${sealAt(stolen.keys[String(stolen.current)], docPath, { ...written, maxAgents: 20 })}`;
    await new RtdbRest(url).set(docPath, {
      box,
      sig: signText(identity.privateKey, signedText(docPath, box)),
      device: B.service.me.id,
      at: Date.now(),
    });
    expect(await A.service.machineGrant(pond.id, A.service.me.id)).toMatchObject({ allowAgents: false });
  });

  it("regression: a viewer cannot hold a question against the people who can answer it", async () => {
    const A = mac("Sibhi2");
    const V = mac("Vera2");
    const pond = await A.service.createPond({ name: "P2" });
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
