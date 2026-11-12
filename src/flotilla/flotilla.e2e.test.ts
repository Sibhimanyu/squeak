import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RtdbRest } from "../remote/rtdb-rest.js";
import { FakeRtdb } from "../remote/fake-rtdb.js";
import type { HostEvent } from "../native/host.js";
import type { MessageRow, RequestRow, Resolution, SessionRow } from "../native/types.js";
import { FlotillaBridge, type HostPort } from "./bridge.js";
import { openAt, randomId, sealAt, signedText, signText } from "./crypto.js";
import { FlotillaService } from "./service.js";
import { FlotillaError } from "./types.js";

class FakeHost extends EventEmitter implements HostPort {
  sessions = new Map<string, SessionRow>();
  messages: MessageRow[] = [];
  requests: RequestRow[] = [];
  sent: Array<{ id: string; text: string; mode: string; author?: { id: string; name: string } }> = [];
  responded: Array<{ requestId: string; resolution: Resolution }> = [];
  notes: string[] = [];
  guest = new Set<string>();
  onEvent(l: (e: HostEvent) => void) {
    this.on("event", l);
    return () => void this.off("event", l);
  }
  getSession = (id: string) => this.sessions.get(id) ?? null;
  messagesAfter = (id: string, seq: number) => this.messages.filter((m) => m.sessionId === id && m.seq > seq);
  openRequests = (id: string) => this.requests.filter((r) => r.sessionId === id && !r.resolvedAt);
  workspace = (id: string) => (id === "w1" ? { name: "ushuaia", branch: "feat/x" } : null);
  async send(id: string, text: string, o: { mode: "queue" | "steer"; author?: { id: string; name: string } }) {
    this.sent.push({ id, text, mode: o.mode, ...(o.author ? { author: o.author } : {}) });
    return { queued: false };
  }
  respond(requestId: string, resolution: Resolution) {
    this.responded.push({ requestId, resolution });
    const r = this.requests.find((x) => x.id === requestId)!;
    r.resolvedAt = "now";
    this.emit("event", { type: "request-resolved", sessionId: r.sessionId, requestId } satisfies HostEvent);
  }
  note(_id: string, text: string) {
    this.notes.push(text);
  }
  setGuestTurn(id: string, on: boolean) {
    if (on) this.guest.add(id);
    else this.guest.delete(id);
  }
  say(sessionId: string, kind: string, payload: unknown, role: "agent" | "user" = "agent") {
    const seq = this.messages.length + 1;
    const createdAt = new Date().toISOString();
    this.messages.push({ seq, sessionId, role, kind, payload, createdAt });
    this.emit("event", { type: "message", sessionId, seq, role, kind, payload, createdAt } satisfies HostEvent);
  }
  ask(sessionId: string, id: string) {
    const row: RequestRow = {
      id,
      sessionId,
      kind: "question",
      payload: {
        toolName: "AskUserQuestion",
        input: { questions: [{ question: "Which port?", options: [{ label: "3000" }, { label: "4000" }] }] },
      },
      createdAt: "now",
      resolvedAt: null,
      resolution: null,
    };
    this.requests.push(row);
    this.emit("event", { type: "request", sessionId, request: row } satisfies HostEvent);
  }
}

