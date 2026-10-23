import type { Answerer } from "../fleet/answer-command.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyAwakeAction, AwakeSession, readAwakeAction } from "../fleet/awake-session.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FleetSnapshot } from "../fleet/fleet-monitor.js";
import type { TranscriptMessage } from "../fleet/transcript.js";
import type { PhoneImageResult } from "./phone-image.js";
import type { QueueAction, QueueItem, ReplyOutcome } from "../fleet/session-reply.js";
import type { FleetSession } from "../fleet/types.js";
import type { ChannelDoc } from "./firestore-rest.js";
import type { NewChatWorkspace, StartChatOutcome } from "../fleet/new-chat.js";
import {
  phoneUsage,
  MEDIA_CHUNK_BYTES,
  MEDIA_TTL_MS,
  RemoteBridge,
  START_MIN_GAP_MS,
  type ChannelStore,
  type RemoteChatStarter,
  type QueueCommand,
  type RemoteBridgeDependencies,
  type RemoteDiffReader,
  type RemoteCommand,
  type RemoteWorkflows,
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

const QUEUED_ID = "0f4c8a52-3c1e-4b9e-9a57-6f0e2d1c7b31";

function fixture(
  options: {
    outcome?: ReplyOutcome;
    turn?: string;
    newChat?: RemoteChatStarter;
    /** The chat's queue as the replier reads it; `"none"` = a replier without queue support. */
    queue?: QueueItem[] | null | "none";
    queueOutcome?: { ok: true } | { ok: false; reason: string };
    /** What the replier's Stop answers; `"none"` = a replier that cannot stop. */
    stopOutcome?: { ok: true } | { ok: false; reason: string } | "none";
    answerer?: Answerer | null;
    diff?: RemoteDiffReader | null;
    image?: ((source: string, cwd: string) => Promise<PhoneImageResult>) | null;
    hotspot?: RemoteBridgeDependencies["hotspot"];
    workflow?: RemoteWorkflows | null;
    media?: RemoteBridgeDependencies["media"];
    renamer?: RemoteBridgeDependencies["renamer"];
    /** The chat's latest message, as the replier reads it. */
    lastText?: string;
    /** Why the chat's newest turn failed, as the replier reads it. */
    failure?: string | null;
    /** A store that streams, like the Realtime Database. */
    streaming?: boolean;
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-"));
  dirs.push(dir);
  const store = options.streaming ? new WatchingStore() : new MemoryStore();
  const sends: Array<{ sessionId: string; text: string }> = [];
  let now = NOW;
  const replier = {
    lastTurnText: () => options.lastText ?? "Pick one?\nA) Arm now\nB) Later",
    lastTurnError: vi.fn(() => options.failure ?? null),
    lastTurnId: vi.fn(() => options.turn ?? "turn-1"),
    send: vi.fn(async (sessionId: string, text: string) => {
      sends.push({ sessionId, text });
      return options.outcome ?? ({ status: "started", via: "conductor" } as ReplyOutcome);
    }),
    ...(options.stopOutcome === "none"
      ? {}
      : {
          stopTurn: vi.fn<(sessionId: string) => Promise<{ ok: true } | { ok: false; reason: string }>>(async () =>
            options.stopOutcome === "none" ? { ok: true } : (options.stopOutcome ?? { ok: true }),
          ),
        }),
    ...(options.queue === "none"
      ? {}
      : {
          queue: vi.fn<(sessionId: string) => Promise<QueueItem[] | null>>(async () =>
            options.queue === undefined || options.queue === "none"
              ? [{ id: QUEUED_ID, text: "Then add tests", mode: "queue" as const, position: 0 }]
              : options.queue,
          ),
          queueAction: vi.fn<
            (
              sessionId: string,
              messageId: string,
              action: QueueAction,
            ) => Promise<{ ok: true } | { ok: false; reason: string }>
          >(async () => options.queueOutcome ?? { ok: true }),
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
    answerer: options.answerer ?? null,
    diff: options.diff ?? null,
    renamer: options.renamer ?? null,
    image: options.image ?? null,
    hotspot: options.hotspot ?? null,
    workflow: options.workflow ?? null,
    media: options.media ?? null,
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

  const answerCommand = (overrides: Record<string, unknown> = {}, signer = phone) => {
    const body = {
      v: 1,
      kind: "answer",
      sessionId: "s1",
      toolUseId: "toolu_q1",
      answers: [{ question: 0, picked: ["Red"] }],
      nonce: crypto.randomBytes(16).toString("hex"),
      expiresAt: now + 60_000,
      ...overrides,
    };
    const box = seal(payload.k, body);
    return { box, sig: signer.sign(box), device: "iphone-1" };
  };

  const queueCommand = (overrides: Partial<QueueCommand> = {}, signer = phone) => {
    const body: QueueCommand = {
      v: 1,
      kind: "queue",
      sessionId: "s1",
      messageId: QUEUED_ID,
      action: "promote",
      nonce: crypto.randomBytes(16).toString("hex"),
      expiresAt: now + 60_000,
      ...overrides,
    };
    const box = seal(payload.k, body);
    return { box, sig: signer.sign(box), device: "iphone-1" };
  };

  const stopCommand = (overrides: Record<string, unknown> = {}, signer = phone) => {
    const body = {
      v: 1,
      kind: "stop",
      sessionId: "s1",
      answersTurn: "turn-1",
      nonce: crypto.randomBytes(16).toString("hex"),
      expiresAt: now + 60_000,
      ...overrides,
    };
    const box = seal(payload.k, body);
    return { box, sig: signer.sign(box), device: "iphone-1" };
  };

  const renameCommand = (overrides: Record<string, unknown> = {}, signer = phone) => {
    const body = {
      v: 1,
      kind: "rename",
      sessionId: "s1",
      title: "Coupon codes at checkout",
      nonce: crypto.randomBytes(16).toString("hex"),
      expiresAt: now + 60_000,
      ...overrides,
    };
    const box = seal(payload.k, body);
    return { box, sig: signer.sign(box), device: "iphone-1" };
  };

  const diffCommand = (overrides: Record<string, unknown> = {}, signer = phone) => {
    const body = {
      v: 1,
      kind: "diff",
      sessionId: "s1",
      nonce: crypto.randomBytes(16).toString("hex"),
      expiresAt: now + 60_000,
      ...overrides,
    };
    const box = seal(payload.k, body);
    return { box, sig: signer.sign(box), device: "iphone-1" };
  };

  const imageCommand = (overrides: Record<string, unknown> = {}, signer = phone) => {
    const body = {
      v: 1,
      kind: "image",
      sessionId: "s1",
      source: "/w/.context/shot.png",
      nonce: crypto.randomBytes(16).toString("hex"),
      expiresAt: now + 60_000,
      ...overrides,
    };
    const box = seal(payload.k, body);
    return { box, sig: signer.sign(box), device: "iphone-1" };
  };

  const hotspotCommand = (overrides: Record<string, unknown> = {}, signer = phone) => {
    const body = {
      v: 1,
      kind: "hotspot",
      action: "join",
      nonce: crypto.randomBytes(16).toString("hex"),
      expiresAt: now + 60_000,
      ...overrides,
    };
    const box = seal(payload.k, body);
    return { box, sig: signer.sign(box), device: "iphone-1" };
  };

  const workflowCommand = (overrides: Record<string, unknown> = {}, signer = phone) => {
    const body = {
      v: 1,
      kind: "workflow",
      sessionKey: "claude-transcript:d1",
      step: "look",
      revision: "look@1",
      type: "choose",
      value: "wild",
      nonce: crypto.randomBytes(16).toString("hex"),
      expiresAt: now + 60_000,
      ...overrides,
    };
    const box = seal(payload.k, body);
    return { box, sig: signer.sign(box), device: "iphone-1" };
  };

  const mediaCommand = (overrides: Record<string, unknown> = {}, signer = phone) => {
    const body = {
      v: 1,
      kind: "media",
      sessionKey: "claude-transcript:d1",
      source: "exports/film.mp4",
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
    answerCommand,
    queueCommand,
    stopCommand,
    renameCommand,
    diffCommand,
    imageCommand,
    hotspotCommand,
    workflowCommand,
    mediaCommand,
    dir,
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

  it("passes the phone's own message id through, so it can find the message in Conductor's queue", async () => {
    const f = fixture();
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.command({ messageId: QUEUED_ID }));
    await f.bridge.tick();
    expect(f.replier.send.mock.calls.map((call) => (call as unknown[])[3])).toEqual([
      { mode: "queue", messageId: QUEUED_ID },
    ]);
    expect(f.result("c1")).toMatchObject({ status: "sent" });
  });

  it("refuses a message id that is not a lowercase UUID", async () => {
    const f = fixture();
    await f.pair();
    const bad = [QUEUED_ID.toUpperCase(), "not-a-uuid", 42 as never, "", `${QUEUED_ID}x`];
    for (const [index, messageId] of bad.entries()) {
      await f.store.set(`${f.channel}/commands/c${index}`, f.command({ messageId }));
    }
    await f.bridge.tick();
    expect(f.sends).toEqual([]);
    for (const index of bad.keys()) {
      expect(f.result(`c${index}`)).toMatchObject({ status: "refused", reason: "Not a reply this Mac understands." });
    }
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

describe("RemoteBridge hotspot", () => {
  const state = { configured: true, ssid: "Phone", enabled: true, onHotspot: false, last: null };
  const hotspot = (outcome: { ok: true } | { ok: false; reason: string } = { ok: true }) => ({
    state: () => state,
    apply: vi.fn(async () => (outcome.ok ? { ok: true as const, state } : outcome)),
  });

  it("hands the phone's request to the Mac's failover, and shows its state without the password", async () => {
    const h = hotspot();
    const f = fixture({ hotspot: h });
    await f.pair();
    await f.store.set(
      `${f.channel}/commands/c1`,
      f.hotspotCommand({ action: "configure", ssid: "Phone", password: "secret-pass", enabled: true }),
    );
    await f.bridge.tick();
    expect(h.apply).toHaveBeenCalledWith({
      action: "configure",
      ssid: "Phone",
      password: "secret-pass",
      enabled: true,
    });
    expect(f.result("c1")).toEqual({ id: "c1", status: "sent" });
    expect(JSON.stringify(f.bridge.phoneView())).not.toContain("secret-pass");
    expect(f.bridge.phoneView()).toMatchObject({ hotspot: state });
  });

  it("passes the failover's refusal back, and refuses without one", async () => {
    const f = fixture({ hotspot: hotspot({ ok: false, reason: "Set up your hotspot's name and password first." }) });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.hotspotCommand());
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({ status: "refused", reason: /Set up/ });
    const bare = fixture();
    await bare.pair();
    await bare.store.set(`${bare.channel}/commands/c1`, bare.hotspotCommand());
    await bare.bridge.tick();
    expect(bare.result("c1")).toMatchObject({
      status: "refused",
      reason: "This Mac can't use a hotspot from a phone.",
    });
    expect(bare.bridge.phoneView()).not.toHaveProperty("hotspot");
  });
});

describe("RemoteBridge image", () => {
  const shown = "Here it is.\n\n![Shot](</w/.context/shot.png>)";
  const ok = async (): Promise<PhoneImageResult> => ({ ok: true, image: { mime: "image/jpeg", data: "AAAA" } });

  it("sends an image the chat's own message names, read in the chat's workspace", async () => {
    const image = vi.fn(ok);
    const f = fixture({ image, lastText: shown });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.imageCommand());
    await f.bridge.tick();
    expect(image).toHaveBeenCalledWith("/w/.context/shot.png", "/w");
    expect(f.result("c1")).toEqual({ id: "c1", status: "sent", image: { mime: "image/jpeg", data: "AAAA" } });
  });

  it("refuses a path the chat never named, without reading anything", async () => {
    const image = vi.fn(ok);
    const f = fixture({ image, lastText: shown });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.imageCommand({ source: "/Users/me/.ssh/id_rsa.png" }));
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({ status: "refused", reason: "That image isn't in this chat." });
    expect(image).not.toHaveBeenCalled();
  });

  it("passes the reader's refusal back, and refuses without a reader or for another chat", async () => {
    const f = fixture({ image: async () => ({ ok: false, reason: "That isn't an image file." }), lastText: shown });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.imageCommand());
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({ status: "refused", reason: "That isn't an image file." });
    await f.store.set(`${f.channel}/commands/c2`, f.imageCommand({ sessionId: "s-elsewhere" }));
    await f.bridge.tick();
    expect(f.result("c2")).toMatchObject({ status: "refused", reason: "That chat isn't on your phone any more." });
    const bare = fixture({ lastText: shown });
    await bare.pair();
    await bare.store.set(`${bare.channel}/commands/c1`, bare.imageCommand());
    await bare.bridge.tick();
    expect(bare.result("c1")).toMatchObject({ status: "refused", reason: "This Mac can't send images to a phone." });
  });
});

describe("RemoteBridge diff", () => {
  const file = { path: "src/a.ts", insertions: 3, deletions: 1, binary: false, untracked: false };
  const summary = { baseRef: "origin/main", files: [file], insertions: 3, deletions: 1, truncated: false };
  const reader = () => ({
    readSummary: vi.fn(async () => summary),
    readFilePatch: vi.fn(async () => "@@ -1 +1 @@\n-a\n+b"),
  });

  it("answers with the chat's file list, read from the Mac's own folder and base branch", async () => {
    const diff = reader();
    const f = fixture({ diff });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.diffCommand());
    await f.bridge.tick();
    expect(diff.readSummary).toHaveBeenCalledWith("/w", null);
    expect(f.result("c1")).toEqual({ id: "c1", status: "sent", diff: summary });
    expect(diff.readFilePatch).not.toHaveBeenCalled();
  });

  it("adds one file's patch when the phone names its index", async () => {
    const diff = reader();
    const f = fixture({ diff });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.diffCommand({ file: 0 }));
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({ patch: { index: 0, path: "src/a.ts", text: "@@ -1 +1 @@\n-a\n+b" } });
    await f.store.set(`${f.channel}/commands/c2`, f.diffCommand({ file: 5 }));
    await f.bridge.tick();
    expect(f.result("c2")).toMatchObject({ status: "refused", reason: "That file isn't in the changes any more." });
  });

  it("refuses a chat the phone is not shown, a Mac without a reader, and a malformed request", async () => {
    const f = fixture({ diff: reader() });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.diffCommand({ sessionId: "s-elsewhere" }));
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({ status: "refused", reason: "That chat isn't on your phone any more." });
    await f.store.set(`${f.channel}/commands/c2`, f.diffCommand({ file: -1 }));
    await f.bridge.tick();
    expect(f.result("c2")).toMatchObject({ status: "refused", reason: "Not a request this Mac understands." });
    const bare = fixture();
    await bare.pair();
    await bare.store.set(`${bare.channel}/commands/c1`, bare.diffCommand());
    await bare.bridge.tick();
    expect(bare.result("c1")).toMatchObject({ status: "refused", reason: "This Mac can't show changes on a phone." });
  });
});

describe("RemoteBridge rename", () => {
  it("renames a chat the phone is shown, to one clean line", async () => {
    const renames: Array<[string, string]> = [];
    const f = fixture({ renamer: { rename: (id, title) => (renames.push([id, title]), true) } });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.renameCommand({ title: "  Fix\nthe   splitter\u0007  " }));
    await f.bridge.tick();
    expect(f.result("c1")).toEqual({ id: "c1", status: "sent" });
    expect(renames).toEqual([["s1", "Fix the splitter"]]);
    expect(f.sends).toEqual([]);
  });

  it("refuses an empty or long name, a chat not shown, a Mac that cannot, and a refusal from Conductor", async () => {
    const renames: Array<[string, string]> = [];
    const f = fixture({ renamer: { rename: (id, title) => (renames.push([id, title]), true) } });
    await f.pair();
    await f.store.set(`${f.channel}/commands/a`, f.renameCommand({ title: "   " }));
    await f.store.set(`${f.channel}/commands/b`, f.renameCommand({ title: "x".repeat(121) }));
    await f.store.set(`${f.channel}/commands/c`, f.renameCommand({ sessionId: "s-elsewhere" }));
    await f.store.set(`${f.channel}/commands/d`, f.renameCommand({ title: 7 as never }));
    await f.bridge.tick();
    for (const id of ["a", "b", "c", "d"]) expect(f.result(id)).toMatchObject({ status: "refused" });
    expect(renames).toEqual([]);
    const none = fixture();
    await none.pair();
    await none.store.set(`${none.channel}/commands/e`, none.renameCommand());
    await none.bridge.tick();
    expect(none.result("e")).toMatchObject({ status: "refused", reason: "This Mac can't rename a chat from a phone." });
    const no = fixture({ renamer: { rename: () => false } });
    await no.pair();
    await no.store.set(`${no.channel}/commands/f`, no.renameCommand());
    await no.bridge.tick();
    expect(no.result("f")).toMatchObject({ status: "refused", reason: "Conductor didn't take the new name." });
  });
});

describe("RemoteBridge stop", () => {
  it("stops a working chat when the phone signs it for the turn it saw", async () => {
    const f = fixture();
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.stopCommand());
    await f.bridge.tick();
    expect(f.replier.stopTurn!.mock.calls).toEqual([["s1"]]);
    expect(f.result("c1")).toEqual({ id: "c1", status: "sent" });
    expect(f.sends).toEqual([]);
  });

  it("takes a Stop with no turn named for a chat that has none", async () => {
    const f = fixture();
    f.replier.lastTurnId.mockReturnValue(null as unknown as string);
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.stopCommand({ answersTurn: undefined }));
    await f.bridge.tick();
    expect(f.result("c1")).toEqual({ id: "c1", status: "sent" });
  });

  it("refuses a Stop for a turn that already ended", async () => {
    const f = fixture({ turn: "turn-2" });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.stopCommand());
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({ status: "refused", reason: "That turn already ended." });
    expect(f.replier.stopTurn).not.toHaveBeenCalled();
  });

  it("passes the replier's refusal back, and refuses a chat the phone is not shown", async () => {
    const f = fixture({ stopOutcome: { ok: false, reason: "The agent isn't working any more." } });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.stopCommand());
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({ status: "refused", reason: "The agent isn't working any more." });
    await f.store.set(`${f.channel}/commands/c2`, f.stopCommand({ sessionId: "s-elsewhere" }));
    await f.bridge.tick();
    expect(f.result("c2")).toMatchObject({ status: "refused", reason: "That chat isn't on your phone any more." });
  });

  it("is refused by a Mac that cannot stop, and refuses a malformed Stop", async () => {
    const f = fixture({ stopOutcome: "none" });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.stopCommand());
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({ status: "refused", reason: "This Mac can't stop an agent from a phone." });
    await f.store.set(`${f.channel}/commands/c2`, f.stopCommand({ sessionId: 7 }));
    await f.bridge.tick();
    expect(f.result("c2")).toMatchObject({ status: "refused", reason: "Not a request this Mac understands." });
  });
});

