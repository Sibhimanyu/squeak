import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { FleetSnapshot } from "../fleet/fleet-monitor.js";
import type { ReplyOutcome } from "../fleet/session-reply.js";
import type { FleetSession } from "../fleet/types.js";
import type { ChannelDoc } from "./firestore-rest.js";
import { phoneUsage, RemoteBridge, type ChannelStore, type RemoteCommand } from "./remote-bridge.js";
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
  let snapshot = {
    sessions: [session()],
    active: [session()],
    attention: [],
    generatedAt: "",
    codexUsage: null,
  } as FleetSnapshot;
  const listeners = new Set<(s: FleetSnapshot) => void>();
  const emit = (active: FleetSession[]) => {
    snapshot = { ...snapshot, sessions: active, active };
    for (const listener of listeners) listener(snapshot);
  };
  const configPath = path.join(dir, "remote.json");
  const bridge = new RemoteBridge({
    configPath,
    projectId: "squeak-test",
    store,
    replier,
    snapshot: () => snapshot,
    onSnapshot: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
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
    emit,
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

  it("passes a signed steer through, defaults to queue, and reports the delivery", async () => {
    const f = fixture({ outcome: { status: "started", via: "conductor", delivery: "steered" } });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.command({ mode: "steer" }));
    await f.store.set(`${f.channel}/commands/c2`, f.command());
    await f.bridge.tick();
    expect(f.replier.send.mock.calls.map((call) => (call as unknown[])[3])).toEqual([
      { mode: "steer" },
      { mode: "queue" },
    ]);
    expect(f.result("c1")).toMatchObject({ status: "sent", delivery: "steered" });
  });

  it("refuses a mode that is neither queue nor steer", async () => {
    const f = fixture();
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.command({ mode: "interrupt" as never }));
    await f.bridge.tick();
    expect(f.sends).toEqual([]);
    expect(f.result("c1")).toMatchObject({ status: "refused" });
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

  it("publishes a state change within about 300 ms instead of waiting for the next pass", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      await f.pair();
      f.bridge.start();
      await vi.advanceTimersByTimeAsync(0);
      f.emit([session()]); // first snapshot only sets the baseline
      const readState = () =>
        open<{ sessions: Array<{ state: string }> }>(f.payload.k, f.store.docs.get(`${f.channel}/state/snapshot`)!.box)
          .sessions[0]!.state;
      expect(readState()).toBe("finished");

      f.advance(2_000); // past the minimum gap between publishes
      f.emit([session({ state: "working" })]);
      await vi.advanceTimersByTimeAsync(100);
      expect(readState()).toBe("finished"); // debounced
      await vi.advanceTimersByTimeAsync(250);
      expect(readState()).toBe("working");

      // A newer timestamp alone is not a change worth a write.
      const before = f.store.docs.get(`${f.channel}/state/snapshot`)!.box;
      f.advance(2_000);
      f.emit([session({ state: "working", lastActivityAt: "2026-09-25T03:00:01.000Z" })]);
      await vi.advanceTimersByTimeAsync(500);
      expect(f.store.docs.get(`${f.channel}/state/snapshot`)!.box).toBe(before);
      f.bridge.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a minimum gap between change-driven publishes", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      await f.pair();
      f.bridge.start();
      await vi.advanceTimersByTimeAsync(0);
      f.emit([session()]);
      f.advance(2_000);
      f.emit([session({ state: "working" })]);
      await vi.advanceTimersByTimeAsync(350);
      const sets = vi.spyOn(f.store, "set");
      f.emit([session({ state: "finished" })]); // 350 ms after the last write
      await vi.advanceTimersByTimeAsync(400);
      expect(sets).not.toHaveBeenCalled();
      f.advance(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sets).toHaveBeenCalledTimes(1);
      f.bridge.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes nothing before any phone is paired", async () => {
    const f = fixture();
    await f.bridge.tick();
    expect(f.store.docs.has(`${f.channel}/state/snapshot`)).toBe(false);
  });
});

describe("RemoteBridge phone view activity", () => {
  function viewWith(sessions: FleetSession[], steps: number) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-activity-"));
    dirs.push(dir);
    const snapshot = { sessions, active: sessions, attention: [], generatedAt: "", codexUsage: null } as FleetSnapshot;
    const bridge = new RemoteBridge({
      configPath: path.join(dir, "remote.json"),
      projectId: "squeak-test",
      store: new MemoryStore(),
      replier: { lastTurnText: () => null, lastTurnId: () => null, send: vi.fn() },
      snapshot: () => snapshot,
      activity: () => ({
        total: steps,
        steps: Array.from({ length: steps }, (_, index) => ({
          kind: index % 2 ? ("tool" as const) : ("thinking" as const),
          text: `step ${index} ${"x".repeat(index === steps - 1 ? 400 : 0)}`.trim(),
          at: "2026-09-25T02:59:00.000Z",
        })),
      }),
      now: () => NOW,
      macName: "Test Mac",
    });
    return bridge.phoneView();
  }

  it("sends a working session's newest steps, clipped, without timestamps", () => {
    const view = viewWith([session({ state: "working" })], 9);
    const activity = view.sessions[0]!.activity!;

    expect(activity.total).toBe(9);
    expect(activity.steps.map((step) => step.text.slice(0, 6))).toEqual([
      "step 3",
      "step 4",
      "step 5",
      "step 6",
      "step 7",
      "step 8",
    ]);
    expect(activity.steps.at(-1)!.text.length).toBe(200);
    expect(activity.steps.at(-1)!.text.endsWith("…")).toBe(true);
    expect(Object.keys(activity.steps[0]!)).toEqual(["kind", "text"]);
  });

  it("sends no activity for a session that is not working", () => {
    expect(viewWith([session({ state: "finished" })], 3).sessions[0]!.activity).toBeNull();
  });

  it("sends the chat's own title for the row headline, never Conductor's placeholder", () => {
    const view = viewWith(
      [
        session({ key: "a", title: "Payment retry logic" }),
        session({ key: "b", title: "Untitled" }),
        session({ key: "c", title: null }),
      ],
      0,
    );
    expect(view.sessions.map((s) => s.title)).toEqual(["Payment retry logic", null, null]);
  });
});

describe("phoneUsage", () => {
  it("normalises both readings to percent used, with when each was observed", () => {
    const usage = phoneUsage(
      {
        planType: "pro",
        primary: { usedPercent: 9.04, windowMinutes: 300, resetsAt: "2026-09-25T06:40:00.000Z" },
        secondary: null,
        hasCredits: false,
        creditBalance: null,
        observedAt: "2026-09-25T02:59:30.000Z",
      },
      {
        fiveHour: { utilization: 0.4234, resetsAt: "2026-09-25T05:10:00.000Z" },
        sevenDay: null,
        observedAt: "2026-09-25T00:00:00.000Z",
      },
    );
    expect(usage.claude).toEqual({
      fiveHour: { usedPercent: 42.3, resetsAt: "2026-09-25T05:10:00.000Z" },
      sevenDay: null,
      observedAt: "2026-09-25T00:00:00.000Z",
    });
    expect(usage.codex?.fiveHour?.usedPercent).toBe(9);
    expect(usage.codex?.weekly).toBeNull();
  });

  it("is honest about a reading that has not been seen", () => {
    expect(phoneUsage(null, null)).toEqual({ claude: null, codex: null });
  });
});
