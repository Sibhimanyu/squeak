import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RtdbRest } from "../remote/rtdb-rest.js";
import { FakeRtdb } from "../remote/fake-rtdb.js";
import type { HostEvent } from "../native/host.js";
import type { MessageRow, RequestRow, SessionRow } from "../native/types.js";
import { FlotillaBridge, type BridgeOptions, type HostPort, type ShareableArtifactRow } from "./bridge.js";
import { randomId, sealAt, signedText, signText } from "./crypto.js";
import { FlotillaService } from "./service.js";
import { ARTIFACT_CHUNK_BYTES, ARTIFACT_FETCH_PER_HOUR, MAX_ARTIFACT_BYTES } from "./types.js";
import { named, verifying } from "./named-account.test-fixture.js";

class FakeHost extends EventEmitter implements HostPort {
  sessions = new Map<string, SessionRow>();
  onEvent(l: (e: HostEvent) => void) {
    this.on("event", l);
    return () => void this.off("event", l);
  }
  getSession = (id: string) => this.sessions.get(id) ?? null;
  messagesAfter = (): MessageRow[] => [];
  openRequests = (): RequestRow[] => [];
  async send() {
    return { queued: false };
  }
  respond(): void {}
  note(): void {}
  setGuestTurn(): void {}
}

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-art-"));
  dirs.push(dir);
  const service = new FlotillaService({
    store: verifying(new RtdbRest(url)),
    supportDir: dir,
    account: named(name),
    nest: name + "-mac",
    inviteLinkBase: "https://x.test/join",
    ...(clock ? { now: () => clock.now } : {}),
  });
  const bridge = new FlotillaBridge(service, new FakeHost(), { flushMs: 60_000, ...options });
  bridge.start();
  return { dir, service, bridge };
}

async function rawCommand(who: Mac, pondId: string, body: Record<string, unknown>, keysFrom?: Mac) {
  const identity = JSON.parse(fs.readFileSync(path.join(who.dir, "flotilla", "identity.json"), "utf8")).identity;
  const pond = JSON.parse(fs.readFileSync(path.join((keysFrom ?? who).dir, "flotilla", "ponds.json"), "utf8")).ponds[
    pondId
  ];
  const id = randomId(12);
  const docPath = `channels/${pondId}/tcmds/${id}`;
  const now = Date.now();
  const cmd = { id, threadId: "", issuedAt: now, expiresAt: now + 60_000, nonce: randomId(12), ...body };
  const box = `${pond.current}.${sealAt(pond.keys[String(pond.current)], docPath, cmd)}`;
  await new RtdbRest(url).set(docPath, {
    box,
    sig: signText(identity.privateKey, signedText(docPath, box)),
    device: who.service.me.id,
    at: now,
  });
  return id;
}

const wireId = (p: string) => crypto.createHash("sha256").update(p).digest("hex").slice(0, 16);