describe("RemoteBridge queued messages", () => {
  it("steers a queued message in, and deletes one, when the phone signs it", async () => {
    const f = fixture();
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.queueCommand());
    await f.bridge.tick();
    await f.store.set(`${f.channel}/commands/c2`, f.queueCommand({ action: "cancel" }));
    await f.bridge.tick();
    expect(f.replier.queueAction!.mock.calls).toEqual([
      ["s1", QUEUED_ID, "promote"],
      ["s1", QUEUED_ID, "cancel"],
    ]);
    expect(f.result("c1")).toEqual({ id: "c1", status: "sent" });
    expect(f.result("c2")).toEqual({ id: "c2", status: "sent" });
    expect(f.sends).toEqual([]);
  });

  it("names no turn: the queued message is the anchor, so a chat that moved on still takes it", async () => {
    const f = fixture({ turn: "turn-9" });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.queueCommand());
    await f.bridge.tick();
    expect(f.result("c1")).toEqual({ id: "c1", status: "sent" });
  });

  it("refuses a message that has already left the queue", async () => {
    const f = fixture({ queue: [] });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.queueCommand());
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({ status: "refused", reason: "That message already went to the agent." });
    expect(f.replier.queueAction).not.toHaveBeenCalled();
  });

  it("refuses when the queue cannot be read, without claiming the message went", async () => {
    const f = fixture({ queue: null });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.queueCommand());
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({
      status: "refused",
      reason: "This Mac can't read that chat's queue right now.",
    });
    expect(f.replier.queueAction).not.toHaveBeenCalled();
  });

  it("is refused by a Mac whose replier cannot change queued messages", async () => {
    const f = fixture({ queue: "none" });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.queueCommand());
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({ status: "refused", reason: "This Mac can't change queued messages." });
  });

  it("refuses a chat the phone is not shown, judged against the Mac's snapshot", async () => {
    const f = fixture();
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.queueCommand({ sessionId: "s-elsewhere" }));
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({ status: "refused", reason: "That chat isn't on your phone any more." });
    expect(f.replier.queue).not.toHaveBeenCalled();
  });

  it("refuses a malformed request: bad id, unknown action, missing session", async () => {
    const f = fixture();
    await f.pair();
    const bad: Array<Partial<QueueCommand>> = [
      { messageId: "nope" },
      { messageId: QUEUED_ID.toUpperCase() },
      { action: "reorder" as never },
      { sessionId: 7 as never },
      { v: 2 as never },
    ];
    for (const [index, overrides] of bad.entries()) {
      await f.store.set(`${f.channel}/commands/c${index}`, f.queueCommand(overrides));
    }
    await f.bridge.tick();
    for (const index of bad.keys()) {
      expect(f.result(`c${index}`)).toMatchObject({ status: "refused", reason: "Not a request this Mac understands." });
    }
    expect(f.replier.queueAction).not.toHaveBeenCalled();
  });

  it("passes Conductor's own refusal back", async () => {
    const f = fixture({ queueOutcome: { ok: false, reason: "Conductor didn't take that change (relay HTTP 409)." } });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.queueCommand());
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({
      status: "refused",
      reason: "Conductor didn't take that change (relay HTTP 409).",
    });
  });

  it("keeps every shared check: signature, expiry, replay", async () => {
    const f = fixture();
    await f.pair();
    const stranger = device();
    await f.store.set(`${f.channel}/commands/c1`, f.queueCommand({}, stranger));
    await f.store.set(`${f.channel}/commands/c2`, f.queueCommand({ expiresAt: NOW - 1 }));
    const once = f.queueCommand();
    await f.store.set(`${f.channel}/commands/c3`, once);
    await f.bridge.tick();
    await f.store.set(`${f.channel}/commands/c4`, once);
    await f.bridge.tick();
    expect(f.result("c1")).toBeNull();
    expect(f.result("c2")).toMatchObject({ status: "refused" });
    expect(f.result("c3")).toMatchObject({ status: "sent" });
    expect(f.result("c4")).toMatchObject({ status: "refused", reason: "That reply was already received." });
    expect(f.replier.queueAction).toHaveBeenCalledTimes(1);
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

  it("answers a pending question through the Mac's answerer, exactly as the phone signed it", async () => {
    const calls: Array<{ id: string; input: unknown }> = [];
    const answerer: Answerer = {
      answer: async (id, input) => {
        calls.push({ id, input });
        return { status: "answered", via: "stopped-and-sent" };
      },
    };
    const f = fixture({ answerer });
    await f.pair();
    expect(await run(f, f.answerCommand())).toMatchObject({ status: "answered", via: "stopped-and-sent" });
    expect(calls).toEqual([
      { id: "s1", input: { toolUseId: "toolu_q1", answers: [{ question: 0, picked: ["Red"] }] } },
    ]);
    expect(f.sends).toEqual([]); // never goes through the reply path
  });

  it("refuses an answer when this Mac has no answerer, and one with fields it doesn't know", async () => {
    const none = fixture();
    await none.pair();
    expect(await run(none, none.answerCommand())).toMatchObject({ status: "refused" });
    const answerer: Answerer = { answer: async () => ({ status: "answered", via: "conductor" }) };
    const f = fixture({ answerer });
    await f.pair();
    expect(await run(f, f.answerCommand({ text: "B" }))).toMatchObject({ status: "refused" });
  });

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

describe("RemoteBridge pending plan", () => {
  it("sends a plan waiting on approval with its text, so the phone can show the plan card", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-plan-"));
    dirs.push(dir);
    const waiting = session({ state: "awaiting_input" });
    const bridge = new RemoteBridge({
      configPath: path.join(dir, "remote.json"),
      projectId: "squeak-test",
      store: new MemoryStore(),
      replier: { lastTurnText: () => null, lastTurnId: () => null, send: vi.fn() },
      snapshot: () =>
        ({ sessions: [waiting], active: [waiting], attention: [], generatedAt: "", codexUsage: null }) as FleetSnapshot,
      question: () => ({ toolUseId: "toolu_p", questions: [], plan: "## Plan\n1. Do it" }),
      now: () => NOW,
      macName: "Test Mac",
    });
    expect(bridge.phoneView().sessions[0]).toMatchObject({
      question: { toolUseId: "toolu_p", questions: [], plan: "## Plan\n1. Do it" },
    });
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

describe("RemoteBridge verbose view (live turn)", () => {
  function verbose(
    options: {
      verbose?: boolean;
      firestore?: boolean;
      queue?: (sessionId: string) => Promise<QueueItem[] | null>;
      transcript?: (sessionId: string, limit: number) => { messages: TranscriptMessage[] };
    } = {},
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-live-"));
    dirs.push(dir);
    const store = options.firestore ? new MemoryStore() : new WatchingStore();
    let now = NOW;
    const working = session({ key: "claude-transcript:s1", state: "working" });
    let active = [working];
    const liveActivity = vi.fn((_session: FleetSession, _limit: number, stepChars: number) => ({
      total: 1,
      steps: [{ kind: "thinking" as const, text: "x".repeat(Math.min(stepChars, 900)), at: null }],
    }));
    const bridge = new RemoteBridge({
      configPath: path.join(dir, "remote.json"),
      projectId: "squeak-test",
      store,
      replier: {
        lastTurnText: () => null,
        lastTurnId: () => null,
        send: vi.fn(),
        ...(options.queue ? { queue: options.queue } : {}),
        ...(options.transcript ? { transcript: options.transcript } : {}),
      },
      snapshot: () => ({ sessions: active, active, attention: [], generatedAt: "", codexUsage: null }) as FleetSnapshot,
      liveActivity,
      ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
      now: () => now,
    });
    const pairing = bridge.startPairing();
    const payload = JSON.parse(Buffer.from(new URL(pairing.url).searchParams.get("d")!, "base64url").toString());
    const channel = `channels/${payload.c}`;
    const phone = device();
    const presence = (watching?: string, caps?: string[]) =>
      store.set(`${channel}/state/presence`, {
        box: seal(payload.k, { at: now, ...(watching ? { watching } : {}), ...(caps ? { caps } : {}) }),
      });
    const liveDocs = () => [...store.docs.keys()].filter((key) => key.startsWith(`${channel}/live/`));
    const pair = async () => {
      await store.set(`${channel}/pairing/iphone-1`, {
        box: seal(payload.k, { name: "iPhone", publicKey: phone.x963 }),
      });
      await bridge.tick();
      await bridge.approve("iphone-1");
    };
    return {
      bridge,
      store,
      payload,
      presence,
      liveDocs,
      pair,
      liveActivity,
      advance: (ms: number) => (now += ms),
      setActive: (next: FleetSession[]) => (active = next),
    };
  }

  // The publisher's own timer and writes run on microtasks; let them land.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

  it("publishes the watched session's whole turn, sealed, while the phone watches it", async () => {
    const t = verbose();
    await t.pair();
    await t.presence("claude-transcript:s1");
    await t.bridge.tick();
    await settle();
    const [doc] = t.liveDocs();
    expect(doc).toBeDefined();
    const turn = open<{ key: string; steps: Array<{ text: string }> }>(t.payload.k, t.store.docs.get(doc!)!.box);
    expect(turn.key).toBe("claude-transcript:s1");
    expect(turn.steps[0]!.text).toHaveLength(900); // not clipped to the snapshot's 200
    t.bridge.stop();
  });

  it("carries the chat's Conductor queue, read for its Conductor id; absent when it can't be read", async () => {
    const queue = vi.fn(
      async (sessionId: string): Promise<QueueItem[] | null> =>
        sessionId === "s1" ? [{ id: "q1", text: "y".repeat(3_000), mode: "queue", position: 2 }] : null,
    );
    const t = verbose({ queue });
    await t.pair();
    await t.presence("claude-transcript:s1");
    await t.bridge.tick();
    await settle();
    const [doc] = t.liveDocs();
    const turn = open<{ queue?: QueueItem[] }>(t.payload.k, t.store.docs.get(doc!)!.box);
    expect(queue).toHaveBeenCalledWith("s1");
    expect(turn.queue).toEqual([{ id: "q1", text: `${"y".repeat(1_999)}…`, mode: "queue", position: 2 }]);
    t.bridge.stop();

    const bare = verbose();
    await bare.pair();
    await bare.presence("claude-transcript:s1");
    await bare.bridge.tick();
    await settle();
    const [plain] = bare.liveDocs();
    expect(open<Record<string, unknown>>(bare.payload.k, bare.store.docs.get(plain!)!.box)).not.toHaveProperty("queue");
    bare.bridge.stop();
  });

  it("carries the chat's history before this turn, read for its Conductor id", async () => {
    const transcript = vi.fn((sessionId: string) => ({
      messages:
        sessionId === "s1"
          ? [
              { id: "a", role: "user" as const, text: "Fix it", at: null, turnId: "t1" },
              { id: "b", role: "assistant" as const, text: "On it", at: null, turnId: "t1" },
              { id: "c", role: "assistant" as const, text: "Fixed.", at: "2026-10-19T09:00:00.000Z", turnId: "t1" },
            ]
          : [],
    }));
    const t = verbose({ transcript });
    await t.pair();
    await t.presence("claude-transcript:s1");
    await t.bridge.tick();
    await settle();
    const [doc] = t.liveDocs();
    const turn = open<{ history?: unknown }>(t.payload.k, t.store.docs.get(doc!)!.box);
    expect(transcript).toHaveBeenCalledWith("s1", 40);
    expect(turn.history).toEqual([
      { role: "user", text: "Fix it", at: null },
      { role: "assistant", text: "Fixed.", at: "2026-10-19T09:00:00.000Z" },
    ]);
    t.bridge.stop();
  });

  it("deletes it when the phone stops watching", async () => {
    const t = verbose();
    await t.pair();
    await t.presence("claude-transcript:s1");
    await t.bridge.tick();
    await settle();
    await t.presence();
    await t.bridge.tick();
    await settle();
    expect(t.liveDocs()).toEqual([]);
    t.bridge.stop();
  });

  it("for a phone that reads it apart: history in its own document, the turn with its state, turn and seq", async () => {
    const transcript = vi.fn(() => ({
      messages: [{ id: "a", role: "user" as const, text: "Fix it", at: null, turnId: "t1" }],
    }));
    const t = verbose({ transcript });
    await t.pair();
    await t.presence("claude-transcript:s1", ["z", "split"]);
    await t.bridge.tick();
    await settle();
    const docs = t.liveDocs();
    expect(docs).toHaveLength(2);
    const turnPath = docs.find((d) => !d.endsWith("-h"))!;
    const turn = open<Record<string, unknown>>(t.payload.k, t.store.docs.get(turnPath)!.box);
    expect(turn).toMatchObject({ split: true, state: "working", key: "claude-transcript:s1" });
    expect(turn).not.toHaveProperty("history");
    expect(typeof turn.seq).toBe("number");
    const history = open<Record<string, unknown>>(t.payload.k, t.store.docs.get(`${turnPath}-h`)!.box);
    expect(history).toMatchObject({ key: "claude-transcript:s1", history: [{ role: "user", text: "Fix it" }] });

    // A new step rewrites the turn, not the unchanged history.
    const sets = vi.spyOn(t.store, "set");
    t.liveActivity.mockReturnValueOnce({ total: 2, steps: [{ kind: "thinking", text: "more", at: null }] });
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    expect(sets.mock.calls.map(([p]) => p.endsWith("-h"))).not.toContain(true);
    expect(sets.mock.calls.some(([p]) => p === turnPath)).toBe(true);

    // Leaving deletes both.
    await t.presence(undefined, ["z", "split"]);
    await t.bridge.tick();
    await settle();
    expect(t.liveDocs()).toEqual([]);
    t.bridge.stop();
  });

  it("keeps history inline for a phone that does not say it reads it apart", async () => {
    const transcript = vi.fn(() => ({
      messages: [{ id: "a", role: "user" as const, text: "Hi", at: null, turnId: "t" }],
    }));
    const t = verbose({ transcript });
    await t.pair();
    await t.presence("claude-transcript:s1");
    await t.bridge.tick();
    await settle();
    const [doc] = t.liveDocs();
    expect(t.liveDocs()).toHaveLength(1);
    expect(open<Record<string, unknown>>(t.payload.k, t.store.docs.get(doc!)!.box)).toHaveProperty("history");
    t.bridge.stop();
  });

  it("deletes it when the phone goes quiet (closed without saying so)", async () => {
    const t = verbose();
    await t.pair();
    await t.presence("claude-transcript:s1");
    await t.bridge.tick();
    await settle();
    t.advance(61_000);
    await t.bridge.tick();
    await settle();
    expect(t.liveDocs()).toEqual([]);
    t.bridge.stop();
  });

  it("publishes nothing for a session the phone cannot see", async () => {
    const t = verbose();
    await t.pair();
    await t.presence("claude-transcript:not-active");
    await t.bridge.tick();
    await settle();
    expect(t.liveDocs()).toEqual([]);
    expect(t.liveActivity).not.toHaveBeenCalled();
    t.bridge.stop();
  });

  it("publishes nothing when the owner switched verbose off on the Mac", async () => {
    const t = verbose({ verbose: false });
    await t.pair();
    await t.presence("claude-transcript:s1");
    await t.bridge.tick();
    await settle();
    expect(t.liveDocs()).toEqual([]);
    t.bridge.stop();
  });

  it("publishes nothing on Firestore, whose rules have no live collection", async () => {
    const t = verbose({ firestore: true });
    await t.pair();
    await t.presence("claude-transcript:s1");
    await t.bridge.tick();
    await settle();
    expect(t.liveDocs()).toEqual([]);
    t.bridge.stop();
  });

  it("publishes nothing before a phone is paired", async () => {
    const t = verbose();
    await t.presence("claude-transcript:s1");
    await t.bridge.tick();
    await settle();
    expect(t.liveDocs()).toEqual([]);
    t.bridge.stop();
  });

  it("a plain presence ping from an older phone keeps working", async () => {
    const t = verbose();
    await t.pair();
    await t.presence();
    await t.bridge.tick();
    expect((t.bridge.status() as { phoneOpen: boolean }).phoneOpen).toBe(true);
    expect(t.liveDocs()).toEqual([]);
    t.bridge.stop();
  });
});

describe("RemoteBridge awake session from the phone", () => {
  async function awake(options: { offered?: boolean } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-awake-"));
    dirs.push(dir);
    const store = new MemoryStore();
    const session = new AwakeSession({ path: null, hold: () => undefined, now: () => NOW });
    const apply = vi.fn((request: unknown) => {
      const action = readAwakeAction(request);
      return action ? applyAwakeAction(session, action) : { ok: false as const, reason: "Not a request." };
    });
    const bridge = new RemoteBridge({
      configPath: path.join(dir, "remote.json"),
      projectId: "squeak-test",
      store,
      replier: { lastTurnText: () => null, lastTurnId: () => null, send: vi.fn() },
      snapshot: () => ({ sessions: [], active: [], attention: [], generatedAt: "", codexUsage: null }) as FleetSnapshot,
      ...(options.offered === false ? {} : { awake: { state: () => session.state, apply } }),
      now: () => NOW,
    });
    const pairing = bridge.startPairing();
    const payload = JSON.parse(Buffer.from(new URL(pairing.url).searchParams.get("d")!, "base64url").toString());
    const channel = `channels/${payload.c}`;
    const phone = device();
    await store.set(`${channel}/pairing/iphone-1`, { box: seal(payload.k, { name: "iPhone", publicKey: phone.x963 }) });
    await bridge.tick();
    await bridge.approve("iphone-1");
    const config = JSON.parse(fs.readFileSync(path.join(dir, "remote.json"), "utf8"));
    const command = (fields: Record<string, unknown>, signer = phone) => {
      const box = seal(payload.k, {
        v: 1,
        kind: "awake",
        ...fields,
        nonce: crypto.randomBytes(16).toString("hex"),
        expiresAt: NOW + 60_000,
      });
      return { box, sig: signer.sign(box), device: "iphone-1" };
    };
    return { bridge, config, command, apply, session };
  }

  it("starts a timed session, adds time, ends it, and the phone view follows", async () => {
    const t = await awake();
    expect(t.bridge.phoneView()).toMatchObject({ keepAwake: false });
    expect(t.bridge.phoneView()).not.toHaveProperty("awakeUntil");
    const started = await t.bridge.handleCommand(t.config, "a1", t.command({ on: true, minutes: 60 }));
    expect(started.result).toMatchObject({ status: "sent" });
    expect(t.bridge.phoneView()).toMatchObject({
      keepAwake: true,
      awakeUntil: new Date(NOW + 60 * 60_000).toISOString(),
    });
    await t.bridge.handleCommand(t.config, "a2", t.command({ on: true, extend: 30 }));
    expect(t.bridge.phoneView().awakeUntil).toBe(new Date(NOW + 90 * 60_000).toISOString());
    await t.bridge.handleCommand(t.config, "a3", t.command({ on: false }));
    expect(t.bridge.phoneView()).toMatchObject({ keepAwake: false });
    t.session.stop();
    t.bridge.stop();
  });

  it("passes lid through, and shows the lid session and whether it can start", async () => {
    const t = await awake();
    expect(t.bridge.phoneView()).not.toHaveProperty("awakeLidReady");
    await t.bridge.handleCommand(t.config, "a0", t.command({ on: true, minutes: 60, lid: true }));
    expect(t.apply).toHaveBeenLastCalledWith({ on: true, minutes: 60, extend: undefined, lid: true });
    t.session.stop();
    t.bridge.stop();
  });

  it("shows the Mac's battery, draw and lid when the daemon has read them", async () => {
    const t = await awake();
    expect(t.bridge.phoneView()).not.toHaveProperty("macPower");
    const power = { percent: 50, onBattery: true, watts: 35, lidClosed: false };
    const bridge = new RemoteBridge({
      configPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-power-")), "remote.json"),
      projectId: "squeak-test",
      store: new MemoryStore(),
      replier: { lastTurnText: () => null, lastTurnId: () => null, send: vi.fn() },
      snapshot: () => ({ sessions: [], active: [], attention: [], generatedAt: "", codexUsage: null }) as FleetSnapshot,
      awake: { state: () => null, apply: () => ({ ok: true, state: null }), power: () => power },
      now: () => NOW,
    });
    expect(bridge.phoneView()).toMatchObject({ keepAwake: false, macPower: power });
    t.bridge.stop();
  });

  it("an old phone's bare on starts an untimed session", async () => {
    const t = await awake();
    await t.bridge.handleCommand(t.config, "a1", t.command({ on: true }));
    expect(t.bridge.phoneView()).toMatchObject({ keepAwake: true });
    expect(t.bridge.phoneView()).not.toHaveProperty("awakeUntil");
    t.session.stop();
    t.bridge.stop();
  });

  it("passes on only the awake fields, and refuses what the session refuses", async () => {
    const t = await awake();
    await t.bridge.handleCommand(t.config, "a1", t.command({ on: true, action: "end", minutes: 5 }));
    expect(t.apply).toHaveBeenLastCalledWith({ on: true, minutes: 5, extend: undefined, lid: undefined });
    t.session.end();
    const extend = await t.bridge.handleCommand(t.config, "a2", t.command({ on: true, extend: 30 }));
    expect(extend.result).toMatchObject({ status: "refused", reason: expect.stringMatching(/No awake session/) });
    const odd = await t.bridge.handleCommand(t.config, "a3", t.command({ on: "yes" }));
    expect(odd.result).toMatchObject({ status: "refused" });
    expect(t.session.active).toBe(false);
    t.bridge.stop();
  });

  it("an unsigned change does nothing", async () => {
    const t = await awake();
    const forged = await t.bridge.handleCommand(t.config, "a1", t.command({ on: true }, device()));
    expect(forged.write).toBe(false);
    expect(t.apply).not.toHaveBeenCalled();
    t.bridge.stop();
  });

  it("a Mac without sessions refuses it and leaves it out of the view", async () => {
    const t = await awake({ offered: false });
    expect(t.bridge.phoneView()).not.toHaveProperty("keepAwake");
    const verdict = await t.bridge.handleCommand(t.config, "a1", t.command({ on: true }));
    expect(verdict.result).toMatchObject({ status: "refused" });
    t.bridge.stop();
  });
});

describe("RemoteBridge usage refresh from the phone", () => {
  async function usage(options: { refresh?: boolean } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-usage-"));
    dirs.push(dir);
    const store = new MemoryStore();
    const refreshUsage = vi.fn(async () => ({ refreshed: true, throttled: false }));
    const bridge = new RemoteBridge({
      configPath: path.join(dir, "remote.json"),
      projectId: "squeak-test",
      store,
      replier: { lastTurnText: () => null, lastTurnId: () => null, send: vi.fn() },
      snapshot: () => ({ sessions: [], active: [], attention: [], generatedAt: "", codexUsage: null }) as FleetSnapshot,
      ...(options.refresh === false ? {} : { refreshUsage }),
      now: () => NOW,
    });
    const pairing = bridge.startPairing();
    const payload = JSON.parse(Buffer.from(new URL(pairing.url).searchParams.get("d")!, "base64url").toString());
    const channel = `channels/${payload.c}`;
    const phone = device();
    await store.set(`${channel}/pairing/iphone-1`, { box: seal(payload.k, { name: "iPhone", publicKey: phone.x963 }) });
    await bridge.tick();
    await bridge.approve("iphone-1");
    const config = JSON.parse(fs.readFileSync(path.join(dir, "remote.json"), "utf8"));
    const command = (nonce = crypto.randomBytes(16).toString("hex"), signer = phone) => {
      const box = seal(payload.k, { v: 1, kind: "usage", nonce, expiresAt: NOW + 60_000 });
      return { box, sig: signer.sign(box), device: "iphone-1" };
    };
    return { bridge, config, command, refreshUsage, phone };
  }

  it("a signed request takes a reading and says whether it was fresh", async () => {
    const t = await usage();
    const verdict = await t.bridge.handleCommand(t.config, "u1", t.command());
    expect(t.refreshUsage).toHaveBeenCalledTimes(1);
    expect(verdict.result).toMatchObject({ status: "sent", refreshed: true, throttled: false });
    t.bridge.stop();
  });

  it("an unsigned or replayed request takes nothing", async () => {
    const t = await usage();
    const forged = await t.bridge.handleCommand(t.config, "u1", t.command(undefined, device()));
    expect(forged.write).toBe(false);
    const nonce = crypto.randomBytes(16).toString("hex");
    await t.bridge.handleCommand(t.config, "u2", t.command(nonce));
    const again = await t.bridge.handleCommand(t.config, "u3", t.command(nonce));
    expect(again.result).toMatchObject({ status: "refused" });
    expect(t.refreshUsage).toHaveBeenCalledTimes(1);
    t.bridge.stop();
  });

  it("is refused by a Mac that cannot refresh", async () => {
    const t = await usage({ refresh: false });
    const verdict = await t.bridge.handleCommand(t.config, "u1", t.command());
    expect(verdict.result).toMatchObject({ status: "refused" });
    t.bridge.stop();
  });

  it("a failed call still answers, from the last reading", async () => {
    const t = await usage();
    t.refreshUsage.mockRejectedValueOnce(new Error("claude exited 1"));
    const verdict = await t.bridge.handleCommand(t.config, "u1", t.command());
    expect(verdict.result).toMatchObject({ status: "sent", refreshed: false });
    expect(verdict.result.note).toMatch(/last reading/);
    expect(JSON.stringify(verdict.result)).not.toContain("claude exited 1");
    t.bridge.stop();
  });

  it("forwards the specific sign-in sentence as the note", async () => {
    const t = await usage();
    const error = "Claude Code's sign-in has expired. Open Claude Code to renew it, then try again.";
    t.refreshUsage.mockResolvedValueOnce({ refreshed: false, throttled: false, error } as never);
    const verdict = await t.bridge.handleCommand(t.config, "u1", t.command());
    expect(verdict.result).toMatchObject({ status: "sent", refreshed: false, throttled: false, note: error });
    t.bridge.stop();
  });

  it("forwards a 429 wait as the note while it is throttled", async () => {
    const t = await usage();
    const error = "Claude asked Squeak to slow down. It will try again later.";
    t.refreshUsage.mockResolvedValueOnce({ refreshed: false, throttled: true, error } as never);
    const verdict = await t.bridge.handleCommand(t.config, "u1", t.command());
    expect(verdict.result).toMatchObject({ status: "sent", refreshed: false, throttled: true, note: error });
    t.bridge.stop();
  });

  it("adds no note to a fresh reading", async () => {
    const t = await usage();
    const verdict = await t.bridge.handleCommand(t.config, "u1", t.command());
    expect(verdict.result).not.toHaveProperty("note");
    t.bridge.stop();
  });
});

describe("RemoteBridge recent chats", () => {
  function recent(
    sessions: FleetSession[],
    active: FleetSession[],
    extra: Partial<ConstructorParameters<typeof RemoteBridge>[0]> = {},
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-recent-"));
    dirs.push(dir);
    return new RemoteBridge({
      ...extra,
      configPath: path.join(dir, "remote.json"),
      projectId: "squeak-test",
      store: new MemoryStore(),
      replier: {
        lastTurnText: (id) => `Last words of ${id}. ${"x".repeat(3_000)}`,
        lastTurnId: (id) => `turn-${id}`,
        send: vi.fn(),
      },
      snapshot: () => ({ sessions, active, attention: [], generatedAt: "", codexUsage: null }) as FleetSnapshot,
      now: () => NOW,
    });
  }
  const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
  const chat = (id: string, minutesAgo: number, overrides: Partial<FleetSession> = {}) =>
    session({ key: `k:${id}`, conductorSessionId: id, state: "idle", lastActivityAt: at(minutesAgo), ...overrides });

  it("lists inactive Conductor chats newest first, each with its turn so a reply is accepted", () => {
    const working = chat("w", 1, { state: "working" });
    const bridge = recent([working, chat("old", 120), chat("new", 30)], [working]);
    const view = bridge.phoneView();
    expect(view.sessions.map((s) => s.key)).toEqual(["k:w"]);
    expect(view.recent.map((s) => s.key)).toEqual(["k:new", "k:old"]);
    expect(view.recent[0]).toMatchObject({ conductorSessionId: "new", turnId: "turn-new" });
  });

  it("leaves out closed or archived chats, other agents' sessions, and anything older than a week", () => {
    const bridge = recent(
      [
        chat("closed", 10, { retired: true }),
        chat("terminal", 10, { conductorSessionId: null, key: "claude-transcript:t" }),
        chat("stale", 8 * 24 * 60),
        chat("ok", 10),
      ],
      [],
    );
    expect(bridge.phoneView().recent.map((s) => s.key)).toEqual(["k:ok"]);
  });

  it("lists a chat closed in Conductor flagged, keeps every open one, and refuses to act on a closed one", () => {
    const bridge = recent(
      [
        chat("open", 10, { closed: false, workspaceRetired: false, retired: false }),
        chat("closed", 20, { closed: true, workspaceRetired: false, retired: true }),
        chat("archived", 30, { closed: true, workspaceRetired: true, retired: true }),
        // Open but quiet for two weeks: still listed, since the phone can filter to what is open.
        chat("quiet", 14 * 24 * 60, { closed: false, workspaceRetired: false, retired: false }),
        chat("old-closed", 14 * 24 * 60, { closed: true, workspaceRetired: false, retired: true }),
      ],
      [],
    );
    const view = bridge.phoneView();
    expect(view.recent.map((s) => [s.key, (s as { open?: boolean }).open])).toEqual([
      ["k:open", true],
      ["k:closed", false],
      ["k:quiet", true],
    ]);
    expect((bridge as unknown as { phoneShows(id: string): boolean }).phoneShows("open")).toBe(true);
    expect((bridge as unknown as { phoneShows(id: string): boolean }).phoneShows("closed")).toBe(false);
  });

  it("sends Conductor's repository icons in the recent document, and none when there are none", () => {
    const withIcons = recent([chat("a", 5)], [], { projectIcons: () => ({ storefront: "UE5H" }) });
    expect(withIcons.phoneView().projectIcons).toEqual({ storefront: "UE5H" });
    expect(withIcons.phoneViewParts().recent.projectIcons).toEqual({ storefront: "UE5H" });
    expect((withIcons.phoneViewParts().snapshot as Record<string, unknown>).projectIcons).toBeUndefined();
    expect(recent([chat("a", 5)], [], { projectIcons: () => ({}) }).phoneView()).not.toHaveProperty("projectIcons");
    expect(recent([chat("a", 5)], []).phoneView()).not.toHaveProperty("projectIcons");
  });

  it("keeps the list short and each message shorter than an active chat's", () => {
    const many = Array.from({ length: 15 }, (_, i) => chat(`c${i}`, i + 1));
    const view = recent(many, []).phoneView();
    expect(view.recent).toHaveLength(10);
    expect(view.recent[0]!.message!.length).toBeLessThanOrEqual(2_001);
  });
});

describe("RemoteBridge recent chats, Show more", () => {
  const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
  const chat = (id: string, minutesAgo: number) =>
    session({ key: `k:${id}`, conductorSessionId: id, state: "idle", lastActivityAt: at(minutesAgo) });

  async function more(sessions: FleetSession[], wanted?: number) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-more-"));
    dirs.push(dir);
    const store = new MemoryStore();
    const bridge = new RemoteBridge({
      configPath: path.join(dir, "remote.json"),
      projectId: "squeak-test",
      store,
      replier: { lastTurnText: () => "x".repeat(3_000), lastTurnId: () => "t", send: vi.fn() },
      snapshot: () => ({ sessions, active: [], attention: [], generatedAt: "", codexUsage: null }) as FleetSnapshot,
      now: () => NOW,
    });
    const pairing = bridge.startPairing();
    const payload = JSON.parse(Buffer.from(new URL(pairing.url).searchParams.get("d")!, "base64url").toString());
    await store.set(`channels/${payload.c}/state/presence`, {
      box: seal(payload.k, { at: NOW, ...(wanted === undefined ? {} : { recent: wanted }) }),
    });
    await bridge.tick();
    const view = bridge.phoneView();
    bridge.stop();
    return view;
  }

  const day = 24 * 60;
  const many = Array.from({ length: 60 }, (_, i) => chat(`c${i}`, (i + 1) * 60 * 10)); // every 10h, back 25 days

  it("sends a week's ten by default and says there are more", async () => {
    const view = await more(many);
    expect(view.recent).toHaveLength(10);
    expect(view.recentMore).toBe(true);
  });

  it("sends what the phone asks for, back a month, with short previews past the first ten", async () => {
    const view = await more(many, 30);
    expect(view.recent).toHaveLength(30);
    expect(view.recent[9]!.message!.length).toBeGreaterThan(1_000);
    expect(view.recent[10]!.message!.length).toBeLessThanOrEqual(301);
    expect(view.recentMore).toBe(true);
  });

  it("never more than fifty, and Show more stops when nothing is left", async () => {
    expect((await more(many, 500)).recent).toHaveLength(50);
    const few = await more([chat("a", 60), chat("b", 10 * day)], 30);
    expect(few.recent.map((s) => s.key)).toEqual(["k:a", "k:b"]);
    expect(few.recentMore).toBe(false);
  });

  it("an older phone's plain presence keeps the default", async () => {
    expect((await more(many, undefined)).recent).toHaveLength(10);
  });
});

describe("RemoteBridge alive answer", () => {
  async function alive() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-alive-"));
    dirs.push(dir);
    const store = new MemoryStore();
    let now = NOW;
    const bridge = new RemoteBridge({
      configPath: path.join(dir, "remote.json"),
      projectId: "squeak-test",
      store,
      replier: { lastTurnText: () => null, lastTurnId: () => null, send: vi.fn() },
      snapshot: () => ({ sessions: [], active: [], attention: [], generatedAt: "", codexUsage: null }) as FleetSnapshot,
      now: () => now,
    });
    const pairing = bridge.startPairing();
    const payload = JSON.parse(Buffer.from(new URL(pairing.url).searchParams.get("d")!, "base64url").toString());
    const channel = `channels/${payload.c}`;
    return {
      bridge,
      ping: (at: number) => store.set(`${channel}/state/presence`, { box: seal(payload.k, { at }) }),
      answer: async () => {
        const doc = await store.get(`${channel}/state/alive`);
        return doc ? open<{ at: number }>(payload.k, doc.box).at : null;
      },
      advance: (ms: number) => (now += ms),
      now: () => now,
    };
  }

  it("answers a phone's presence with a sealed stamp of the Mac's own time", async () => {
    const t = await alive();
    await t.ping(t.now());
    await t.bridge.tick();
    expect(await t.answer()).toBe(NOW);
    t.bridge.stop();
  });

  it("answers each new ping, but not the same ping twice nor faster than every ten seconds", async () => {
    const t = await alive();
    await t.ping(t.now());
    await t.bridge.tick();
    t.advance(20_000);
    await t.bridge.tick(); // same ping again: no new answer
    expect(await t.answer()).toBe(NOW);
    await t.ping(t.now());
    await t.bridge.tick();
    expect(await t.answer()).toBe(NOW + 20_000);
    t.advance(3_000);
    await t.ping(t.now());
    await t.bridge.tick();
    expect(await t.answer()).toBe(NOW + 20_000);
    t.bridge.stop();
  });

  it("a Mac waking to an hour-old ping says nothing: no phone is looking", async () => {
    const t = await alive();
    await t.ping(t.now() - 60 * 60_000);
    await t.bridge.tick();
    expect(await t.answer()).toBeNull();
    t.bridge.stop();
  });
});

describe("RemoteBridge channel upkeep", () => {
  const presence = (f: ReturnType<typeof fixture>, at: number) =>
    f.store.set(`${f.channel}/state/presence`, { box: seal(f.payload.k, { at }) });

  it("counts a phone whose clock runs behind as open, timed by when its new ping arrived", async () => {
    const f = fixture();
    await f.pair();
    const behind = NOW - 5 * 60_000;
    await presence(f, behind);
    await f.bridge.tick(); // the first read keeps the phone's stamp: it may be an old ping
    expect(f.store.docs.has(`${f.channel}/state/alive`)).toBe(false);
    f.advance(20_000);
    await presence(f, behind + 20_000);
    await f.bridge.tick();
    expect(f.store.docs.has(`${f.channel}/state/alive`)).toBe(true);
    // The same ping read again is not a sign of life: it lapses after the window.
    f.advance(61_000);
    f.store.docs.delete(`${f.channel}/state/alive`);
    f.advance(20_000);
    await f.bridge.tick();
    expect(f.store.docs.has(`${f.channel}/state/alive`)).toBe(false);
  });

  it("sweeps results older than fifteen minutes and keeps recent ones", async () => {
    const f = fixture();
    await f.pair();
    await f.store.set(`${f.channel}/results/old`, { box: seal(f.payload.k, { id: "old" }), at: NOW - 16 * 60_000 });
    await f.store.set(`${f.channel}/results/unstamped`, { box: seal(f.payload.k, { id: "u" }) });
    await f.store.set(`${f.channel}/results/new`, { box: seal(f.payload.k, { id: "new" }), at: NOW - 60_000 });
    await f.bridge.tick();
    expect(f.result("old")).toBeNull();
    expect(f.result("unstamped")).toBeNull();
    expect(f.result("new")).not.toBeNull();
  });

  it("publishes a working chat's new steps while a phone looks, and not while none does", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      await f.pair();
      f.bridge.start();
      await vi.advanceTimersByTimeAsync(0);
      const working = (at: string) => session({ state: "working", lastActivityAt: at });
      f.emit([working("2026-09-25T03:00:00.000Z")]);
      f.advance(2_000);
      f.emit([working("2026-09-25T03:00:00.000Z")]);
      await vi.advanceTimersByTimeAsync(500);
      const sets = vi.spyOn(f.store, "set");

      // No phone open: a step alone writes nothing.
      f.emit([working("2026-09-25T03:00:01.000Z")]);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(sets.mock.calls.filter(([p]) => p.endsWith("/state/snapshot"))).toHaveLength(0);

      await presence(f, NOW);
      await f.bridge.tick();
      sets.mockClear();
      f.advance(5_000);
      f.emit([working("2026-09-25T03:00:02.000Z")]);
      await vi.advanceTimersByTimeAsync(3_100);
      expect(sets.mock.calls.filter(([p]) => p.endsWith("/state/snapshot"))).toHaveLength(1);
      f.bridge.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RemoteBridge formats for the phone in front of it", () => {
  const presence = (f: ReturnType<typeof fixture>, caps?: string[]) =>
    f.store.set(`${f.channel}/state/presence`, { box: seal(f.payload.k, { at: NOW, ...(caps ? { caps } : {}) }) });
  const read = (f: ReturnType<typeof fixture>, doc: string) =>
    open<Record<string, unknown>>(f.payload.k, f.store.docs.get(`${f.channel}/state/${doc}`)!.box);

  it("writes one whole view, with a seq, for a phone that names no capabilities", async () => {
    const f = fixture({ streaming: true });
    await f.pair();
    await presence(f);
    await f.bridge.tick();
    const view = read(f, "snapshot");
    expect(view).toHaveProperty("recent");
    expect(view).not.toHaveProperty("split");
    expect(typeof view.seq).toBe("number");
    expect(f.store.docs.has(`${f.channel}/state/recent`)).toBe(false);
  });

  it("splits the recent list off and compresses both for a phone that reads them", async () => {
    const f = fixture({ streaming: true });
    await f.pair();
    f.emit([session()]);
    await presence(f, ["z", "split"]);
    await f.bridge.tick();
    const view = read(f, "snapshot");
    expect(view.split).toBe(true);
    expect(view).not.toHaveProperty("recent");
    expect(view).not.toHaveProperty("workspaces");
    const recent = read(f, "recent");
    expect(recent).toHaveProperty("recent");
    expect((recent.seq as number) <= (view.seq as number)).toBe(true);
    // Compressed: the plaintext starts with the zero byte, which no JSON does.
    const raw = Buffer.from(f.store.docs.get(`${f.channel}/state/snapshot`)!.box, "base64");
    const key = Buffer.from(f.payload.k, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const plain = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
    expect(plain[0]).toBe(0);
  });

  it("rewrites the recent document only when the list changes", async () => {
    const f = fixture({ streaming: true });
    await f.pair();
    await presence(f, ["z", "split"]);
    await f.bridge.tick();
    const before = f.store.docs.get(`${f.channel}/state/recent`)!.box;
    f.emit([session({ state: "working", detail: "Run tests" })]);
    f.advance(5_000);
    await f.bridge.tick();
    expect(read(f, "snapshot").sessions).toMatchObject([{ state: "working" }]);
    expect(f.store.docs.get(`${f.channel}/state/recent`)!.box).toBe(before);
  });

  it("goes back to the whole view when an older phone is in front", async () => {
    const f = fixture({ streaming: true });
    await f.pair();
    await presence(f, ["z", "split"]);
    await f.bridge.tick();
    f.advance(5_000);
    await f.store.set(`${f.channel}/state/presence`, { box: seal(f.payload.k, { at: NOW + 5_000 }) });
    await f.bridge.tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(read(f, "snapshot")).toHaveProperty("recent");
    expect(read(f, "snapshot")).not.toHaveProperty("split");
  });

  it("ignores capabilities on Firestore, whose rules have no recent document", async () => {
    const f = fixture();
    await f.pair();
    await presence(f, ["z", "split"]);
    await f.bridge.tick();
    expect(read(f, "snapshot")).toHaveProperty("recent");
    expect(f.store.docs.has(`${f.channel}/state/recent`)).toBe(false);
  });

  it("numbers every write higher than the last", async () => {
    const f = fixture({ streaming: true });
    await f.pair();
    await f.bridge.tick();
    const first = read(f, "snapshot").seq as number;
    f.emit([session({ state: "working" })]);
    f.advance(61_000); // past the idle publish interval
    await f.bridge.tick();
    expect(read(f, "snapshot").sessions).toMatchObject([{ state: "working" }]);
    expect(read(f, "snapshot").seq as number).toBeGreaterThan(first);
  });
});

describe("RemoteBridge phone view: an errored chat", () => {
  it("says why it failed, clipped, and only for an errored chat", () => {
    const f = fixture({ failure: `You've hit your session limit · resets 7:20pm ${"x".repeat(300)}` });
    f.emit([session({ state: "error" })]);
    const failure = (f.bridge.phoneView().sessions[0] as { failure?: string | null }).failure;
    expect(failure?.startsWith("You've hit your session limit")).toBe(true);
    expect(failure?.length).toBe(201);
    f.emit([session({ state: "finished" })]);
    expect(f.bridge.phoneView().sessions[0]).not.toHaveProperty("failure");
  });

  it("sends null when the Mac has no reason", () => {
    const f = fixture({ failure: null });
    f.emit([session({ state: "error" })]);
    expect(f.bridge.phoneView().sessions[0]).toMatchObject({ failure: null });
  });
});

describe("RemoteBridge workflow", () => {
  const status = {
    provider: "rasanai" as const,
    projectDir: "/films/quotidian",
    runDir: "/films/quotidian/.rasanai/run-1",
    title: "Quotidian",
    call: "look" as const,
    step: "look",
    revision: "look@1",
    since: "2026-09-25T02:58:00.000Z",
    prompt: "Pick a look",
  };
  const film = session({
    key: "claude-transcript:d1",
    conductorSessionId: null,
    origin: "sdk",
    cwd: "/films/quotidian",
    state: "awaiting_input",
    detail: "RasanAI · Pick a look",
    workflow: status,
  });
  const card = {
    provider: "rasanai" as const,
    call: "look" as const,
    step: "look",
    revision: "look@1",
    title: "Quotidian",
    prompt: "Pick a look",
    options: [{ id: "wild", label: "Wild", title: "Foil", summary: null, why: null, image: ".rasanai/run-1/w.png" }],
    recommended: "wild",
  };
  const workflows = () => ({
    view: vi.fn(() => card),
    allowsImage: vi.fn((_: unknown, source: string) => source === ".rasanai/run-1/w.png"),
    act: vi.fn(() => ({ ok: true as const, actionId: "sq1", said: "Picked Wild: Foil" })),
  });

  it("puts the film's card on the waiting session", async () => {
    const f = fixture({ workflow: workflows() });
    f.emit([film]);
    const shown = f.bridge.phoneView().sessions[0] as Record<string, unknown>;
    expect(shown.workflow).toEqual(card);
    expect(shown.detail).toBe("RasanAI · Pick a look");
  });

  it("hands a pick to the provider with the session's own project folder, never the phone's", async () => {
    const workflow = workflows();
    const f = fixture({ workflow });
    await f.pair();
    f.emit([film]);
    await f.store.set(`${f.channel}/commands/c1`, f.workflowCommand({ projectDir: "/etc" }));
    await f.bridge.tick();
    expect(workflow.act).toHaveBeenCalledWith("/films/quotidian", {
      step: "look",
      revision: "look@1",
      type: "choose",
      value: "wild",
    });
    expect(f.result("c1")).toEqual({ id: "c1", status: "sent", said: "Picked Wild: Foil" });
  });

  it("refuses a session that isn't waiting on a film, a malformed answer, and a provider's no", async () => {
    const workflow = workflows();
    workflow.act.mockReturnValueOnce({ ok: false, reason: "That isn't one of the options." } as never);
    const f = fixture({ workflow });
    await f.pair();
    f.emit([film, session()]);
    await f.store.set(`${f.channel}/commands/c1`, f.workflowCommand({ sessionKey: "claude-transcript:s1" }));
    await f.store.set(`${f.channel}/commands/c2`, f.workflowCommand({ type: "Choose; rm" }));
    await f.store.set(`${f.channel}/commands/c3`, f.workflowCommand({ value: "nope" }));
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({ status: "refused", reason: "That isn't waiting on you any more." });
    expect(f.result("c2")).toMatchObject({ status: "refused", reason: "Not a request this Mac understands." });
    expect(f.result("c3")).toMatchObject({ status: "refused", reason: "That isn't one of the options." });
    expect(workflow.act).toHaveBeenCalledTimes(1);
  });

  it("refuses everything when this Mac has no workflows", async () => {
    const f = fixture();
    await f.pair();
    f.emit([film]);
    await f.store.set(`${f.channel}/commands/c1`, f.workflowCommand());
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({ status: "refused", reason: "This Mac can't answer that from a phone." });
  });

  it("sends a picture on the card, read in the film's folder, and nothing else", async () => {
    const image = vi.fn(
      async (): Promise<PhoneImageResult> => ({ ok: true, image: { mime: "image/jpeg", data: "AAAA" } }),
    );
    const f = fixture({ workflow: workflows(), image });
    await f.pair();
    f.emit([film]);
    await f.store.set(
      `${f.channel}/commands/c1`,
      f.imageCommand({ sessionId: "", sessionKey: "claude-transcript:d1", source: ".rasanai/run-1/w.png" }),
    );
    await f.store.set(
      `${f.channel}/commands/c2`,
      f.imageCommand({ sessionId: "", sessionKey: "claude-transcript:d1", source: ".rasanai/run-1/director.log" }),
    );
    await f.bridge.tick();
    expect(image).toHaveBeenCalledTimes(1);
    expect(image).toHaveBeenCalledWith(".rasanai/run-1/w.png", "/films/quotidian");
    expect(f.result("c1")).toMatchObject({ status: "sent" });
    expect(f.result("c2")).toMatchObject({ status: "refused", reason: "That picture isn't on this card." });
  });
});

describe("RemoteBridge media", () => {
  const film = session({
    key: "claude-transcript:d1",
    conductorSessionId: null,
    origin: "sdk",
    cwd: "/films/q",
    state: "awaiting_input",
    workflow: {
      provider: "rasanai",
      projectDir: "/films/q",
      runDir: "/films/q/.rasanai/run-1",
      title: "Q",
      call: "final",
      step: "render",
      revision: "render@1",
      since: "2026-09-25T02:58:00.000Z",
      prompt: "Review the film",
    },
  });
  const workflows = () => ({
    view: () => null,
    allowsImage: () => false,
    allowsMedia: vi.fn((_: unknown, source: string) => source === "exports/film.mp4"),
    act: () => ({ ok: false as const, reason: "no" }),
  });

  function withFile(bytes: Buffer) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-media-"));
    dirs.push(dir);
    const file = path.join(dir, "copy.m4v");
    fs.writeFileSync(file, bytes);
    return vi.fn(async () => ({
      ok: true as const,
      file: { path: file, mime: "video/mp4" as const, bytes: bytes.length },
    }));
  }

  it("leaves the phone copy in sealed chunks that put back together into the same bytes", async () => {
    const bytes = crypto.randomBytes(MEDIA_CHUNK_BYTES * 2 + 1234);
    const media = withFile(bytes);
    const f = fixture({ streaming: true, workflow: workflows(), media });
    await f.pair();
    f.emit([film]);
    await f.store.set(`${f.channel}/commands/c1`, f.mediaCommand());
    await f.bridge.tick();
    expect(media).toHaveBeenCalledWith("exports/film.mp4", "/films/q");
    const answer = f.result("c1") as {
      status: string;
      media: { id: string; chunks: number; bytes: number; sha256: string };
    };
    expect(answer).toMatchObject({ status: "sent", media: { chunks: 3, bytes: bytes.length, mime: "video/mp4" } });
    const parts = Array.from({ length: answer.media.chunks }, (_, index) => {
      const doc = f.store.docs.get(`${f.channel}/media/${answer.media.id}-${index}`)!;
      expect(doc.box.length).toBeLessThan(900_000);
      return open<{ i: number; n: number; data: string }>(f.payload.k, doc.box);
    });
    const joined = Buffer.concat(parts.map((part) => Buffer.from(part.data, "base64")));
    expect(joined.equals(bytes)).toBe(true);
    expect(crypto.createHash("sha256").update(joined).digest("hex")).toBe(answer.media.sha256);
  });

  it("reuses an upload still in the channel, and deletes the chunks when their time is up", async () => {
    const media = withFile(crypto.randomBytes(1000));
    const f = fixture({ streaming: true, workflow: workflows(), media });
    await f.pair();
    f.emit([film]);
    await f.store.set(`${f.channel}/commands/c1`, f.mediaCommand());
    await f.bridge.tick();
    await f.store.set(`${f.channel}/commands/c2`, f.mediaCommand());
    await f.bridge.tick();
    const first = f.result("c1") as { media: { id: string } };
    expect((f.result("c2") as { media: { id: string } }).media.id).toBe(first.media.id);
    expect(f.store.docs.has(`${f.channel}/media/${first.media.id}-0`)).toBe(true);
    f.advance(MEDIA_TTL_MS + 1);
    await f.bridge.tick();
    expect(f.store.docs.has(`${f.channel}/media/${first.media.id}-0`)).toBe(false);
  });

  it("refuses what the card doesn't play, a session not waiting, and a Mac on Firestore", async () => {
    const media = withFile(Buffer.from("x"));
    const f = fixture({ streaming: true, workflow: workflows(), media });
    await f.pair();
    f.emit([film, session()]);
    await f.store.set(`${f.channel}/commands/c1`, f.mediaCommand({ source: "../../etc/hosts.mp4" }));
    await f.store.set(`${f.channel}/commands/c2`, f.mediaCommand({ sessionKey: "claude-transcript:s1" }));
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({ status: "refused", reason: "That isn't on this card." });
    expect(f.result("c2")).toMatchObject({ status: "refused", reason: "That isn't waiting on you any more." });
    expect(media).not.toHaveBeenCalled();
    const polled = fixture({ workflow: workflows(), media });
    await polled.pair();
    polled.emit([film]);
    await polled.store.set(`${polled.channel}/commands/c1`, polled.mediaCommand());
    await polled.bridge.tick();
    expect(polled.result("c1")).toMatchObject({ status: "refused", reason: "This Mac can't send films to a phone." });
  });
});
