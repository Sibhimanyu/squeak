import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RtdbRest } from "../remote/rtdb-rest.js";
import { FakeRtdb } from "../remote/fake-rtdb.js";
import { FakeHost, session } from "./journey-support.js";
import { FlotillaBridge } from "./bridge.js";
import { randomId, sealAt, signedText, signText } from "./crypto.js";
import { FlotillaService, type FlotillaOptions } from "./service.js";
import { admitMember } from "./admit-member.test-fixture.js";
import { named } from "./named-account.test-fixture.js";

// The stashed own-thread mode (docs/ponds.md): these tests exercise it, so it is on here.
process.env.SQUEAK_POND_OWN_THREADS = "on";

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

type Mac = ReturnType<typeof mac>;
function mac(name: string, nest: string | null = name + "-mac", extra: Partial<FlotillaOptions> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-"));
  dirs.push(dir);
  const service = new FlotillaService({
    store: new RtdbRest(url),
    supportDir: dir,
    account: named(name),
    nest,
    ...extra,
  });
  const host = new FakeHost();
  const bridge = new FlotillaBridge(service, host, { flushMs: 60_000 });
  bridge.start();
  return { dir, service, host, bridge, name };
}

/** A signed command built by hand, as a hostile or buggy member would. */
async function rawCommand(who: Mac, pondId: string, body: Record<string, unknown>, opts: { tamper?: boolean } = {}) {
  const identity = JSON.parse(fs.readFileSync(path.join(who.dir, "flotilla", "identity.json"), "utf8")).identity;
  const pond = JSON.parse(fs.readFileSync(path.join(who.dir, "flotilla", "ponds.json"), "utf8")).ponds[pondId];
  const id = randomId(12);
  const docPath = `channels/${pondId}/tcmds/${id}`;
  const now = Date.now();
  const cmd = { id, issuedAt: now, expiresAt: now + 60_000, nonce: randomId(12), ...body };
  const box = `${pond.current}.${sealAt(pond.keys[String(pond.current)], docPath, cmd)}`;
  const doc = { box, sig: signText(identity.privateKey, signedText(docPath, box)), device: who.service.me.id, at: now };
  if (opts.tamper) doc.box = box.slice(0, -4) + (box.endsWith("AAAA") ? "BBBB" : "AAAA");
  await new RtdbRest(url).set(docPath, doc);
  return { docPath, doc };
}