describe("a member reads the owner's artifacts", () => {
  const clock = { now: Date.now() };
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "art-files-"));
  dirs.push(folder);
  const big = Buffer.alloc(ARTIFACT_CHUNK_BYTES * 2 + 1234, 7);
  const files = {
    deck: path.join(folder, "deck.pdf"),
    big: path.join(folder, "big.mov"),
    huge: path.join(folder, "huge.mov"),
  };
  let rows: ShareableArtifactRow[] = [];
  let seenPrivate: ReadonlySet<string> = new Set();
  let A: Mac;
  let B: Mac;
  let V: Mac;
  let C: Mac;
  let pondId = "";

  beforeAll(async () => {
    fs.writeFileSync(files.deck, "%PDF-1.4 deck");
    fs.writeFileSync(files.big, big);
    fs.writeFileSync(files.huge, "x");
    rows = Object.entries(files).map(([k, abs]) => ({
      id: wireId(abs),
      absPath: abs,
      path: wireId(abs),
      name: path.basename(abs),
      kind: k === "deck" ? "pdf" : "video",
      source: "shown" as const,
      modifiedAt: 1,
      size: k === "huge" ? MAX_ARTIFACT_BYTES + 1 : fs.statSync(abs).size,
    }));
    A = mac(
      "Sibhi",
      {
        artifacts: (_project, priv) => {
          seenPrivate = priv;
          return rows;
        },
      },
      clock,
    );
    B = mac("Aarav", {}, clock);
    V = mac("Vera", {}, clock);
    C = mac("Chris");
    await C.service.createPond({ name: "Elsewhere", projectId: "proj-Elsewhere" });
    pondId = (await A.service.createPond({ name: "Site", projectId: "proj-Site" })).id;
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

  it("lists by wire id only, no path of the owner's Mac, and only after the owner's Mac answers", async () => {
    const { requestId, ownerName } = await B.service.requestArtifacts(pondId);
    expect(ownerName).toBe("Sibhi");
    expect(await B.service.artifactsResult(pondId, requestId)).toBeNull();
    expect(await A.bridge.runCommands(pondId)).toEqual([expect.objectContaining({ ok: true, kind: "artifacts" })]);
    const got = (await B.service.artifactsResult(pondId, requestId))!;
    expect(got.items.map((i) => i.name)).toEqual(["deck.pdf", "big.mov", "huge.mov"]);
    expect(JSON.stringify(got)).not.toContain(folder);
    expect(got.items[0]!.path).toMatch(/^[a-f0-9]{16}$/);
    expect(seenPrivate).toBeInstanceOf(Set);
  });

  it("a viewer may read the list", async () => {
    const { requestId } = await V.service.requestArtifacts(pondId);
    await A.bridge.runCommands(pondId);
    expect((await V.service.artifactsResult(pondId, requestId))!.items).toHaveLength(3);
  });

  it("a file travels in chunks, arrives intact and is cached on the member's Mac", async () => {
    const { requestId } = await B.service.requestArtifacts(pondId, rows[1]!.id);
    expect(await A.bridge.runCommands(pondId)).toEqual([expect.objectContaining({ ok: true, kind: "artifact" })]);
    const result = (await B.service.artifactsResult(pondId, requestId))!;
    expect(result.file).toMatchObject({ name: "big.mov", size: big.length, chunks: 3 });
    const got = await B.service.artifactFile(pondId, requestId);
    expect(got.ready).toBe(true);
    expect(got.file!.path.startsWith(path.join(B.dir, "artifact-cache", pondId))).toBe(true);
    expect(fs.readFileSync(got.file!.path).equals(big)).toBe(true);
    expect(got.file!.ownerName).toBe("Sibhi");
    // asking again hands back the same cached copy
    expect((await B.service.artifactFile(pondId, requestId)).file!.path).toBe(got.file!.path);
  });

  it("a file over the cap is refused with a sentence the member sees", async () => {
    const huge = rows[2]!;
    fs.truncateSync(huge.absPath, MAX_ARTIFACT_BYTES + 1);
    const { requestId } = await B.service.requestArtifacts(pondId, huge.id);
    await A.bridge.runCommands(pondId);
    expect((await B.service.artifactFile(pondId, requestId)).error).toMatch(/too large/);
  });

  it("an id the list does not hold (or a path) is refused, never read", async () => {
    const { requestId } = await B.service.requestArtifacts(pondId, "0123456789abcdef");
    await A.bridge.runCommands(pondId);
    expect((await B.service.artifactFile(pondId, requestId)).error).toMatch(/no longer shared/);
    await expect(B.service.requestArtifacts(pondId, "../../etc/passwd")).rejects.toThrow(/not an artifact/);
    for (const bad of ["../../etc/passwd", "/etc/passwd", files.deck]) {
      const id = await rawCommand(B, pondId, { kind: "artifact", path: bad });
      await A.bridge.runCommands(pondId);
      const doc = await new RtdbRest(url).get(`channels/${pondId}/tevents/art-r${id}`);
      const result = await B.service.artifactFile(pondId, id);
      expect(result.error).toMatch(/no longer shared/);
      expect(doc).not.toBeNull();
      expect(result.file).toBeUndefined();
    }
  });

  it("someone who is not a member is refused", async () => {
    await rawCommand(C, pondId, { kind: "artifacts" }, B);
    expect(await A.bridge.runCommands(pondId)).toEqual([
      expect.objectContaining({ ok: false, reason: "not a member" }),
    ]);
  });

  it("the owner's own Mac does not ask itself", async () => {
    await expect(A.service.requestArtifacts(pondId)).rejects.toThrow(/your own Mac/);
  });

  it("a member's file asks are limited per hour", async () => {
    let refused = 0;
    for (let i = 0; i < ARTIFACT_FETCH_PER_HOUR + 3; i++) {
      await B.service.requestArtifacts(pondId, rows[0]!.id);
      const out = await A.bridge.runCommands(pondId);
      if (out.some((o) => !o.ok && o.reason === "too many files asked for this hour")) refused++;
    }
    expect(refused).toBeGreaterThan(0);
  });

  it("answers expire after ten minutes and are deleted", async () => {
    const { requestId } = await V.service.requestArtifacts(pondId);
    await A.bridge.runCommands(pondId);
    const docPath = `channels/${pondId}/tevents/art-r${requestId}`;
    expect(await new RtdbRest(url).get(docPath)).not.toBeNull();
    clock.now += 11 * 60_000;
    await A.bridge.runCommands(pondId);
    await new Promise((r) => setTimeout(r, 150));
    expect(await new RtdbRest(url).get(docPath)).toBeNull();
    expect(await V.service.artifactsResult(pondId, requestId)).toBeNull();
  });
});
