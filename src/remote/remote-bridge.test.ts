import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { FleetSnapshot } from "../fleet/fleet-monitor.js";
import type { ReplyOutcome } from "../fleet/session-reply.js";
import type { FleetSession } from "../fleet/types.js";
import type { ChannelDoc } from "./firestore-rest.js";
import { RemoteBridge, type ChannelStore, type RemoteCommand } from "./remote-bridge.js";
import { open, pairingCode, seal } from "./remote-crypto.js";

const NOW = Date.parse("2026-09-25T03:00:00.000Z");

class MemoryStore implements ChannelStore {
  readonly docs = new Map<string, ChannelDoc>();
  async get(p: string) {
    return this.docs.get(p) ?? null;
  }
  async set(p: string, doc: ChannelDoc) {
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

/** A device key signing like CryptoKit: raw r‖s over the box string. */
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

function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    key: "claude-transcript:s1",
    source: "claude-transcript",
    agent: "claude",
    origin: "conductor",
    sourceId: "s1",
    agentSessionId: "s1",
    conductorSessionId: "s1",
    cwd: "/w",
    repoName: "farm",
    branch: "arm",
    title: "Farm",
    state: "finished",
    detail: "D1?",
    lastActivityAt: "2026-09-25T02:59:00.000Z",
    transcriptPath: null,
    pid: null,
    alive: false,
    stateSource: "transcript",
    contextPercent: null,
    retired: false,
    baseRef: null,
    costUsd: null,
    git: null,
    ...overrides,
  } as FleetSession;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(options: { outcome?: ReplyOutcome; turn?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-"));
  dirs.push(dir);
  const store = new MemoryStore();
  const sends: Array<{ sessionId: string; text: string }> = [];
  let now = NOW;
  const replier = {
    lastTurnText: () => "Pick one?\nA) Arm now\nB) Later",
    lastTurnId: vi.fn(() => options.turn ?? "turn-1"),
    send: vi.fn(async (sessionId: string, text: string) => {
      sends.push({ sessionId, text });
      return options.outcome ?? ({ status: "started", via: "conductor" } as ReplyOutcome);
    }),
  };
  const snapshot = {
    sessions: [session()],
    active: [session()],
    attention: [],
    generatedAt: "",
    codexUsage: null,
  } as FleetSnapshot;
  const configPath = path.join(dir, "remote.json");
  const bridge = new RemoteBridge({
    configPath,
    projectId: "squeak-test",
    store,
    replier,
    snapshot: () => snapshot,
    now: () => now,
    macName: "Test Mac",
  });

  const pairing = bridge.startPairing();
  const payload = JSON.parse(Buffer.from(new URL(pairing.url).searchParams.get("d")!, "base64url").toString());
  const channel = `channels/${payload.c}`;
  const phone = device();

  const pair = async () => {
    await store.set(`${channel}/pairing/iphone-1`, { box: seal(payload.k, { name: "iPhone", publicKey: phone.x963 }) });
    await bridge.tick();
    await bridge.approve("iphone-1");
  };

  const command = (overrides: Partial<RemoteCommand> = {}, signer = phone) => {
    const body: RemoteCommand = {
      v: 1,
      sessionId: "s1",
      answersTurn: "turn-1",
      text: "B",
      nonce: crypto.randomBytes(16).toString("hex"),
      expiresAt: now + 60_000,
      ...overrides,
    };
    const box = seal(payload.k, body);
    return { box, sig: signer.sign(box), device: "iphone-1" };
  };

  const result = (id: string) => {
    const doc = store.docs.get(`${channel}/results/${id}`);
    return doc ? open<Record<string, unknown>>(payload.k, doc.box) : null;
  };

  return {
    bridge,
    store,
    sends,
    replier,
    payload,
    channel,
    phone,
    pair,
    command,
    result,
    configPath,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("RemoteBridge pairing", () => {
  it("hands out a QR payload with the channel, key and project, and keeps the secret on disk 0600", () => {
    const { payload, configPath } = fixture();
    expect(payload).toMatchObject({ v: 1, p: "squeak-test", n: "Test Mac" });
    expect(payload.c).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(payload.k, "base64")).toHaveLength(32);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("holds a pairing request until it is approved on the Mac, showing the code the phone shows", async () => {
    const { bridge, store, channel, payload, phone } = fixture();
    await store.set(`${channel}/pairing/iphone-1`, { box: seal(payload.k, { name: "iPhone", publicKey: phone.x963 }) });
    await bridge.tick();

    const status = bridge.status() as { pending: Array<{ id: string; code: string }>; devices: unknown[] };
    expect(status.pending).toEqual([expect.objectContaining({ id: "iphone-1", code: pairingCode(phone.x963) })]);
    expect(status.devices).toEqual([]);

    expect(await bridge.approve("iphone-1")).toBe(true);
    expect((bridge.status() as { devices: unknown[] }).devices).toHaveLength(1);
    const answer = store.docs.get(`${channel}/results/pair-iphone-1`)!;
    expect(open(payload.k, answer.box)).toMatchObject({ approved: true });
    expect(store.docs.has(`${channel}/pairing/iphone-1`)).toBe(false);
  });

  it("ignores pairing requests it cannot decrypt", async () => {
    const { bridge, store, channel } = fixture();
    await store.set(`${channel}/pairing/intruder`, {
      box: seal(crypto.randomBytes(32).toString("base64"), { name: "x", publicKey: "y" }),
    });
    await bridge.tick();
    expect((bridge.status() as { pending: unknown[] }).pending).toEqual([]);
  });
});

describe("RemoteBridge commands", () => {
  it("sends a signed, current, fresh reply exactly once and reports how it went", async () => {
    const f = fixture();
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.command());
    await f.bridge.tick();

    expect(f.sends).toEqual([{ sessionId: "s1", text: "B" }]);
    expect(f.result("c1")).toMatchObject({ status: "sent", via: "conductor" });
    expect(f.store.docs.has(`${f.channel}/commands/c1`)).toBe(false);
  });

  it("does nothing, and says nothing, for a command signed by an unpaired key", async () => {
    const f = fixture();
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.command({}, device()));
    await f.bridge.tick();
    expect(f.sends).toEqual([]);
    expect(f.result("c1")).toBeNull();
  });

  it("does nothing for an unsigned command, even one sealed with the right key", async () => {
    const f = fixture();
    await f.pair();
    const { box } = f.command();
    await f.store.set(`${f.channel}/commands/c1`, { box, device: "iphone-1" });
    await f.bridge.tick();
    expect(f.sends).toEqual([]);
  });

  it("stops obeying a device the moment it is revoked", async () => {
    const f = fixture();
    await f.pair();
    f.bridge.revoke("iphone-1");
    await f.store.set(`${f.channel}/commands/c1`, f.command());
    await f.bridge.tick();
    expect(f.sends).toEqual([]);
  });

  it("refuses an expired command, and one claiming to live longer than allowed", async () => {
    const f = fixture();
    await f.pair();
    await f.store.set(`${f.channel}/commands/old`, f.command({ expiresAt: NOW - 1 }));
    await f.store.set(`${f.channel}/commands/far`, f.command({ expiresAt: NOW + 3_600_000 }));
    await f.bridge.tick();
    expect(f.sends).toEqual([]);
    expect(f.result("old")).toMatchObject({ status: "refused" });
    expect(f.result("far")).toMatchObject({ status: "refused" });
  });

  it("refuses a replayed command", async () => {
    const f = fixture();
    await f.pair();
    const signed = f.command();
    await f.store.set(`${f.channel}/commands/c1`, signed);
    await f.bridge.tick();
    await f.store.set(`${f.channel}/commands/c2`, signed);
    await f.bridge.tick();
    expect(f.sends).toHaveLength(1);
    expect(f.result("c2")).toMatchObject({ status: "refused", reason: expect.stringContaining("already") });
  });

  it("refuses a letter meant for a question the chat has moved past", async () => {
    const f = fixture({ turn: "turn-2" });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.command({ answersTurn: "turn-1" }));
    await f.bridge.tick();
    expect(f.sends).toEqual([]);
    expect(f.result("c1")).toMatchObject({ status: "refused", reason: expect.stringContaining("moved on") });
  });

  it("passes the replier's own refusal back to the phone", async () => {
    const f = fixture({ outcome: { status: "refused", reason: "That chat is still working in Conductor." } });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.command());
    await f.bridge.tick();
    expect(f.result("c1")).toEqual({ id: "c1", status: "refused", reason: "That chat is still working in Conductor." });
  });
});

describe("RemoteBridge snapshot", () => {
  it("publishes an encrypted view with the full message, its choices and the current turn", async () => {
    const f = fixture();
    await f.pair();
    await f.bridge.tick();
    const doc = f.store.docs.get(`${f.channel}/state/snapshot`)!;
    expect(doc.box).not.toContain("Arm now");
    const view = open<{ sessions: Array<Record<string, unknown>> }>(f.payload.k, doc.box);
    expect(view.sessions[0]).toMatchObject({
      conductorSessionId: "s1",
      label: "farm · arm",
      turnId: "turn-1",
      choices: {
        options: [
          { letter: "A", title: "Arm now" },
          { letter: "B", title: "Later" },
        ],
      },
    });
  });

  it("publishes nothing before any phone is paired", async () => {
    const f = fixture();
    await f.bridge.tick();
    expect(f.store.docs.has(`${f.channel}/state/snapshot`)).toBe(false);
  });
});