describe("the multiplayer journey: shared thread, then a member's own thread", () => {
  let A: Mac;
  let B: Mac;
  let pondId = "";
  let shared = "";
  let own = "";

  beforeAll(() => {
    A = mac("Sibhi");
    B = mac("Aarav");
  });

  it("1. create, publish and add a member: the member sees the pond", async () => {
    const pond = await A.service.createPond({
      name: "Site",
      projectId: "p1",
      gitRemote: "git@github.com:acme/site.git",
    });
    pondId = pond.id;
    await admitMember(A.service, B.service, pondId, "member");
    const view = await B.service.view(pondId);
    expect(view.me.role).toBe("member");
    expect(view.members.map((m) => m.name).sort()).toEqual(["Aarav", "Sibhi"]);
  });

  it("2. the member reads the owner's shared thread and messages it: the owner sees it in order with the author", async () => {
    A.host.sessions.set("a1", session("a1", { title: "Owner thread" }));
    A.host.say("a1", "user/text", { text: "Start" }, "user");
    shared = (await A.bridge.share(pondId, "a1")).id;
    await A.bridge.flush();
    const seen = (await B.service.threads(pondId)).find((t) => t.id === shared)!;
    expect(seen).toMatchObject({ mode: "shared", starterName: "Sibhi" });
    await B.bridge.message(pondId, shared, "first");
    await B.bridge.message(pondId, shared, "second");
    await A.bridge.runCommands(pondId);
    expect(A.host.sent.map((s) => [s.text, s.author?.name])).toEqual([
      ["first", "Aarav"],
      ["second", "Aarav"],
    ]);
  });

  it("3. the member answers the owner's question under a hold; the owner's answer then loses", async () => {
    A.host.ask("a1", "q1");
    await A.bridge.flush();
    expect(await B.bridge.hold(pondId, "q1")).toMatchObject({ ok: true });
    expect(await A.service.heldBy(pondId, "q1")).toMatchObject({ byName: "Aarav" });
    expect((await B.bridge.answer(pondId, shared, "q1", "3000")).ok).toBe(true);
    await A.bridge.runCommands(pondId);
    expect(A.host.responded.map((r) => r.requestId)).toEqual(["q1"]);
  });

  it("4. the member starts an own thread on their own Mac: the owner sees it live, as theirs, with its Nest", async () => {
    B.host.sessions.set("b1", session("b1", { title: "Aarav's thread" }));
    B.host.say("b1", "user/text", { text: "Do it" }, "user");
    own = (await B.bridge.share(pondId, "b1", { mode: "own" })).id;
    B.host.say("b1", "assistant", { message: { content: [{ type: "text", text: "On it." }] } });
    await B.bridge.flush();
    const seen = (await A.service.threads(pondId)).find((t) => t.id === own)!;
    expect(seen).toMatchObject({ mode: "own", starterName: "Aarav", nest: "Aarav-mac" });
    expect(seen.sessionId).toBeUndefined();
    const events = (await A.service.readEvents(pondId, own, 0)).events;
    expect(events.map((e) => e.type)).toContain("agent");
  });

  it("5. the owner messages the member's thread; it runs on the member's Mac, attributed; approvals stay with the starter", async () => {
    expect(await A.bridge.message(pondId, own, "Also add tests")).toMatchObject({ ok: true, state: "queued" });
    expect(await B.bridge.runCommands(pondId)).toEqual([expect.objectContaining({ ok: true, kind: "message" })]);
    expect(B.host.sent).toEqual([
      { id: "b1", text: "Also add tests", mode: "queue", author: { id: A.service.me.id, name: "Sibhi" } },
    ]);
    expect(A.host.sent).toHaveLength(2);
    await rawCommand(A, pondId, { kind: "approve", threadId: own, requestId: "x" });
    expect((await B.bridge.runCommands(pondId))[0]).toMatchObject({ ok: false });
    // The owner answers the member's question under a hold.
    B.host.ask("b1", "q2");
    await B.bridge.flush();
    expect(await A.bridge.hold(pondId, "q2")).toMatchObject({ ok: true });
    await A.bridge.answer(pondId, own, "q2", "4000");
    await B.bridge.runCommands(pondId);
    expect(B.host.responded.map((r) => r.requestId)).toEqual(["q2"]);
  });

  it("6. the owner restricts the member live: refused at the starter's Mac even if their client sends it", async () => {
    await A.service.changeRole(pondId, B.service.me.id, "viewer");
    // Their client is stopped early, calmly...
    expect(await B.bridge.message(pondId, shared, "still here")).toMatchObject({ ok: false, state: "refused" });
    // ...and a forged command is refused by the starter's host.
    await rawCommand(B, pondId, { kind: "message", threadId: shared, text: "forged" });
    expect(await A.bridge.runCommands(pondId)).toEqual([
      expect.objectContaining({ ok: false, reason: "Viewers can read but not send." }),
    ]);
    expect(A.host.sent.map((s) => s.text)).not.toContain("forged");
    const ripples = (await A.service.view(pondId)).ripples.map((r) => r.text);
    expect(ripples.some((r) => /made Aarav a viewer/.test(r))).toBe(true);
    await B.service.refresh(pondId);
    const mine = await B.service.view(pondId);
    expect(mine.me).toMatchObject({ role: "viewer", caps: { message: false, answer: false, start: false } });
    await A.service.changeRole(pondId, B.service.me.id, "member");
    expect((await B.bridge.message(pondId, shared, "back")).ok).toBe(true);
    await A.bridge.runCommands(pondId);
  });

  it("7. there is no per-Member switch: a Member is a Member, and their own thread stays shown", async () => {
    expect((await A.service.threads(pondId)).some((t) => t.id === own)).toBe(true);
    const you = (await B.service.view(pondId)).members.find((m) => m.you)!;
    expect(you).not.toHaveProperty("canStartTasks");
    expect(you.caps).toMatchObject({ message: true, answer: true });
  });

  it("9. the member leaves; the owner's Mac removes them and nothing new reads", async () => {
    await B.service.leave(pondId);
    await A.service.refresh(pondId);
    expect((await A.service.view(pondId)).members.map((m) => m.name)).toEqual(["Sibhi"]);
    A.host.sessions.set("a2", session("a2", { title: "After" }));
    await A.bridge.share(pondId, "a2");
    await A.bridge.flush();
  });
});

describe("a signed-in member", () => {
  it("is in the Pond, then messages a thread", async () => {
    const relay = {
      url: "https://relay.example/server/squeak_relay",
      issue: async () => ({ token: "t", expiresAt: 0 }),
      revoke: async () => undefined,
    };
    const account = named("Bea Lee", "bea@example.com");
    const location = { provider: "firebase", databaseUrl: "https://squeak-test-default-rtdb.firebaseio.com" };
    const A = mac("Owner", "Owner-mac", {
      relay: relay as never,
      account,
      location: location as never,
      storeFor: () => new RtdbRest(url),
    });
    const C = mac("Bea", "Bea-mac", { relay: relay as never, account, storeFor: () => new RtdbRest(url) });
    const pond = await A.service.createPond({
      name: "Docs",
      projectId: "p2",
      gitRemote: "git@github.com:acme/docs.git",
    });
    await admitMember(A.service, C.service, pond.id, "member");
    expect((await C.service.view(pond.id)).me.role).toBe("member");
    A.host.sessions.set("d1", session("d1", { title: "Docs thread" }));
    const thread = await A.bridge.share(pond.id, "d1");
    await A.bridge.flush();
    expect((await C.bridge.message(pond.id, thread.id, "hello")).ok).toBe(true);
    await A.bridge.runCommands(pond.id);
    expect(A.host.sent[0]).toMatchObject({ text: "hello", author: { name: "Bea Lee" } });
  });
});