const session = (id: string, over: Partial<SessionRow> = {}): SessionRow => ({
  id,
  workspaceId: null,
  cwd: "/w",
  agent: "claude",
  agentSessionId: null,
  title: "Fix login",
  model: "m",
  effort: null,
  permissionMode: "default",
  status: "idle",
  createdAt: "",
  updatedAt: "",
  lastTurnEndedAt: null,
  prunedThrough: 0,
  ...over,
});

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
function mac(name: string, nest: string | null = name + "-mac") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-"));
  dirs.push(dir);
  const service = new FlotillaService({
    store: new RtdbRest(url),
    supportDir: dir,
    displayName: name,
    nest,
    inviteLinkBase: "https://x.test/join",
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

describe("two Macs over one store", () => {
  let A: Mac;
  let B: Mac;
  let V: Mac;
  beforeAll(() => {
    A = mac("Sibhi");
    B = mac("Aarav");
    V = mac("Vera");
  });
  let pondId = "";
  let threadId = "";
  const SID = "s1";

  it("creates a pond, invites, and a join waits for a person", async () => {
    const pond = await A.service.createPond({ name: "Website", gitRemote: "git@github.com:acme/site.git" });
    pondId = pond.id;
    const { link } = await A.service.invite(pondId, "member");
    expect(link).toContain("https://x.test/join#");
    expect(link).not.toContain("?");
    expect(await B.service.join(link!, "Aarav")).toEqual({ pondId, status: "pending" });
    await B.service.refresh(pondId);
    await expect(B.service.view(pondId)).rejects.toThrow(/waiting/);
    const view = await A.service.view(pondId);
    expect(view.joins).toHaveLength(1);
    expect(view.joins[0]!.name).toBe("Aarav");
    expect(view.members).toHaveLength(1);
    await V.service.join((await A.service.invite(pondId, "viewer")).code, "Vera");
  });

  it("an approval by the owner adds the member; nobody else can", async () => {
    await expect(B.service.decideJoin(pondId, "x", { approve: true })).rejects.toThrow();
    const joins = (await A.service.view(pondId)).joins;
    expect(joins).toHaveLength(2);
    for (const j of joins) await A.service.decideJoin(pondId, j.requestId, { approve: true });
    await B.service.refresh(pondId);
    await V.service.refresh(pondId);
    const view = await B.service.view(pondId);
    expect(view.members.map((m) => m.name).sort()).toEqual(["Aarav", "Sibhi", "Vera"]);
    expect(view.me.role).toBe("member");
    expect((await V.service.view(pondId)).me.role).toBe("viewer");
    expect((await A.service.view(pondId)).joins).toHaveLength(0);
  });

  it("shares a thread; events arrive in order and resume by seq", async () => {
    A.host.sessions.set(SID, session(SID, { workspaceId: "w1" }));
    A.host.say(SID, "user/text", { text: "Fix the login" }, "user");
    const thread = await A.bridge.share(pondId, SID);
    threadId = thread.id;
    A.host.say(SID, "assistant", {
      message: {
        content: [
          { type: "text", text: "Looking." },
          { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/a/login.ts" } },
        ],
      },
    });
    A.host.say(SID, "user", { message: { content: [{ type: "tool_result", tool_use_id: "tu1" }] } });
    A.host.ask(SID, "q1");
    await A.bridge.flush();
    const all = await B.service.readEvents(pondId, threadId, 0);
    expect(all.events.map((e) => e.type)).toEqual(["user", "state", "agent", "tool", "tool", "question"]);
    expect(all.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(all.events[0]).toMatchObject({ type: "user", by: A.service.me.id });
    expect(all.events[4]).toMatchObject({ type: "tool", label: "Read login.ts", state: "done" });
    expect((await B.service.readEvents(pondId, threadId, 4)).events.map((e) => e.seq)).toEqual([5, 6]);
    expect((await V.service.readEvents(pondId, threadId, 0)).events).toHaveLength(6);
    const seen = (await B.service.threads(pondId))[0]!;
    expect(seen).toMatchObject({ id: threadId, starterName: "Sibhi", state: "idle" });
    expect(seen.sessionId).toBeUndefined();
    expect(seen).toMatchObject({ workspace: "ushuaia", branch: "feat/x" });
    expect(seen.participants).toEqual([expect.objectContaining({ memberId: A.service.me.id, name: "Sibhi" })]);
  });

  it("a member's message reaches the starter's host, attributed, and is never auto-allowed", async () => {
    expect(await B.bridge.message(pondId, threadId, "Use port 4000")).toEqual({ ok: true, queued: true });
    expect(await A.bridge.runCommands(pondId)).toEqual([expect.objectContaining({ ok: true, kind: "message" })]);
    expect(A.host.sent).toEqual([
      { id: SID, text: "Use port 4000", mode: "queue", author: { id: B.service.me.id, name: "Aarav" } },
    ]);
    expect(A.host.notes).toContain("Aarav sent the next message.");
    expect(A.host.guest.has(SID)).toBe(true);
    A.host.say(SID, "user/text", { text: "Use port 4000" }, "user");
    await A.bridge.flush();
    const events = (await V.service.readEvents(pondId, threadId, 6)).events;
    expect(events[0]).toMatchObject({ type: "user", byName: "Aarav", text: "Use port 4000" });
    // Participants: the starter and Aarav, newest activity first, on the starter's view and on a member's.
    const mine = (await A.service.threads(pondId)).find((t) => t.id === threadId)!;
    expect(mine.participants!.map((p) => p.name)).toEqual(["Aarav", "Sibhi"]);
    await new Promise((r) => setTimeout(r, 50));
    const theirs = (await V.service.threads(pondId)).find((t) => t.id === threadId)!;
    expect(theirs.participants!.map((p) => p.name)).toEqual(["Aarav", "Sibhi"]);
    expect(theirs.participants![0]).toMatchObject({ memberId: B.service.me.id });
  });

  it("a viewer cannot send, and a forged viewer command is refused by the starter", async () => {
    await expect(V.service.sendCommand(pondId, threadId, { kind: "message", text: "hi" })).rejects.toThrow(/watch/);
    await rawCommand(V, pondId, { kind: "message", threadId, text: "let me in" });
    expect(await A.bridge.runCommands(pondId)).toEqual([
      expect.objectContaining({ ok: false, reason: "viewers only watch" }),
    ]);
    expect(A.host.sent).toHaveLength(1);
  });

  it("there is no approve or stop on the wire", async () => {
    for (const kind of ["approve", "stop", "interrupt", "deny"]) {
      await rawCommand(B, pondId, { kind, threadId, requestId: "q1" });
      expect(await A.bridge.runCommands(pondId)).toEqual([
        expect.objectContaining({ ok: false, reason: "not a command this Mac runs" }),
      ]);
    }
    expect(A.host.responded).toHaveLength(0);
    A.host.requests.push({
      id: "tool1",
      sessionId: SID,
      kind: "tool",
      payload: { toolName: "Bash", input: {} },
      createdAt: "",
      resolvedAt: null,
      resolution: null,
    });
    await rawCommand(B, pondId, { kind: "answer", threadId, requestId: "tool1", answer: "yes" });
    expect((await A.bridge.runCommands(pondId))[0]).toMatchObject({
      ok: false,
      reason: "only the starter approves an action",
    });
    expect(A.host.responded).toHaveLength(0);
    A.host.requests = A.host.requests.filter((r) => r.id !== "tool1");
  });

  it("tampered, replayed, expired and unknown-thread commands are refused", async () => {
    await rawCommand(B, pondId, { kind: "message", threadId, text: "x" }, { tamper: true });
    expect((await A.bridge.runCommands(pondId))[0]).toMatchObject({ ok: false, reason: "bad signature" });

    const good = await rawCommand(B, pondId, { kind: "message", threadId, text: "once" });
    expect((await A.bridge.runCommands(pondId))[0]).toMatchObject({ ok: true });
    await new RtdbRest(url).set(good.docPath, good.doc);
    expect((await A.bridge.runCommands(pondId))[0]).toMatchObject({ ok: false, reason: "already used" });
    expect(A.host.sent.filter((s) => s.text === "once")).toHaveLength(1);

    await rawCommand(B, pondId, { kind: "message", threadId, text: "late", expiresAt: Date.now() - 1 });
    expect((await A.bridge.runCommands(pondId))[0]).toMatchObject({ ok: false, reason: "expired" });
    await rawCommand(B, pondId, { kind: "message", threadId, text: "long", expiresAt: Date.now() + 11 * 60_000 });
    expect((await A.bridge.runCommands(pondId))[0]).toMatchObject({ ok: false, reason: "lives too long" });
    await rawCommand(B, pondId, { kind: "message", threadId: "other", text: "x" });
    expect(await A.bridge.runCommands(pondId)).toEqual([]);
    // That one is left for its starter; clear it so later passes are clean.
    for (const { id } of rtdb.tree.list(`channels/${pondId}/tcmds`)) rtdb.tree.delete(`channels/${pondId}/tcmds/${id}`);
  });

  it("a thread running without asking refuses other members' messages", async () => {
    A.host.sessions.set(SID, session(SID, { permissionMode: "bypassPermissions" }));
    await B.bridge.message(pondId, threadId, "do anything");
    expect((await A.bridge.runCommands(pondId))[0]).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/without asking/),
    });
    expect(A.host.sent.some((s) => s.text === "do anything")).toBe(false);
    A.host.sessions.set(SID, session(SID));
  });

  it("answers a question with a hold; the second answer is a 409", async () => {
    expect(await B.bridge.hold(pondId, "q1")).toMatchObject({ ok: true });
    await expect(A.bridge.answer(pondId, threadId, "q1", "3000")).rejects.toMatchObject({
      status: 409,
      extra: { heldBy: "Aarav" },
    });
    // A viewer cannot answer at all (permissions.ts): refused before the hold is even looked at.
    await expect(V.bridge.answer(pondId, threadId, "q1", "3000")).rejects.toMatchObject({ status: 403 });
    await B.bridge.answer(pondId, threadId, "q1", "4000");
    expect((await A.bridge.runCommands(pondId))[0]).toMatchObject({ ok: true, kind: "answer" });
    expect(A.host.responded).toEqual([
      { requestId: "q1", resolution: { decision: "allow", answers: { "Which port?": "4000" } } },
    ]);
    await A.bridge.flush();
    await expect(B.bridge.answer(pondId, threadId, "q1", "3000")).rejects.toMatchObject({ status: 409 });
  });

  it("a private thread is hidden and its events go", async () => {
    await A.service.setThreadPrivate(pondId, threadId, true);
    expect((await B.service.threads(pondId)).filter((t) => t.id === threadId)).toHaveLength(0);
    await expect(B.service.sendCommand(pondId, threadId, { kind: "message", text: "hi" })).rejects.toThrow(
      /no such thread/,
    );
    await expect(B.service.readEvents(pondId, threadId, 0)).rejects.toThrow();
    expect(rtdb.tree.list(`channels/${pondId}/tevents`)).toHaveLength(0);
    await rawCommand(B, pondId, { kind: "message", threadId, text: "sneak" });
    expect((await A.bridge.runCommands(pondId))[0]).toMatchObject({ ok: false, reason: "that thread is private" });
    expect((await A.service.threads(pondId)).find((t) => t.id === threadId)?.private).toBe(true);
    // A private thread still shows who took part, and keeps counting turns that pass through the host.
    A.host.say(SID, "user/text", { text: "private note" }, "user");
    await new Promise((r) => setTimeout(r, 20));
    const priv = (await A.service.threads(pondId)).find((t) => t.id === threadId)!;
    expect(priv.participants!.map((p) => p.name)).toEqual(["Sibhi", "Aarav"]);
    expect(priv).toMatchObject({ workspace: "ushuaia", branch: "feat/x" });
    await A.service.setThreadPrivate(pondId, threadId, false);
    await A.bridge.flush();
    expect((await B.service.readEvents(pondId, threadId, 0)).events.length).toBeGreaterThan(0);
  });

  it("removing a member rotates the key: they can read nothing new", async () => {
    const oldKey = JSON.parse(fs.readFileSync(path.join(B.dir, "flotilla", "ponds.json"), "utf8")).ponds[pondId].keys[
      "1"
    ];
    await A.service.removeMember(pondId, B.service.me.id);
    A.host.sessions.set("s2", session("s2", { title: "After removal" }));
    const t2 = await A.bridge.share(pondId, "s2");
    await A.bridge.flush();
    await B.service.refresh(pondId);
    await expect(B.service.view(pondId)).rejects.toThrow(/no longer have access/);
    const doc = rtdb.tree.get(`channels/${pondId}/threads/${t2.id}`)!;
    expect(doc.box.startsWith("2.")).toBe(true);
    expect(() => openAt(oldKey, `channels/${pondId}/threads/${t2.id}`, doc.box.slice(2))).toThrow();
    await V.service.refresh(pondId);
    expect((await V.service.threads(pondId)).map((t) => t.title)).toContain("After removal");
    expect(rtdb.tree.get(`channels/${pondId}/keys/${B.service.me.id}`)).toBeNull();
    await rawCommand(B, pondId, { kind: "message", threadId: t2.id, text: "still here?" });
    expect((await A.bridge.runCommands(pondId))[0]).toMatchObject({ ok: false });
  });

  it("key files are 0600", () => {
    for (const f of ["identity.json", "ponds.json"]) {
      expect(fs.statSync(path.join(A.dir, "flotilla", f)).mode & 0o777).toBe(0o600);
    }
  });
});

describe("web guests and the wire", () => {
  it("two requests on one invite show once (the newest), and deciding removes both", async () => {
    const A = mac("OwnerDup");
    const W1 = mac("Web1", null);
    const W2 = mac("Web2", null);
    const pond = await A.service.createPond({ name: "Dup" });
    const { code } = await A.service.invite(pond.id);
    await W1.service.join(code, "First");
    await new Promise((r) => setTimeout(r, 5));
    await W2.service.join(code, "Second");
    const joins = (await A.service.view(pond.id)).joins;
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({ name: "Second" });
    await A.service.decideJoin(pond.id, joins[0]!.requestId, { approve: false });
    expect(await new RtdbRest(url).list(`channels/${pond.id}/joins`)).toHaveLength(0);
  });

  it("the same Mac joining twice keeps one request id", async () => {
    const A = mac("OwnerRetry");
    const B = mac("JoinerRetry");
    const pond = await A.service.createPond({ name: "Retry" });
    const { code } = await A.service.invite(pond.id);
    await B.service.join(code, "Joiner");
    await B.service.join(code, "Joiner");
    const joins = (await A.service.view(pond.id)).joins;
    expect(joins).toHaveLength(1);
    expect(await new RtdbRest(url).list(`channels/${pond.id}/joins`)).toHaveLength(1);
  });

  it("a member with no Nest joins, sees and messages, but cannot start a thread", async () => {
    const A = mac("Owner2");
    const W = mac("Web", null);
    const pond = await A.service.createPond({ name: "Docs" });
    await W.service.join((await A.service.invite(pond.id)).code, "Webby");
    const [join] = (await A.service.view(pond.id)).joins;
    expect(join).toMatchObject({ client: "web", nest: null });
    await A.service.decideJoin(pond.id, join!.requestId, { approve: true });
    await W.service.refresh(pond.id);
    const view = await W.service.view(pond.id);
    expect(view.members.find((m) => m.you)).toMatchObject({ nest: null });
    await expect(
      W.service.publishThread(pond.id, { sessionId: "x", title: "t", agent: "claude", model: "m", mode: "own" }),
    ).rejects.toThrow(/no machine/);
    A.host.sessions.set("s", session("s"));
    const t = await A.bridge.share(pond.id, "s");
    await W.bridge.message(pond.id, t.id, "hello from the browser");
    const o = await A.bridge.runCommands(pond.id);
    expect(o[0]).toMatchObject({ ok: true });
    expect(A.host.sent[0]!.text).toBe("hello from the browser");
  });

  it("a garbled invite is refused, and a denied join never becomes a member", async () => {
    const A = mac("Owner3");
    const B = mac("Joiner3");
    const pond = await A.service.createPond({ name: "P" });
    await expect(B.service.join("squeak-pond:nonsense", "x")).rejects.toThrow(/not valid/);
    await B.service.join((await A.service.invite(pond.id)).code, "Joiner");
    const [join] = (await A.service.view(pond.id)).joins;
    await A.service.decideJoin(pond.id, join!.requestId, { approve: false });
    await B.service.refresh(pond.id);
    await expect(B.service.view(pond.id)).rejects.toThrow(/declined your request to join/);
    expect((await A.service.view(pond.id)).members).toHaveLength(1);
  });

  it("an invite's secret is checked: a join without it is not offered to the owner", async () => {
    const A = mac("Owner5");
    const B = mac("Joiner5");
    const pond = await A.service.createPond({ name: "P" });
    const { code } = await A.service.invite(pond.id);
    const body = JSON.parse(Buffer.from(code.replace("squeak-pond:", ""), "base64url").toString());
    body.s = "wrongsecretwrongsecret";
    await B.service.join(Buffer.from(JSON.stringify(body)).toString("base64url"), "Eve");
    expect((await A.service.view(pond.id)).joins).toHaveLength(0);
  });

  it("wakes on a store change (watch)", async () => {
    const A = mac("Owner4");
    const pond = await A.service.createPond({ name: "W" });
    const seen: string[] = [];
    A.service.on("changed", (id: string) => seen.push(id));
    A.service.watch(pond.id);
    await new Promise((r) => setTimeout(r, 100));
    await new RtdbRest(url).set(`channels/${pond.id}/presence/x`, { box: "1.zz", at: 1 });
    for (let i = 0; i < 40 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(seen).toContain(pond.id);
    A.service.stop();
  });
});

void FlotillaError;
