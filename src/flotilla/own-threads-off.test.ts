import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { RtdbRest } from "../remote/rtdb-rest.js";
import { FakeRtdb } from "../remote/fake-rtdb.js";
import { FakeHost, session } from "./journey-support.js";
import { FlotillaBridge } from "./bridge.js";
import { FlotillaService } from "./service.js";

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
    store: new RtdbRest(url),
    supportDir: dir,
    displayName: name,
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
});
