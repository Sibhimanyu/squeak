import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { FleetSnapshot } from "../fleet/fleet-monitor.js";
import type { ReplyOutcome } from "../fleet/session-reply.js";
import type { FleetSession } from "../fleet/types.js";
import type { ChannelDoc } from "./firestore-rest.js";
import type { NewChatWorkspace, StartChatOutcome } from "../fleet/new-chat.js";
import {
  phoneUsage,
  RemoteBridge,
  START_MIN_GAP_MS,
  type ChannelStore,
  type RemoteChatStarter,
  type RemoteCommand,
  type StartCommand,
} from "./remote-bridge.js";
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

function fixture(options: { outcome?: ReplyOutcome; turn?: string; newChat?: RemoteChatStarter } = {}) {
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
    newChat: options.newChat ?? null,
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

  const startCommand = (overrides: Partial<StartCommand> = {}, signer = phone) => {
    const body: StartCommand = {
      v: 1,
      kind: "start",
      workspaceId: "w1",
      agent: "claude",
      text: "Add a timer",
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
    startCommand,
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

function workspace(id: string, overrides: Partial<NewChatWorkspace> = {}): NewChatWorkspace {
  return {
    id,
    repoName: "farm",
    branch: `b-${id}`,
    lastActivityAt: "2026-09-25T02:00:00Z",
    defaultAgent: "codex",
    ...overrides,
  };
}

function chatStarter(workspaces: NewChatWorkspace[] = [workspace("w1")], outcome?: StartChatOutcome) {
  const starts: Array<{ workspaceId: string; agent: string; text: string }> = [];
  const starter: RemoteChatStarter = {
    workspaces: vi.fn(() => workspaces),
    start: vi.fn(async (args): Promise<StartChatOutcome> => {
      starts.push(args);
      return outcome ?? ({ ok: true, sessionId: "new-session" } as const);
    }),
  };
  return { starter, starts, workspaces };
}

describe("RemoteBridge starting a chat", () => {
  async function run(f: ReturnType<typeof fixture>, doc: ReturnType<ReturnType<typeof fixture>["startCommand"]>) {
    await f.store.set(`${f.channel}/commands/n1`, doc);
    await f.bridge.tick();
    return f.result("n1");
  }

  it("starts a chat in a listed workspace, with the agent and trimmed text the phone signed", async () => {
    const { starter, starts } = chatStarter();
    const f = fixture({ newChat: starter });
    await f.pair();
    expect(await run(f, f.startCommand({ agent: "codex", text: "  Add a timer \n" }))).toEqual({
      id: "n1",
      status: "sent",
      sessionId: "new-session",
    });
    expect(starts).toEqual([{ workspaceId: "w1", agent: "codex", text: "Add a timer" }]);
    expect(f.sends).toEqual([]); // never goes through the reply path
  });

  it("passes the relay's own refusal back", async () => {
    const { starter } = chatStarter([workspace("w1")], { ok: false, reason: "Conductor isn't connected." });
    const f = fixture({ newChat: starter });
    await f.pair();
    expect(await run(f, f.startCommand())).toEqual({
      id: "n1",
      status: "refused",
      reason: "Conductor isn't connected.",
    });
  });

  it("refuses everything when this Mac offers no new chats", async () => {
    const f = fixture();
    await f.pair();
    expect(await run(f, f.startCommand())).toMatchObject({ status: "refused" });
  });

  it("refuses a workspace the Mac does not publish, judged against the registry now", async () => {
    const { starter, starts } = chatStarter([workspace("w1")]);
    const f = fixture({ newChat: starter });
    await f.pair();
    expect(await run(f, f.startCommand({ workspaceId: "archived-one" }))).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("isn't available"),
    });
    expect(starts).toEqual([]);
  });

  it("refuses a workspace beyond the twenty it publishes", async () => {
    const many = Array.from({ length: 25 }, (_, i) => workspace(`w${i}`));
    const { starter, starts } = chatStarter(many);
    const f = fixture({ newChat: starter });
    await f.pair();
    expect(await run(f, f.startCommand({ workspaceId: "w21" }))).toMatchObject({ status: "refused" });
    expect(starts).toEqual([]);
  });

  it("refuses an empty message, one over 20,000 characters, and an unknown agent", async () => {
    const { starter, starts } = chatStarter();
    const f = fixture({ newChat: starter });
    await f.pair();
    await f.store.set(`${f.channel}/commands/a`, f.startCommand({ text: "   " }));
    await f.store.set(`${f.channel}/commands/b`, f.startCommand({ text: "x".repeat(20_001) }));
    await f.store.set(`${f.channel}/commands/c`, f.startCommand({ agent: "gemini" as never }));
    await f.bridge.tick();
    for (const id of ["a", "b", "c"]) expect(f.result(id)).toMatchObject({ status: "refused" });
    expect(starts).toEqual([]);
  });

  it("allows one start per device every 15 seconds", async () => {
    const { starter, starts } = chatStarter();
    const f = fixture({ newChat: starter });
    await f.pair();
    await f.store.set(`${f.channel}/commands/a`, f.startCommand());
    await f.bridge.tick();
    await f.store.set(`${f.channel}/commands/b`, f.startCommand());
    await f.bridge.tick();
    expect(f.result("a")).toMatchObject({ status: "sent" });
    expect(f.result("b")).toMatchObject({ status: "refused", reason: expect.stringContaining("just started") });
    expect(starts).toHaveLength(1);
    f.advance(START_MIN_GAP_MS);
    await f.store.set(`${f.channel}/commands/c`, f.startCommand());
    await f.bridge.tick();
    expect(f.result("c")).toMatchObject({ status: "sent" });
    expect(starts).toHaveLength(2);
  });

  it("keeps every existing check: signature, expiry, replay, revocation", async () => {
    const { starter, starts } = chatStarter();
    const f = fixture({ newChat: starter });
    await f.pair();
    await f.store.set(`${f.channel}/commands/forged`, f.startCommand({}, device()));
    await f.store.set(`${f.channel}/commands/old`, f.startCommand({ expiresAt: NOW - 1 }));
    await f.store.set(`${f.channel}/commands/far`, f.startCommand({ expiresAt: NOW + 3_600_000 }));
    await f.bridge.tick();
    expect(f.result("forged")).toBeNull();
    expect(f.result("old")).toMatchObject({ status: "refused" });
    expect(f.result("far")).toMatchObject({ status: "refused" });
    const signed = f.startCommand();
    await f.store.set(`${f.channel}/commands/one`, signed);
    await f.bridge.tick();
    f.advance(START_MIN_GAP_MS);
    await f.store.set(`${f.channel}/commands/replay`, signed);
    await f.bridge.tick();
    expect(f.result("replay")).toMatchObject({ status: "refused", reason: expect.stringContaining("already") });
    f.bridge.revoke("iphone-1");
    await f.store.set(`${f.channel}/commands/late`, f.startCommand());
    await f.bridge.tick();
    expect(f.result("late")).toBeNull();
    expect(starts).toHaveLength(1);
  });

  it("refuses a kind it does not know, and a start shaped like a reply", async () => {
    const { starter, starts } = chatStarter();
    const f = fixture({ newChat: starter });
    await f.pair();
    await f.store.set(`${f.channel}/commands/a`, f.startCommand({ kind: "stop" as never }));
    await f.store.set(`${f.channel}/commands/b`, f.startCommand({ workspaceId: undefined as never }));
    await f.bridge.tick();
    expect(f.result("a")).toMatchObject({ status: "refused" });
    expect(f.result("b")).toMatchObject({ status: "refused" });
    expect(starts).toEqual([]);
    expect(f.sends).toEqual([]);
  });

  it("publishes the workspaces, newest first, at most twenty, as 'repo · branch'", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      workspace(`w${i}`, { defaultAgent: i === 0 ? "claude" : "codex" }),
    );
    const f = fixture({ newChat: chatStarter(many).starter });
    const view = f.bridge.phoneView() as { workspaces?: Array<{ id: string; label: string; defaultAgent: string }> };
    expect(view.workspaces).toHaveLength(20);
    expect(view.workspaces![0]).toEqual({ id: "w0", label: "farm · b-w0", defaultAgent: "claude" });
    expect(view.workspaces![19]!.id).toBe("w19");
  });

  it("leaves workspaces out of the view when this Mac cannot start chats", () => {
    const f = fixture();
    expect("workspaces" in f.bridge.phoneView()).toBe(false);
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

/** A MemoryStore that streams like the Realtime Database: every write under a watched path wakes its watcher. */
class WatchingStore extends MemoryStore {
  readonly watchers = new Map<string, () => void>();
  stopped: string[] = [];
  watch(p: string, onChange: () => void) {
    this.watchers.set(p, onChange);
    return () => {
      this.watchers.delete(p);
      this.stopped.push(p);
    };
  }
  override async set(p: string, doc: ChannelDoc) {
    await super.set(p, doc);
    for (const [watched, onChange] of this.watchers) if (p === watched || p.startsWith(`${watched}/`)) onChange();
  }
}

describe("RemoteBridge on a streaming store (Realtime Database)", () => {
  const DB = "https://squeak-test-default-rtdb.asia-southeast1.firebasedatabase.app";

  function streaming() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-rtdb-"));
    dirs.push(dir);
    const store = new WatchingStore();
    const firestore = new MemoryStore();
    const sends: string[] = [];
    const replier = {
      lastTurnText: () => "Pick one?",
      lastTurnId: () => "turn-1",
      send: vi.fn(async (_sessionId: string, text: string) => {
        sends.push(text);
        return { status: "started", via: "conductor" } as ReplyOutcome;
      }),
    };
    const snapshot = {
      sessions: [session()],
      active: [session()],
      attention: [],
      generatedAt: "",
      codexUsage: null,
    } as FleetSnapshot;
    const bridge = new RemoteBridge({
      configPath: path.join(dir, "remote.json"),
      projectId: "squeak-test",
      store,
      announce: firestore,
      databaseUrl: DB,
      replier,
      snapshot: () => snapshot,
      now: () => Date.now(),
      macName: "Test Mac",
    });
    const pairing = bridge.startPairing();
    const payload = JSON.parse(Buffer.from(new URL(pairing.url).searchParams.get("d")!, "base64url").toString());
    return { bridge, store, firestore, sends, payload, channel: `channels/${payload.c}`, phone: device() };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("puts the database URL in the pairing code", () => {
    expect(streaming().payload.r).toBe(DB);
    expect(fixture().payload.r).toBeUndefined();
  });

  it("announces the database, sealed with the channel key, in Firestore for phones paired before the move", async () => {
    const { bridge, firestore, channel, payload } = streaming();
    await bridge.tick();
    await bridge.tick();
    const doc = firestore.docs.get(`${channel}/state/transport`)!;
    expect(open(payload.k, doc.box)).toEqual({ r: DB });
    expect(firestore.docs.size).toBe(1);
  });

  it("watches only what phones write: presence, pairing and commands", async () => {
    vi.useFakeTimers();
    const { bridge, store, channel } = streaming();
    bridge.start();
    expect([...store.watchers.keys()].sort()).toEqual([
      `${channel}/commands`,
      `${channel}/pairing`,
      `${channel}/state/presence`,
    ]);
    bridge.stop();
    expect(store.watchers.size).toBe(0);
  });

  it("runs a command as soon as it is written, without waiting for a poll", async () => {
    vi.useFakeTimers();
    const { bridge, store, channel, payload, phone, sends } = streaming();
    bridge.start();
    await vi.advanceTimersByTimeAsync(10);
    await store.set(`${channel}/pairing/iphone-1`, { box: seal(payload.k, { name: "iPhone", publicKey: phone.x963 }) });
    await vi.advanceTimersByTimeAsync(100);
    await bridge.approve("iphone-1");

    const body: RemoteCommand = {
      v: 1,
      sessionId: "s1",
      answersTurn: "turn-1",
      text: "B",
      nonce: crypto.randomBytes(16).toString("hex"),
      expiresAt: Date.now() + 60_000,
    };
    const box = seal(payload.k, body);
    await store.set(`${channel}/commands/c1`, { box, sig: phone.sign(box), device: "iphone-1" });
    await vi.advanceTimersByTimeAsync(100);
    expect(sends).toEqual(["B"]);
    expect(store.docs.has(`${channel}/commands/c1`)).toBe(false);
    expect(open(payload.k, store.docs.get(`${channel}/results/c1`)!.box)).toMatchObject({ status: "sent" });
    bridge.stop();
  });

  it("an unsigned command written to the stream still runs nothing", async () => {
    vi.useFakeTimers();
    const { bridge, store, channel, payload, sends } = streaming();
    bridge.start();
    await vi.advanceTimersByTimeAsync(10);
    await store.set(`${channel}/commands/forged`, { box: seal(payload.k, { v: 1, sessionId: "s1", text: "rm -rf" }) });
    await vi.advanceTimersByTimeAsync(100);
    expect(sends).toEqual([]);
    bridge.stop();
  });

  it("a change during a pass runs another pass right after it", async () => {
    vi.useFakeTimers();
    const { bridge, store, channel } = streaming();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const list = vi.spyOn(store, "list");
    // Hold the first pass inside its pairing read.
    list.mockImplementationOnce(async () => {
      await gate;
      return [];
    });
    const first = bridge.tick();
    await bridge.tick(); // arrives while busy: remembered, not dropped
    release();
    await first;
    await vi.advanceTimersByTimeAsync(5);
    expect(list.mock.calls.filter(([p]) => p === `${channel}/pairing`).length).toBeGreaterThanOrEqual(2);
    bridge.stop();
  });

  it("an announcement that fails never holds up the pass", async () => {
    const { bridge, firestore, store, channel, payload, phone } = streaming();
    vi.spyOn(firestore, "set").mockRejectedValue(new Error("firestore down"));
    await store.set(`${channel}/pairing/iphone-1`, { box: seal(payload.k, { name: "iPhone", publicKey: phone.x963 }) });
    await bridge.tick();
    expect((bridge.status() as { pending: unknown[] }).pending).toHaveLength(1);
  });
});
