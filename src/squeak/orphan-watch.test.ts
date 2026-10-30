import { describe, expect, it } from "vitest";

import { OrphanWatch, usableCopy, type InstallClaim, type OrphanWatchDeps } from "./orphan-watch.js";

const HOME = "/Users/x";

function rig(over: Partial<OrphanWatchDeps> = {}) {
  let clock = 1_000;
  const present = new Set<string>(["/Applications/Squeak.app"]);
  const state = {
    claim: {
      v: 1,
      appPath: "/Applications/Squeak.app",
      bundleId: "com.squeak.mac",
      version: "1",
      writtenAt: 500,
    } as InstallClaim | null,
    copies: [] as string[],
    trash: false,
    spotlight: true,
    spawns: 0,
    spawnFails: false,
    logs: [] as string[],
    written: [] as InstallClaim[],
  };
  const deps: OrphanWatchDeps = {
    home: HOME,
    now: () => clock,
    log: (m) => state.logs.push(m),
    readClaim: () => state.claim,
    writeClaim: (c) => {
      state.written.push(c);
      state.claim = c;
    },
    appPresent: async (p) => present.has(p),
    findCopies: async () => state.copies,
    trashHasSqueak: async () => state.trash,
    spotlightWorks: async () => state.spotlight,
    spawnUninstall: () => {
      if (state.spawnFails) throw new Error("nope");
      state.spawns += 1;
    },
    ...over,
  };
  return {
    state,
    present,
    watch: new OrphanWatch(deps, { firstMs: 1, everyMs: 1 }),
    advance: (ms: number) => void (clock += ms),
  };
}

describe("OrphanWatch", () => {
  it("does nothing while the app is present", async () => {
    const r = rig();
    for (let i = 0; i < 5; i++) await r.watch.tick();
    expect(r.state.spawns).toBe(0);
  });

  it("a moved app updates the claim and resets", async () => {
    const r = rig({ trashHasSqueak: async () => true });
    r.present.delete("/Applications/Squeak.app");
    r.present.add("/Users/x/Apps/Squeak.app");
    r.state.copies = ["/Volumes/Squeak/Squeak.app", "/Users/x/.Trash/Squeak.app", "/Users/x/Apps/Squeak.app"];
    for (let i = 0; i < 5; i++) await r.watch.tick();
    expect(r.state.written.map((c) => c.appPath)).toEqual(["/Users/x/Apps/Squeak.app"]);
    expect(r.state.spawns).toBe(0);
  });

  it("trashed: three counted misses spawn once, never twice", async () => {
    const r = rig();
    r.present.clear();
    r.state.trash = true;
    r.state.spotlight = false;
    await r.watch.tick();
    await r.watch.tick();
    expect(r.state.spawns).toBe(0);
    await r.watch.tick();
    expect(r.state.spawns).toBe(1);
    for (let i = 0; i < 5; i++) await r.watch.tick();
    expect(r.state.spawns).toBe(1);
  });

  it("Spotlight alone counts when it demonstrably works", async () => {
    const r = rig();
    r.present.clear();
    for (let i = 0; i < 3; i++) await r.watch.tick();
    expect(r.state.spawns).toBe(1);
  });

  it("no Trash evidence and Spotlight dead: never acts, says so once", async () => {
    const r = rig();
    r.present.clear();
    r.state.spotlight = false;
    for (let i = 0; i < 10; i++) await r.watch.tick();
    expect(r.state.spawns).toBe(0);
    expect(r.state.logs.filter((l) => l.includes("can't prove")).length).toBe(1);
  });

  it("no claim file: never watches", async () => {
    const r = rig();
    r.state.claim = null;
    r.present.clear();
    expect(r.watch.start()).toBe(false);
    for (let i = 0; i < 5; i++) await r.watch.tick();
    expect(r.state.spawns).toBe(0);
  });

  it("a claim rewritten mid-way resets the count", async () => {
    const r = rig();
    r.present.clear();
    await r.watch.tick();
    await r.watch.tick();
    r.advance(10);
    r.state.claim = { ...r.state.claim!, writtenAt: 99_999 };
    await r.watch.tick();
    await r.watch.tick();
    expect(r.state.spawns).toBe(0);
    await r.watch.tick();
    expect(r.state.spawns).toBe(1);
  });

  it("a spawn failure is not retried for 24 hours", async () => {
    const r = rig();
    r.present.clear();
    r.state.spawnFails = true;
    for (let i = 0; i < 6; i++) await r.watch.tick();
    expect(r.state.spawns).toBe(0);
    r.state.spawnFails = false;
    await r.watch.tick();
    expect(r.state.spawns).toBe(0);
    r.advance(24 * 60 * 60_000 + 1);
    await r.watch.tick();
    expect(r.state.spawns).toBe(1);
  });

  it("filters trashed, mounted and build copies", () => {
    expect(usableCopy("/Users/x/.Trash/Squeak.app", HOME)).toBe(false);
    expect(usableCopy("/Volumes/Squeak 2.1/Squeak.app", HOME)).toBe(false);
    expect(usableCopy("/Users/x/repo/macos/.build/Squeak.app", HOME)).toBe(false);
    expect(usableCopy("/Applications/Squeak.app", HOME)).toBe(true);
  });
});
