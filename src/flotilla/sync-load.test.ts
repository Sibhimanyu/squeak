import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { CloudStore, WatchSource } from "../cloud/store.js";
import type { ChannelDoc } from "../remote/firestore-rest.js";
import { FlotillaService } from "./service.js";

const LOCATION = { provider: "firebase", databaseUrl: "https://squeak-test-default-rtdb.firebaseio.com" };
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A relay that, like the real one, tells every watcher (the writer too) after each write. */
class Relay {
  docs = new Map<string, ChannelDoc>();
  writes = 0;
  clock = { t: 1_800_000_000_000 };
  failing: string | null = null;
  dirs: string[] = [];
  private readonly watchers = new Set<(source?: WatchSource) => void>();
  store(): CloudStore {
    const run = async <T>(call: () => T): Promise<T> => {
      if (this.failing) throw new Error(this.failing);
      return call();
    };
    return {
      get: (p) => run(() => this.docs.get(p) ?? null),
      set: (p, doc) =>
        run(() => {
          this.docs.set(p, doc);
          this.writes += 1;
          setTimeout(() => this.watchers.forEach((w) => w("stream")), 5);
        }),
      list: (c) =>
        run(() =>
          [...this.docs].filter(([k]) => k.startsWith(`${c}/`)).map(([k, doc]) => ({ id: k.slice(c.length + 1), doc })),
        ),
      delete: (p) => run(() => void this.docs.delete(p)),
      watch: (_p, onChange) => {
        this.watchers.add(onChange);
        return () => this.watchers.delete(onChange);
      },
    };
  }
  mac(name: string, owner = false) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pond-sync-"));
    this.dirs.push(dir);
    const store = this.store();
    const service = new FlotillaService({
      store,
      supportDir: dir,
      displayName: name,
      nest: `${name}'s Mac`,
      ...(owner ? { location: LOCATION } : {}),
      storeFor: () => store,
      now: () => this.clock.t,
      wakeDebounceMs: 30,
      wakeMinIntervalMs: 0,
      random: () => 0.5,
    });
    return { service, store };
  }
}

const relays: Relay[] = [];
afterAll(() => {
  for (const r of relays) for (const d of r.dirs) fs.rmSync(d, { recursive: true, force: true });
});

async function twoMembers() {
  const r = new Relay();
  relays.push(r);
  const A = r.mac("Sibhi", true);
  const pond = await A.service.createPond({ name: "Greenroom" });
  const B = r.mac("Aarav");
  await B.service.join((await A.service.invite(pond.id, "member")).code);
  const [req] = (await A.service.view(pond.id)).joins;
  await A.service.decideJoin(pond.id, req!.requestId, { approve: true });
  await B.service.refresh(pond.id);
  return { r, A, B, pondId: pond.id };
}

/** Starts both services, lets the start-up reads finish, and zeroes the counters. */
async function settled(A: { service: FlotillaService }, B: { service: FlotillaService }) {
  A.service.start();
  B.service.start();
  await wait(150);
  A.service.takeStats();
  B.service.takeStats();
}

describe("pond sync load", () => {
  it("ignores the echo of its own presence write", async () => {
    const { A, B, pondId } = await twoMembers();
    await settled(A, B);
    await A.service.setPresence(pondId, { viewing: "pond" });
    await wait(150);
    const a = A.service.takeStats();
    expect(a).toMatchObject({ streamEvents: 1, skippedOwnEcho: 1, refreshes: 0 });
    A.service.stop();
    B.service.stop();
  });

  it("does not ping-pong: two members' presence writes cause one read each and no further writes", async () => {
    const { r, A, B, pondId } = await twoMembers();
    await settled(A, B);
    const before = r.writes;
    await A.service.setPresence(pondId, { viewing: "pond" });
    await B.service.setPresence(pondId, { viewing: "pond" });
    await wait(400);
    expect(r.writes - before).toBe(2);
    // Each Mac read once for the other's write (its own was an echo) and wrote nothing because of it.
    expect(A.service.takeStats().refreshes).toBeLessThanOrEqual(1);
    expect(B.service.takeStats().refreshes).toBeLessThanOrEqual(1);
    A.service.stop();
    B.service.stop();
  });

  it("writes an unchanged presence only when the heartbeat is due", async () => {
    const { r, A, B, pondId } = await twoMembers();
    await settled(A, B);
    const before = r.writes;
    for (let i = 0; i < 5; i++) await A.service.setPresence(pondId, { viewing: "pond" });
    expect(r.writes - before).toBe(1);
    r.clock.t += 120_000;
    await A.service.setPresence(pondId, { viewing: "pond" });
    expect(r.writes - before).toBe(2);
    A.service.stop();
    B.service.stop();
  });

  it("folds a burst of notices into one read", async () => {
    const { A, B, pondId } = await twoMembers();
    await settled(A, B);
    for (let i = 0; i < 20; i++) A.service.onNotice(pondId, "stream");
    await wait(200);
    expect(A.service.takeStats()).toMatchObject({ streamEvents: 20, refreshes: 1, coalesced: 19 });
    A.service.stop();
    B.service.stop();
  });

  it("a safety poll that finds nothing new does not tell the app to read again", async () => {
    const { A, B, pondId } = await twoMembers();
    await settled(A, B);
    let changed = 0;
    A.service.on("changed", () => (changed += 1));
    A.service.onNotice(pondId, "poll");
    await wait(150);
    expect(changed).toBe(0);
    A.service.onNotice(pondId, "stream");
    await wait(150);
    expect(changed).toBe(1);
    A.service.stop();
    B.service.stop();
  });

  it("backs off on a 429, longer each time, and a notice during it starts no read", async () => {
    const { r, A, B, pondId } = await twoMembers();
    await settled(A, B);
    r.failing = "catalyst get failed: 429";
    A.service.onNotice(pondId, "stream");
    await wait(150);
    expect(A.service.backoffLeft(pondId)).toBe(30_000);
    const reads = A.service.takeStats().refreshes;
    expect(reads).toBe(1);
    A.service.onNotice(pondId, "stream");
    await wait(150);
    expect(A.service.takeStats().refreshes).toBe(0);
    // Past the first back-off a read is tried again; a second 429 doubles it.
    r.clock.t += 31_000;
    A.service.wake(pondId);
    await wait(100);
    expect(A.service.backoffLeft(pondId)).toBe(60_000);
    // The relay is back: the next read clears it.
    r.failing = null;
    r.clock.t += 61_000;
    A.service.wake(pondId);
    await wait(100);
    expect(A.service.backoffLeft(pondId)).toBe(0);
    A.service.stop();
    B.service.stop();
  });
});
