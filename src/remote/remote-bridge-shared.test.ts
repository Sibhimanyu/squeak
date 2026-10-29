import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { FleetSnapshot } from "../fleet/fleet-monitor.js";
import type { FleetSession } from "../fleet/types.js";
import type { ChannelDoc } from "./firestore-rest.js";
import { RemoteBridge, type ChannelStore } from "./remote-bridge.js";
import { open, seal } from "./remote-crypto.js";
import { BudgetedStore, CloudBudget, SHARED_BOX_MAX_CHARS, SHARED_RECENT_MIN_GAP_MS } from "./shared-limits.js";

const NOW = Date.parse("2026-09-25T03:00:00.000Z");

class Store implements ChannelStore {
  readonly docs = new Map<string, ChannelDoc>();
  readonly writes: string[] = [];
  readonly watchers = new Map<string, () => void>();
  watch(p: string, onChange: () => void) {
    this.watchers.set(p, onChange);
    return () => void this.watchers.delete(p);
  }
  async get(p: string) {
    return this.docs.get(p) ?? null;
  }
  async set(p: string, doc: ChannelDoc) {
    this.writes.push(p);
    this.docs.set(p, doc);
  }
  async list(collection: string) {
    return [...this.docs.entries()]
      .filter(([p]) => p.startsWith(`${collection}/`) && !p.slice(collection.length + 1).includes("/"))
      .map(([p, doc]) => ({ id: p.split("/").pop()!, doc }));
  }
  async delete(p: string) {
    this.docs.delete(p);
  }
}

function device() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const x963 = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x!, "base64url"),
    Buffer.from(jwk.y!, "base64url"),
  ]).toString("base64");
  const sign = (message: string) =>
    crypto.sign("sha256", Buffer.from(message), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
  return { x963, sign };
}

