import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { RtdbRest } from "../remote/rtdb-rest.js";
import { FakeRtdb } from "../remote/fake-rtdb.js";
import { FakeHost, session } from "./journey-support.js";
import { FlotillaBridge } from "./bridge.js";
import { FlotillaService } from "./service.js";
import { named, verifying } from "./named-account.test-fixture.js";

// The stashed own-thread mode is off by default (docs/ponds.md, SQUEAK_POND_OWN_THREADS).
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
afterEach(() => {
  delete process.env.SQUEAK_POND_OWN_THREADS;
});

function mac(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flotilla-"));
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
  return { service, host, bridge };
}

async function pond() {
  const A = mac("Sibhi");
  const B = mac("Aarav");
  const created = await A.service.createPond({
    name: "Site",
    projectId: "p1",
    gitRemote: "git@github.com:acme/site.git",
  });
  await B.service.join((await A.service.invite(created.id, "member")).link!);
  const [join] = (await A.service.view(created.id)).joins;
  await A.service.decideJoin(created.id, join!.requestId, { approve: true });
  await B.service.refresh(created.id);
  return { A, B, pondId: created.id };
}

describe("own threads off (the default)", () => {
  it("a member's Mac refuses to start or publish its own thread, and the owner's own threads still work", async () => {
    const { A, B, pondId } = await pond();
    await expect(B.service.assertCanStart(pondId)).rejects.toThrow(/Runs on the owner/);
    B.host.sessions.set("b1", session("b1", { title: "Aarav's thread" }));
    await expect(B.bridge.share(pondId, "b1", { mode: "own" })).rejects.toThrow(/switched off/);
    // Sharing an existing chat is not an own thread, and the owner's Mac is the owner's.
    B.host.sessions.set("b2", session("b2", { title: "Shared by Aarav" }));
    await B.bridge.share(pondId, "b2");
    A.host.sessions.set("a1", session("a1", { title: "Owner's" }));
    const own = await A.bridge.share(pondId, "a1", { mode: "own" });
    expect((await B.service.threads(pondId)).map((t) => t.id)).toContain(own.id);
    await expect(A.service.assertCanStart(pondId)).resolves.toBeUndefined();
  });

  it("readers drop a member's own thread published while the mode was on, and show it again when it is on", async () => {
    const { A, B, pondId } = await pond();
    process.env.SQUEAK_POND_OWN_THREADS = "on";
    B.host.sessions.set("b1", session("b1", { title: "Aarav's thread" }));
    const own = await B.bridge.share(pondId, "b1", { mode: "own" });
    expect((await A.service.threads(pondId)).some((t) => t.id === own.id)).toBe(true);
    delete process.env.SQUEAK_POND_OWN_THREADS;
    expect((await A.service.threads(pondId)).some((t) => t.id === own.id)).toBe(false);
    expect((await B.service.threads(pondId)).some((t) => t.id === own.id)).toBe(false);
    process.env.SQUEAK_POND_OWN_THREADS = "on";
    expect((await A.service.threads(pondId)).some((t) => t.id === own.id)).toBe(true);
  });

  it("a remote pond shows no code: the member's Mac never asks for a diff, the owner's Mac still can", async () => {
    const { A, B, pondId } = await pond();
    expect(B.service.accessOf(pondId)).toBe("remote");
    expect(A.service.accessOf(pondId)).toBe("owner");
    await expect(B.service.requestDiff(pondId, "t1")).rejects.toMatchObject({ status: 403 });
    await expect(B.service.requestDiff(pondId, "t1")).rejects.toThrow(/remote pond/);
    // With the stashed flag on and a Git remote the pond is "git" and the request is no longer refused for being remote.
    process.env.SQUEAK_POND_OWN_THREADS = "on";
    expect(B.service.accessOf(pondId)).toBe("git");
    await expect(B.service.requestDiff(pondId, "t1")).rejects.not.toThrow(/remote pond/);
  });

  it("the owner's Mac refuses a member's diff request in a remote pond, whatever the member's Mac sent", async () => {
    const { A, B, pondId } = await pond();
    A.host.sessions.set("a1", session("a1", { title: "Owner's" }));
    const thread = await A.bridge.share(pondId, "a1");
    // The member's Mac asks while it believes the pond is "git"; the owner's flag is off when the command is read.
    process.env.SQUEAK_POND_OWN_THREADS = "on";
    await B.service.requestDiff(pondId, thread.id);
    delete process.env.SQUEAK_POND_OWN_THREADS;
    expect(await A.bridge.runCommands(pondId)).toEqual([
      expect.objectContaining({ ok: false, reason: expect.stringMatching(/remote pond/) }),
    ]);
    // With the owner's flag on the same member (a Mac, on a pond with a Git remote) is answered; no flag change breaks it.
    process.env.SQUEAK_POND_OWN_THREADS = "on";
    await B.service.requestDiff(pondId, thread.id);
    // (The fake host has nothing to diff, so it says so: past the level check.)
    const [out] = await A.bridge.runCommands(pondId);
    expect(out!.reason ?? "").not.toMatch(/remote pond/);
  });

  it("leaving is safe from any surface: gone from the directory at once, twice is a plain 404, an owner is refused", async () => {
    const { A, B, pondId } = await pond();
    expect((await B.service.directoryRecords()).map((r) => r.id)).toContain(pondId);
    await B.service.leave(pondId);
    expect((await B.service.directoryRecords()).map((r) => r.id)).not.toContain(pondId);
    await expect(B.service.leave(pondId)).rejects.toMatchObject({ status: 404 });
    await expect(A.service.leave(pondId)).rejects.toMatchObject({ status: 409 });
  });
});
