import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { FlotillaBridge } from "./bridge.js";
import { randomId, sealAt, signedText, signText } from "./crypto.js";
import { FakeHost, session } from "./journey-support.js";
import { named, verifying } from "./named-account.test-fixture.js";
import { FlotillaService } from "./service.js";

// Roles are Owner, Member and Viewer (docs/ponds.md, "Who can do what"); Ducks that exist before the first invite are
// Private. These are the host-level rules of issue #125.
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
function mac(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-roles-"));
  dirs.push(dir);
  const service = new FlotillaService({
    store: verifying(new RtdbRest(url)),
    supportDir: dir,
    account: named(name),
    nest: name + "-mac",
    inviteLinkBase: "https://x.test/join",
  });
  const host = new FakeHost();
  const bridge = new FlotillaBridge(service, host, { flushMs: 60_000 });
  bridge.start();
  return { dir, service, host, bridge };
}

async function rawCommand(who: Mac, pondId: string, body: Record<string, unknown>): Promise<void> {
  const identity = JSON.parse(fs.readFileSync(path.join(who.dir, "flotilla", "identity.json"), "utf8")).identity;
  const pond = JSON.parse(fs.readFileSync(path.join(who.dir, "flotilla", "ponds.json"), "utf8")).ponds[pondId];
  const id = randomId(12);
  const docPath = `channels/${pondId}/tcmds/${id}`;
  const now = Date.now();
  const cmd = { id, issuedAt: now, expiresAt: now + 60_000, nonce: randomId(12), ...body };
  const box = `${pond.current}.${sealAt(pond.keys[String(pond.current)], docPath, cmd)}`;
  await new RtdbRest(url).set(docPath, {
    box,
    sig: signText(identity.privateKey, signedText(docPath, box)),
    device: who.service.me.id,
    at: now,
  });
}

async function admit(A: Mac, pondId: string, who: Mac, role: "member" | "viewer"): Promise<void> {
  await who.service.join((await A.service.invite(pondId, role)).code);
  for (const j of (await A.service.view(pondId)).joins)
    await A.service.decideJoin(pondId, j.requestId, { approve: true });
  await who.service.refresh(pondId);
}

describe("Ducks that exist before a Pond's first invite start Private", () => {
  let A: Mac;
  let B: Mac;
  let pondId = "";
  let oldId = "";

  beforeAll(async () => {
    A = mac("Sibhi");
    B = mac("Aarav");
    // A pond published with nobody invited yet: the Ducks shared in it so far are the Owner's alone.
    pondId = (await A.service.createPond({ name: "Site", projectId: "p-roles" })).id;
    A.host.sessions.set("old", session("old", { title: "Old chat" }));
    oldId = (await A.bridge.share(pondId, "old")).id;
    expect(A.service.localThread(pondId, oldId)?.private).toBe(false);
  });

  it("the first invite sets them Private; a Member never reads them", async () => {
    await admit(A, pondId, B, "member");
    expect(A.service.localThread(pondId, oldId)?.private).toBe(true);
    expect((await A.service.threads(pondId)).some((t) => t.id === oldId)).toBe(true); // the Owner still sees it
    await B.service.refresh(pondId);
    expect((await B.service.threads(pondId)).map((t) => t.id)).not.toContain(oldId);
    expect(await new RtdbRest(url).list(`channels/${pondId}/threads`)).toEqual([]);
  });

  it("a Duck shared after the first invite is visible, and making an old one visible is one call", async () => {
    A.host.sessions.set("new", session("new", { title: "New chat" }));
    const fresh = (await A.bridge.share(pondId, "new")).id;
    await B.service.refresh(pondId);
    expect((await B.service.threads(pondId)).map((t) => t.id)).toEqual([fresh]);
    await A.service.setThreadPrivate(pondId, oldId, false);
    await B.service.refresh(pondId);
    expect((await B.service.threads(pondId)).map((t) => t.id).sort()).toEqual([fresh, oldId].sort());
  });

  it("a second invite does not hide Ducks again", async () => {
    const C = mac("Chris");
    await admit(A, pondId, C, "viewer");
    expect(A.service.localThread(pondId, oldId)?.private).toBe(false);
  });
});

