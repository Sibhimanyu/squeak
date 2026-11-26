import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { FlotillaBridge, type BridgeOptions } from "./bridge.js";
import { randomId, sealAt, signedText, signText } from "./crypto.js";
import { FakeHost, session } from "./journey-support.js";
import { admitMember } from "./admit-member.test-fixture.js";
import { named } from "./named-account.test-fixture.js";
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
function mac(name: string, options: BridgeOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-roles-"));
  dirs.push(dir);
  const service = new FlotillaService({
    store: new RtdbRest(url),
    supportDir: dir,
    account: named(name),
    nest: name + "-mac",
  });
  const host = new FakeHost();
  const bridge = new FlotillaBridge(service, host, { flushMs: 60_000, ...options });
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
  await admitMember(A.service, who.service, pondId, role);
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

describe("Viewer, Member and the Owner", () => {
  let A: Mac;
  let B: Mac;
  let V: Mac;
  let pondId = "";
  let threadId = "";
  let privateId = "";
  const startedChats: Array<{ projectId: string; text: string; permissionMode: string }> = [];

  beforeAll(async () => {
    let next = 0;
    let owner: Mac | null = null;
    A = mac("Sibhi2", {
      startChat: async (projectId, spec) => {
        startedChats.push({ projectId, text: spec.text, permissionMode: spec.permissionMode });
        const id = `n${++next}`;
        owner!.host.sessions.set(id, session(id, { title: "New chat" }));
        return { sessionId: id };
      },
    });
    owner = A;
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

  it("a Member's Duck waits for the Owner: recorded with who asked and the first message, nothing started", async () => {
    const asked = { text: "Fix the login bug", title: "Login bug", agent: "claude" as const, model: "m" };
    const { requestId, ownerName } = await B.service.requestStart(pondId, asked);
    expect(ownerName).toBe("Sibhi2");
    // The Member sees it wait, without the message body.
    const mine = (await B.service.view(pondId)).starts!;
    expect(mine).toEqual([expect.objectContaining({ requestId, title: "Login bug", mine: true })]);
    expect(mine[0]).not.toHaveProperty("text");
    await A.bridge.runCommands(pondId); // the queued ask is applied: recorded as waiting
    expect(startedChats).toEqual([]);
    expect(A.service.ownThreads().some((t) => t.thread.sessionId.startsWith("n"))).toBe(false);
    // The Owner sees who asked and what, to Approve or Decline.
    expect((await A.service.view(pondId)).starts).toEqual([
      expect.objectContaining({
        requestId,
        name: "Aarav2",
        title: "Login bug",
        text: "Fix the login bug",
        mine: false,
      }),
    ]);
    // A Member and a Viewer cannot decide it, by the service or the bridge.
    for (const who of [B, V]) {
      await expect(who.service.takeStart(pondId, requestId)).rejects.toThrow(/Only an owner/);
      await expect(who.bridge.approveStart(pondId, requestId)).rejects.toThrow(/Only an owner/);
      await expect(who.bridge.declineStart(pondId, requestId)).rejects.toThrow(/Only an owner/);
    }
    expect((await A.service.view(pondId)).starts).toHaveLength(1);
  });

  it("Approve starts the Duck through the normal path with the first message; the Member then sees the Duck", async () => {
    const [waiting] = (await A.service.view(pondId)).starts!;
    await A.bridge.approveStart(pondId, waiting!.requestId);
    expect(startedChats).toEqual([{ projectId: "p-roles2", text: "Fix the login bug", permissionMode: "default" }]);
    expect(A.host.notes).toContain("Aarav2 started this thread.");
    expect((await A.service.view(pondId)).starts).toBeUndefined();
    await B.service.refresh(pondId);
    const view = await B.service.view(pondId);
    expect(view.starts).toBeUndefined();
    expect(view.threads.find((t) => t.requester?.requestId === waiting!.requestId)).toMatchObject({
      title: "Login bug",
    });
    // Approving twice, or a request nobody made, is a plain 404.
    await expect(A.bridge.approveStart(pondId, waiting!.requestId)).rejects.toThrow(/no longer waiting/);
  });

  it("Decline tells the Member in one line and starts nothing", async () => {
    const { requestId } = await B.service.requestStart(pondId, {
      text: "Rewrite everything",
      title: "Rewrite",
      agent: "codex",
      model: "m",
    });
    await A.bridge.runCommands(pondId);
    await A.bridge.declineStart(pondId, requestId);
    expect(startedChats).toHaveLength(1);
    expect((await A.service.view(pondId)).starts).toBeUndefined();
    B.service.noteAnswered(pondId, [requestId]);
    const view = await B.service.view(pondId);
    expect(view.starts).toBeUndefined();
    // The Owner's Mac keeps the line and says it in the Room (room-sync.test.ts): the Member stops saying "Waiting" from that.
    const line = (await A.service.view(pondId)).ripples.find((r) => r.ref === requestId)!;
    expect(`${line.actorName} ${line.text}`).toBe('Aarav2 declined the duck "Rewrite"');
  });

  it("a Member made Viewer loses their waiting Ducks: they cannot be approved", async () => {
    const { requestId } = await B.service.requestStart(pondId, { text: "later", agent: "claude", model: "m" });
    await A.bridge.runCommands(pondId);
    expect((await A.service.view(pondId)).starts).toHaveLength(1);
    await A.service.changeRole(pondId, B.service.me.id, "viewer");
    expect((await A.service.view(pondId)).starts).toBeUndefined();
    await expect(A.bridge.approveStart(pondId, requestId)).rejects.toThrow(/no longer a member/);
    await A.service.changeRole(pondId, B.service.me.id, "member");
    expect(startedChats).toHaveLength(1);
  });

  it("approving edits and Stop are the Owner's alone, on every Duck: a Member's command for them is refused", async () => {
    const mineId = A.service.ownThreads()[0]!.threadId;
    for (const kind of ["approve", "stop"]) {
      await rawCommand(B, pondId, { kind, threadId: mineId, requestId: "x" });
    }
    expect(await A.bridge.runCommands(pondId)).toEqual([
      expect.objectContaining({ ok: false }),
      expect.objectContaining({ ok: false }),
    ]);
    expect(A.host.responded).toEqual([]);
  });

  it("only the Owner changes roles; there is no per-Member switch to change", async () => {
    await expect(B.service.changeRole(pondId, V.service.me.id, "member")).rejects.toThrow(/Only an owner/);
    expect(await A.service.view(pondId)).toMatchObject({
      members: expect.not.arrayContaining([expect.objectContaining({ canStartTasks: expect.anything() })]),
    });
  });

  it("a role change lands on the next read", async () => {
    await A.service.changeRole(pondId, B.service.me.id, "viewer");
    await B.service.refresh(pondId);
    expect((await B.service.view(pondId)).me).toMatchObject({ role: "viewer", caps: { message: false, start: false } });
    await A.service.changeRole(pondId, B.service.me.id, "member");
    await B.service.refresh(pondId);
    expect((await B.service.view(pondId)).me).toMatchObject({ role: "member", caps: { message: true, start: true } });
  });
});