function chat(i: number, title = `Chat ${i}`): FleetSession {
  return {
    key: `claude-transcript:s${i}`,
    source: "claude-transcript",
    agent: "claude",
    origin: "conductor",
    sourceId: `s${i}`,
    agentSessionId: `s${i}`,
    conductorSessionId: `s${i}`,
    cwd: "/w",
    repoName: "farm",
    branch: `b${i}`,
    title,
    state: "finished",
    detail: "done",
    lastActivityAt: new Date(NOW - 60_000 * (i + 1)).toISOString(),
    transcriptPath: null,
    pid: null,
    alive: false,
    stateSource: "transcript",
    contextPercent: null,
    retired: false,
    baseRef: null,
    costUsd: null,
    git: null,
  } as FleetSession;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function shared(options: { sessions?: FleetSession[]; budgetBytes?: number; plain?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-shared-"));
  dirs.push(dir);
  const cloud = new Store();
  const budget = new CloudBudget(options.budgetBytes, () => now);
  const store = new BudgetedStore(cloud, budget);
  let now = NOW;
  let sessions = options.sessions ?? [];
  const liveActivity = vi.fn(() => ({ total: 1, steps: [] }));
  const bridge = new RemoteBridge({
    configPath: path.join(dir, "remote.json"),
    projectId: "squeak-shared",
    store: options.plain ? cloud : store,
    shared: options.plain ? null : { budget },
    replier: { lastTurnText: () => null, lastTurnId: () => null, send: vi.fn() },
    snapshot: () => ({ sessions, active: [], attention: [], generatedAt: "", codexUsage: null }) as FleetSnapshot,
    liveActivity,
    media: vi.fn(async () => ({ ok: false, reason: "never" }) as never),
    now: () => now,
  });
  const pairing = bridge.startPairing();
  const payload = JSON.parse(Buffer.from(new URL(pairing.url).searchParams.get("d")!, "base64url").toString());
  const channel = `channels/${payload.c}`;
  const phone = device();
  const presence = (watching?: string) =>
    cloud.set(`${channel}/state/presence`, {
      box: seal(payload.k, { at: now, caps: ["split"], ...(watching ? { watching } : {}) }),
    });
  const pair = async () => {
    await cloud.set(`${channel}/pairing/iphone-1`, { box: seal(payload.k, { name: "iPhone", publicKey: phone.x963 }) });
    await bridge.tick();
    await bridge.approve("iphone-1");
  };
  const command = async (id: string, body: Record<string, unknown>) => {
    const box = seal(payload.k, {
      v: 1,
      nonce: crypto.randomBytes(16).toString("hex"),
      expiresAt: now + 60_000,
      ...body,
    });
    await cloud.set(`${channel}/commands/${id}`, { box, sig: phone.sign(box), device: "iphone-1" });
    await bridge.tick();
    return open<Record<string, unknown>>(payload.k, cloud.docs.get(`${channel}/results/${id}`)!.box);
  };
  return {
    bridge,
    cloud,
    budget,
    payload,
    channel,
    presence,
    pair,
    command,
    liveActivity,
    advance: (ms: number) => (now += ms),
    setSessions: (next: FleetSession[]) => (sessions = next),
  };
}

describe("RemoteBridge on the shared server", () => {
  it("reports shared status with the budget, and nothing extra elsewhere", () => {
    const t = shared({ budgetBytes: 1000 });
    expect(t.bridge.status()).toMatchObject({ shared: true, usedBytes: 0, budgetBytes: 1000, pausedUntil: null });
    expect(shared({ plain: true }).bridge.status()).not.toHaveProperty("shared");
  });

  it("refuses verbose: a watched session publishes no live document", async () => {
    const t = shared({ sessions: [chat(1)] });
    await t.pair();
    await t.presence("claude-transcript:s1");
    await t.bridge.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([...t.cloud.docs.keys()].filter((key) => key.includes("/live/"))).toEqual([]);
    expect(t.liveActivity).not.toHaveBeenCalled();
    t.bridge.stop();
  });

  it("refuses films", async () => {
    const t = shared();
    await t.pair();
    const result = await t.command("m1", { kind: "media", filmId: "film:0123456789abcdef", source: "/x.mp4" });
    expect(result).toMatchObject({ status: "refused" });
    expect(String(result.reason)).toMatch(/shared server/);
    expect([...t.cloud.docs.keys()].some((key) => key.includes("/media/"))).toBe(false);
    t.bridge.stop();
  });

  it("writes `recent` at most every 5 minutes", async () => {
    const t = shared({ sessions: [chat(1)] });
    await t.pair();
    await t.presence();
    await t.bridge.tick();
    const recentWrites = () => t.cloud.writes.filter((p) => p.endsWith("/state/recent")).length;
    expect(recentWrites()).toBe(1);
    t.setSessions([chat(1), chat(2)]);
    t.advance(60_000);
    await t.bridge.tick();
    expect(recentWrites()).toBe(1);
    t.advance(SHARED_RECENT_MIN_GAP_MS);
    await t.bridge.tick();
    expect(recentWrites()).toBe(2);
    t.bridge.stop();
  });

  it("trims the oldest recent chats until the box is under 60000 characters", async () => {
    const big = () => crypto.randomBytes(1500).toString("hex");
    const sessions = Array.from({ length: 50 }, (_, i) => chat(i, big()));
    const t = shared({ sessions });
    await t.pair();
    await t.presence();
    await t.bridge.tick();
    const doc = t.cloud.docs.get(`${t.channel}/state/recent`)!;
    expect(doc.box.length).toBeLessThan(SHARED_BOX_MAX_CHARS);
    const view = open<{ recent: Array<{ title: string }> }>(t.payload.k, doc.box);
    expect(view.recent.length).toBeGreaterThan(0);
    expect(view.recent.length).toBeLessThan(50);
    expect(view.recent[0]!.title).toBe(sessions[0]!.title);
    t.bridge.stop();
  });

  it("stops cloud reads and writes once the budget is spent, and writes again the next day", async () => {
    const t = shared({ sessions: [chat(1)], budgetBytes: 1 });
    await t.pair();
    await t.presence();
    await t.bridge.tick();
    expect(t.budget.exceeded()).toBe(true);
    expect(t.bridge.status()).toMatchObject({ shared: true, pausedUntil: expect.any(Number) });
    const before = t.cloud.writes.length;
    t.setSessions([chat(1), chat(2)]);
    t.advance(10 * 60_000);
    await t.bridge.tick();
    expect(t.cloud.writes.length).toBe(before);
    t.advance(24 * 60 * 60_000);
    await t.presence();
    await t.bridge.tick();
    expect(t.cloud.writes.length).toBeGreaterThan(before);
    t.bridge.stop();
  });
});