describe("Viewer, Member and the Owner's switch", () => {
  let A: Mac;
  let B: Mac;
  let V: Mac;
  let pondId = "";
  let threadId = "";
  let privateId = "";

  beforeAll(async () => {
    A = mac("Sibhi2");
    B = mac("Aarav2");
    V = mac("Vera2");
    pondId = (await A.service.createPond({ name: "P", projectId: "p-roles2" })).id;
    await admit(A, pondId, B, "member");
    await admit(A, pondId, V, "viewer");
    A.host.sessions.set("s1", session("s1"));
    A.host.sessions.set("s2", session("s2", { title: "Secret" }));
    threadId = (await A.bridge.share(pondId, "s1")).id;
    privateId = (await A.bridge.share(pondId, "s2", { private: true })).id;
    await B.service.refresh(pondId);
    await V.service.refresh(pondId);
  });

  it("a Viewer cannot post, message or start anything, by the client or by hand", async () => {
    expect(await V.bridge.message(pondId, threadId, "hi")).toMatchObject({ ok: false, state: "refused" });
    await expect(V.service.requestStart(pondId, { text: "hi", agent: "claude", model: "m" })).rejects.toThrow(
      /read but not send/,
    );
    await rawCommand(V, pondId, { kind: "message", threadId, text: "forged" });
    await rawCommand(V, pondId, { kind: "start", threadId: "", text: "forged", agent: "claude", model: "m" });
    expect(await A.bridge.runCommands(pondId)).toEqual([
      expect.objectContaining({ ok: false, reason: "Viewers can read but not send." }),
      expect.objectContaining({ ok: false, reason: "Viewers can read but not send." }),
    ]);
    expect(A.host.sent.map((s) => s.text)).not.toContain("forged");
  });

  it("a Member messages and answers, but Private Ducks are never returned to a Member or a Viewer", async () => {
    expect((await B.bridge.message(pondId, threadId, "hello")).ok).toBe(true);
    expect(await A.bridge.runCommands(pondId)).toEqual([expect.objectContaining({ ok: true, kind: "message" })]);
    for (const who of [B, V]) {
      expect((await who.service.threads(pondId)).map((t) => t.id)).toEqual([threadId]);
      expect(JSON.stringify(await who.service.view(pondId))).not.toContain("Secret");
    }
    await rawCommand(B, pondId, { kind: "message", threadId: privateId, text: "peek" });
    expect(await A.bridge.runCommands(pondId)).toEqual([
      expect.objectContaining({ ok: false, reason: "that thread is private" }),
    ]);
  });

  it("a Member without Can start Tasks cannot start a Duck; with it the start goes to the Owner's Mac", async () => {
    const asked = { text: "go", agent: "claude", model: "m" };
    expect((await A.service.view(pondId)).members.find((m) => m.id === B.service.me.id)).toMatchObject({
      role: "member",
      canStartTasks: false,
      caps: { start: false },
    });
    await expect(B.service.requestStart(pondId, asked)).rejects.toThrow(/waits for the Owner/);
    await rawCommand(B, pondId, { kind: "start", threadId: "", ...asked });
    expect(await A.bridge.runCommands(pondId)).toEqual([
      expect.objectContaining({ ok: false, reason: "That waits for the Owner's approval." }),
    ]);

    await A.service.setCanStartTasks(pondId, B.service.me.id, true);
    await B.service.refresh(pondId);
    await expect(B.service.requestStart(pondId, asked)).resolves.toBeTruthy();
  });

  it("only the Owner changes roles and the switch; a Viewer has no switch", async () => {
    await expect(B.service.changeRole(pondId, V.service.me.id, "member")).rejects.toThrow(/Only an owner/);
    await expect(B.service.setCanStartTasks(pondId, B.service.me.id, true)).rejects.toThrow(/Only an owner/);
    await expect(A.service.setCanStartTasks(pondId, V.service.me.id, true)).rejects.toThrow(/Only a member/);
  });

  it("a role change lands on the next read, and a Viewer made Member again starts with the switch off", async () => {
    await A.service.changeRole(pondId, B.service.me.id, "viewer");
    await B.service.refresh(pondId);
    expect((await B.service.view(pondId)).me).toMatchObject({ role: "viewer", caps: { message: false, start: false } });
    await A.service.changeRole(pondId, B.service.me.id, "member");
    await B.service.refresh(pondId);
    expect((await B.service.view(pondId)).me).toMatchObject({ role: "member", caps: { message: true, start: false } });
  });
});
