import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RtdbRest } from "../remote/rtdb-rest.js";
import { FakeRtdb } from "../remote/fake-rtdb.js";
import type { HostEvent } from "../native/host.js";
import type { MessageRow, RequestRow, SessionRow } from "../native/types.js";
import { FlotillaBridge, type BridgeOptions, type HostPort } from "./bridge.js";
import { randomId, sealAt, signedText, signText } from "./crypto.js";
import { FlotillaService } from "./service.js";
import { MAX_DIFF_RESULT_BYTES, START_PER_HOUR, type ChangedFiles } from "./types.js";

class FakeHost extends EventEmitter implements HostPort {
  sessions = new Map<string, SessionRow>();
  messages: MessageRow[] = [];
  sent: Array<{ id: string; text: string }> = [];
  notes: string[] = [];
  patches = new Map<string, string>();
  changed: ChangedFiles | null = {
    files: 2,
    added: 5,
    removed: 1,
    paths: ["src/a.ts", "README.md"],
    fileStats: [
      { path: "src/a.ts", changes: 4 },
      { path: "README.md", changes: 2 },
    ],
  };
  onEvent(l: (e: HostEvent) => void) {
    this.on("event", l);
    return () => void this.off("event", l);
  }
  getSession = (id: string) => this.sessions.get(id) ?? null;
  messagesAfter = (id: string, seq: number) => this.messages.filter((m) => m.sessionId === id && m.seq > seq);
  openRequests = (): RequestRow[] => [];
  async send(id: string, text: string) {
    this.sent.push({ id, text });
    return { queued: false };
  }
  respond(): void {}
  note(_id: string, text: string) {
    this.notes.push(text);
  }
  setGuestTurn() {}
  async diff(_id: string, file: string) {
    return this.patches.get(file) ?? null;
  }
  async changes() {
    return this.changed;
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
  archivedAt: null,
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
function mac(name: string, options: BridgeOptions = {}, clock?: { now: number }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-"));
  dirs.push(dir);
  const service = new FlotillaService({
    store: new RtdbRest(url),
    supportDir: dir,
    displayName: name,
    nest: name + "-mac",
    inviteLinkBase: "https://x.test/join",
    ...(clock ? { now: () => clock.now } : {}),
  });
  const host = new FakeHost();
  const bridge = new FlotillaBridge(service, host, { flushMs: 60_000, ...options });
  bridge.start();
  return { dir, service, host, bridge };
}

async function rawCommand(
  who: Mac,
  pondId: string,
  body: Record<string, unknown>,
  opts: { keysFrom?: Mac; at?: number } = {},
) {
  const identity = JSON.parse(fs.readFileSync(path.join(who.dir, "flotilla", "identity.json"), "utf8")).identity;
  const holder = opts.keysFrom ?? who;
  const pond = JSON.parse(fs.readFileSync(path.join(holder.dir, "flotilla", "ponds.json"), "utf8")).ponds[pondId];
  const id = randomId(12);
  const docPath = `channels/${pondId}/tcmds/${id}`;
  const now = opts.at ?? Date.now();
  const cmd = { id, issuedAt: now, expiresAt: now + 60_000, nonce: randomId(12), ...body };
  const box = `${pond.current}.${sealAt(pond.keys[String(pond.current)], docPath, cmd)}`;
  await new RtdbRest(url).set(docPath, {
    box,
    sig: signText(identity.privateKey, signedText(docPath, box)),
    device: who.service.me.id,
    at: now,
  });
  return id;
}

describe("a member reads the changes of someone else's thread", () => {
  const clock = { now: Date.now() };
  let A: Mac;
  let B: Mac;
  let V: Mac;
  let C: Mac;
  let pondId = "";
  let threadId = "";
  let privateId = "";
  beforeAll(async () => {
    A = mac("Sibhi", {}, clock);
    B = mac("Aarav", {}, clock);
    V = mac("Vera", {}, clock);
    C = mac("Chris");
    await C.service.createPond({ name: "Elsewhere", projectId: "proj-Elsewhere" });
    pondId = (
      await A.service.createPond({ name: "Site", projectId: "proj-Site", gitRemote: "git@github.com:acme/site.git" })
    ).id;
    for (const [m, role] of [
      [B, "member"],
      [V, "viewer"],
    ] as const) {
      await m.service.join((await A.service.invite(pondId, role)).code);
      for (const j of (await A.service.view(pondId)).joins)
        await A.service.decideJoin(pondId, j.requestId, { approve: true });
      await m.service.refresh(pondId);
    }
    A.host.sessions.set("s1", session("s1"));
    A.host.sessions.set("s2", session("s2", { title: "Secret" }));
    threadId = (await A.bridge.share(pondId, "s1")).id;
    privateId = (await A.bridge.share(pondId, "s2", { private: true })).id;
    A.host.patches.set("src/a.ts", "@@ -1 +1 @@\n-a\n+b\n");
  });

  it("a member gets the file list and one file's patch; nobody is polled", async () => {
    const { requestId } = await B.service.requestDiff(pondId, threadId);
    expect(await B.service.diffResult(pondId, threadId, requestId)).toBeNull();
    expect(await A.bridge.runCommands(pondId)).toEqual([expect.objectContaining({ ok: true, kind: "diff" })]);
    const list = (await B.service.diffResult(pondId, threadId, requestId))!;
    expect(list.files).toEqual([
      { path: "src/a.ts", changes: 4 },
      { path: "README.md", changes: 2 },
    ]);
    expect(list.summary).toEqual({ files: 2, added: 5, removed: 1 });
    expect(list.patch).toBeUndefined();
    const one = await B.service.requestDiff(pondId, threadId, "src/a.ts");
    await A.bridge.runCommands(pondId);
    expect((await B.service.diffResult(pondId, threadId, one.requestId))!.patch).toEqual({
      path: "src/a.ts",
      text: "@@ -1 +1 @@\n-a\n+b\n",
      truncated: false,
    });
  });

  it("a viewer may read the changes", async () => {
    const { requestId } = await V.service.requestDiff(pondId, threadId, "src/a.ts");
    expect(await A.bridge.runCommands(pondId)).toEqual([expect.objectContaining({ ok: true, kind: "diff" })]);
    expect((await V.service.diffResult(pondId, threadId, requestId))!.patch?.text).toContain("+b");
  });

  it("a private thread is refused to a member's request and a hand-signed one", async () => {
    await expect(B.service.requestDiff(pondId, privateId)).rejects.toThrow(/no longer shared/);
    await rawCommand(B, pondId, { kind: "diff", threadId: privateId });
    expect(await A.bridge.runCommands(pondId)).toEqual([
      expect.objectContaining({ ok: false, reason: "that thread is private" }),
    ]);
  });

  it("someone who is not a member is refused", async () => {
    // Chris holds the pond key (as a leaked key would) but was never added: his signature names no member.
    await rawCommand(C, pondId, { kind: "diff", threadId }, { keysFrom: B });
    expect(await A.bridge.runCommands(pondId)).toEqual([
      expect.objectContaining({ ok: false, reason: "not a member" }),
    ]);
  });

  it("a path that is not among the changed files is refused", async () => {
    for (const bad of ["../../.ssh/id_rsa", "/etc/passwd", "other.ts"]) {
      await rawCommand(B, pondId, { kind: "diff", threadId, path: bad });
      expect(await A.bridge.runCommands(pondId)).toEqual([
        expect.objectContaining({ ok: false, reason: "that file is not in the changes" }),
      ]);
    }
  });

  it("a patch over the cap is cut and says so", async () => {
    A.host.patches.set("README.md", "x".repeat(MAX_DIFF_RESULT_BYTES + 500));
    const { requestId } = await B.service.requestDiff(pondId, threadId, "README.md");
    await A.bridge.runCommands(pondId);
    const got = (await B.service.diffResult(pondId, threadId, requestId))!;
    expect(got.patch!.truncated).toBe(true);
    expect(got.patch!.text.length).toBe(MAX_DIFF_RESULT_BYTES);
  });

  it("an answer expires after ten minutes and is deleted", async () => {
    const { requestId } = await B.service.requestDiff(pondId, threadId);
    await A.bridge.runCommands(pondId);
    expect(await B.service.diffResult(pondId, threadId, requestId)).not.toBeNull();
    const docPath = `channels/${pondId}/tevents/${threadId}-r${requestId}`;
    expect(await new RtdbRest(url).get(docPath)).not.toBeNull();
    clock.now += 11 * 60_000;
    // The next pass of the starter's Mac sweeps what it wrote.
    await A.bridge.runCommands(pondId);
    await new Promise((r) => setTimeout(r, 100));
    expect(await new RtdbRest(url).get(docPath)).toBeNull();
    expect(await B.service.diffResult(pondId, threadId, requestId)).toBeNull();
    clock.now += 0;
  });

  it("making the thread private withdraws what was asked of it", async () => {
    const { requestId } = await B.service.requestDiff(pondId, threadId);
    await A.bridge.runCommands(pondId);
    await A.service.setThreadPrivate(pondId, threadId, true);
    expect(await B.service.diffResult(pondId, threadId, requestId)).toBeNull();
    await A.service.setThreadPrivate(pondId, threadId, false);
  });
});

describe("a member starts a thread on the owner's Mac", () => {
  const clock = { now: Date.now() };
  let A: Mac;
  let B: Mac;
  let V: Mac;
  let pondId = "";
  const started: Array<{ projectId: string; spec: Record<string, unknown> }> = [];
  beforeAll(async () => {
    let next = 0;
    let host: FakeHost | null = null;
    A = mac(
      "Sibhi",
      {
        startChat: async (projectId, spec) => {
          started.push({ projectId, spec });
          const id = `n${++next}`;
          host!.sessions.set(id, session(id, { title: "New chat", permissionMode: spec.permissionMode }));
          return { sessionId: id };
        },
        permissionModeFor: () => "bypassPermissions",
      },
      clock,
    );
    host = A.host;
    B = mac("Aarav", {}, clock);
    V = mac("Vera", {}, clock);
    const created = await A.service.createPond({ name: "Notes", projectId: "proj1" });
    pondId = created.id;
    for (const [m, role] of [
      [B, "member"],
      [V, "viewer"],
    ] as const) {
      await m.service.join((await A.service.invite(pondId, role)).code);
      for (const j of (await A.service.view(pondId)).joins)
        await A.service.decideJoin(pondId, j.requestId, { approve: true });
      await m.service.refresh(pondId);
    }
  });

  it("the owner's Mac makes a normal chat in the pond's folder and publishes it for everyone", async () => {
    const { requestId } = await B.service.requestStart(pondId, {
      text: "Draft the outline",
      title: "Outline",
      agent: "claude",
      model: "claude-opus",
    });
    const out = await A.bridge.runCommands(pondId);
    expect(out).toEqual([expect.objectContaining({ ok: true, kind: "start" })]);
    // The folder: Main, in the pond's project. Never bypassPermissions, though the owner's default says so.
    expect(started[0]).toMatchObject({
      projectId: "proj1",
      spec: { main: true, agent: "claude", model: "claude-opus", permissionMode: "default", text: "Draft the outline" },
    });
    // A normal chat on the owner's Mac: a thread of theirs with a session behind it.
    const own = A.service.ownThreads();
    expect(own).toHaveLength(1);
    expect(own[0]!.thread.sessionId).toBe("n1");
    expect(A.host.notes).toContain("Aarav started this thread.");
    await B.service.refresh(pondId);
    const seen = (await B.service.threads(pondId))[0]!;
    expect(seen).toMatchObject({ title: "Outline", starterName: "Sibhi", requester: { requestId } });
    expect(seen.participants!.map((p) => p.name).sort()).toEqual(["Aarav", "Sibhi"]);
    expect(seen.sessionId).toBeUndefined();
    const ripples = (await V.service.view(pondId)).ripples;
    expect(ripples.some((r) => /started Outline/.test(r.text) && r.onBehalf?.name === "Aarav")).toBe(true);
  });

  it("the first message is attributed to the member", async () => {
    A.host.emit("event", {
      type: "message",
      sessionId: "n1",
      seq: 1,
      role: "user",
      kind: "user/text",
      payload: { text: "Draft the outline" },
      createdAt: new Date().toISOString(),
    } satisfies HostEvent);
    await A.bridge.flush();
    const threadId = A.service.ownThreads()[0]!.threadId;
    const events = (await B.service.readEvents(pondId, threadId, 0)).events;
    expect(events.find((e) => e.type === "user")).toMatchObject({ byName: "Aarav", text: "Draft the outline" });
  });

  it("a viewer cannot start one, on the wire or by hand", async () => {
    await expect(V.service.requestStart(pondId, { text: "hi", agent: "claude", model: "m" })).rejects.toThrow(
      /read but not send/,
    );
    await rawCommand(V, pondId, { kind: "start", threadId: "", text: "hi", agent: "claude", model: "m" });
    expect(await A.bridge.runCommands(pondId)).toEqual([
      expect.objectContaining({ ok: false, reason: "Viewers can read but not send." }),
    ]);
    expect(started).toHaveLength(1);
  });

  it("only the owner's Mac answers a start; a member's Mac leaves it alone", async () => {
    await B.service.requestStart(pondId, { text: "more", agent: "codex", model: "gpt-x" });
    expect(await B.bridge.runCommands(pondId)).toEqual([]);
    expect(await A.bridge.runCommands(pondId)).toEqual([expect.objectContaining({ ok: true, kind: "start" })]);
    expect(started[1]!.spec).toMatchObject({ agent: "codex", permissionMode: "default" });
  });

  it("a bad agent or model is refused, and the owner cannot ask their own Mac", async () => {
    await rawCommand(B, pondId, { kind: "start", threadId: "", text: "x", agent: "rm", model: "m" });
    expect(await A.bridge.runCommands(pondId)).toEqual([expect.objectContaining({ ok: false })]);
    await expect(A.service.requestStart(pondId, { text: "x", agent: "claude", model: "m" })).rejects.toThrow(
      /your own Mac/,
    );
  });

  it("a member may start at most ten an hour, then it opens again", async () => {
    const before = started.length;
    const accepted: boolean[] = [];
    for (let i = 0; i < START_PER_HOUR + 2; i++) {
      await rawCommand(
        B,
        pondId,
        { kind: "start", threadId: "", text: `t${i}`, agent: "claude", model: "m" },
        { at: clock.now },
      );
      const [o] = await A.bridge.runCommands(pondId);
      accepted.push(o!.ok);
    }
    // Two were already used above (one before, one more).
    expect(accepted.filter(Boolean).length).toBe(START_PER_HOUR - 3);
    expect(started.length - before).toBe(START_PER_HOUR - 3);
    clock.now += 61 * 60_000;
    await rawCommand(
      B,
      pondId,
      { kind: "start", threadId: "", text: "later", agent: "claude", model: "m" },
      { at: clock.now },
    );
    expect((await A.bridge.runCommands(pondId))[0]).toMatchObject({ ok: true });
  });
});
