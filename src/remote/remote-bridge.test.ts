import { CloudBudget } from "./shared-limits.js";
import type { Answerer } from "../fleet/answer-command.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyAwakeAction, AwakeSession, readAwakeAction } from "../fleet/awake-session.js";
import { LidActions, readSettings as readLidActionSettings } from "../fleet/lid-actions.js";
import { awakeRules } from "../fleet/power-monitor.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FleetSnapshot } from "../fleet/fleet-monitor.js";
import type { TranscriptMessage } from "../fleet/transcript.js";
import type { PhoneImageResult } from "./phone-image.js";
import type { QueueAction, QueueItem, ReplyOutcome } from "../fleet/reply-types.js";
import type { FleetSession } from "../fleet/types.js";
import type { ChannelDoc } from "./firestore-rest.js";
import type { NewChatWorkspace } from "../fleet/new-chat.js";
import type { StartChatOutcome } from "../fleet/chat-starter.js";
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
  type RemoteAddonPhone,
  type StartCommand,
} from "./remote-bridge.js";
import { open, pairingCode, seal } from "./remote-crypto.js";
import { AddonHost } from "../addon-host.js";
import type { AddonHandle } from "../addons.js";
import { historyPageDoc, liveHandle } from "./live-turn.js";
import { subagentFeedDoc } from "./subagent-feed.js";
import type { SubagentActivity } from "../fleet/subagent-activity.js";
import { ChatPresetsStore } from "../fleet/chat-presets.js";
import { logger } from "../utils/logger.js";
import { NativeHostError } from "../native/client.js";
import { defaultNotifySettings, NotifySettingsStore } from "../fleet/notify-settings.js";
import { VoiceSettingsStore } from "../voice/settings.js";

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
    image?: ((source: string, cwd: string, root?: string) => Promise<PhoneImageResult>) | null;
    hotspot?: RemoteBridgeDependencies["hotspot"];
    claudeAccounts?: RemoteBridgeDependencies["claudeAccounts"];
    shared?: RemoteBridgeDependencies["shared"];
    addonPhone?: RemoteAddonPhone | null;
    renamer?: RemoteBridgeDependencies["renamer"];
    closer?: RemoteBridgeDependencies["closer"];
    /** The chat's latest message, as the replier reads it. */
    lastText?: string;
    /** Why the chat's newest turn failed, as the replier reads it. */
    failure?: string | null;
    /** A store that streams, like the Realtime Database. */
    streaming?: boolean;
    /** The replier's paged transcript reader. */
    transcript?: (
      sessionId: string,
      limit: number,
      before?: number | null,
    ) => { messages: TranscriptMessage[]; nextBefore?: string | null };
    /** The session as the snapshot shows it. */
    session?: Partial<FleetSession>;
    /** The replier's reader of the work between two messages. */
    workBetween?: (
      sessionId: string,
      messageId: string,
    ) => { steps: Array<{ kind: "tool" | "thinking"; text: string }>; more: number } | null;
    verbose?: boolean;
    sendDefault?: RemoteBridgeDependencies["sendDefault"];
    native?: RemoteBridgeDependencies["native"];
    projectIcons?: RemoteBridgeDependencies["projectIcons"];
    /** The add-ons enabled now; absent: an older Mac that does not say. */
    addons?: string[];
    /** The replier's answer for a session no host owns; absent: a replier without `canReply`. */
    canReply?: (session: FleetSession) => boolean;
    notify?: RemoteBridgeDependencies["notify"];
    workspaceActions?: RemoteBridgeDependencies["workspaceActions"];
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
    ...(options.canReply ? { canReply: options.canReply } : {}),
    send: vi.fn(async (sessionId: string, text: string) => {
      sends.push({ sessionId, text });
      return options.outcome ?? ({ status: "started", via: "conductor" } as ReplyOutcome);
    }),
    ...(options.transcript ? { transcript: options.transcript } : {}),
    ...(options.workBetween ? { workBetween: options.workBetween } : {}),
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
    sessions: [session(options.session)],
    active: [session(options.session)],
    attention: [],
    generatedAt: "",
    codexUsage: null,
  } as FleetSnapshot;
  const listeners = new Set<(s: FleetSnapshot) => void>();
  const emit = (active: FleetSession[], sessions: FleetSession[] = active) => {
    snapshot = { ...snapshot, sessions, active };
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
    native: options.native ?? null,
    ...(options.projectIcons ? { projectIcons: options.projectIcons } : {}),
    ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
    answerer: options.answerer ?? null,
    sendDefault: options.sendDefault ?? null,
    diff: options.diff ?? null,
    renamer: options.renamer ?? null,
    closer: options.closer ?? null,
    ...(options.addons ? { addons: () => options.addons! } : {}),
    notify: options.notify ?? null,
    workspaceActions: options.workspaceActions ?? null,
    image: options.image ?? null,
    hotspot: options.hotspot ?? null,
    claudeAccounts: options.claudeAccounts ?? null,
    shared: options.shared ?? null,
    addonPhone: options.addonPhone ?? null,
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

  const pondCommand = (overrides: Record<string, unknown> = {}, signer = phone) => {
    const body = {
      v: 1,
      kind: "pond",
      op: "hide",
      pondId: "p-new",
      hidden: true,
      nonce: crypto.randomBytes(16).toString("hex"),
      expiresAt: now + 60_000,
      ...overrides,
    };
    const box = seal(payload.k, body);
    return { box, sig: signer.sign(box), device: "iphone-1" };
  };

  const attachCommand = (overrides: Record<string, unknown> = {}, signer = phone) => {
    const body = {
      v: 1,
      kind: "attach",
      sessionId: "s1",
      uploadId: crypto.randomBytes(8).toString("hex"),
      index: 0,
      total: 1,
      data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 9)]).toString("base64"),
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

  const workCommand = (overrides: Record<string, unknown> = {}, signer = phone) => {
    const body = {
      v: 1,
      kind: "work",
      sessionId: "s1",
      messageId: "2",
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

  const historyCommand = (overrides: Record<string, unknown> = {}, signer = phone) => {
    const body = {
      v: 1,
      kind: "history",
      key: "claude-transcript:s1",
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

  const claudeAccountCommand = (overrides: Record<string, unknown> = {}, signer = phone) => {
    const body = {
      v: 1,
      kind: "claudeAccount",
      use: "home",
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

  const nativeCommand = (body: Record<string, unknown>, signer = phone) => {
    const box = seal(payload.k, {
      v: 1,
      kind: "native",
      nonce: crypto.randomBytes(16).toString("hex"),
      expiresAt: now + 60_000,
      ...body,
    });
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
    pondCommand,
    attachCommand,
    diffCommand,
    workCommand,
    imageCommand,
    historyCommand,
    hotspotCommand,
    claudeAccountCommand,
    workflowCommand,
    mediaCommand,
    nativeCommand,
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

describe("RemoteBridge command order and the send default", () => {
  it("writes the result before deleting the command", async () => {
    const f = fixture();
    await f.pair();
    const order: string[] = [];
    const set = f.store.set.bind(f.store);
    const del = f.store.delete.bind(f.store);
    f.store.set = async (p: string, d: never) => {
      if (p.includes("/results/")) order.push("result");
      return set(p, d);
    };
    f.store.delete = async (p: string) => {
      if (p.includes("/commands/")) order.push("delete");
      return del(p);
    };
    await f.store.set(`${f.channel}/commands/c1`, f.command());
    await f.bridge.tick();
    expect(order.indexOf("result")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("result")).toBeLessThan(order.indexOf("delete"));
  });

  it("handles a reply before the other commands in the same batch, still checking every one", async () => {
    const f = fixture();
    await f.pair();
    const handled: string[] = [];
    const real = f.bridge.handleCommand.bind(f.bridge);
    f.bridge.handleCommand = (async (config: never, id: string, doc: never) => {
      handled.push(id);
      return real(config, id, doc);
    }) as typeof f.bridge.handleCommand;
    await f.store.set(`${f.channel}/commands/a-stop`, f.stopCommand());
    await f.store.set(`${f.channel}/commands/b-queue`, f.queueCommand());
    await f.store.set(`${f.channel}/commands/c-reply`, f.command());
    await f.store.set(`${f.channel}/commands/d-forged`, f.command({}, device()));
    await f.bridge.tick();
    expect(handled[0]).toBe("c-reply");
    expect(new Set(handled)).toEqual(new Set(["a-stop", "b-queue", "c-reply", "d-forged"]));
    expect(f.result("d-forged")).toBeNull();
    expect(f.result("c-reply")).toMatchObject({ status: "sent" });
  });

  it("uses the shared send default only when the reply names no mode", async () => {
    const f = fixture({ sendDefault: { state: () => "steer", apply: () => ({ ok: true, state: "steer" }) } });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.command());
    await f.store.set(`${f.channel}/commands/c2`, f.command({ mode: "queue" }));
    await f.bridge.tick();
    expect(f.replier.send.mock.calls.map((call) => (call as unknown[])[3])).toEqual([
      { mode: "steer" },
      { mode: "queue" },
    ]);
    expect(f.bridge.phoneView().sendDefault).toBe("steer");
  });

  it("changes the default through a signed command, exactly its keys", async () => {
    let mode: "queue" | "steer" = "queue";
    const f = fixture({
      sendDefault: {
        state: () => mode,
        apply: (request) => {
          const next = (request as { mode?: unknown }).mode;
          if (next !== "queue" && next !== "steer") return { ok: false, reason: "no" };
          mode = next;
          return { ok: true, state: mode };
        },
      },
    });
    await f.pair();
    const signed = (fields: Record<string, unknown>) => {
      const box = seal(f.payload.k, {
        v: 1,
        kind: "sendDefault",
        nonce: crypto.randomBytes(16).toString("hex"),
        expiresAt: NOW + 60_000,
        ...fields,
      });
      return { box, sig: f.phone.sign(box), device: "iphone-1" };
    };
    const config = JSON.parse(fs.readFileSync(path.join(path.dirname(f.configPath), "remote.json"), "utf8"));
    expect((await f.bridge.handleCommand(config, "s1", signed({ mode: "steer" }))).result).toEqual({
      id: "s1",
      status: "sent",
    });
    expect(mode).toBe("steer");
    expect((await f.bridge.handleCommand(config, "s2", signed({ mode: "interrupt" }))).result).toMatchObject({
      status: "refused",
    });
    expect((await f.bridge.handleCommand(config, "s3", signed({ mode: "queue", extra: 1 }))).result).toMatchObject({
      status: "refused",
    });
    expect(mode).toBe("steer");
  });
});

describe("RemoteBridge honest delivery", () => {
  it("reports a message the Mac could not prove arrived as unconfirmed, never as sent", async () => {
    const f = fixture({ outcome: { status: "unconfirmed", reason: "I could not see it arrive." } });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.command());
    await f.bridge.tick();
    expect(f.result("c1")).toEqual({ id: "c1", status: "unconfirmed", reason: "I could not see it arrive." });
  });

  it("answers a reply that blew up with unconfirmed, so the phone is never left waiting", async () => {
    const f = fixture();
    f.replier.send.mockRejectedValueOnce(new Error("boom"));
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.command());
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({ status: "unconfirmed" });
    expect(f.store.docs.has(`${f.channel}/commands/c1`)).toBe(false);
  });

  it("tells the phone a reply expired before the Mac saw it", async () => {
    const f = fixture();
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.command());
    f.advance(11 * 60_000);
    await f.bridge.tick();
    expect(f.sends).toEqual([]);
    expect(f.result("c1")).toMatchObject({ status: "refused", reason: expect.stringContaining("expired") });
  });

  it("writes the result again when the network drops it once", async () => {
    const f = fixture();
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.command());
    const set = f.store.set.bind(f.store);
    let failed = 0;
    f.store.set = async (path: string, doc: never) => {
      if (path.includes("/results/c1") && failed++ < 1) {
        throw new Error("fetch failed");
      }
      return set(path, doc);
    };
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({ status: "sent" });
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

describe("RemoteBridge Claude account", () => {
  const list = {
    available: true,
    current: "work",
    accounts: [
      { name: "home", email: "h@x.com", plan: "claude_max" },
      { name: "work", email: "w@x.com", plan: "claude_team" },
    ],
  };
  const accounts = (state: unknown = list) => ({
    state: () => state,
    apply: vi.fn(async (request: unknown) =>
      (request as { use?: unknown }).use === "home"
        ? { ok: true as const, current: "home" }
        : { ok: false as const, reason: "That isn't a Claude account this Mac knows." },
    ),
  });

  it("switches through the shared function, answers the account now in use, and shows the list", async () => {
    const a = accounts();
    const f = fixture({ claudeAccounts: a });
    await f.pair();
    expect(f.bridge.phoneView()).toMatchObject({ claudeAccounts: list });
    await f.store.set(`${f.channel}/commands/c1`, f.claudeAccountCommand());
    await f.bridge.tick();
    expect(a.apply).toHaveBeenCalledWith({ use: "home" });
    expect(f.result("c1")).toEqual({ id: "c1", status: "sent", current: "home" });
  });

  it("refuses an unknown name, an extra key, a replay, and a Mac that cannot switch", async () => {
    const a = accounts();
    const f = fixture({ claudeAccounts: a });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.claudeAccountCommand({ use: "nobody" }));
    await f.store.set(`${f.channel}/commands/c2`, f.claudeAccountCommand({ extra: 1 }));
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({ status: "refused", reason: /isn't a Claude account/ });
    expect(f.result("c2")).toMatchObject({ status: "refused" });
    expect(a.apply).toHaveBeenCalledTimes(1);
    const none = fixture({ claudeAccounts: accounts(null) });
    await none.pair();
    expect(none.bridge.phoneView()).not.toHaveProperty("claudeAccounts");
    await none.store.set(`${none.channel}/commands/c1`, none.claudeAccountCommand());
    await none.bridge.tick();
    expect(none.result("c1")).toMatchObject({ status: "refused" });
  });

  it("is refused on the shared server", async () => {
    const a = accounts();
    const f = fixture({ claudeAccounts: a, shared: { budget: new CloudBudget() } });
    await f.pair();
    expect(f.bridge.phoneView()).not.toHaveProperty("claudeAccounts");
    await f.store.set(`${f.channel}/commands/c1`, f.claudeAccountCommand());
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({ status: "refused" });
    expect(a.apply).not.toHaveBeenCalled();
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
    expect(image).toHaveBeenCalledWith("/w/.context/shot.png", "/w", "/w");
    expect(f.result("c1")).toEqual({ id: "c1", status: "sent", image: { mime: "image/jpeg", data: "AAAA" } });
  });

  it("keeps an image inside the Conductor workspace, not the subfolder the agent cd'd into", async () => {
    const image = vi.fn(ok);
    const f = fixture({ image, lastText: shown, session: { cwd: "/w/brand/source", workspaceRoot: "/w" } });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.imageCommand());
    await f.bridge.tick();
    expect(image).toHaveBeenCalledWith("/w/.context/shot.png", "/w/brand/source", "/w");
    expect(f.result("c1")).toMatchObject({ status: "sent" });
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

describe("RemoteBridge history pages", () => {
  const messages = (count: number): TranscriptMessage[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `m${index}`,
      cursor: String(100 + index),
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `message ${index}`,
      at: null,
      turnId: null,
    }));
  function withHistory(total = 30) {
    const calls: Array<{ limit: number; before: number | null | undefined }> = [];
    const f = fixture({
      streaming: true,
      transcript: (_id, limit, before) => {
        calls.push({ limit, before });
        const all = messages(total).filter((m) => before == null || Number(m.cursor) < before);
        const page = all.slice(-limit);
        return { messages: page, nextBefore: all.length > limit ? page[0]!.cursor! : null };
      },
    });
    const page = (id: string) => {
      const doc = [...f.store.docs.entries()].find(([key]) => key.includes("/live/") && key.endsWith(id));
      return doc ? open<Record<string, unknown>>(f.payload.k, doc[1].box) : null;
    };
    return { f, calls, page };
  }

  it("answers with a sealed live document of up to 12 entries and the cursor to go further back", async () => {
    const { f, page } = withHistory();
    await f.pair();
    await f.store.set(`${f.channel}/commands/h1`, f.historyCommand({ n: 99 }));
    await f.bridge.tick();
    const result = f.result("h1") as { status: string; doc: string };
    expect(result.status).toBe("sent");
    expect(result.doc).toBe(historyPageDoc("claude-transcript:s1", null));
    const first = page(result.doc) as { entries: Array<{ id: string }>; nextBefore: string; complete: boolean };
    expect(first.entries).toHaveLength(12);
    expect(first.entries.at(-1)!.id).toBe("129");
    expect(first.complete).toBe(false);
    expect(first.nextBefore).toBe(first.entries[0]!.id);

    await f.store.set(`${f.channel}/commands/h2`, f.historyCommand({ before: first.nextBefore, n: 12 }));
    await f.bridge.tick();
    const second = page((f.result("h2") as { doc: string }).doc) as { entries: unknown[]; nextBefore: string | null };
    expect(second.entries).toHaveLength(12);
    await f.store.set(`${f.channel}/commands/h3`, f.historyCommand({ before: "106", n: 12 }));
    await f.bridge.tick();
    const last = page((f.result("h3") as { doc: string }).doc) as { complete: boolean; nextBefore: string | null };
    expect(last).toMatchObject({ complete: true, nextBefore: null });
  });

  it("never runs on a bad signature, an expired or replayed command, or a key the phone is not shown", async () => {
    const { f, calls } = withHistory();
    await f.pair();
    const stranger = device();
    await f.store.set(`${f.channel}/commands/b1`, f.historyCommand({}, stranger));
    await f.bridge.tick();
    expect(f.result("b1")).toBeNull();
    await f.store.set(`${f.channel}/commands/b2`, f.historyCommand({ expiresAt: NOW - 1 }));
    await f.bridge.tick();
    expect(f.result("b2")).toMatchObject({ status: "refused" });
    const replay = f.historyCommand({ nonce: "n".repeat(20) });
    await f.store.set(`${f.channel}/commands/b3`, replay);
    await f.bridge.tick();
    expect(f.result("b3")).toMatchObject({ status: "sent" });
    await f.store.set(`${f.channel}/commands/b4`, f.historyCommand({ nonce: "n".repeat(20) }));
    await f.bridge.tick();
    expect(f.result("b4")).toMatchObject({ status: "refused", reason: "That reply was already received." });
    await f.store.set(`${f.channel}/commands/b5`, f.historyCommand({ key: "claude-transcript:elsewhere" }));
    await f.bridge.tick();
    expect(f.result("b5")).toMatchObject({ status: "refused", reason: "That chat isn't on your phone any more." });
    await f.store.set(`${f.channel}/commands/b6`, f.historyCommand({ before: "12abc" }));
    await f.bridge.tick();
    expect(f.result("b6")).toMatchObject({ status: "refused" });
    // The phone view's own lastUser reads (limit 4) are not history pages.
    expect(calls.filter((call) => call.limit === 60)).toHaveLength(1);
  });

  it("clamps n to 12 and deletes the page with the media after 30 minutes", async () => {
    const { f } = withHistory(100);
    await f.pair();
    await f.store.set(`${f.channel}/commands/h1`, f.historyCommand({ n: 500 }));
    await f.bridge.tick();
    const doc = (f.result("h1") as { doc: string }).doc;
    expect(f.store.docs.has(`${f.channel}/live/${doc}`)).toBe(true);
    f.advance(MEDIA_TTL_MS + 1000);
    await f.bridge.tick();
    expect(f.store.docs.has(`${f.channel}/live/${doc}`)).toBe(false);
  });

  it("refuses a Mac whose store cannot stream", async () => {
    const f = fixture({ transcript: () => ({ messages: [] }) });
    await f.pair();
    await f.store.set(`${f.channel}/commands/h1`, f.historyCommand());
    await f.bridge.tick();
    expect(f.result("h1")).toMatchObject({ status: "refused" });
  });
});

describe("RemoteBridge steer and lastUser", () => {
  it("refuses a steer while the chat waits on a question, and sends one otherwise", async () => {
    const waiting = fixture({ session: { state: "awaiting_input" } });
    await waiting.pair();
    await waiting.store.set(
      `${waiting.channel}/commands/c1`,
      waiting.command({ mode: "steer", answersTurn: "turn-1" }),
    );
    await waiting.bridge.tick();
    expect(waiting.result("c1")).toMatchObject({ status: "refused" });
    expect(waiting.sends).toHaveLength(0);
  });

  it("carries the newest user message, clipped to 200 characters, on each phone session", async () => {
    const f = fixture({
      transcript: () => ({
        messages: [
          { id: "a", role: "user", text: "old", at: null, turnId: null },
          { id: "b", role: "user", text: "x".repeat(500), at: "2026-09-25T02:00:00.000Z", turnId: null },
          { id: "c", role: "assistant", text: "answer", at: null, turnId: null },
        ],
      }),
    });
    await f.pair();
    await f.bridge.tick();
    const view = open<{ sessions: Array<{ lastUser?: { text: string; at: string } }> }>(
      f.payload.k,
      f.store.docs.get(`${f.channel}/state/snapshot`)!.box,
    );
    expect(view.sessions[0]!.lastUser!.text).toHaveLength(200);
    expect(view.sessions[0]!.lastUser!.at).toBe("2026-09-25T02:00:00.000Z");
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

  it("reads the Conductor workspace, not the subfolder the agent cd'd into", async () => {
    const diff = reader();
    const f = fixture({ diff, session: { cwd: "/w/brand/source", workspaceRoot: "/w" } });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.diffCommand({ file: 0 }));
    await f.bridge.tick();
    // From the subfolder, git names files from the top but looks them up from there: a patch came back empty.
    expect(diff.readSummary).toHaveBeenCalledWith("/w", null);
    expect(diff.readFilePatch).toHaveBeenCalledWith("/w", null, file);
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

describe("RemoteBridge work between messages", () => {
  const steps = [{ kind: "tool" as const, text: "Read a.ts" }];
  const work = (steps0 = steps) => vi.fn((_s: string, id: string) => (id === "2" ? { steps: steps0, more: 0 } : null));

  it("answers with the steps, for a chat the phone is shown, and advertises the capability", async () => {
    const workBetween = work();
    const f = fixture({ workBetween });
    await f.pair();
    expect(f.bridge.phoneView()).toMatchObject({ workSteps: true });
    await f.store.set(`${f.channel}/commands/w1`, f.workCommand());
    await f.bridge.tick();
    expect(workBetween).toHaveBeenCalledWith("s1", "2");
    expect(f.result("w1")).toEqual({ id: "w1", status: "sent", work: { steps, more: 0 } });
  });

  it("refuses an unknown message, a chat not shown, extra keys, and a replay", async () => {
    const f = fixture({ workBetween: work() });
    await f.pair();
    const ask = async (name: string, overrides: Record<string, unknown>) => {
      await f.store.set(`${f.channel}/commands/${name}`, f.workCommand(overrides));
      await f.bridge.tick();
      return f.result(name);
    };
    expect(await ask("a", { messageId: "99" })).toMatchObject({ status: "refused" });
    expect(await ask("b", { sessionId: "s-elsewhere" })).toMatchObject({
      status: "refused",
      reason: "That chat isn't on your phone any more.",
    });
    expect(await ask("c", { extra: 1 })).toMatchObject({ status: "refused" });
    expect(await ask("d", { messageId: "nope" })).toMatchObject({ status: "refused" });
    const replay = f.workCommand({ nonce: "a".repeat(32) });
    await f.store.set(`${f.channel}/commands/e1`, replay);
    await f.bridge.tick();
    await f.store.set(`${f.channel}/commands/e2`, replay);
    await f.bridge.tick();
    expect(f.result("e1")).toMatchObject({ status: "sent" });
    expect(f.result("e2")).toMatchObject({ status: "refused" });
  });

  it("is refused, and not advertised, with verbose off or a replier that cannot read it", async () => {
    const off = fixture({ workBetween: work(), verbose: false });
    await off.pair();
    expect(off.bridge.phoneView()).not.toHaveProperty("workSteps");
    await off.store.set(`${off.channel}/commands/w1`, off.workCommand());
    await off.bridge.tick();
    expect(off.result("w1")).toMatchObject({ status: "refused" });
    const bare = fixture();
    expect(bare.bridge.phoneView()).not.toHaveProperty("workSteps");
  });
});

describe("RemoteBridge photos", () => {
  const tmp: string[] = [];
  const folder = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-photo-"));
    tmp.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of tmp.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("saves a photo for a chat the phone is shown, in that chat's own folder, and says where", async () => {
    const dir = folder();
    const f = fixture();
    f.emit([session({ cwd: dir })]);
    await f.pair();
    await f.store.set(`${f.channel}/commands/p1`, f.attachCommand());
    await f.bridge.tick();
    const result = f.result("p1") as { status: string; ref?: string };
    expect(result.status).toBe("sent");
    expect(result.ref).toMatch(/^\.context\/attachments\/[0-9a-f]{8}\/image-1\.jpg$/);
    expect(fs.existsSync(path.join(dir, result.ref!))).toBe(true);
  });

  it("answers a photo's re-sent last chunk with the same ref and saves it once", async () => {
    const dir = folder();
    const f = fixture();
    f.emit([session({ cwd: dir })]);
    await f.pair();
    const body = { uploadId: "retry-upload-1" };
    await f.store.set(`${f.channel}/commands/p1`, f.attachCommand(body));
    await f.bridge.tick();
    const first = f.result("p1") as { status: string; ref?: string };
    await f.store.set(`${f.channel}/commands/p2`, f.attachCommand(body));
    await f.bridge.tick();
    expect(f.result("p2")).toMatchObject({ status: "sent", ref: first.ref });
    expect(fs.readdirSync(path.join(dir, ".context", "attachments"))).toHaveLength(1);
  });

  it("saves a photo at the workspace's top when the agent has cd'd into a subfolder", async () => {
    const dir = folder();
    const sub = path.join(dir, "brand", "source");
    fs.mkdirSync(sub, { recursive: true });
    const f = fixture();
    f.emit([session({ cwd: sub, workspaceRoot: dir })]);
    await f.pair();
    await f.store.set(`${f.channel}/commands/p1`, f.attachCommand());
    await f.bridge.tick();
    const result = f.result("p1") as { status: string; ref?: string };
    expect(result.ref).toMatch(/^\.context\/attachments\//);
    // `.context/` is ignored by git only at the top; under the subfolder the photo could be committed.
    expect(fs.existsSync(path.join(dir, result.ref!))).toBe(true);
    expect(fs.existsSync(path.join(sub, ".context"))).toBe(false);
  });

  it("saves a photo for a new chat in the workspace's folder, which comes from the Mac's list", async () => {
    const dir = folder();
    const { starter } = chatStarter([workspace("w1", { path: dir })]);
    const f = fixture({ newChat: starter });
    await f.pair();
    await f.store.set(`${f.channel}/commands/p1`, f.attachCommand({ sessionId: undefined, workspaceId: "w1" }));
    await f.bridge.tick();
    expect(f.result("p1")).toMatchObject({ status: "sent", ref: expect.stringContaining(".context/attachments/") });
    expect(fs.readdirSync(path.join(dir, ".context", "attachments"))).toHaveLength(1);
  });

  it("refuses a chat that is not shown, a closed one, both targets or neither, and a file that is not a photo", async () => {
    const dir = folder();
    const f = fixture();
    f.emit([session({ cwd: dir }), session({ conductorSessionId: "gone", key: "k:gone", cwd: dir, closed: true })]);
    await f.pair();
    const send = async (name: string, overrides: Record<string, unknown>) => {
      await f.store.set(`${f.channel}/commands/${name}`, f.attachCommand(overrides));
      await f.bridge.tick();
      return f.result(name);
    };
    expect(await send("a", { sessionId: "s-elsewhere" })).toMatchObject({ status: "refused" });
    expect(await send("b", { sessionId: "gone" })).toMatchObject({ status: "refused" });
    expect(await send("c", { workspaceId: "w1" })).toMatchObject({ status: "refused" });
    expect(await send("d", { sessionId: undefined })).toMatchObject({ status: "refused" });
    expect(await send("e", { data: Buffer.from("not an image").toString("base64") })).toMatchObject({
      status: "refused",
    });
    expect(fs.existsSync(path.join(dir, ".context"))).toBe(false);
  });

  it("slows a phone that sends too many pieces in a minute", async () => {
    const dir = folder();
    const f = fixture();
    f.emit([session({ cwd: dir })]);
    await f.pair();
    let refused = 0;
    for (let i = 0; i < 45; i++) {
      await f.store.set(`${f.channel}/commands/r${i}`, f.attachCommand());
      await f.bridge.tick();
      if ((f.result(`r${i}`) as { status: string }).status === "refused") refused++;
    }
    expect(refused).toBeGreaterThan(0);
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

describe("RemoteBridge close", () => {
  const closeCommand = (f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) =>
    f.renameCommand({ kind: "close", title: undefined, ...overrides });

  it("closes a chat the phone is shown", async () => {
    const closed: string[] = [];
    const f = fixture({ closer: { close: (id) => (closed.push(id), "closed") } });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, closeCommand(f));
    await f.bridge.tick();
    expect(f.result("c1")).toEqual({ id: "c1", status: "sent" });
    expect(closed).toEqual(["s1"]);
  });

  it("waits for a closer that drives Conductor's window", async () => {
    const closed: string[] = [];
    const f = fixture({
      closer: {
        close: async (id) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          closed.push(id);
          return "closed" as const;
        },
      },
    });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, closeCommand(f));
    await f.bridge.tick();
    expect(f.result("c1")).toEqual({ id: "c1", status: "sent" });
    expect(closed).toEqual(["s1"]);
  });

  it("refuses a chat not shown, a busy chat, a missing one, and a Mac that cannot", async () => {
    const closed: string[] = [];
    const f = fixture({ closer: { close: (id) => (closed.push(id), "closed") } });
    await f.pair();
    await f.store.set(`${f.channel}/commands/a`, closeCommand(f, { sessionId: "s-elsewhere" }));
    await f.bridge.tick();
    expect(f.result("a")).toMatchObject({ status: "refused" });
    expect(closed).toEqual([]);
    const busy = fixture({ closer: { close: () => "busy" } });
    await busy.pair();
    await busy.store.set(`${busy.channel}/commands/b`, closeCommand(busy));
    await busy.bridge.tick();
    expect(busy.result("b")).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("running or waiting"),
    });
    const gone = fixture({ closer: { close: () => "missing" } });
    await gone.pair();
    await gone.store.set(`${gone.channel}/commands/c`, closeCommand(gone));
    await gone.bridge.tick();
    expect(gone.result("c")).toMatchObject({ status: "refused", reason: "Conductor didn't close it." });
    const none = fixture();
    await none.pair();
    await none.store.set(`${none.channel}/commands/d`, closeCommand(none));
    await none.bridge.tick();
    expect(none.result("d")).toMatchObject({ status: "refused", reason: "This Mac can't close a chat from a phone." });
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
      { messageId: "99" },
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

const CHAT_MODELS = [
  {
    agent: "claude" as const,
    id: "opus-5-5-1m",
    label: "Opus 5.5 · 1M",
    levels: ["low", "medium", "high"],
    favorite: true,
  },
  {
    agent: "codex" as const,
    id: "gpt-6.1-sol",
    label: "GPT 6.1 Sol",
    levels: ["low", "medium", "high"],
    favorite: false,
  },
  { agent: "claude" as const, id: "haiku-4-5", label: "Haiku 4.5", levels: [], favorite: false },
];

function chatStarter(workspaces: NewChatWorkspace[] = [workspace("w1")], outcome?: StartChatOutcome) {
  const starts: Array<{
    workspaceId: string;
    agent: string;
    text: string;
    model?: string;
    thinking?: string;
    split?: unknown;
  }> = [];
  const starter: RemoteChatStarter = {
    workspaces: vi.fn(() => workspaces),
    models: vi.fn(() => CHAT_MODELS),
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

  it("starts a chat with the model and thinking level the phone chose, when this Mac offers them", async () => {
    const { starter, starts } = chatStarter();
    const f = fixture({ newChat: starter });
    await f.pair();
    expect(await run(f, f.startCommand({ model: "opus-5-5-1m", thinking: "high" }))).toMatchObject({ status: "sent" });
    expect(starts).toEqual([
      { workspaceId: "w1", agent: "claude", text: "Add a timer", model: "opus-5-5-1m", thinking: "high" },
    ]);
  });

  it("refuses a model this Mac does not offer for that agent, a level the model lacks, and a level with no model", async () => {
    const { starter, starts } = chatStarter();
    const f = fixture({ newChat: starter });
    await f.pair();
    const attempt = async (overrides: Partial<StartCommand>, id: string) => {
      await f.store.set(`${f.channel}/commands/${id}`, f.startCommand(overrides));
      await f.bridge.tick();
      f.advance(START_MIN_GAP_MS);
      return f.result(id);
    };
    expect(await attempt({ model: "gpt-6.1-sol" }, "a")).toMatchObject({ status: "refused" });
    expect(await attempt({ model: "nope" }, "b")).toMatchObject({ status: "refused" });
    expect(await attempt({ model: "opus-5-5-1m", thinking: "max" }, "c")).toMatchObject({ status: "refused" });
    expect(await attempt({ model: "haiku-4-5", thinking: "low" }, "d")).toMatchObject({ status: "refused" });
    expect(await attempt({ thinking: "low" }, "e")).toMatchObject({ status: "refused" });
    expect(starts).toEqual([]);
  });

  it("starts a chat with the work split the phone chose, and refuses one this Mac does not offer", async () => {
    const { starter, starts } = chatStarter();
    const f = fixture({ newChat: starter });
    await f.pair();
    const attempt = async (overrides: Partial<StartCommand>, id: string) => {
      await f.store.set(`${f.channel}/commands/${id}`, f.startCommand(overrides));
      await f.bridge.tick();
      f.advance(START_MIN_GAP_MS);
      return f.result(id);
    };
    expect(await attempt({ split: { code: "gpt-5.5" } }, "a")).toMatchObject({ status: "refused" });
    expect(await attempt({ agent: "codex", split: { run: "haiku" } }, "b")).toMatchObject({ status: "refused" });
    expect(starts).toEqual([]);
    expect(await attempt({ split: { code: "sonnet", run: "haiku", planFirst: true } }, "c")).toMatchObject({
      status: "sent",
    });
    expect(starts[0]).toMatchObject({ split: { code: "sonnet", run: "haiku", planFirst: true } });
    expect(await attempt({}, "d")).toMatchObject({ status: "sent" });
    expect(starts[1]).not.toHaveProperty("split");
  });

  it("offers the worker models with Conductor's, only when there is a Claude model to plan on", () => {
    const { starter } = chatStarter();
    const view = fixture({ newChat: starter }).bridge.phoneView();
    expect(view.chatWorkers?.map((worker) => worker.id)).toEqual(["sonnet", "haiku", "opus", "fable"]);
    expect(fixture().bridge.phoneView()).not.toHaveProperty("chatWorkers");
  });

  it("starts a chat on Haiku, which takes no thinking level, with the model alone", async () => {
    const { starter, starts } = chatStarter();
    const f = fixture({ newChat: starter });
    await f.pair();
    expect(await run(f, f.startCommand({ model: "haiku-4-5" }))).toMatchObject({ status: "sent" });
    expect(starts[0]).toMatchObject({ model: "haiku-4-5" });
    expect(starts[0]).not.toHaveProperty("thinking");
  });

  it("names the model and thinking level a chat runs, only when the Mac knows them", () => {
    const f = fixture();
    f.emit([
      session({ model: "Opus 5.5 · 1M", effort: "Extra high", fast: true }),
      session({ key: "k:2", conductorSessionId: "s2" }),
    ]);
    const view = f.bridge.phoneView();
    expect(view.sessions[0]).toMatchObject({ model: "Opus 5.5 · 1M", effort: "Extra high", fast: true });
    for (const field of ["model", "effort", "fast"]) expect(view.sessions[1]).not.toHaveProperty(field);
  });

  it("counts a finished chat that asks you something as needing you, and sends the question only then", () => {
    const f = fixture();
    f.emit([session({ asks: "Want me to open a PR?" }), session({ key: "k:2", conductorSessionId: "s2" })]);
    const view = f.bridge.phoneView();
    expect(view.duck.blockedCount).toBe(1);
    // The chat is still finished, so the phone can reply to it; `asks` is what marks it as waiting.
    expect(view.sessions[0]).toMatchObject({ state: "finished", asks: "Want me to open a PR?" });
    expect(view.sessions[1]).not.toHaveProperty("asks");
    // A stale `asks` on a chat that moved on is never sent.
    f.emit([session({ state: "working", asks: "Want me to open a PR?" })]);
    expect(f.bridge.phoneView().sessions[0]).not.toHaveProperty("asks");
    expect(f.bridge.phoneView().duck.blockedCount).toBe(0);
  });

  it("publishes the models in the recent document, and none when this Mac cannot list them", () => {
    const f = fixture({ newChat: chatStarter().starter });
    expect(f.bridge.phoneView().chatModels).toEqual(CHAT_MODELS);
    expect(f.bridge.phoneViewParts().recent.chatModels).toEqual(CHAT_MODELS);
    expect((f.bridge.phoneViewParts().snapshot as Record<string, unknown>).chatModels).toBeUndefined();
    const none = fixture({ newChat: { workspaces: () => [], start: vi.fn() } });
    expect(none.bridge.phoneView()).not.toHaveProperty("chatModels");
  });

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

  it("a change only in the Recent list publishes promptly too", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      await f.pair();
      f.bridge.start();
      await vi.advanceTimersByTimeAsync(0);
      const recentChat = (overrides: Partial<FleetSession> = {}) =>
        session({
          key: "claude-transcript:old",
          conductorSessionId: "old",
          sourceId: "old",
          lastActivityAt: "2026-09-25T02:00:00.000Z",
          ...overrides,
        });
      const emitBoth = (recent: FleetSession) => f.emit([session()], [session(), recent]);
      emitBoth(recentChat()); // baseline
      await vi.advanceTimersByTimeAsync(500);
      const sets = vi.spyOn(f.store, "set");
      f.advance(2_000);
      emitBoth(recentChat({ title: "Renamed" }));
      await vi.advanceTimersByTimeAsync(400);
      expect(sets).toHaveBeenCalled();
      f.bridge.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a failed change publish after 5 s, then 15 s, and stops once it works", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      await f.pair();
      f.bridge.start();
      await vi.advanceTimersByTimeAsync(0);
      f.emit([session()]);
      f.advance(2_000);
      const sets = vi.spyOn(f.store, "set").mockRejectedValue(new Error("offline"));
      f.emit([session({ state: "working" })]);
      await vi.advanceTimersByTimeAsync(400);
      expect(sets).toHaveBeenCalledTimes(1);
      f.advance(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sets).toHaveBeenCalledTimes(2);
      f.advance(15_000);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(sets).toHaveBeenCalledTimes(3);
      // Out of retries: left to the regular pass.
      f.advance(30_000);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sets).toHaveBeenCalledTimes(3);
      f.bridge.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a retry that works ends the retrying", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      await f.pair();
      f.bridge.start();
      await vi.advanceTimersByTimeAsync(0);
      f.emit([session()]);
      f.advance(2_000);
      const sets = vi.spyOn(f.store, "set").mockRejectedValueOnce(new Error("offline"));
      f.emit([session({ state: "working" })]);
      await vi.advanceTimersByTimeAsync(400);
      f.advance(5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      const after = sets.mock.calls.length;
      expect(
        open<{ sessions: Array<{ state: string }> }>(f.payload.k, f.store.docs.get(`${f.channel}/state/snapshot`)!.box)
          .sessions[0]!.state,
      ).toBe("working");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sets.mock.calls.length).toBe(after);
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
    let others: FleetSession[] = [];
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
      snapshot: () =>
        ({
          sessions: [...active, ...others],
          active,
          attention: [],
          generatedAt: "",
          codexUsage: null,
        }) as FleetSnapshot,
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
      setOthers: (next: FleetSession[]) => (others = next),
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
      { role: "assistant", text: "On it", at: null },
      { role: "assistant", text: "Fixed.", at: "2026-10-19T09:00:00.000Z" },
    ]);
    t.bridge.stop();
  });

  it("a recent chat the phone opens gets its history and queue, never steps; an unknown key gets nothing", async () => {
    const transcript = vi.fn((sessionId: string) => ({
      messages: [{ id: "a", role: "user" as const, text: `hello ${sessionId}`, at: null, turnId: "t1" }],
    }));
    const queue = vi.fn(async (): Promise<QueueItem[] | null> => []);
    const t = verbose({ transcript, queue });
    const older = session({
      key: "claude-transcript:old",
      conductorSessionId: "old",
      sourceId: "old",
      state: "finished",
      lastActivityAt: "2026-09-24T03:00:00.000Z",
    });
    t.setOthers([older]);
    await t.pair();
    await t.presence("claude-transcript:old");
    await t.bridge.tick();
    await settle();
    const [doc] = t.liveDocs();
    expect(doc).toBeDefined();
    const turn = open<{ key: string; working: boolean; steps: unknown[]; history?: unknown[]; queue?: unknown[] }>(
      t.payload.k,
      t.store.docs.get(doc!)!.box,
    );
    expect(turn).toMatchObject({ key: "claude-transcript:old", working: false, steps: [], queue: [] });
    expect(turn.history).toEqual([{ role: "user", text: "hello old", at: null }]);
    expect(transcript).toHaveBeenCalledWith("old", 40);
    expect(t.liveActivity).not.toHaveBeenCalledWith(older, expect.anything(), expect.anything());

    // A key the phone cannot see (not active, not recent) publishes nothing and clears the old document.
    await t.presence("claude-transcript:nobody");
    await t.bridge.tick();
    await settle();
    expect(t.liveDocs()).toEqual([]);
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

describe("RemoteBridge detailed usage for the phone", () => {
  async function statsT(offered = true) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-stats-"));
    dirs.push(dir);
    const store = new MemoryStore();
    const stats = vi.fn(async (range: string) => ({ range, totals: { tokens: 42 } }) as never);
    const bridge = new RemoteBridge({
      configPath: path.join(dir, "remote.json"),
      projectId: "squeak-test",
      store,
      replier: { lastTurnText: () => null, lastTurnId: () => null, send: vi.fn() },
      snapshot: () => ({ sessions: [], active: [], attention: [], generatedAt: "", codexUsage: null }) as FleetSnapshot,
      ...(offered ? { stats } : {}),
      now: () => NOW,
    });
    const pairing = bridge.startPairing();
    const payload = JSON.parse(Buffer.from(new URL(pairing.url).searchParams.get("d")!, "base64url").toString());
    const phone = device();
    await store.set(`channels/${payload.c}/pairing/iphone-1`, {
      box: seal(payload.k, { name: "iPhone", publicKey: phone.x963 }),
    });
    await bridge.tick();
    await bridge.approve("iphone-1");
    const config = JSON.parse(fs.readFileSync(path.join(dir, "remote.json"), "utf8"));
    const command = (range: unknown, agent?: unknown) => {
      const box = seal(payload.k, {
        v: 1,
        kind: "stats",
        range,
        ...(agent === undefined ? {} : { agent }),
        nonce: crypto.randomBytes(16).toString("hex"),
        expiresAt: NOW + 60_000,
      });
      return { box, sig: phone.sign(box), device: "iphone-1" };
    };
    return { bridge, config, command, stats };
  }

  it("answers one range in the result, and only says in the view that it can", async () => {
    const t = await statsT();
    expect(t.bridge.phoneView()).toMatchObject({ usageStats: true });
    const verdict = await t.bridge.handleCommand(t.config, "s1", t.command("30d"));
    expect(verdict.result).toEqual({ id: "s1", status: "sent", stats: { range: "30d", totals: { tokens: 42 } } });
    // An older phone names no agent: both together.
    expect(t.stats).toHaveBeenLastCalledWith("30d", undefined);
    expect(JSON.stringify(t.bridge.phoneView())).not.toContain('"tokens":42');
    // An agent, when named, must be one there is.
    const named = await t.bridge.handleCommand(t.config, "a1", t.command("7d", "codex"));
    expect(named.result).toMatchObject({ status: "sent" });
    expect(t.stats).toHaveBeenLastCalledWith("7d", "codex");
    expect((await t.bridge.handleCommand(t.config, "a2", t.command("7d", "gemini"))).result).toMatchObject({
      status: "refused",
    });
    for (const [i, bad] of ["1y", 30, null, { range: "7d" }].entries()) {
      const refused = await t.bridge.handleCommand(t.config, `b${i}`, t.command(bad));
      expect(refused.result).toMatchObject({ status: "refused" });
    }
    expect(t.stats).toHaveBeenCalledTimes(2);
    t.bridge.stop();
  });

  it("a Mac without it refuses and leaves it out of the view", async () => {
    const t = await statsT(false);
    expect(t.bridge.phoneView()).not.toHaveProperty("usageStats");
    expect((await t.bridge.handleCommand(t.config, "n1", t.command("7d"))).result).toMatchObject({ status: "refused" });
    t.bridge.stop();
  });
});

describe("RemoteBridge live controls from the phone", () => {
  async function controlsT(options: { offered?: boolean } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-controls-"));
    dirs.push(dir);
    const store = new MemoryStore();
    const state = {
      volume: 40,
      muted: false,
      brightness: 57,
      screenAwake: false,
      fans: { mode: "auto" as const, choice: "auto" as const, available: true, rpm: [2300, 2500] },
    };
    const apply = vi.fn(async () => ({ ok: true as const, state }));
    const bridge = new RemoteBridge({
      configPath: path.join(dir, "remote.json"),
      projectId: "squeak-test",
      store,
      replier: { lastTurnText: () => null, lastTurnId: () => null, send: vi.fn() },
      snapshot: () => ({ sessions: [], active: [], attention: [], generatedAt: "", codexUsage: null }) as FleetSnapshot,
      ...(options.offered === false ? {} : { controls: { state: () => state, apply } }),
      now: () => NOW,
    });
    const pairing = bridge.startPairing();
    const payload = JSON.parse(Buffer.from(new URL(pairing.url).searchParams.get("d")!, "base64url").toString());
    const phone = device();
    await store.set(`channels/${payload.c}/pairing/iphone-1`, {
      box: seal(payload.k, { name: "iPhone", publicKey: phone.x963 }),
    });
    await bridge.tick();
    await bridge.approve("iphone-1");
    const config = JSON.parse(fs.readFileSync(path.join(dir, "remote.json"), "utf8"));
    const command = (change: unknown, signer = phone) => {
      const box = seal(payload.k, {
        v: 1,
        kind: "controls",
        change,
        nonce: crypto.randomBytes(16).toString("hex"),
        expiresAt: NOW + 60_000,
      });
      return { box, sig: signer.sign(box), device: "iphone-1" };
    };
    return { bridge, config, command, apply, state };
  }

  it("shows the controls and applies one signed change", async () => {
    const t = await controlsT();
    expect(t.bridge.phoneView().macControls).toEqual(t.state);
    const verdict = await t.bridge.handleCommand(t.config, "c1", t.command({ fans: "60" }));
    expect(verdict.result).toEqual({ id: "c1", status: "sent" });
    expect(t.apply).toHaveBeenCalledWith({ fans: "60" });
    await t.bridge.handleCommand(t.config, "p1", t.command({ power: "high" }));
    expect(t.apply).toHaveBeenLastCalledWith({ power: "high" });
    await t.bridge.handleCommand(t.config, "c2", t.command({ volume: 25 }));
    expect(t.apply).toHaveBeenLastCalledWith({ volume: 25 });
    t.bridge.stop();
  });

  it("refuses anything but one known control with an exact value, and a forged signature", async () => {
    const t = await controlsT();
    for (const [i, change] of [
      { volume: 101 },
      { volume: 4.5 },
      { volume: "40; do shell script" },
      { brightness: -1 },
      { fans: "50" },
      { power: "turbo" },
      { power: 2 },
      { power: "low", fans: "max" },
      { fans: "max", volume: 10 },
      { muted: "true" },
      { displaySleep: false },
      { shell: "ls" },
      {},
      [],
      null,
    ].entries()) {
      const verdict = await t.bridge.handleCommand(t.config, `b${i}`, t.command(change));
      expect(verdict.result).toMatchObject({ status: "refused" });
    }
    const forged = await t.bridge.handleCommand(t.config, "f1", t.command({ muted: true }, device()));
    expect(forged.write).toBe(false);
    expect(t.apply).not.toHaveBeenCalled();
    t.bridge.stop();
  });

  it("answers the installed apps in the command's result, never in the view", async () => {
    const t = await controlsT();
    const apps = [{ id: "com.apple.Notes", name: "Notes" }];
    t.apply.mockResolvedValueOnce({ ok: true as const, state: t.state, apps } as never);
    const verdict = await t.bridge.handleCommand(t.config, "l1", t.command({ listApps: true }));
    expect(verdict.result).toEqual({ id: "l1", status: "sent", apps });
    expect(JSON.stringify(t.bridge.phoneView())).not.toContain("com.apple.Notes");
    t.bridge.stop();
  });

  it("a Mac without controls refuses them and leaves them out of the view", async () => {
    const t = await controlsT({ offered: false });
    expect(t.bridge.phoneView()).not.toHaveProperty("macControls");
    const verdict = await t.bridge.handleCommand(t.config, "n1", t.command({ muted: true }));
    expect(verdict.result).toMatchObject({ status: "refused" });
    t.bridge.stop();
  });
});

describe("RemoteBridge lid actions from the phone", () => {
  async function lidT(options: { offered?: boolean } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-lid-"));
    dirs.push(dir);
    const store = new MemoryStore();
    const lid = new LidActions({
      settingsPath: path.join(dir, "awake-settings.json"),
      journalPath: path.join(dir, "lid-actions.json"),
      setLowPowerWanted: () => undefined,
      lidSessionOn: () => false,
    });
    // What the daemon's applyAwake does with a lid-actions request.
    const apply = vi.fn((request: unknown) => {
      const { settings, mode } = request as { action?: string; settings?: object; mode?: string };
      if (mode === "open") lid.updateOpenSettings(settings as object);
      else lid.updateSettings(readLidActionSettings({ ...lid.settings, ...settings }));
      return { ok: true as const, state: null };
    });
    const bridge = new RemoteBridge({
      configPath: path.join(dir, "remote.json"),
      projectId: "squeak-test",
      store,
      replier: { lastTurnText: () => null, lastTurnId: () => null, send: vi.fn() },
      snapshot: () => ({ sessions: [], active: [], attention: [], generatedAt: "", codexUsage: null }) as FleetSnapshot,
      ...(options.offered === false
        ? { awake: { state: () => null, apply } }
        : {
            awake: {
              state: () => null,
              apply,
              lidActions: () => lid.settings,
              openActions: () => lid.openSettings,
              rules: () => awakeRules({ lowPowerPercent: 35, endPercent: 8 }),
              lastEnd: () => ({ reason: "battery" as const, at: "2026-10-23T01:00:00.000Z", why: "Battery at 8%" }),
              sleepProblem: () => "Sleep is disabled.",
            },
          }),
      now: () => NOW,
    });
    const pairing = bridge.startPairing();
    const payload = JSON.parse(Buffer.from(new URL(pairing.url).searchParams.get("d")!, "base64url").toString());
    const phone = device();
    await store.set(`channels/${payload.c}/pairing/iphone-1`, {
      box: seal(payload.k, { name: "iPhone", publicKey: phone.x963 }),
    });
    await bridge.tick();
    await bridge.approve("iphone-1");
    const config = JSON.parse(fs.readFileSync(path.join(dir, "remote.json"), "utf8"));
    const command = (fields: Record<string, unknown>, extra: Record<string, unknown> = {}, signer = phone) => {
      const box = seal(payload.k, {
        v: 1,
        kind: "lidActions",
        settings: fields,
        nonce: crypto.randomBytes(16).toString("hex"),
        expiresAt: NOW + 60_000,
        ...extra,
      });
      return { box, sig: signer.sign(box), device: "iphone-1" };
    };
    return { bridge, config, command, apply, lid, dir };
  }

  it("applies the settings through the awake entry and shows the new ones", async () => {
    const t = await lidT();
    expect(t.bridge.phoneView().awakeLidActions).toEqual({
      displayOff: true,
      mute: true,
      lowPower: true,
      freezeApps: false,
    });
    const verdict = await t.bridge.handleCommand(t.config, "l1", t.command({ mute: false, freezeApps: true }));
    expect(verdict.result).toEqual({ id: "l1", status: "sent" });
    expect(t.apply).toHaveBeenCalledWith({
      action: "lid-actions",
      mode: "closed",
      settings: { mute: false, freezeApps: true },
    });
    expect(t.lid.settings).toEqual({ displayOff: true, mute: false, lowPower: true, freezeApps: true });
    expect(t.bridge.phoneView().awakeLidActions).toEqual(t.lid.settings);
    expect(JSON.parse(fs.readFileSync(path.join(t.dir, "awake-settings.json"), "utf8"))).toMatchObject({
      mute: false,
      freezeApps: true,
    });
    t.bridge.stop();
  });

  it("changes the lid-open switches with mode open, leaving the closed ones alone", async () => {
    const t = await lidT();
    expect(t.bridge.phoneView().awakeOpenActions).toEqual({
      screenOn: false,
      mute: false,
      lowPower: false,
      freezeApps: false,
    });
    const verdict = await t.bridge.handleCommand(t.config, "o1", t.command({ screenOn: true }, { mode: "open" }));
    expect(verdict.result).toEqual({ id: "o1", status: "sent" });
    expect(t.apply).toHaveBeenCalledWith({ action: "lid-actions", mode: "open", settings: { screenOn: true } });
    expect(t.bridge.phoneView().awakeOpenActions).toMatchObject({ screenOn: true });
    expect(t.bridge.phoneView().awakeLidActions).toMatchObject({ displayOff: true, mute: true });
    t.bridge.stop();
  });

  it("refuses a switch that belongs to the other mode, and a mode it does not know", async () => {
    const t = await lidT();
    for (const [i, [settings, extra]] of [
      [{ screenOn: true }, {}],
      [{ screenOn: true }, { mode: "closed" }],
      [{ displayOff: true }, { mode: "open" }],
      [{ mute: true }, { mode: "half" }],
    ].entries()) {
      const verdict = await t.bridge.handleCommand(
        t.config,
        `m${i}`,
        t.command(settings as Record<string, unknown>, extra as Record<string, unknown>),
      );
      expect(verdict.result).toMatchObject({ status: "refused" });
    }
    expect(t.apply).not.toHaveBeenCalled();
    t.bridge.stop();
  });

  it("refuses a bad payload: unknown keys, non-booleans, nothing at all", async () => {
    const t = await lidT();
    for (const [i, settings] of [
      { mute: "no" },
      { mute: false, volume: 3 },
      {},
      { displayOff: 1 },
      { __proto__: { mute: false }, mute: null },
    ].entries()) {
      const verdict = await t.bridge.handleCommand(t.config, `b${i}`, t.command(settings as Record<string, unknown>));
      expect(verdict.result).toMatchObject({ status: "refused" });
    }
    const notAnObject = await t.bridge.handleCommand(t.config, "b9", t.command([] as never));
    expect(notAnObject.result).toMatchObject({ status: "refused" });
    expect(t.apply).not.toHaveBeenCalled();
    t.bridge.stop();
  });

  it("keeps every shared check: signature, expiry, replay", async () => {
    const t = await lidT();
    const forged = await t.bridge.handleCommand(t.config, "f1", t.command({ mute: false }, {}, device()));
    expect(forged.write).toBe(false);
    const expired = await t.bridge.handleCommand(t.config, "f2", t.command({ mute: false }, { expiresAt: NOW - 1 }));
    expect(expired.result).toMatchObject({ status: "refused", reason: expect.stringContaining("expired") });
    const tooLong = await t.bridge.handleCommand(
      t.config,
      "f3",
      t.command({ mute: false }, { expiresAt: NOW + 60 * 60_000 }),
    );
    expect(tooLong.result).toMatchObject({ status: "refused" });
    const signed = t.command({ mute: false });
    expect((await t.bridge.handleCommand(t.config, "f4", signed)).result).toMatchObject({ status: "sent" });
    const replay = await t.bridge.handleCommand(t.config, "f5", signed);
    expect(replay.result).toMatchObject({ status: "refused", reason: expect.stringContaining("already") });
    expect(t.apply).toHaveBeenCalledTimes(1);
    t.bridge.stop();
  });

  it("a Mac that does not offer it refuses, and leaves the fields out of the view", async () => {
    const t = await lidT({ offered: false });
    const view = t.bridge.phoneView();
    for (const key of ["awakeLidActions", "awakeRules", "awakeLastEnd", "awakeSleepProblem"]) {
      expect(view).not.toHaveProperty(key);
    }
    const verdict = await t.bridge.handleCommand(t.config, "n1", t.command({ mute: false }));
    expect(verdict.result).toMatchObject({ status: "refused" });
    expect(t.apply).not.toHaveBeenCalled();
    t.bridge.stop();
  });

  it("sends the safety floors, how the last session ended, and a sleep problem", async () => {
    const t = await lidT();
    expect(t.bridge.phoneView()).toMatchObject({
      awakeRules: { lowPowerPercent: 35, endPercent: 8, heat: true },
      awakeLastEnd: { reason: "battery", at: "2026-10-23T01:00:00.000Z", why: "Battery at 8%" },
      awakeSleepProblem: "Sleep is disabled.",
    });
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

  it("adds the newest quiet chat of every project, however old, once", () => {
    const working = chat("w", 1, { state: "working", repoName: "busy" });
    const filler = Array.from({ length: 12 }, (_, i) => chat(`f${i}`, 10 + i, { repoName: "farm" }));
    const sessions = [
      working,
      ...filler,
      chat("busy-old", 60 * 24 * 90, { repoName: "busy" }), // project has an active session
      chat("zed-new", 60 * 24 * 90, { repoName: "zed" }),
      chat("zed-older", 60 * 24 * 120, { repoName: "zed" }),
      chat("gone", 60 * 24 * 100, { repoName: "gone", retired: true }),
      chat("term", 60 * 24 * 100, { repoName: "term", conductorSessionId: null, key: "claude-transcript:t" }),
    ];
    const bridge = recent(sessions, [working]);
    const keys = bridge.phoneView().recent.map((s) => s.key);
    expect(keys).toHaveLength(11);
    expect(keys.slice(0, 10)).toEqual(filler.slice(0, 10).map((s) => s.key));
    expect(keys[10]).toBe("k:zed-new");
    expect(new Set(keys).size).toBe(keys.length);
    // The two filler chats past the page are still more to show; the extra does not change that.
    expect(bridge.phoneViewParts().recent.recentMore).toBe(true);
  });

  it("extras alone do not say there is more", () => {
    const bridge = recent([chat("a", 10, { repoName: "farm" }), chat("old", 60 * 24 * 90, { repoName: "old" })], []);
    const view = bridge.phoneView();
    expect(view.recent.map((s) => s.key)).toEqual(["k:a", "k:old"]);
    expect(view.recentMore).toBeFalsy();
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

  it("sends a chat's ducklings only to a phone whose caps name them", async () => {
    const ducklings = {
      running: 1,
      items: [
        { id: "toolu_1", kind: "agent", title: "scan", status: "running", startedAt: "2026-09-25T03:00:00.000Z" },
      ],
    };
    const f = fixture({ streaming: true });
    await f.pair();
    f.emit([session({ ducklings } as never)]);
    await presence(f);
    await f.bridge.tick();
    expect(read(f, "snapshot").sessions).toMatchObject([{ state: expect.any(String) }]);
    expect((read(f, "snapshot").sessions as Record<string, unknown>[])[0]).not.toHaveProperty("ducklings");
    await presence(f, ["ducklings"]);
    f.advance(5_000);
    await f.bridge.tick();
    expect((read(f, "snapshot").sessions as Record<string, unknown>[])[0]!.ducklings).toEqual(ducklings);
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

/**
 * Phone commands, cards, pictures and media that an add-on owns (RasanAI's films). Core's side of the contract: the
 * device's signature, decryption, expiry and nonce are checked before any add-on handler runs, a handler runs only
 * while its add-on is enabled and is handed the Mac's own snapshot and never the document, the key or the store, and
 * core writes the sealed result and the upload. What a handler checks is the add-on's own (addons/rasanai tests).
 */
function demoPhone(handle: AddonHandle, enabled = true): RemoteAddonPhone {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-addon-"));
  dirs.push(dir);
  const host = new AddonHost(dir);
  host.register({ id: "demo", name: "Demo", blurb: "" }, handle);
  if (enabled) host.setEnabled("demo", true);
  return host.remotePhone();
}

describe("RemoteBridge add-on cards and commands", () => {
  const status = {
    provider: "demo",
    projectDir: "/films/quotidian",
    title: "Quotidian",
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
    detail: "Demo · Pick a look",
    workflow: status,
  });
  const card = { provider: "demo", revision: "look@1", prompt: "Pick a look" };
  const workflows = () => ({
    view: vi.fn(() => card),
    allowsImage: vi.fn((_: unknown, source: string) => source === ".demo/w.png"),
    act: vi.fn<(dir: string, type: string, value: unknown) => { ok: true; said: string }>(() => ({
      ok: true,
      said: "Picked Wild: Foil",
    })),
  });
  /** A handle shaped like the RasanAI add-on's, over mocks: the Mac's snapshot names the session, never the phone. */
  const handleFor = (workflow: ReturnType<typeof workflows>): AddonHandle => ({
    phoneSessionFields: (s) => (s.workflow ? { workflow: workflow.view() } : {}),
    phoneCommands: {
      workflow: (command, call) => {
        const found = call.snapshot.active.find((s) => s.key === command.sessionKey && s.workflow);
        if (!found?.workflow) return { ok: false, reason: "That isn't waiting on you any more." };
        if (typeof command.type !== "string" || !/^[a-z-]{2,20}$/.test(command.type)) {
          return { ok: false, reason: "Not a request this Mac understands." };
        }
        const result = workflow.act(found.workflow.projectDir, command.type, command.value);
        return result.ok ? { ok: true, said: result.said } : { ok: false, reason: result as never as string };
      },
    },
    phoneImages: {
      fields: ["sessionKey"],
      resolve: (command, call) => {
        const found = call.snapshot.active.find((s) => s.key === command.sessionKey && s.workflow);
        if (!found?.workflow) return { refuse: "That isn't waiting on you any more." };
        if (!workflow.allowsImage(found.workflow, command.source as string)) {
          return { refuse: "That picture isn't on this card." };
        }
        return { projectDir: found.workflow.projectDir };
      },
    },
  });

  it("puts what an enabled add-on says on the session's row, and nothing while it is off", async () => {
    const f = fixture({ addonPhone: demoPhone(handleFor(workflows())) });
    f.emit([film]);
    const shown = f.bridge.phoneView().sessions[0] as Record<string, unknown>;
    expect(shown.workflow).toEqual(card);
    expect(shown.detail).toBe("Demo · Pick a look");
    const off = fixture({ addonPhone: demoPhone(handleFor(workflows()), false) });
    off.emit([film]);
    expect(off.bridge.phoneView().sessions[0]).not.toHaveProperty("workflow");
  });

  it("hands a command to the handler with the session's own project folder, never the phone's", async () => {
    const workflow = workflows();
    const f = fixture({ addonPhone: demoPhone(handleFor(workflow)) });
    await f.pair();
    f.emit([film]);
    await f.store.set(`${f.channel}/commands/c1`, f.workflowCommand({ projectDir: "/etc" }));
    await f.bridge.tick();
    expect(workflow.act).toHaveBeenCalledWith("/films/quotidian", "choose", "wild");
    expect(f.result("c1")).toEqual({ id: "c1", status: "sent", said: "Picked Wild: Foil" });
  });

  it("refuses a session that isn't waiting, and passes the handler's no on as the reason", async () => {
    const workflow = workflows();
    const f = fixture({ addonPhone: demoPhone(handleFor(workflow)) });
    await f.pair();
    f.emit([film, session()]);
    await f.store.set(`${f.channel}/commands/c1`, f.workflowCommand({ sessionKey: "claude-transcript:s1" }));
    await f.store.set(`${f.channel}/commands/c2`, f.workflowCommand({ type: "Choose; rm" }));
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({ status: "refused", reason: "That isn't waiting on you any more." });
    expect(f.result("c2")).toMatchObject({ status: "refused", reason: "Not a request this Mac understands." });
    expect(workflow.act).not.toHaveBeenCalled();
  });

  it("refuses a handler that throws, without saying why", async () => {
    const f = fixture({
      addonPhone: demoPhone({
        phoneCommands: {
          workflow: () => {
            throw new Error("/secret/path exploded");
          },
        },
      }),
    });
    await f.pair();
    await f.store.set(`${f.channel}/commands/c1`, f.workflowCommand());
    await f.bridge.tick();
    expect(f.result("c1")).toEqual({
      id: "c1",
      status: "refused",
      reason: "Your Mac couldn't do that. Try again.",
    });
  });

  it("refuses everything when no add-on has the kind, and when its add-on is disabled", async () => {
    const f = fixture();
    await f.pair();
    f.emit([film]);
    await f.store.set(`${f.channel}/commands/c1`, f.workflowCommand());
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({ status: "refused", reason: "Not a request this Mac understands." });
    const workflow = workflows();
    const off = fixture({ addonPhone: demoPhone(handleFor(workflow), false) });
    await off.pair();
    off.emit([film]);
    await off.store.set(`${off.channel}/commands/c1`, off.workflowCommand());
    await off.bridge.tick();
    expect(off.result("c1")).toMatchObject({ status: "refused", reason: "This Mac can't answer that from a phone." });
    expect(workflow.act).not.toHaveBeenCalled();
  });

  it("never reaches the handler for an unsigned, expired or replayed command, or an oversized one", async () => {
    const workflow = workflows();
    const f = fixture({ addonPhone: demoPhone(handleFor(workflow)) });
    await f.pair();
    f.emit([film]);
    const stranger = device();
    await f.store.set(`${f.channel}/commands/s1`, f.workflowCommand({}, stranger));
    await f.store.set(`${f.channel}/commands/e1`, f.workflowCommand({ expiresAt: NOW - 1 }));
    const once = f.workflowCommand({ nonce: "n".repeat(16) });
    await f.store.set(`${f.channel}/commands/r1`, once);
    await f.store.set(`${f.channel}/commands/r2`, once);
    await f.store.set(`${f.channel}/commands/big`, f.workflowCommand({ value: "x".repeat(70_000) }));
    const tampered = f.workflowCommand();
    const raw = Buffer.from(tampered.box, "base64");
    raw[20] = raw[20]! ^ 1;
    await f.store.set(`${f.channel}/commands/t1`, { ...tampered, box: raw.toString("base64") });
    await f.bridge.tick();
    expect(f.result("s1")).toBeNull();
    expect(f.result("t1")).toBeNull();
    expect(f.result("e1")).toMatchObject({ status: "refused" });
    expect(f.result("r1")).toMatchObject({ status: "sent" });
    expect(f.result("r2")).toMatchObject({ status: "refused" });
    expect(f.result("big")).toMatchObject({ status: "refused" });
    expect(workflow.act).toHaveBeenCalledTimes(1);
  });

  it("gives the handler only the command and the Mac's snapshot, not the key, the document or the store", async () => {
    const seen: unknown[][] = [];
    const f = fixture({
      addonPhone: demoPhone({
        phoneCommands: {
          workflow: (...args) => {
            seen.push(args);
            return { ok: true, said: "ok" };
          },
        },
      }),
    });
    await f.pair();
    f.emit([film]);
    await f.store.set(`${f.channel}/commands/c1`, f.workflowCommand());
    await f.bridge.tick();
    expect(seen).toHaveLength(1);
    const [command, call] = seen[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(Object.keys(call).sort()).toEqual(["deviceName", "now", "snapshot"]);
    expect(JSON.stringify([command, call])).not.toContain(f.payload.k);
    expect(command).not.toHaveProperty("box");
    expect(command).not.toHaveProperty("sig");
  });

  it("cannot take a kind core handles, or one another add-on has", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-addon-kinds-"));
    dirs.push(dir);
    const host = new AddonHost(dir);
    const handler = () => ({ ok: true as const, said: "x" });
    for (const kind of ["reply", "awake", "image", "media", "answer"]) {
      expect(() =>
        host.register({ id: `x-${kind}`, name: "X", blurb: "" }, { phoneCommands: { [kind]: handler } }),
      ).toThrow(/may not register/);
    }
    host.register({ id: "first", name: "First", blurb: "" }, { phoneCommands: { shared: handler } });
    expect(() =>
      host.register({ id: "second", name: "Second", blurb: "" }, { phoneCommands: { shared: handler } }),
    ).toThrow();
  });

  it("sends a picture on the card, read in the add-on's folder, and nothing else", async () => {
    const image = vi.fn(
      async (): Promise<PhoneImageResult> => ({ ok: true, image: { mime: "image/jpeg", data: "AAAA" } }),
    );
    const f = fixture({ addonPhone: demoPhone(handleFor(workflows())), image });
    await f.pair();
    f.emit([film]);
    await f.store.set(
      `${f.channel}/commands/c1`,
      f.imageCommand({ sessionId: "", sessionKey: "claude-transcript:d1", source: ".demo/w.png" }),
    );
    await f.store.set(
      `${f.channel}/commands/c2`,
      f.imageCommand({ sessionId: "", sessionKey: "claude-transcript:d1", source: ".demo/director.log" }),
    );
    await f.bridge.tick();
    expect(image).toHaveBeenCalledTimes(1);
    expect(image).toHaveBeenCalledWith(".demo/w.png", "/films/quotidian");
    expect(f.result("c1")).toMatchObject({ status: "sent" });
    expect(f.result("c2")).toMatchObject({ status: "refused", reason: "That picture isn't on this card." });
  });

  it("refuses an add-on's picture while it is off, instead of reading it as a chat's", async () => {
    const image = vi.fn(
      async (): Promise<PhoneImageResult> => ({ ok: true, image: { mime: "image/jpeg", data: "AAAA" } }),
    );
    const f = fixture({ addonPhone: demoPhone(handleFor(workflows()), false), image });
    await f.pair();
    f.emit([film]);
    await f.store.set(
      `${f.channel}/commands/c1`,
      f.imageCommand({ sessionId: "", sessionKey: "claude-transcript:d1", source: ".demo/w.png" }),
    );
    await f.bridge.tick();
    expect(image).not.toHaveBeenCalled();
    expect(f.result("c1")).toMatchObject({ status: "refused", reason: "This Mac can't send images to a phone." });
  });
});

describe("RemoteBridge add-on media", () => {
  const film = session({
    key: "claude-transcript:d1",
    conductorSessionId: null,
    origin: "sdk",
    cwd: "/films/q",
    state: "awaiting_input",
    workflow: {
      provider: "demo",
      projectDir: "/films/q",
      title: "Q",
      revision: "render@1",
      since: "2026-09-25T02:58:00.000Z",
      prompt: "Review the film",
    },
  });

  function withFile(bytes: Buffer) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-media-"));
    dirs.push(dir);
    const file = path.join(dir, "copy.m4v");
    fs.writeFileSync(file, bytes);
    return vi.fn(async () => ({
      ok: true as const,
      file: { path: file, mime: "video/mp4", bytes: bytes.length },
    }));
  }
  /** An add-on that plays one file from a waiting session's folder. */
  const phoneFor = (prepare: ReturnType<typeof withFile>, enabled = true) =>
    demoPhone(
      {
        phoneMedia: {
          fields: ["sessionKey", "filmId"],
          resolve: (command, call) => {
            const found = call.snapshot.active.find((s) => s.key === command.sessionKey && s.workflow);
            if (!found?.workflow) return { refuse: "That isn't waiting on you any more." };
            if (command.source !== "exports/film.mp4") return { refuse: "That isn't on this card." };
            return { source: command.source, projectDir: found.workflow.projectDir };
          },
          prepare,
        },
      },
      enabled,
    );

  it("leaves the phone copy in sealed chunks that put back together into the same bytes", async () => {
    const bytes = crypto.randomBytes(MEDIA_CHUNK_BYTES * 2 + 1234);
    const media = withFile(bytes);
    const f = fixture({ streaming: true, addonPhone: phoneFor(media) });
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
    const f = fixture({ streaming: true, addonPhone: phoneFor(media) });
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

  it("refuses what the add-on won't play, a session not waiting, a Mac on Firestore, and a disabled add-on", async () => {
    const media = withFile(Buffer.from("x"));
    const f = fixture({ streaming: true, addonPhone: phoneFor(media) });
    await f.pair();
    f.emit([film, session()]);
    await f.store.set(`${f.channel}/commands/c1`, f.mediaCommand({ source: "../../etc/hosts.mp4" }));
    await f.store.set(`${f.channel}/commands/c2`, f.mediaCommand({ sessionKey: "claude-transcript:s1" }));
    await f.bridge.tick();
    expect(f.result("c1")).toMatchObject({ status: "refused", reason: "That isn't on this card." });
    expect(f.result("c2")).toMatchObject({ status: "refused", reason: "That isn't waiting on you any more." });
    expect(media).not.toHaveBeenCalled();
    const polled = fixture({ addonPhone: phoneFor(media) });
    await polled.pair();
    polled.emit([film]);
    await polled.store.set(`${polled.channel}/commands/c1`, polled.mediaCommand());
    await polled.bridge.tick();
    expect(polled.result("c1")).toMatchObject({ status: "refused", reason: "This Mac can't send films to a phone." });
    const off = fixture({ streaming: true, addonPhone: phoneFor(media, false) });
    await off.pair();
    off.emit([film]);
    await off.store.set(`${off.channel}/commands/c1`, off.mediaCommand());
    await off.bridge.tick();
    expect(off.result("c1")).toMatchObject({ status: "refused", reason: "This Mac can't send films to a phone." });
    expect(media).not.toHaveBeenCalled();
  });
});

describe("RemoteBridge add-on view fields", () => {
  const item = { id: "x1", title: "26keys" };
  const presence = (f: ReturnType<typeof fixture>, caps?: string[]) =>
    f.store.set(`${f.channel}/state/presence`, { box: seal(f.payload.k, { at: NOW, ...(caps ? { caps } : {}) }) });
  const phoneWith = (list: () => unknown[], enabled = true) =>
    demoPhone({ phoneViewFields: (_snapshot, caps) => (caps.includes("films") ? { films: list() } : {}) }, enabled);

  it("adds an add-on's fields only for a phone whose presence says it reads them, and only while enabled", async () => {
    const list = vi.fn(() => [item]);
    const f = fixture({ addonPhone: phoneWith(list) });
    await f.pair();
    expect(f.bridge.phoneView()).not.toHaveProperty("films");
    await presence(f, ["z", "films"]);
    await f.bridge.tick();
    expect((f.bridge.phoneView() as Record<string, unknown>).films).toEqual([item]);
    const off = fixture({ addonPhone: phoneWith(list, false) });
    await off.pair();
    await presence(off, ["films"]);
    await off.bridge.tick();
    expect(off.bridge.phoneView()).not.toHaveProperty("films");
    const bare = fixture();
    await bare.pair();
    await presence(bare, ["films"]);
    await bare.bridge.tick();
    expect(bare.bridge.phoneView()).not.toHaveProperty("films");
  });

  it("publishes an add-on field's change, and carries it in the split view too", async () => {
    let state = "stopped";
    const f = fixture({ streaming: true, addonPhone: phoneWith(() => [{ ...item, state }]) });
    await f.pair();
    await presence(f, ["z", "split", "films"]);
    await f.bridge.tick();
    const read = () => open<Record<string, unknown>>(f.payload.k, f.store.docs.get(`${f.channel}/state/snapshot`)!.box);
    expect(read().films).toEqual([{ ...item, state: "stopped" }]);
    state = "running";
    f.advance(5_000);
    await f.bridge.tick();
    expect((read().films as Array<{ state: string }>)[0]!.state).toBe("running");
  });
});

describe("RemoteBridge changing a chat's model", () => {
  function setupFixture(outcome: { ok: true } | { ok: false; reason: string } = { ok: true }) {
    const { starter } = chatStarter();
    const f = fixture({ newChat: starter });
    const setSetup = vi.fn<
      (
        sessionId: string,
        setup: { model: string; thinkingLevel?: string; fastMode: boolean },
      ) => Promise<typeof outcome>
    >(async () => outcome);
    Object.assign(f.replier, { setSetup });
    const command = (overrides: Record<string, unknown>) =>
      f.stopCommand({ kind: "setup", answersTurn: undefined, model: "opus-5-5-1m", ...overrides });
    return { f, setSetup, command };
  }

  it("sets a model this Mac offers for the chat's own agent, keeping its level and fast mode", async () => {
    const { f, setSetup, command } = setupFixture();
    f.emit([session({ effortId: "high", fast: true })]);
    await f.pair();
    await f.store.set(`${f.channel}/commands/m1`, command({}));
    await f.bridge.tick();
    expect(f.result("m1")).toEqual({ id: "m1", status: "sent" });
    expect(setSetup.mock.calls).toEqual([["s1", { model: "opus-5-5-1m", thinkingLevel: "high", fastMode: true }]]);
  });

  it("takes a chosen level and fast mode, and falls back to a level the new model takes", async () => {
    const { f, setSetup, command } = setupFixture();
    f.emit([session({ effortId: "max" })]);
    await f.pair();
    await f.store.set(`${f.channel}/commands/m1`, command({ thinking: "low", fast: true }));
    await f.bridge.tick();
    await f.store.set(`${f.channel}/commands/m2`, command({}));
    await f.bridge.tick();
    expect(setSetup.mock.calls.map((call) => call[1])).toEqual([
      { model: "opus-5-5-1m", thinkingLevel: "low", fastMode: true },
      { model: "opus-5-5-1m", thinkingLevel: "high", fastMode: false },
    ]);
  });

  it("refuses another provider's model, an unknown level, a chat it doesn't show, and a malformed request", async () => {
    const { f, setSetup, command } = setupFixture();
    await f.pair();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ model: "gpt-6.1-sol" }, "That model isn't one this Mac offers for this chat's agent. Pick another."],
      [{ thinking: "max" }, "That thinking level isn't available for that model."],
      [{ sessionId: "s-elsewhere" }, "That chat isn't on your phone any more."],
      [{ fast: "yes" }, "Not a request this Mac understands."],
    ];
    for (const [index, [overrides, reason]] of cases.entries()) {
      await f.store.set(`${f.channel}/commands/m${index}`, command(overrides));
      await f.bridge.tick();
      expect(f.result(`m${index}`)).toMatchObject({ status: "refused", reason });
    }
    expect(setSetup).not.toHaveBeenCalled();
  });

  it("passes Conductor's refusal back, and is refused by a Mac that cannot change it", async () => {
    const { f, command } = setupFixture({ ok: false, reason: "The agent is working." });
    await f.pair();
    await f.store.set(`${f.channel}/commands/m1`, command({}));
    await f.bridge.tick();
    expect(f.result("m1")).toMatchObject({ status: "refused", reason: "The agent is working." });
    const plain = fixture({ newChat: chatStarter().starter });
    await plain.pair();
    await plain.store.set(`${plain.channel}/commands/m1`, plain.stopCommand({ kind: "setup", model: "opus-5-5-1m" }));
    await plain.bridge.tick();
    expect(plain.result("m1")).toMatchObject({
      status: "refused",
      reason: "This Mac can't change a chat's model from a phone.",
    });
  });

  it("tells the phone what the chat runs as Conductor stores it", async () => {
    const { f } = setupFixture();
    f.emit([session({ model: "Opus 5.5 · 1M", modelId: "opus-5-5-1m", effortId: "high" })]);
    await f.pair();
    await f.bridge.tick();
    const view = JSON.stringify(f.bridge.phoneView());
    expect(view).toContain('"modelId":"opus-5-5-1m"');
    expect(view).toContain('"effortId":"high"');
  });
});

describe("RemoteBridge a chat that seems stuck", () => {
  it("tells the phone what it waits on and since when, only once it has waited long enough", async () => {
    const f = fixture();
    const since = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
    await f.pair();
    f.emit([session({ state: "working", waitingOn: "model", waitingSince: since(11), stateSource: "transcript" })]);
    expect(JSON.stringify(f.bridge.phoneView())).toContain(`"stalled":{"on":"model","since":"${since(11)}"}`);
    f.emit([session({ state: "working", waitingOn: "model", waitingSince: since(4), stateSource: "transcript" })]);
    expect(JSON.stringify(f.bridge.phoneView())).not.toContain('"stalled"');
    f.emit([session({ state: "working", waitingOn: "tool", waitingSince: since(40), stateSource: "transcript" })]);
    expect(JSON.stringify(f.bridge.phoneView())).not.toContain('"stalled"');
  });
});

describe("RemoteBridge background work", () => {
  it("lists a working Claude chat's subagents and shells, and nothing for a resting one", async () => {
    const f = fixture();
    (f.bridge as unknown as { deps: RemoteBridgeDependencies }).deps.background = () => [
      {
        id: "toolu_1",
        kind: "agent",
        label: "Audit the relay",
        background: true,
        status: "running",
        startedAt: "2026-09-25T02:55:00.000Z",
      },
      {
        id: "toolu_2",
        kind: "shell",
        label: "Run the suite",
        background: true,
        status: "done",
        startedAt: "2026-09-25T02:50:00.000Z",
        endedAt: "2026-09-25T02:58:00.000Z",
        summary: "completed (exit code 0)",
      },
    ];
    await f.pair();
    f.emit([session({ state: "working" })]);
    const view = JSON.stringify(f.bridge.phoneView());
    expect(view).toContain(
      '"background":[{"id":"toolu_1","kind":"agent","label":"Audit the relay","status":"running","background":true,"startedAt":"2026-09-25T02:55:00.000Z"}',
    );
    expect(view).toContain('"summary":"completed (exit code 0)"');
    f.emit([session({ state: "finished" })]);
    expect(JSON.stringify(f.bridge.phoneView())).not.toContain("Audit the relay");
  });
});

describe("RemoteBridge background work, subagent hints", () => {
  it("carries a subagent's agentId and hasSteps, and omits hasSteps when false", async () => {
    const f = fixture();
    (f.bridge as unknown as { deps: RemoteBridgeDependencies }).deps.background = () => [
      {
        id: "toolu_1",
        kind: "agent",
        label: "A",
        background: true,
        status: "running",
        startedAt: null,
        agentId: "a1b2c3d4e5f607182",
        hasSteps: true,
      },
      {
        id: "toolu_2",
        kind: "agent",
        label: "B",
        background: true,
        status: "running",
        startedAt: null,
        agentId: "b9c8d7e6f5a403921",
        hasSteps: false,
      },
    ];
    await f.pair();
    f.emit([session({ state: "working" })]);
    const view = JSON.stringify(f.bridge.phoneView());
    expect(view).toContain(
      '"label":"A","status":"running","background":true,"agentId":"a1b2c3d4e5f607182","hasSteps":true}',
    );
    expect(view).toContain('"label":"B","status":"running","background":true,"agentId":"b9c8d7e6f5a403921"}');
  });
});

describe("RemoteBridge workspace actions", () => {
  function withActions(overrides: Partial<NonNullable<RemoteBridgeDependencies["workspaceActions"]>> = {}) {
    const f = fixture({ newChat: chatStarter().starter });
    const actions = {
      repos: vi.fn(() => [{ id: "r1", name: "farm" }]),
      archive: vi.fn(async () => ({ ok: true as const })),
      create: vi.fn(async () => ({ ok: true as const, workspaceId: "w-new" })),
      prPrompt: vi.fn(() => "Open a pull request."),
      ...overrides,
    };
    (f.bridge as unknown as { deps: RemoteBridgeDependencies }).deps.workspaceActions = actions;
    const command = (overrides: Record<string, unknown>) =>
      f.stopCommand({ kind: "workspace", answersTurn: undefined, sessionId: undefined, ...overrides });
    return { f, actions, command };
  }

  it("makes a workspace in a listed repository and says its id", async () => {
    const { f, actions, command } = withActions();
    await f.pair();
    expect(JSON.stringify(f.bridge.phoneView())).toContain('"repos":[{"id":"r1","name":"farm"}]');
    await f.store.set(`${f.channel}/commands/w1`, command({ action: "create", repoId: "r1" }));
    await f.bridge.tick();
    expect(f.result("w1")).toEqual({ id: "w1", status: "sent", workspaceId: "w-new" });
    await f.store.set(`${f.channel}/commands/w2`, command({ action: "create", repoId: "r9" }));
    await f.bridge.tick();
    expect(f.result("w2")).toMatchObject({ status: "refused", reason: "That repository isn't in Conductor any more." });
    expect(vi.mocked(actions.create).mock.calls).toEqual([["r1"]]);
  });

  it("archives only a workspace the phone is shown, and passes the action's refusal back", async () => {
    const { f, actions, command } = withActions({
      archive: vi.fn(async () => ({ ok: false as const, reason: "That workspace has 2 uncommitted changes." })),
    });
    f.emit([session({ conductorWorkspaceId: "w1" } as Partial<FleetSession>)]);
    await f.pair();
    await f.store.set(`${f.channel}/commands/a1`, command({ action: "archive", workspaceId: "w-elsewhere" }));
    await f.bridge.tick();
    expect(f.result("a1")).toMatchObject({ status: "refused", reason: "That workspace isn't on your phone any more." });
    await f.store.set(`${f.channel}/commands/a2`, command({ action: "archive", workspaceId: "w1" }));
    await f.bridge.tick();
    expect(f.result("a2")).toMatchObject({ status: "refused", reason: "That workspace has 2 uncommitted changes." });
    expect(vi.mocked(actions.archive).mock.calls).toEqual([["w1"]]);
  });

  it("asks a resting chat for a PR on the turn the phone saw, and not one mid-turn", async () => {
    const { f, command } = withActions();
    f.emit([session({ conductorWorkspaceId: "w1" } as Partial<FleetSession>)]);
    await f.pair();
    await f.store.set(
      `${f.channel}/commands/p1`,
      command({ action: "createPr", sessionId: "s1", answersTurn: "turn-1" }),
    );
    await f.bridge.tick();
    expect(f.result("p1")).toMatchObject({ status: "sent" });
    expect(f.sends).toEqual([{ sessionId: "s1", text: "Open a pull request." }]);
    await f.store.set(`${f.channel}/commands/p2`, command({ action: "createPr", sessionId: "s1", answersTurn: "old" }));
    await f.bridge.tick();
    expect(f.result("p2")).toMatchObject({ status: "refused" });
    f.emit([session({ conductorWorkspaceId: "w1", state: "working" } as Partial<FleetSession>)]);
    await f.store.set(
      `${f.channel}/commands/p3`,
      command({ action: "createPr", sessionId: "s1", answersTurn: "turn-1" }),
    );
    await f.bridge.tick();
    expect(f.result("p3")).toMatchObject({ status: "refused", reason: expect.stringMatching(/mid-turn/) });
    expect(f.sends).toHaveLength(1);
  });

  it("is refused by a Mac without workspace actions", async () => {
    const f = fixture();
    await f.pair();
    await f.store.set(`${f.channel}/commands/x1`, f.stopCommand({ kind: "workspace", action: "create", repoId: "r1" }));
    await f.bridge.tick();
    expect(f.result("x1")).toMatchObject({ status: "refused", reason: "This Mac can't do that from a phone." });
    expect(JSON.stringify(f.bridge.phoneView())).not.toContain('"repos"');
  });
});

describe("RemoteBridge subagent feed", () => {
  const KEY = "claude-transcript:s1";
  const TASK = "toolu_AAAAAAAA1";

  function harness(options: { verbose?: boolean; known?: string[]; enabled?: boolean } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-sub-"));
    dirs.push(dir);
    const store = new WatchingStore();
    const now = NOW;
    let active = [session({ key: KEY, state: "working" })];
    let steps = [{ kind: "tool" as const, text: "Read radar.ts", at: null as string | null }];
    const subagentActivity = vi.fn(
      (_session: FleetSession, taskId: string, _limit: number, stepChars: number): SubagentActivity | null =>
        (options.known ?? [TASK]).includes(taskId)
          ? {
              taskId,
              agentId: "a1b2c3d4e5f607182",
              label: "Survey the tests",
              status: "running",
              available: true,
              steps: steps.map((step) => ({ ...step, text: step.text.slice(0, stepChars) })),
              total: steps.length,
              startedAt: null,
              endedAt: null,
            }
          : null,
    );
    const bridge = new RemoteBridge({
      configPath: path.join(dir, "remote.json"),
      projectId: "squeak-test",
      store,
      replier: { lastTurnText: () => null, lastTurnId: () => null, send: vi.fn() },
      snapshot: () => ({ sessions: active, active, attention: [], generatedAt: "", codexUsage: null }) as FleetSnapshot,
      liveActivity: () => ({ total: 0, steps: [] }),
      ...(options.enabled === false ? {} : { subagentActivity }),
      ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
      now: () => now,
    });
    const pairing = bridge.startPairing();
    const payload = JSON.parse(Buffer.from(new URL(pairing.url).searchParams.get("d")!, "base64url").toString());
    const channel = `channels/${payload.c}`;
    const phone = device();
    const presence = (watching?: string) =>
      store.set(`${channel}/state/presence`, {
        box: seal(payload.k, { at: now, ...(watching ? { watching } : {}) }),
      });
    const command = (overrides: Record<string, unknown> = {}, signer = phone) => {
      const body = {
        v: 1,
        kind: "subagent",
        key: KEY,
        taskId: TASK,
        nonce: crypto.randomBytes(16).toString("hex"),
        expiresAt: now + 60_000,
        ...overrides,
      };
      const box = seal(payload.k, body);
      return { box, sig: signer.sign(box), device: "iphone-1" };
    };
    const send = async (id: string, doc: ReturnType<typeof command>) => {
      await store.set(`${channel}/commands/${id}`, doc);
      await bridge.tick();
      await settle();
      const result = store.docs.get(`${channel}/results/${id}`);
      return result ? open<Record<string, unknown>>(payload.k, result.box) : null;
    };
    const feedDoc = () => store.docs.get(`${channel}/live/${subagentFeedDoc(KEY)}`);
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
      channel,
      presence,
      command,
      send,
      feedDoc,
      pair,
      phone,
      subagentActivity,
      setActive: (next: FleetSession[]) => (active = next),
      setSteps: (next: typeof steps) => (steps = next),
    };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

  it("publishes the picked subagent's steps, sealed, and deletes them when the phone leaves the chat", async () => {
    const t = harness();
    await t.pair();
    await t.presence(KEY);
    await t.bridge.tick();
    const result = await t.send("s1", t.command());
    expect(result).toEqual({ id: "s1", status: "sent", doc: `${liveHandle(KEY)}-s` });
    const feed = open<Record<string, unknown>>(t.payload.k, t.feedDoc()!.box);
    expect(feed).toMatchObject({
      v: 1,
      key: KEY,
      taskId: TASK,
      agentId: "a1b2c3d4e5f607182",
      label: "Survey the tests",
      status: "running",
      available: true,
      total: 1,
      steps: [{ kind: "tool", text: "Read radar.ts", at: null }],
    });
    expect(typeof feed.seq).toBe("number");
    // The phone moves to another chat: the next pass deletes it.
    await t.presence("claude-transcript:other");
    await t.bridge.tick();
    await settle();
    expect(t.feedDoc()).toBeUndefined();
    t.bridge.stop();
  });

  it("stops on a null taskId, and a stop from another chat changes nothing", async () => {
    const t = harness();
    await t.pair();
    await t.presence(KEY);
    await t.bridge.tick();
    await t.send("s1", t.command());
    expect(t.feedDoc()).toBeDefined();
    expect(await t.send("s2", t.command({ key: "claude-transcript:other", taskId: null }))).toMatchObject({
      status: "sent",
    });
    expect(t.feedDoc()).toBeDefined();
    expect(await t.send("s3", t.command({ taskId: null }))).toMatchObject({ status: "sent" });
    expect(t.feedDoc()).toBeUndefined();
    t.bridge.stop();
  });

  it("refuses anything but exact keys, a strict task id, and a v of 1", async () => {
    const t = harness();
    await t.pair();
    await t.presence(KEY);
    await t.bridge.tick();
    let n = 0;
    for (const overrides of [
      { extra: 1 },
      { taskId: "../../etc/passwd" },
      { taskId: "short" },
      { taskId: 7 },
      { taskId: undefined },
      { key: 7 },
      { v: 2 },
    ]) {
      const result = await t.send(`bad${n++}`, t.command(overrides));
      expect(result, JSON.stringify(overrides)).toMatchObject({ status: "refused" });
    }
    expect(t.feedDoc()).toBeUndefined();
    t.bridge.stop();
  });

  it("refuses a subagent the Mac does not see, a chat the phone does not have open, and a chat that is not active", async () => {
    const t = harness({ known: [] });
    await t.pair();
    await t.presence(KEY);
    await t.bridge.tick();
    expect(await t.send("u1", t.command())).toMatchObject({ status: "refused" });

    const known = harness();
    await known.pair();
    await known.presence("claude-transcript:other");
    await known.bridge.tick();
    expect(await known.send("o1", known.command())).toMatchObject({
      status: "refused",
      reason: "Open that chat first.",
    });

    const idle = harness();
    await idle.pair();
    await idle.presence(KEY);
    await idle.bridge.tick();
    idle.setActive([]);
    expect(await idle.send("i1", idle.command())).toMatchObject({ status: "refused" });
    for (const h of [t, known, idle]) {
      expect(h.feedDoc()).toBeUndefined();
      h.bridge.stop();
    }
  });

  it("refuses when verbose is off on the Mac or the Mac has no subagent reader", async () => {
    const off = harness({ verbose: false });
    await off.pair();
    await off.presence(KEY);
    await off.bridge.tick();
    expect(await off.send("v1", off.command())).toMatchObject({ status: "refused" });
    const none = harness({ enabled: false });
    await none.pair();
    await none.presence(KEY);
    await none.bridge.tick();
    expect(await none.send("n1", none.command())).toMatchObject({ status: "refused" });
    expect(off.feedDoc()).toBeUndefined();
    expect(none.feedDoc()).toBeUndefined();
    off.bridge.stop();
    none.bridge.stop();
  });

  it("keeps every handleCommand check: a stranger's signature, a replayed nonce and an expired command do nothing", async () => {
    const t = harness();
    await t.pair();
    await t.presence(KEY);
    await t.bridge.tick();
    expect(await t.send("x1", t.command({}, device()))).toBeNull();
    expect(await t.send("x2", t.command({ expiresAt: NOW - 1 }))).toMatchObject({ status: "refused" });
    const once = t.command();
    expect(await t.send("x3", once)).toMatchObject({ status: "sent" });
    expect(await t.send("x4", once)).toMatchObject({ status: "refused" });
    t.bridge.stop();
  });

  it("is not written again when nothing changed", async () => {
    const t = harness();
    await t.pair();
    await t.presence(KEY);
    await t.bridge.tick();
    await t.send("s1", t.command());
    const before = t.feedDoc()!.box;
    await t.bridge.tick();
    await settle();
    expect(t.feedDoc()!.box).toBe(before);
    t.bridge.stop();
  });
});

describe("RemoteBridge chat presets from the phone", () => {
  async function presetsT(options: { offered?: boolean } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-presets-"));
    dirs.push(dir);
    const store = new MemoryStore();
    const presets = new ChatPresetsStore(path.join(dir, "chat-presets.json"));
    const apply = vi.fn((request: unknown) => {
      const outcome = presets.apply(request);
      return outcome.ok ? { ok: true as const, state: outcome.doc } : outcome;
    });
    const bridge = new RemoteBridge({
      configPath: path.join(dir, "remote.json"),
      projectId: "squeak-test",
      store,
      replier: { lastTurnText: () => null, lastTurnId: () => null, send: vi.fn() },
      snapshot: () => ({ sessions: [], active: [], attention: [], generatedAt: "", codexUsage: null }) as FleetSnapshot,
      ...(options.offered === false ? {} : { presets: { state: () => presets.snapshot(), apply } }),
      now: () => NOW,
    });
    const pairing = bridge.startPairing();
    const payload = JSON.parse(Buffer.from(new URL(pairing.url).searchParams.get("d")!, "base64url").toString());
    const phone = device();
    await store.set(`channels/${payload.c}/pairing/iphone-1`, {
      box: seal(payload.k, { name: "iPhone", publicKey: phone.x963 }),
    });
    await bridge.tick();
    await bridge.approve("iphone-1");
    const config = JSON.parse(fs.readFileSync(path.join(dir, "remote.json"), "utf8"));
    const command = (
      fields: Record<string, unknown>,
      signer = phone,
      nonce = crypto.randomBytes(16).toString("hex"),
    ) => {
      const box = seal(payload.k, { v: 1, kind: "presets", nonce, expiresAt: NOW + 60_000, ...fields });
      return { box, sig: signer.sign(box), device: "iphone-1" };
    };
    return { bridge, config, command, presets };
  }
  const setup = { modelId: "opus-5-5", level: "high", code: "sonnet", run: null, planFirst: true };

  it("shows the document and applies a signed setup, a name and a reset", async () => {
    const t = await presetsT();
    expect(t.bridge.phoneView().presets).toEqual({ names: {}, presets: {}, setups: {} });
    const sent = await t.bridge.handleCommand(
      t.config,
      "p1",
      t.command({ agent: "claude", preset: "balanced", change: { setup } }),
    );
    expect(sent.result).toEqual({ id: "p1", status: "sent" });
    expect(
      (await t.bridge.handleCommand(t.config, "p2", t.command({ preset: "balanced", change: { name: "Mine" } })))
        .result,
    ).toEqual({
      id: "p2",
      status: "sent",
    });
    expect(t.bridge.phoneView().presets).toEqual({
      names: { balanced: "Mine" },
      presets: { balanced: { ...setup } },
      setups: { claude: { balanced: { ...setup } } },
    });
    await t.bridge.handleCommand(
      t.config,
      "p3",
      t.command({ agent: "claude", preset: "balanced", change: { reset: true } }),
    );
    expect(t.bridge.phoneView().presets).toEqual({ names: {}, presets: {}, setups: {} });
    t.bridge.stop();
  });

  it("refuses malformed changes and extra envelope keys, changing nothing", async () => {
    const t = await presetsT();
    const bad: Record<string, unknown>[] = [
      { preset: "balanced", change: { name: 7 } },
      { agent: "claude", preset: "custom", change: { reset: true } },
      { agent: "claude", preset: "balanced", change: { setup: { ...setup, code: "gpt" } } },
      { agent: "claude", preset: "balanced", change: { setup }, extra: 1 },
      { agent: "claude", preset: "balanced", change: { setup }, v: 2 },
      {},
    ];
    for (const fields of bad) {
      const verdict = await t.bridge.handleCommand(t.config, "x", t.command(fields));
      expect(verdict.result).toMatchObject({ status: "refused" });
    }
    expect(t.presets.snapshot()).toEqual({ names: {}, presets: {}, setups: {} });
    t.bridge.stop();
  });

  it("refuses a replay, a stranger's signature, and a Mac without presets", async () => {
    const t = await presetsT();
    const fields = { preset: "best", change: { name: "Top" } };
    const nonce = "p".repeat(32);
    expect((await t.bridge.handleCommand(t.config, "a", t.command(fields, undefined, nonce))).result).toMatchObject({
      status: "sent",
    });
    expect((await t.bridge.handleCommand(t.config, "b", t.command(fields, undefined, nonce))).result).toMatchObject({
      status: "refused",
    });
    expect(
      (await t.bridge.handleCommand(t.config, "c", t.command({ preset: "best", change: { name: "X" } }, device())))
        .write,
    ).toBe(false);
    expect(t.presets.snapshot().names).toEqual({ best: "Top" });
    t.bridge.stop();

    const off = await presetsT({ offered: false });
    expect(off.bridge.phoneView().presets).toBeUndefined();
    expect((await off.bridge.handleCommand(off.config, "d", off.command(fields))).result).toMatchObject({
      status: "refused",
    });
    off.bridge.stop();
  });
});

describe("RemoteBridge notification settings from the phone", () => {
  async function notifyT(options: { offered?: boolean } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-notify-"));
    dirs.push(dir);
    const store = new MemoryStore();
    const settings = new NotifySettingsStore(path.join(dir, "notify-settings.json"));
    const view = () => ({ ...settings.snapshot(), channels: { telegram: true, cliq: true } });
    const apply = vi.fn((request: unknown) => {
      const outcome = settings.apply(request);
      return outcome.ok ? { ok: true as const, state: view() } : outcome;
    });
    const bridge = new RemoteBridge({
      configPath: path.join(dir, "remote.json"),
      projectId: "squeak-test",
      store,
      replier: { lastTurnText: () => null, lastTurnId: () => null, send: vi.fn() },
      snapshot: () => ({ sessions: [], active: [], attention: [], generatedAt: "", codexUsage: null }) as FleetSnapshot,
      ...(options.offered === false ? {} : { notify: { state: view, apply } }),
      now: () => NOW,
    });
    const pairing = bridge.startPairing();
    const payload = JSON.parse(Buffer.from(new URL(pairing.url).searchParams.get("d")!, "base64url").toString());
    const phone = device();
    await store.set(`channels/${payload.c}/pairing/iphone-1`, {
      box: seal(payload.k, { name: "iPhone", publicKey: phone.x963 }),
    });
    await bridge.tick();
    await bridge.approve("iphone-1");
    const config = JSON.parse(fs.readFileSync(path.join(dir, "remote.json"), "utf8"));
    const command = (
      fields: Record<string, unknown>,
      signer = phone,
      nonce = crypto.randomBytes(16).toString("hex"),
    ) => {
      const box = seal(payload.k, { v: 1, kind: "notify", nonce, expiresAt: NOW + 60_000, ...fields });
      return { box, sig: signer.sign(box), device: "iphone-1" };
    };
    return { bridge, config, command, apply, settings };
  }

  it("shows the settings and applies one signed change", async () => {
    const t = await notifyT();
    // A phone that does not name the generic cap still reads the old spelling of `replyable`.
    const spelled = (settings: ReturnType<typeof defaultNotifySettings>) =>
      JSON.parse(JSON.stringify(settings).replaceAll('"replyable"', '"conductor"'));
    expect(t.bridge.phoneView().notify).toEqual({
      ...spelled(defaultNotifySettings()),
      channels: { telegram: true, cliq: true },
    });
    const verdict = await t.bridge.handleCommand(
      t.config,
      "n1",
      t.command({ channel: "cliq", change: { finished: "off" } }),
    );
    expect(verdict.result).toEqual({ id: "n1", status: "sent" });
    expect(t.settings.settings.cliq.finished).toBe("off");
    expect(t.settings.settings.telegram.finished).toBe("replyable");
    expect(t.bridge.phoneView().notify).toMatchObject({ cliq: { finished: "off" } });
    t.bridge.stop();
  });

  it("refuses every malformed change and changes nothing", async () => {
    const t = await notifyT();
    const bad: Record<string, unknown>[] = [
      { channel: "cliq", change: { error: true } },
      { channel: "cliq", change: { muted: "true" } },
      { channel: "cliq", change: { muted: true, stalled: false } },
      { channel: "cliq", change: {} },
      { channel: "phone", change: { muted: true } },
      { channel: 1, change: { muted: true } },
      { change: { muted: true } },
      { channel: "cliq" },
      { channel: "cliq", change: { quiet: { from: "22:00", to: "22:00" } } },
      { channel: "cliq", change: { muted: true }, extra: 1 },
      { channel: "cliq", change: { muted: true }, v: 2 },
    ];
    for (const fields of bad) {
      const verdict = await t.bridge.handleCommand(t.config, "x", t.command(fields));
      expect(verdict.result).toMatchObject({ status: "refused" });
    }
    expect(t.settings.settings).toEqual(defaultNotifySettings());
    t.bridge.stop();
  });

  it("refuses a replay, a stranger's signature, and a Mac without the setting", async () => {
    const t = await notifyT();
    const fields = { channel: "telegram", change: { muted: true } };
    const nonce = "n".repeat(32);
    expect((await t.bridge.handleCommand(t.config, "a", t.command(fields, undefined, nonce))).result).toMatchObject({
      status: "sent",
    });
    expect((await t.bridge.handleCommand(t.config, "b", t.command(fields, undefined, nonce))).result).toMatchObject({
      status: "refused",
    });
    const stranger = await t.bridge.handleCommand(
      t.config,
      "c",
      t.command({ channel: "cliq", change: { muted: true } }, device()),
    );
    expect(stranger.write).toBe(false);
    expect(t.settings.settings.cliq.muted).toBe(false);
    t.bridge.stop();

    const off = await notifyT({ offered: false });
    expect(off.bridge.phoneView()).not.toHaveProperty("notify");
    const verdict = await off.bridge.handleCommand(off.config, "d", off.command(fields));
    expect(verdict.result).toMatchObject({ status: "refused" });
    off.bridge.stop();
  });
});

describe("RemoteBridge phone-call settings from the phone", () => {
  async function voiceT(
    options: {
      offered?: boolean;
      testOutcome?: { ok: true } | { ok: false; reason: string };
      calls?: () => unknown;
      gatewayUpdate?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
      preview?: (voice: string) => Promise<Buffer | null>;
      natural?: Record<string, unknown>;
      streaming?: boolean;
    } = {},
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-voice-"));
    dirs.push(dir);
    const store = options.streaming ? new WatchingStore() : new MemoryStore();
    const clock = { t: NOW };
    const voice = new VoiceSettingsStore(path.join(dir, "voice-settings.json"));
    const view = () => ({
      mode: "gateway",
      callee: voice.settings.callee,
      defaultCallee: null,
      ...(options.natural ? { natural: options.natural } : {}),
    });
    const apply = vi.fn((request: unknown) => {
      const outcome = voice.apply(request);
      return outcome.ok ? { ok: true as const, state: view() } : outcome;
    });
    const test = vi.fn(() => options.testOutcome ?? { ok: true as const });
    const changePin = vi.fn(async (current: string, next: string) => {
      void next;
      return current === "1234"
        ? { ok: true as const }
        : { ok: false as const, reason: "That is not your current pin." };
    });
    const pinAction = vi.fn(async (action: { action: string; current?: string }) =>
      action.action === "disable" && action.current !== "1234"
        ? { ok: false as const, reason: "That is not your current pin." }
        : { ok: true as const },
    );
    const bridge = new RemoteBridge({
      configPath: path.join(dir, "remote.json"),
      projectId: "squeak-test",
      store,
      replier: { lastTurnText: () => null, lastTurnId: () => null, send: vi.fn() },
      snapshot: () => ({ sessions: [], active: [], attention: [], generatedAt: "", codexUsage: null }) as FleetSnapshot,
      ...(options.offered === false
        ? {}
        : {
            voice: {
              state: view,
              apply,
              test,
              changePin,
              pinAction,
              ...(options.gatewayUpdate ? { gatewayUpdate: options.gatewayUpdate } : {}),
              ...(options.calls ? { calls: options.calls } : {}),
              ...(options.preview ? { preview: options.preview } : {}),
            },
          }),
      now: () => clock.t,
    });
    const pairing = bridge.startPairing();
    const payload = JSON.parse(Buffer.from(new URL(pairing.url).searchParams.get("d")!, "base64url").toString());
    const phone = device();
    await store.set(`channels/${payload.c}/pairing/iphone-1`, {
      box: seal(payload.k, { name: "iPhone", publicKey: phone.x963 }),
    });
    await bridge.tick();
    await bridge.approve("iphone-1");
    const config = JSON.parse(fs.readFileSync(path.join(dir, "remote.json"), "utf8"));
    const command = (
      fields: Record<string, unknown>,
      signer = phone,
      nonce = crypto.randomBytes(16).toString("hex"),
    ) => {
      const box = seal(payload.k, { v: 1, kind: "voice", nonce, expiresAt: NOW + 60_000, ...fields });
      return { box, sig: signer.sign(box), device: "iphone-1" };
    };
    const presence = async (caps: string[]) => {
      await store.set(`channels/${payload.c}/state/presence`, { box: seal(payload.k, { at: NOW, caps }) });
      await bridge.tick();
    };
    return { bridge, config, command, apply, test, voice, changePin, pinAction, presence, store, payload, clock };
  }

  it("sends the calls log only to a phone whose caps name calls, and never breaks the view", async () => {
    const calls = [{ id: "c1", at: 1, kind: "agent", outcome: "answered", durationMs: 5, events: [] }];
    const t = await voiceT({ calls: () => calls });
    expect(t.bridge.phoneView().voice).not.toHaveProperty("calls");
    await t.presence(["z", "calls"]);
    expect(t.bridge.phoneView().voice).toMatchObject({ mode: "gateway", calls });
    await t.presence(["z"]);
    expect(t.bridge.phoneView().voice).not.toHaveProperty("calls");
    t.bridge.stop();
    const broken = await voiceT({
      calls: () => {
        throw new Error("boom");
      },
    });
    await broken.presence(["calls"]);
    expect(broken.bridge.phoneView().voice).toEqual({ mode: "gateway", callee: null, defaultCallee: null });
    broken.bridge.stop();
    const none = await voiceT();
    await none.presence(["calls"]);
    expect(none.bridge.phoneView().voice).not.toHaveProperty("calls");
    none.bridge.stop();
  });

  it("hands natural and favorites changes to voice.apply unchanged", async () => {
    const t = await voiceT();
    const natural = await t.bridge.handleCommand(
      t.config,
      "n1",
      t.command({ change: { natural: { enabled: false } } }),
    );
    expect(natural.result).toMatchObject({ id: "n1" });
    expect(t.apply).toHaveBeenLastCalledWith({ natural: { enabled: false } });
    await t.bridge.handleCommand(t.config, "n2", t.command({ change: { favorites: [{ n: 1, workspace: "w" }] } }));
    expect(t.apply).toHaveBeenLastCalledWith({ favorites: [{ n: 1, workspace: "w" }] });
    t.bridge.stop();
  });

  it("shows who it rings, sets the extension, and clears it", async () => {
    const t = await voiceT();
    expect(t.bridge.phoneView().voice).toEqual({ mode: "gateway", callee: null, defaultCallee: null });
    const set = await t.bridge.handleCommand(t.config, "v1", t.command({ change: { callee: "35210" } }));
    expect(set.result).toEqual({ id: "v1", status: "sent" });
    expect(t.voice.settings.callee).toBe("35210");
    expect(t.bridge.phoneView().voice).toMatchObject({ callee: "35210" });
    const cleared = await t.bridge.handleCommand(t.config, "v2", t.command({ change: { callee: null } }));
    expect(cleared.result).toMatchObject({ status: "sent" });
    expect(t.voice.settings.callee).toBeNull();
    t.bridge.stop();
  });

  it("accepts a pause through voice.apply and refuses an unknown choice", async () => {
    const t = await voiceT();
    const paused = await t.bridge.handleCommand(t.config, "p1", t.command({ change: { pause: "1h" } }));
    expect(paused.result).toEqual({ id: "p1", status: "sent" });
    expect(t.apply).toHaveBeenLastCalledWith({ pause: "1h" });
    expect(t.voice.pause()).not.toBeNull();
    const bad = await t.bridge.handleCommand(t.config, "p2", t.command({ change: { pause: "2h" } }));
    expect(bad.result).toMatchObject({ id: "p2", status: "refused" });
    const resumed = await t.bridge.handleCommand(t.config, "p3", t.command({ change: { pause: "resume" } }));
    expect(resumed.result).toEqual({ id: "p3", status: "sent" });
    expect(t.voice.pause()).toBeNull();
    t.bridge.stop();
  });

  describe("voice sample", () => {
    const natural = {
      installed: true,
      enabled: true,
      voice: "af_heart",
      voices: [
        { id: "af_heart", label: "Heart" },
        { id: "am_adam", label: "Adam" },
      ],
    };
    const sample = (voice: unknown = "am_adam", extra: Record<string, unknown> = {}) => ({
      kind: "voiceSample",
      voice,
      ...extra,
    });
    const send = (t: Awaited<ReturnType<typeof voiceT>>, id: string, fields: Record<string, unknown>) => {
      return t.bridge.handleCommand(t.config, id, t.command(fields as never));
    };

    it("is offered only on a streaming store with a preview, and old Macs omit it", async () => {
      const on = await voiceT({ natural, streaming: true, preview: async () => Buffer.from("x") });
      expect(on.bridge.phoneView().voice).toMatchObject({ natural: { installed: true, sample: true } });
      const polling = await voiceT({ natural, preview: async () => Buffer.from("x") });
      expect(polling.bridge.phoneView().voice).not.toHaveProperty("natural.sample");
      const none = await voiceT({ natural, streaming: true });
      expect(none.bridge.phoneView().voice).not.toHaveProperty("natural.sample");
      for (const t of [on, polling, none]) t.bridge.stop();
    });

    it("makes the sample with the preview function and leaves it as sealed chunks", async () => {
      const wav = crypto.randomBytes(MEDIA_CHUNK_BYTES + 99);
      const preview = vi.fn(async () => wav);
      const t = await voiceT({ natural, streaming: true, preview });
      const verdict = await send(t, "s1", sample());
      expect(preview).toHaveBeenCalledWith("am_adam");
      const media = (
        verdict.result as { media: { id: string; chunks: number; bytes: number; sha256: string; mime: string } }
      ).media;
      expect(verdict.result).toMatchObject({
        id: "s1",
        status: "sent",
        media: { chunks: 2, bytes: wav.length, mime: "audio/wav" },
      });
      const joined = Buffer.concat(
        Array.from({ length: media.chunks }, (_, index) => {
          const doc = t.store.docs.get(`channels/${t.payload.c}/media/${media.id}-${index}`)!;
          return Buffer.from(open<{ data: string }>(t.payload.k, doc.box).data, "base64");
        }),
      );
      expect(joined.equals(wav)).toBe(true);
      expect(crypto.createHash("sha256").update(joined).digest("hex")).toBe(media.sha256);
      t.bridge.stop();
    });

    it("makes a sample of another engine, checked against that engine's own voices and install", async () => {
      const engines = {
        ...natural,
        engine: "kokoro",
        engines: [
          { id: "kokoro", installed: true, voices: natural.voices },
          { id: "ming", installed: true, voices: [{ id: "US_Emma", label: "Emma" }] },
          { id: "qwen3", installed: false, voices: [{ id: "ryan", label: "Ryan" }] },
        ],
      };
      const preview = vi.fn<(voice: string, engine?: string) => Promise<Buffer>>(async () => Buffer.from("x"));
      const t = await voiceT({ natural: engines, streaming: true, preview });
      expect((await send(t, "e1", sample("US_Emma", { engine: "ming" }))).result).toMatchObject({ status: "sent" });
      expect(preview).toHaveBeenCalledWith("US_Emma", "ming");
      for (const [i, fields] of [
        sample("am_adam", { engine: "ming" }),
        sample("ryan", { engine: "qwen3" }),
        sample("ryan", { engine: "elevenlabs" }),
        sample("US_Emma", { engine: 7 }),
      ].entries()) {
        expect((await send(t, `e${i + 2}`, fields)).result).toMatchObject({ status: "refused" });
      }
      expect(preview).toHaveBeenCalledTimes(1);
      t.bridge.stop();
    });

    it("refuses extra keys, an unknown or malformed voice, and an uninstalled voice, making nothing", async () => {
      const preview = vi.fn(async () => Buffer.from("x"));
      const t = await voiceT({ natural, streaming: true, preview });
      for (const [i, fields] of [
        sample("am_adam", { text: "hi" }),
        sample("bf_emma"),
        sample("../etc"),
        sample(7),
        { kind: "voiceSample" },
      ].entries()) {
        const verdict = await send(t, `b${i}`, fields);
        expect(verdict.result).toMatchObject({ status: "refused" });
      }
      expect(preview).not.toHaveBeenCalled();
      t.bridge.stop();
      const missing = await voiceT({ natural: { ...natural, installed: false }, streaming: true, preview });
      expect((await send(missing, "n1", sample())).result).toEqual({
        id: "n1",
        status: "refused",
        reason: "The realistic voice isn't installed on this Mac.",
      });
      missing.bridge.stop();
    });

    it("refuses when this Mac cannot carry media or make a sample", async () => {
      const polling = await voiceT({ natural, preview: async () => Buffer.from("x") });
      expect((await send(polling, "p1", sample())).result).toMatchObject({ status: "refused" });
      const none = await voiceT({ natural, streaming: true });
      expect((await send(none, "p2", sample())).result).toMatchObject({ status: "refused" });
      for (const t of [polling, none]) t.bridge.stop();
    });

    it("says so when the sample could not be made, and writes no chunk", async () => {
      const t = await voiceT({ natural, streaming: true, preview: async () => null });
      const verdict = await send(t, "f1", sample());
      expect(verdict.result).toMatchObject({ id: "f1", status: "refused" });
      expect([...t.store.docs.keys()].some((key) => key.includes("/media/"))).toBe(false);
      t.bridge.stop();
    });

    it("lets one device ask every 5 seconds, and only one at a time", async () => {
      let release: (wav: Buffer) => void = () => undefined;
      let calls = 0;
      const preview = vi.fn(
        () =>
          new Promise<Buffer | null>((resolve) => {
            calls += 1;
            release = resolve;
          }),
      );
      const t = await voiceT({ natural, streaming: true, preview });
      const first = send(t, "r1", sample());
      await vi.waitFor(() => expect(calls).toBe(1));
      expect((await send(t, "r2", sample())).result).toMatchObject({
        status: "refused",
        reason: "Your Mac is still making the last sample.",
      });
      release(Buffer.from("wav"));
      expect((await first).result).toMatchObject({ status: "sent" });
      expect((await send(t, "r3", sample())).result).toMatchObject({
        status: "refused",
        reason: "Wait a few seconds before playing another sample.",
      });
      t.clock.t += 5_001;
      const again = send(t, "r4", sample());
      await vi.waitFor(() => expect(calls).toBe(2));
      release(Buffer.from("wav"));
      expect((await again).result).toMatchObject({ status: "sent" });
      t.bridge.stop();
    });
  });

  it("starts a test call and answers at once, touching no setting", async () => {
    const t = await voiceT();
    const verdict = await t.bridge.handleCommand(t.config, "t1", t.command({ change: { test: true } }));
    expect(verdict.result).toEqual({ id: "t1", status: "sent" });
    expect(t.test).toHaveBeenCalledTimes(1);
    expect(t.apply).not.toHaveBeenCalled();
    t.bridge.stop();
  });

  it("passes the Mac's reason when a test cannot start", async () => {
    const t = await voiceT({ testOutcome: { ok: false, reason: "A test call is already ringing." } });
    const verdict = await t.bridge.handleCommand(t.config, "t2", t.command({ change: { test: true } }));
    expect(verdict.result).toEqual({ id: "t2", status: "refused", reason: "A test call is already ringing." });
    t.bridge.stop();
  });

  it("changes the pin with the current one, and never logs either", async () => {
    const t = await voiceT();
    const ok = await t.bridge.handleCommand(
      t.config,
      "p1",
      t.command({ change: { pin: { current: "1234", next: "987654" } } }),
    );
    expect(ok.result).toEqual({ id: "p1", status: "sent" });
    expect(t.changePin).toHaveBeenCalledWith("1234", "987654");
    const wrong = await t.bridge.handleCommand(
      t.config,
      "p2",
      t.command({ change: { pin: { current: "0000", next: "987654" } } }),
    );
    expect(wrong.result).toEqual({ id: "p2", status: "refused", reason: "That is not your current pin." });
    const log = JSON.stringify((t.bridge.status() as { activity: unknown }).activity);
    expect(log).not.toContain("987654");
    expect(log).not.toContain("1234");
    t.bridge.stop();
  });

  it("runs each pin action once, and a reset needs no current pin", async () => {
    const t = await voiceT();
    const actions = [
      { action: "change", current: "1234", next: "987654" },
      { action: "disable", current: "1234" },
      { action: "enable", next: "987654" },
      { action: "reset", next: null },
      { action: "reset", next: "987654" },
      { action: "policy", outgoing: "skip", incoming: "ask" },
    ];
    for (const [i, pinAction] of actions.entries()) {
      const verdict = await t.bridge.handleCommand(t.config, `a${i}`, t.command({ change: { pinAction } }));
      expect(verdict.result).toEqual({ id: `a${i}`, status: "sent" });
    }
    expect(t.pinAction.mock.calls.map((call) => call[0])).toEqual(actions);
    const refused = await t.bridge.handleCommand(
      t.config,
      "a9",
      t.command({ change: { pinAction: { action: "disable", current: "0000" } } }),
    );
    expect(refused.result).toEqual({ id: "a9", status: "refused", reason: "That is not your current pin." });
    const log = JSON.stringify((t.bridge.status() as { activity: unknown }).activity);
    expect(log).not.toMatch(/987654|1234|0000/);
    t.bridge.stop();
  });

  it("updates the add-on only for exactly { gatewayUpdate: true }", async () => {
    const gatewayUpdate = vi.fn(async () => ({ ok: true as const }));
    const t = await voiceT({ gatewayUpdate });
    const sent = await t.bridge.handleCommand(t.config, "g1", t.command({ change: { gatewayUpdate: true } }));
    expect(sent.result).toEqual({ id: "g1", status: "sent" });
    expect(gatewayUpdate).toHaveBeenCalledTimes(1);
    for (const change of [
      { gatewayUpdate: false },
      { gatewayUpdate: "true" },
      { gatewayUpdate: 1 },
      { gatewayUpdate: null },
      { gatewayUpdate: true, callee: "101" },
      { gatewayUpdate: true, pinAction: { action: "reset", next: null } },
    ]) {
      const verdict = await t.bridge.handleCommand(t.config, "g2", t.command({ change }));
      expect(verdict.result).toMatchObject({ status: "refused" });
    }
    expect(gatewayUpdate).toHaveBeenCalledTimes(1);
    t.bridge.stop();
  });

  it("passes the add-on's refusal sentence back, and refuses on a Mac without the hook", async () => {
    const t = await voiceT({
      gatewayUpdate: async () => ({ ok: false, reason: "The add-on is already on the newest version." }),
    });
    const verdict = await t.bridge.handleCommand(t.config, "g3", t.command({ change: { gatewayUpdate: true } }));
    expect(verdict.result).toEqual({
      id: "g3",
      status: "refused",
      reason: "The add-on is already on the newest version.",
    });
    t.bridge.stop();
    const bare = await voiceT();
    const none = await bare.bridge.handleCommand(bare.config, "g4", bare.command({ change: { gatewayUpdate: true } }));
    expect(none.result).toMatchObject({ status: "refused" });
    bare.bridge.stop();
  });

  it("refuses malformed pin actions, extra keys and bad digits without asking", async () => {
    const t = await voiceT();
    const bad: Record<string, unknown>[] = [
      { change: { pinAction: { action: "reset" } } },
      { change: { pinAction: { action: "reset", next: "12" } } },
      { change: { pinAction: { action: "reset", next: "12ab" } } },
      { change: { pinAction: { action: "reset", next: 1234 } } },
      { change: { pinAction: { action: "reset", next: null, current: "1234" } } },
      { change: { pinAction: { action: "disable", current: "123" } } },
      { change: { pinAction: { action: "disable" } } },
      { change: { pinAction: { action: "enable", next: "1234567890123" } } },
      { change: { pinAction: { action: "change", current: "1234" } } },
      { change: { pinAction: { action: "status" } } },
      { change: { pinAction: { action: "policy", outgoing: "skip" } } },
      { change: { pinAction: { action: "policy", outgoing: "never", incoming: "ask" } } },
      { change: { pinAction: "reset" } },
      { change: { pinAction: null } },
      { change: { pinAction: { action: "reset", next: null }, callee: "101" } },
    ];
    for (const fields of bad) {
      const verdict = await t.bridge.handleCommand(t.config, "x", t.command(fields));
      expect(verdict.result).toMatchObject({ status: "refused" });
    }
    expect(t.pinAction).not.toHaveBeenCalled();
    t.bridge.stop();
  });

  it("refuses a malformed pin change without asking the gateway", async () => {
    const t = await voiceT();
    const bad: Record<string, unknown>[] = [
      { change: { pin: { current: "123", next: "987654" } } },
      { change: { pin: { current: "1234", next: "12ab" } } },
      { change: { pin: { current: "1234", next: "1234567890123" } } },
      { change: { pin: { current: "1234" } } },
      { change: { pin: { current: "1234", next: "5678", extra: "1" } } },
      { change: { pin: "1234" } },
      { change: { pin: { current: 1234, next: 5678 } } },
      { change: { pin: { current: "1234", next: "5678" }, callee: "101" } },
    ];
    for (const fields of bad) {
      const verdict = await t.bridge.handleCommand(t.config, "x", t.command(fields));
      expect(verdict.result).toMatchObject({ status: "refused" });
    }
    expect(t.changePin).not.toHaveBeenCalled();
    t.bridge.stop();
  });

  it("refuses every malformed change and changes nothing", async () => {
    const t = await voiceT();
    const bad: Record<string, unknown>[] = [
      { change: { callee: "+919876543210" } },
      { change: { callee: "1" } },
      { change: { callee: 101 } },
      { change: { callee: "101", test: true } },
      { change: { test: false } },
      { change: { test: "true" } },
      { change: { test: true, callee: null } },
      { change: {} },
      { change: [] },
      { change: null },
      {},
      { change: { callee: "101" }, extra: 1 },
      { change: { callee: "101" }, v: 2 },
    ];
    for (const fields of bad) {
      const verdict = await t.bridge.handleCommand(t.config, "x", t.command(fields));
      expect(verdict.result).toMatchObject({ status: "refused" });
    }
    expect(t.voice.settings.callee).toBeNull();
    expect(t.test).not.toHaveBeenCalled();
    t.bridge.stop();
  });

  it("refuses a replay, a stranger's signature, and a Mac without phone calls", async () => {
    const t = await voiceT();
    const fields = { change: { callee: "35210" } };
    const nonce = "v".repeat(32);
    expect((await t.bridge.handleCommand(t.config, "a", t.command(fields, undefined, nonce))).result).toMatchObject({
      status: "sent",
    });
    expect((await t.bridge.handleCommand(t.config, "b", t.command(fields, undefined, nonce))).result).toMatchObject({
      status: "refused",
    });
    const stranger = await t.bridge.handleCommand(t.config, "c", t.command({ change: { test: true } }, device()));
    expect(stranger.write).toBe(false);
    expect(t.test).not.toHaveBeenCalled();
    t.bridge.stop();

    const off = await voiceT({ offered: false });
    expect(off.bridge.phoneView()).not.toHaveProperty("voice");
    expect((await off.bridge.handleCommand(off.config, "d", off.command(fields))).result).toMatchObject({
      status: "refused",
    });
    off.bridge.stop();
  });
});

describe("RemoteBridge Telegram avatar from the phone", () => {
  async function avatarT(
    options: { offered?: boolean; outcome?: { ok: true; message: string } | { ok: false; reason: string } } = {},
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-avatar-"));
    dirs.push(dir);
    const store = new MemoryStore();
    const apply = vi.fn((...args: unknown[]) => {
      void args;
      return Promise.resolve(options.outcome ?? { ok: true as const, message: "Done" });
    });
    const bridge = new RemoteBridge({
      configPath: path.join(dir, "remote.json"),
      projectId: "squeak-test",
      store,
      replier: { lastTurnText: () => null, lastTurnId: () => null, send: vi.fn() },
      snapshot: () => ({ sessions: [], active: [], attention: [], generatedAt: "", codexUsage: null }) as FleetSnapshot,
      ...(options.offered === false ? {} : { telegramAvatar: { apply } }),
      now: () => NOW,
    });
    const pairing = bridge.startPairing();
    const payload = JSON.parse(Buffer.from(new URL(pairing.url).searchParams.get("d")!, "base64url").toString());
    const phone = device();
    await store.set(`channels/${payload.c}/pairing/iphone-1`, {
      box: seal(payload.k, { name: "iPhone", publicKey: phone.x963 }),
    });
    await bridge.tick();
    await bridge.approve("iphone-1");
    const config = JSON.parse(fs.readFileSync(path.join(dir, "remote.json"), "utf8"));
    const command = (
      fields: Record<string, unknown> = {},
      signer = phone,
      nonce = crypto.randomBytes(16).toString("hex"),
    ) => {
      const box = seal(payload.k, { v: 1, kind: "telegramAvatar", nonce, expiresAt: NOW + 60_000, ...fields });
      return { box, sig: signer.sign(box), device: "iphone-1" };
    };
    return { bridge, config, command, apply };
  }

  it("carries the capability flag and runs one signed command", async () => {
    const t = await avatarT();
    expect(t.bridge.phoneView().telegramAvatar).toBe(true);
    const verdict = await t.bridge.handleCommand(t.config, "a1", t.command());
    expect(verdict.result).toEqual({ id: "a1", status: "sent" });
    expect(t.apply).toHaveBeenCalledWith({});
    t.bridge.stop();
  });

  it("passes the Mac's fixed refusal sentence through", async () => {
    const t = await avatarT({ outcome: { ok: false, reason: "Telegram is not set up" } });
    const verdict = await t.bridge.handleCommand(t.config, "a1", t.command());
    expect(verdict.result).toEqual({ id: "a1", status: "refused", reason: "Telegram is not set up" });
    t.bridge.stop();
  });

  it("refuses extra keys, a wrong version, a replay, a stranger, and a Mac without it", async () => {
    const t = await avatarT();
    for (const fields of [{ which: "logo" }, { extra: 1 }, { v: 2 }]) {
      const verdict = await t.bridge.handleCommand(t.config, "x", t.command(fields));
      expect(verdict.result).toMatchObject({ status: "refused" });
    }
    expect(t.apply).not.toHaveBeenCalled();
    const nonce = "n".repeat(32);
    expect((await t.bridge.handleCommand(t.config, "a", t.command({}, undefined, nonce))).result).toMatchObject({
      status: "sent",
    });
    expect((await t.bridge.handleCommand(t.config, "b", t.command({}, undefined, nonce))).result).toMatchObject({
      status: "refused",
    });
    const stranger = await t.bridge.handleCommand(t.config, "c", t.command({}, device()));
    expect(stranger.write).toBe(false);
    expect(t.apply).toHaveBeenCalledTimes(1);
    t.bridge.stop();

    const off = await avatarT({ offered: false });
    expect(off.bridge.phoneView()).not.toHaveProperty("telegramAvatar");
    expect((await off.bridge.handleCommand(off.config, "d", off.command())).result).toMatchObject({
      status: "refused",
    });
    off.bridge.stop();
  });
});

describe("RemoteBridge Telegram and Cliq setup from the phone", () => {
  const SECRET_TOKEN = "123456789:SECRETtokenABCDEFGHIJKLMNOP";
  const SECRET_HOOK = "https://cliq.zoho.in/api/v2/bots/b/incoming?zapikey=SECRETZAPIKEY";

  async function setupT(options: { offered?: boolean; fail?: boolean } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remote-bridge-channels-"));
    dirs.push(dir);
    const store = new MemoryStore();
    const telegram = vi.fn(async (change: unknown) => {
      if (options.fail) throw new Error(`boom ${JSON.stringify(change)}`);
      return (change as { token?: string }).token === "bad"
        ? { ok: false as const, reason: "That doesn't look like a bot token." }
        : { ok: true as const, message: "Saved." };
    });
    const cliq = vi.fn((change: unknown) => {
      if (options.fail) throw new Error(`boom ${JSON.stringify(change)}`);
      return { ok: true as const, message: "Saved." };
    });
    const state = () => ({ telegram: { tokenSet: true, chats: [], linking: null }, cliq: { webhookSet: false } });
    const bridge = new RemoteBridge({
      configPath: path.join(dir, "remote.json"),
      projectId: "squeak-test",
      store,
      replier: { lastTurnText: () => null, lastTurnId: () => null, send: vi.fn() },
      snapshot: () => ({ sessions: [], active: [], attention: [], generatedAt: "", codexUsage: null }) as FleetSnapshot,
      ...(options.offered === false ? {} : { channelsSetup: { state, telegram, cliq } }),
      now: () => NOW,
    });
    const pairing = bridge.startPairing();
    const payload = JSON.parse(Buffer.from(new URL(pairing.url).searchParams.get("d")!, "base64url").toString());
    const phone = device();
    await store.set(`channels/${payload.c}/pairing/iphone-1`, {
      box: seal(payload.k, { name: "iPhone", publicKey: phone.x963 }),
    });
    await bridge.tick();
    await bridge.approve("iphone-1");
    const config = JSON.parse(fs.readFileSync(path.join(dir, "remote.json"), "utf8"));
    const command = (
      kind: string,
      fields: Record<string, unknown>,
      signer = phone,
      nonce = crypto.randomBytes(16).toString("hex"),
    ) => {
      const box = seal(payload.k, { v: 1, kind, nonce, expiresAt: NOW + 60_000, ...fields });
      return { box, sig: signer.sign(box), device: "iphone-1" };
    };
    return { bridge, config, command, telegram, cliq };
  }

  it("shows only non-secret state, and hides it on a Mac without the setup", async () => {
    const t = await setupT();
    expect(t.bridge.phoneView().channelsSetup).toEqual({
      telegram: { tokenSet: true, chats: [], linking: null },
      cliq: { webhookSet: false },
    });
    t.bridge.stop();
    const off = await setupT({ offered: false });
    expect(off.bridge.phoneView()).not.toHaveProperty("channelsSetup");
    off.bridge.stop();
  });

  it("applies one signed change per command and answers only sent or a fixed reason", async () => {
    const t = await setupT();
    const sent = await t.bridge.handleCommand(
      t.config,
      "a",
      t.command("telegram", { change: { token: SECRET_TOKEN } }),
    );
    expect(sent.result).toEqual({ id: "a", status: "sent" });
    expect(t.telegram).toHaveBeenCalledWith({ token: SECRET_TOKEN });
    const hook = await t.bridge.handleCommand(t.config, "b", t.command("cliq", { change: { webhook: SECRET_HOOK } }));
    expect(hook.result).toEqual({ id: "b", status: "sent" });
    expect(t.cliq).toHaveBeenCalledWith({ webhook: SECRET_HOOK });
    const refused = await t.bridge.handleCommand(t.config, "c", t.command("telegram", { change: { token: "bad" } }));
    expect(refused.result).toEqual({
      id: "c",
      status: "refused",
      reason: "That doesn't look like a bot token.",
    });
    t.bridge.stop();
  });

  it("refuses extra or missing keys, a wrong version, a replay, a stranger, and a Mac without the setup", async () => {
    const t = await setupT();
    const verdict = async (id: string, kind: string, fields: Record<string, unknown>) =>
      (await t.bridge.handleCommand(t.config, id, t.command(kind, fields))).result;
    expect(await verdict("1", "telegram", { change: { off: true }, extra: 1 })).toMatchObject({ status: "refused" });
    expect(await verdict("2", "telegram", {})).toMatchObject({ status: "refused" });
    expect(await verdict("3", "cliq", { change: { removeWebhook: true }, channel: "x" })).toMatchObject({
      status: "refused",
    });
    expect(await verdict("4", "telegram", { v: 2, change: { off: true } })).toMatchObject({ status: "refused" });
    // The change itself is read strictly by the writer: an array or a string reaches it and is its to refuse.
    expect(t.telegram).not.toHaveBeenCalled();
    expect(t.cliq).not.toHaveBeenCalled();

    const fields = { change: { test: true } };
    const nonce = "t".repeat(32);
    expect(
      (await t.bridge.handleCommand(t.config, "5", t.command("telegram", fields, undefined, nonce))).result,
    ).toEqual({ id: "5", status: "sent" });
    expect(
      (await t.bridge.handleCommand(t.config, "6", t.command("telegram", fields, undefined, nonce))).result,
    ).toMatchObject({ status: "refused" });
    const stranger = await t.bridge.handleCommand(
      t.config,
      "7",
      t.command("telegram", { change: { off: true } }, device()),
    );
    expect(stranger.write).toBe(false);
    expect(t.telegram).toHaveBeenCalledTimes(1);
    t.bridge.stop();

    const off = await setupT({ offered: false });
    expect((await off.bridge.handleCommand(off.config, "8", off.command("telegram", fields))).result).toMatchObject({
      status: "refused",
    });
    expect(
      (await off.bridge.handleCommand(off.config, "9", off.command("cliq", { change: { removeWebhook: true } })))
        .result,
    ).toMatchObject({ status: "refused" });
    off.bridge.stop();
  });

  it("never logs, answers or shows a secret, even when the writer fails with it in its message", async () => {
    const logs = [vi.spyOn(logger, "info"), vi.spyOn(logger, "warn"), vi.spyOn(logger, "error")];
    const t = await setupT({ fail: true });
    const results = [
      (await t.bridge.handleCommand(t.config, "a", t.command("telegram", { change: { token: SECRET_TOKEN } }))).result,
      (await t.bridge.handleCommand(t.config, "b", t.command("cliq", { change: { webhook: SECRET_HOOK } }))).result,
    ];
    for (const result of results) expect(result).toMatchObject({ status: "refused" });
    const everything = JSON.stringify([results, logs.flatMap((spy) => spy.mock.calls), t.bridge.phoneView()]);
    expect(everything).not.toContain("SECRET");
    expect(everything).not.toContain("zapikey");
    t.bridge.stop();
    vi.restoreAllMocks();
  });
});

describe("RemoteBridge native chats from the phone", () => {
  const KEY = "squeak-native:n1";
  const nativeSession = (overrides: Partial<FleetSession> = {}) => ({
    key: KEY,
    source: "squeak-native" as const,
    origin: "squeak" as const,
    sourceId: "n1",
    conductorSessionId: null,
    state: "awaiting_approval" as const,
    nativeRequest: { id: "r1", kind: "tool" as const, summary: "Bash: ls" },
    ...overrides,
  });
  const QUESTION_PAYLOAD = {
    input: {
      questions: [{ question: "Which colour?", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false }],
    },
  };

  function fakeNative(
    options: {
      open?: { id: string; kind: string; payload?: unknown } | null;
      respondError?: Error;
      bypass?: boolean;
    } = {},
  ) {
    const responds: Array<[string, unknown]> = [];
    const starts: Array<Record<string, unknown>> = [];
    const open = options.open === undefined ? { id: "r1", kind: "tool", payload: {} } : options.open;
    const native = {
      detail: (_id: string, summary: { id: string; kind: string; summary: string }) => ({
        id: summary.id,
        kind: summary.kind,
        summary: summary.summary,
        command: "ls",
        chatRule: true,
      }),
      projects: () => [
        {
          id: "p1",
          name: "farm",
          rootPath: "/repo/farm",
          workspaces: [{ id: "w1", name: "arm", branch: "arm" }],
          paths: new Map([["w1", "/ws/farm/arm"]]),
        },
      ],
      models: () => [
        { agent: "claude" as const, id: "opus-5-5-1m", label: "Opus", levels: ["low", "high"], favorite: true },
      ],
      allowBypass: () => options.bypass === true,
      currentRequest: async () => (open ? { id: open.id, kind: open.kind, payload: open.payload ?? {} } : null),
      respond: async (requestId: string, body: unknown) => {
        if (options.respondError) throw options.respondError;
        responds.push([requestId, body]);
      },
      start: async (spec: Record<string, unknown>) => {
        starts.push(spec);
        return { id: "n9" };
      },
    } as unknown as NonNullable<RemoteBridgeDependencies["native"]>;
    return { native, responds, starts };
  }

  async function go(f: ReturnType<typeof fixture>, doc: { box: string; sig: string; device: string }) {
    await f.store.set(`${f.channel}/commands/n1`, doc);
    await f.bridge.tick();
    return f.result("n1");
  }
  const respond = (overrides: Record<string, unknown> = {}) => ({
    action: "respond",
    sessionKey: KEY,
    requestId: "r1",
    decision: "allow",
    ...overrides,
  });
  const start = (overrides: Record<string, unknown> = {}) => ({
    action: "start",
    projectId: "p1",
    where: "newWorkspace",
    agent: "claude",
    model: "opus-5-5-1m",
    effort: "high",
    permissionMode: "default",
    text: "Add a timer",
    ...overrides,
  });
  const setup = async (options: Parameters<typeof fakeNative>[0] = {}, session = nativeSession()) => {
    const n = fakeNative(options);
    const f = fixture({ native: n.native, session: session as unknown as Partial<FleetSession> });
    await f.pair();
    return { f, ...n };
  };

  it("allows the current request, once or for the chat", async () => {
    const { f, responds } = await setup();
    expect(await go(f, f.nativeCommand(respond()))).toMatchObject({ status: "sent" });
    expect(responds).toEqual([["r1", { decision: "allow" }]]);
  });

  it("keeps an allow rule for the chat only for a tool, command or file request that is allowed", async () => {
    const a = await setup();
    expect(await go(a.f, a.f.nativeCommand(respond({ scope: "session" })))).toMatchObject({ status: "sent" });
    expect(a.responds).toEqual([["r1", { decision: "allow", scope: "session" }]]);
    const b = await setup({ open: { id: "r1", kind: "plan" } });
    expect(await go(b.f, b.f.nativeCommand(respond({ scope: "session" })))).toMatchObject({ status: "refused" });
    const c = await setup();
    expect(await go(c.f, c.f.nativeCommand(respond({ decision: "deny", scope: "session" })))).toMatchObject({
      status: "refused",
    });
    expect(a.responds.length + b.responds.length + c.responds.length).toBe(1);
  });

  it("denies with a note, and refuses a note on an allow or one that is too long", async () => {
    const a = await setup();
    expect(await go(a.f, a.f.nativeCommand(respond({ decision: "deny", message: "Keep planning." })))).toMatchObject({
      status: "sent",
    });
    expect(a.responds).toEqual([["r1", { decision: "deny", message: "Keep planning." }]]);
    const b = await setup();
    expect(await go(b.f, b.f.nativeCommand(respond({ message: "hi" })))).toMatchObject({ status: "refused" });
    const c = await setup();
    expect(await go(c.f, c.f.nativeCommand(respond({ decision: "deny", message: "x".repeat(501) })))).toMatchObject({
      status: "refused",
    });
    expect(b.responds.length + c.responds.length).toBe(0);
  });

  it("refuses a request that is not the host's current one, and one already gone", async () => {
    const a = await setup({ open: { id: "r2", kind: "tool" } });
    expect(await go(a.f, a.f.nativeCommand(respond()))).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("already answered"),
    });
    const b = await setup({ open: null });
    expect(await go(b.f, b.f.nativeCommand(respond()))).toMatchObject({ status: "refused" });
    expect(a.responds.length + b.responds.length).toBe(0);
  });

  it("answers a question only with an option the host's own request offered", async () => {
    const open = { id: "r1", kind: "question", payload: QUESTION_PAYLOAD };
    const ok = await setup({ open });
    expect(await go(ok.f, ok.f.nativeCommand(respond({ answers: [{ question: 0, picked: "Blue" }] })))).toMatchObject({
      status: "sent",
    });
    expect(ok.responds).toEqual([["r1", { decision: "allow", answers: { "Which colour?": "Blue" } }]]);
    for (const bad of [
      [{ question: 0, picked: "Green" }],
      [{ question: 3, picked: "Red" }],
      [
        { question: 0, picked: "Red" },
        { question: 0, picked: "Blue" },
      ],
      [],
      "Red",
    ]) {
      const t = await setup({ open });
      expect(await go(t.f, t.f.nativeCommand(respond({ answers: bad })))).toMatchObject({ status: "refused" });
      expect(t.responds).toEqual([]);
    }
    const none = await setup({ open });
    expect(await go(none.f, none.f.nativeCommand(respond()))).toMatchObject({ status: "refused" });
    const wrongKind = await setup();
    expect(
      await go(wrongKind.f, wrongKind.f.nativeCommand(respond({ answers: [{ question: 0, picked: "Red" }] }))),
    ).toMatchObject({ status: "refused" });
  });

  it("refuses a chat the Mac does not show, one that is not a Squeak chat, and a Mac without native support", async () => {
    const { f } = await setup();
    expect(await go(f, f.nativeCommand(respond({ sessionKey: "squeak-native:other" })))).toMatchObject({
      status: "refused",
    });
    const conductor = await setup({}, nativeSession({ origin: "conductor" as never }));
    expect(await go(conductor.f, conductor.f.nativeCommand(respond()))).toMatchObject({ status: "refused" });
    const bare = fixture();
    await bare.pair();
    expect(await go(bare, bare.nativeCommand(respond()))).toMatchObject({ status: "refused" });
  });

  it("says so when the request closed under the tap, and when the host is down", async () => {
    const gone = await setup({ respondError: new NativeHostError("closed", "http", 409) });
    expect(await go(gone.f, gone.f.nativeCommand(respond()))).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("already answered"),
    });
    const down = await setup({ respondError: new NativeHostError("Squeak's session host is not running.", "down") });
    expect(await go(down.f, down.f.nativeCommand(respond()))).toMatchObject({
      status: "refused",
      reason: "Squeak's session host is not running.",
    });
  });

  it("holds every shared check for a native command: signature, expiry, a nonce used once", async () => {
    const { f, responds } = await setup();
    const forger = device();
    await f.store.set(`${f.channel}/commands/n1`, f.nativeCommand(respond(), forger));
    await f.bridge.tick();
    expect(f.result("n1")).toBeNull();
    const expired = f.nativeCommand(respond({ expiresAt: NOW - 1 }));
    expect(await go(f, expired)).toMatchObject({ status: "refused", reason: expect.stringContaining("expired") });
    const fresh = f.nativeCommand(respond());
    expect(await go(f, fresh)).toMatchObject({ status: "sent" });
    await f.store.set(`${f.channel}/commands/n2`, fresh);
    await f.bridge.tick();
    expect(f.result("n2")).toMatchObject({ status: "refused", reason: expect.stringContaining("already received") });
    expect(responds).toHaveLength(1);
  });

  it("starts a chat in a project the Mac lists, in a new workspace, an existing one, or the project folder", async () => {
    const a = await setup();
    expect(await go(a.f, a.f.nativeCommand(start()))).toMatchObject({ status: "sent", sessionKey: "squeak-native:n9" });
    expect(a.starts[0]).toMatchObject({
      projectId: "p1",
      where: "newWorkspace",
      model: "opus-5-5-1m",
      effort: "high",
      permissionMode: "default",
      cwd: "/repo/farm",
    });
    const b = await setup();
    expect(await go(b.f, b.f.nativeCommand(start({ where: "workspace", workspaceId: "w1" })))).toMatchObject({
      status: "sent",
    });
    expect(b.starts[0]).toMatchObject({ workspaceId: "w1", cwd: "/ws/farm/arm" });
    const c = await setup();
    expect(await go(c.f, c.f.nativeCommand(start({ where: "folder" })))).toMatchObject({ status: "sent" });
    expect(c.starts[0]).toMatchObject({ cwd: "/repo/farm" });
  });

  it("refuses a project, workspace, model or level the Mac does not offer, and a mode it does not know", async () => {
    for (const bad of [
      { projectId: "nope" },
      { where: "workspace", workspaceId: "nope" },
      { where: "workspace" },
      { where: "folder", workspaceId: "w1" },
      { model: "gpt-9" },
      { effort: "max" },
      { permissionMode: "dontAsk" },
      { text: "  " },
      { agent: "codex" },
    ]) {
      const t = await setup();
      expect(await go(t.f, t.f.nativeCommand(start(bad)))).toMatchObject({ status: "refused" });
      expect(t.starts).toEqual([]);
    }
  });

  it("refuses bypassPermissions unless this Mac allows it, and spaces starts apart", async () => {
    const off = await setup();
    expect(await go(off.f, off.f.nativeCommand(start({ permissionMode: "bypassPermissions" })))).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("skips approvals"),
    });
    expect(off.starts).toEqual([]);
    const on = await setup({ bypass: true });
    expect(await go(on.f, on.f.nativeCommand(start({ permissionMode: "bypassPermissions" })))).toMatchObject({
      status: "sent",
    });
    await on.f.store.set(`${on.f.channel}/commands/n2`, on.f.nativeCommand(start()));
    await on.f.bridge.tick();
    expect(on.f.result("n2")).toMatchObject({ status: "refused", reason: expect.stringContaining("just started") });
    expect(on.starts).toHaveLength(1);
  });

  it("sends the open request and the project list only to a phone that names native", async () => {
    const { f } = await setup();
    const presence = (caps?: string[]) =>
      f.store.set(`${f.channel}/state/presence`, { box: seal(f.payload.k, { at: NOW, ...(caps ? { caps } : {}) }) });
    const view = () =>
      f.bridge.phoneView() as unknown as Record<string, unknown> & { sessions: Array<Record<string, unknown>> };
    await presence();
    await f.bridge.tick();
    expect(view().sessions[0]).not.toHaveProperty("nativeRequest");
    expect(view()).not.toHaveProperty("nativeProjects");
    await presence(["native"]);
    await f.bridge.tick();
    expect(view().sessions[0]!.nativeRequest).toMatchObject({ id: "r1", kind: "tool", command: "ls", chatRule: true });
    expect(view().nativeProjects).toEqual([
      { id: "p1", name: "farm", workspaces: [{ id: "w1", name: "arm", branch: "arm" }] },
    ]);
    expect(JSON.stringify(view())).not.toContain("/repo/farm");
    expect(view().nativePermissionModes).toEqual(["default", "acceptEdits", "plan"]);
  });
});

describe("RemoteBridge ponds in the phone view", () => {
  const ponds = [
    { id: "p-old", name: "Docs", shared: false, members: [], match: "docs" },
    {
      id: "p-new",
      name: "Shop",
      shared: true,
      members: [{ name: "Asha", online: true }],
      match: "shop",
    },
  ];
  const withPonds = (value: unknown) =>
    ({
      ...({ projects: () => [], models: () => [], allowBypass: () => false } as object),
      ponds: async () => value,
    }) as unknown as NonNullable<RemoteBridgeDependencies["native"]>;

  it("carries ponds newest chat first and each chat's pond, without the matching key", async () => {
    const f = fixture({ native: withPonds(ponds), session: { repoName: "shop" } as Partial<FleetSession> });
    await f.pair();
    await f.bridge.tick();
    const view = f.bridge.phoneView() as unknown as {
      ponds: unknown[];
      sessions: Array<{ pond?: unknown }>;
    };
    expect(view.ponds).toEqual([
      { id: "p-new", name: "Shop", shared: true, members: [{ name: "Asha", online: true }] },
      { id: "p-old", name: "Docs", shared: false, members: [] },
    ]);
    expect(view.sessions[0]?.pond).toEqual({ id: "p-new", name: "Shop" });
    expect(JSON.stringify(view)).not.toContain('"match"');
    f.bridge.stop();
  });

  it("links a chat to its pond by project id: a rename keeps it, same names stay apart, no id falls back to name", async () => {
    const list = [
      { id: "p-a", name: "Shop", shared: false, members: [], match: "shop", projectId: "proj-a" },
      { id: "p-b", name: "Shop", shared: false, members: [], match: "shop", projectId: "proj-b" },
      { id: "p-n", name: "Blog", shared: false, members: [], match: "blog" },
    ];
    const pondFor = async (session: Partial<FleetSession>) => {
      const f = fixture({ native: withPonds(list), session });
      await f.pair();
      await f.bridge.tick();
      const view = f.bridge.phoneView() as unknown as { sessions: Array<{ pond?: { id: string } }> };
      f.bridge.stop();
      return view.sessions[0]?.pond?.id;
    };
    expect(await pondFor({ repoName: "Renamed", projectId: "proj-a" })).toBe("p-a");
    expect(await pondFor({ repoName: "Shop", projectId: "proj-b" })).toBe("p-b");
    expect(await pondFor({ repoName: "Shop", projectId: "proj-c" })).toBeUndefined();
    expect(await pondFor({ repoName: "blog", projectId: "proj-z" })).toBe("p-n");
  });

  describe("native project icons", () => {
    const withIcons = (icons: () => Promise<Record<string, string> | null>) =>
      ({
        ...({ projects: () => [], models: () => [], allowBypass: () => false } as object),
        projectIcons: icons,
      }) as unknown as NonNullable<RemoteBridgeDependencies["native"]>;
    const iconsOf = async (
      native: NonNullable<RemoteBridgeDependencies["native"]>,
      conductor: Record<string, string>,
    ) => {
      const f = fixture({ native, projectIcons: () => conductor });
      await f.pair();
      await f.bridge.tick();
      const icons = (f.bridge.phoneView() as unknown as { projectIcons?: Record<string, string> }).projectIcons;
      f.bridge.stop();
      return icons;
    };

    it("merges by name and id, and the native icon wins over Conductor's", async () => {
      const icons = await iconsOf(
        withIcons(async () => ({ Shop: "NATIVE", "proj-1": "NATIVE" })),
        { Shop: "COND", Blog: "COND" },
      );
      expect(icons).toEqual({ Shop: "NATIVE", "proj-1": "NATIVE", Blog: "COND" });
    });

    it("keeps Conductor's icons when the host fails or answers nothing", async () => {
      expect(
        await iconsOf(
          withIcons(async () => {
            throw new Error("down");
          }),
          { Blog: "COND" },
        ),
      ).toEqual({ Blog: "COND" });
      expect(
        await iconsOf(
          withIcons(async () => null),
          { Blog: "COND" },
        ),
      ).toEqual({ Blog: "COND" });
    });
  });

  it("leaves both fields out when the host is down", async () => {
    const f = fixture({ native: withPonds(null), session: { repoName: "shop" } as Partial<FleetSession> });
    await f.pair();
    await f.bridge.tick();
    const view = f.bridge.phoneView() as unknown as { ponds?: unknown; sessions: Array<{ pond?: unknown }> };
    expect(view.ponds).toBeUndefined();
    expect(view.sessions[0]?.pond).toBeUndefined();
    f.bridge.stop();
  });
});

describe("RemoteBridge ponds2 (prefs, streams, order, detail, pond command)", () => {
  const ponds = [
    {
      id: "p-old",
      name: "Docs",
      shared: false,
      members: [],
      match: "docs",
      projectId: "proj-docs",
      hidden: true,
      colour: "teal",
      labels: ["writing"],
      streams: [{ id: "w1", name: "Draft", branch: "draft" }],
      archivedStreams: 3,
    },
    {
      id: "p-new",
      name: "Shop",
      shared: true,
      members: [{ name: "Asha", online: true }],
      match: "shop",
      projectId: "proj-shop",
      streams: [
        { id: "w-a", name: "Checkout", branch: "checkout" },
        { id: "w-b", name: "Cart", branch: "cart" },
      ],
      archivedStreams: 0,
    },
  ];
  const calls: unknown[][] = [];
  const makeNative = (over: Record<string, unknown> = {}) =>
    ({
      projects: () => [],
      models: () => [],
      allowBypass: () => false,
      ponds: async () => ponds,
      pondOrder: async () => ({ mode: "manual", ids: ["proj-docs", "proj-shop"] }),
      pondDetail: async (id: string) => ({
        id,
        waiting: [{ name: "Ravi" }],
        ripples: [{ text: "joined", at: "2026-01-01T00:00:00.000Z" }],
      }),
      setPondHidden: async (key: string, hidden: boolean) => void calls.push(["hide", key, hidden]),
      setPondOrder: async (change: unknown) => void calls.push(["order", change]),
      ...over,
    }) as unknown as NonNullable<RemoteBridgeDependencies["native"]>;
  const presence = (f: ReturnType<typeof fixture>, extra: Record<string, unknown>) =>
    f.store.set(`${f.channel}/state/presence`, { box: seal(f.payload.k, { at: NOW, ...extra }) });
  const viewOf = (f: ReturnType<typeof fixture>) => f.bridge.phoneView() as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const sessionIn = {
    repoName: "shop",
    branch: "cart",
    lastActivityAt: new Date(NOW - 1000).toISOString(),
  } as Partial<FleetSession>;

  it("adds the new fields only for a phone that names ponds2", async () => {
    const old = fixture({ native: makeNative(), session: sessionIn });
    await old.pair();
    await old.bridge.tick();
    expect(viewOf(old).ponds[0]).toEqual({
      id: "p-new",
      name: "Shop",
      shared: true,
      members: [{ name: "Asha", online: true }],
    });
    expect(viewOf(old).pondOrder).toBeUndefined();
    expect(viewOf(old).pondDetail).toBeUndefined();
    old.bridge.stop();

    const f = fixture({ native: makeNative(), session: sessionIn });
    await f.pair();
    await presence(f, { caps: ["ponds2"], pond: "p-new" });
    await f.bridge.tick();
    await f.bridge.tick();
    const view = viewOf(f);
    expect(view.ponds[0]).toMatchObject({ id: "p-new", projectId: "proj-shop" });
    expect(view.ponds[0].lastActivityAt).toBe(new Date(NOW - 1000).toISOString());
    // The stream with a chat comes first; no hidden flag on a visible pond.
    expect(view.ponds[0].streams.map((s: { id: string }) => s.id)).toEqual(["w-b", "w-a"]);
    expect(view.ponds[0].hidden).toBeUndefined();
    expect(view.ponds[1]).toMatchObject({ hidden: true, colour: "teal", labels: ["writing"], archivedStreams: 3 });
    expect(view.pondOrder).toEqual({ mode: "manual", ids: ["proj-docs", "proj-shop"] });
    expect(view.pondDetail).toMatchObject({ id: "p-new", waiting: [{ name: "Ravi" }] });
    expect(JSON.stringify(view)).not.toContain('"match"');
    f.bridge.stop();
  });

  it("sends the page only for the pond the phone has open, and leaves fields out when the host cannot say", async () => {
    const f = fixture({ native: makeNative({ pondOrder: async () => null }), session: sessionIn });
    await f.pair();
    await presence(f, { caps: ["ponds2"], pond: "no-such-pond" });
    await f.bridge.tick();
    await f.bridge.tick();
    expect(viewOf(f).pondDetail).toBeUndefined();
    expect(viewOf(f).pondOrder).toBeUndefined();
    f.bridge.stop();
  });

  const setup = async () => {
    calls.length = 0;
    const f = fixture({ native: makeNative(), session: sessionIn });
    await f.pair();
    await presence(f, { caps: ["ponds2"] });
    await f.bridge.tick();
    return f;
  };
  const run = async (f: Awaited<ReturnType<typeof setup>>, id: string, overrides: Record<string, unknown>) => {
    await f.store.set(`${f.channel}/commands/${id}`, f.pondCommand(overrides));
    await f.bridge.tick();
    return f.result(id) as { status: string; reason?: string };
  };

  it("hides and shows a pond through the host, by its project key", async () => {
    const f = await setup();
    expect(await run(f, "a", {})).toEqual({ id: "a", status: "sent" });
    expect(await run(f, "b", { hidden: false, pondId: "p-old" })).toEqual({ id: "b", status: "sent" });
    expect(calls).toEqual([
      ["hide", "proj-shop", true],
      ["hide", "proj-docs", false],
    ]);
    f.bridge.stop();
  });

  it("orders ponds manually or back to newest", async () => {
    const f = await setup();
    expect(
      await run(f, "a", { op: "order", pondId: undefined, hidden: undefined, ids: ["proj-shop", "proj-docs"] }),
    ).toMatchObject({ status: "sent" });
    expect(await run(f, "b", { op: "order", pondId: undefined, hidden: undefined, mode: "newest" })).toMatchObject({
      status: "sent",
    });
    expect(calls).toEqual([
      ["order", { ids: ["proj-shop", "proj-docs"] }],
      ["order", { mode: "newest" }],
    ]);
    f.bridge.stop();
  });

  it("refuses unknown ponds, bad shapes, long or duplicate lists, and extra fields", async () => {
    const f = await setup();
    const order = { op: "order", pondId: undefined, hidden: undefined };
    const bad: Array<[string, Record<string, unknown>]> = [
      ["unknown hide", { pondId: "nope" }],
      ["hide not boolean", { hidden: "yes" }],
      ["hide no pond", { pondId: 5 }],
      ["unknown op", { op: "delete" }],
      ["extra field", { extra: 1 }],
      ["hide with ids", { ids: ["proj-shop"] }],
      ["order unknown id", { ...order, ids: ["proj-shop", "ghost"] }],
      ["order non-string", { ...order, ids: ["proj-shop", 4] }],
      ["order dup", { ...order, ids: ["proj-shop", "proj-shop"] }],
      ["order too many", { ...order, ids: Array.from({ length: 201 }, (_, i) => `k${i}`) }],
      ["order no ids", { ...order }],
      ["order bad mode", { ...order, mode: "oldest" }],
      ["order mode and ids", { ...order, mode: "newest", ids: ["proj-shop"] }],
      ["order with pondId", { op: "order", ids: ["proj-shop"] }],
      ["wrong version", { v: 2 }],
    ];
    for (const [index, [name, overrides]] of bad.entries()) {
      const result = await run(f, `c${index}`, overrides);
      expect(result.status, name).toBe("refused");
    }
    expect(calls).toEqual([]);
    f.bridge.stop();
  });

  it("keeps the usual checks: bad signature, expiry and replayed nonce", async () => {
    const f = await setup();
    const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    void other;
    await f.store.set(`${f.channel}/commands/e`, f.pondCommand({ expiresAt: NOW - 1 }));
    await f.bridge.tick();
    expect(f.result("e")).toMatchObject({ status: "refused" });
    const same = f.pondCommand({ nonce: "n".repeat(16) });
    await f.store.set(`${f.channel}/commands/r1`, same);
    await f.bridge.tick();
    await f.store.set(`${f.channel}/commands/r2`, same);
    await f.bridge.tick();
    expect(f.result("r1")).toMatchObject({ status: "sent" });
    expect(f.result("r2")).toMatchObject({ status: "refused" });
    const forged = f.pondCommand();
    await f.store.set(`${f.channel}/commands/f`, { ...forged, sig: "AAAA" });
    await f.bridge.tick();
    expect(f.result("f")).toBeNull();
    expect(calls).toHaveLength(1);
    f.bridge.stop();
  });

  it("refuses when the Mac has no ponds or the host fails", async () => {
    const f = fixture({
      native: makeNative({
        setPondHidden: async () => {
          throw new Error("boom");
        },
      }),
      session: sessionIn,
    });
    await f.pair();
    await f.bridge.tick();
    await f.store.set(`${f.channel}/commands/x`, f.pondCommand());
    await f.bridge.tick();
    expect(f.result("x")).toMatchObject({ status: "refused" });
    f.bridge.stop();
    const none = fixture({ session: sessionIn });
    await none.pair();
    await none.store.set(`${none.channel}/commands/y`, none.pondCommand());
    await none.bridge.tick();
    expect(none.result("y")).toMatchObject({ status: "refused" });
    none.bridge.stop();
  });
});

describe("RemoteBridge generic chats (add-on split)", () => {
  const presence = (f: ReturnType<typeof fixture>, caps?: string[]) =>
    f.store.set(`${f.channel}/state/presence`, { box: seal(f.payload.k, { at: NOW, ...(caps ? { caps } : {}) }) });
  const native = (overrides: Partial<FleetSession> = {}) =>
    session({
      key: "squeak:n1",
      source: "squeak",
      origin: "squeak",
      sourceId: "n1",
      conductorSessionId: null,
      hostId: undefined,
      cwd: "/w",
      ...overrides,
    } as Partial<FleetSession>);
  const hosted = (overrides: Partial<FleetSession> = {}) =>
    session({ hostId: "conductor", hostSessionId: "s1", rules: { label: "Conductor" }, ...overrides });
  const viewOf = (f: ReturnType<typeof fixture>) => f.bridge.phoneView() as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  it("names the enabled add-ons, and says nothing on a Mac that does not know", async () => {
    expect(viewOf(fixture({ addons: ["conductor"] })).addons).toEqual(["conductor"]);
    expect(viewOf(fixture({ addons: [] })).addons).toEqual([]);
    expect(viewOf(fixture())).not.toHaveProperty("addons");
  });

  it("gives a host chat its handle, its actions and its source, and keeps conductorSessionId", () => {
    const f = fixture({
      session: hosted(),
      closer: { close: () => "closed" },
      renamer: { rename: () => true },
      diff: { readSummary: async () => null, readFilePatch: async () => null },
      transcript: () => ({ messages: [] }),
    });
    const [row] = viewOf(f).sessions;
    expect(row).toMatchObject({
      sessionId: "s1",
      conductorSessionId: "s1",
      source: { id: "conductor", label: "Conductor" },
    });
    expect(row.actions).toEqual(["reply", "stop", "rename", "close", "queue", "photos", "diff"]);
  });

  it("derives actions from what this Mac can do, not from the chat's source alone", () => {
    const f = fixture({ session: hosted(), stopOutcome: "none", queue: "none" });
    const [row] = viewOf(f).sessions;
    expect(row.actions).toEqual(["reply", "photos"]);
  });

  it("gives a Squeak chat reply and diff only, addressed by its fleet key", () => {
    const f = fixture({
      session: native(),
      canReply: () => true,
      diff: { readSummary: async () => null, readFilePatch: async () => null },
      closer: { close: () => "closed" },
    });
    const [row] = viewOf(f).sessions;
    expect(row).toMatchObject({ sessionId: "squeak:n1", conductorSessionId: null, source: { id: "squeak" } });
    expect(row.actions).toEqual(["reply", "diff"]);
  });

  it("gives a terminal agent no handle, no actions and no source", () => {
    const f = fixture({
      session: session({ conductorSessionId: null, origin: "terminal" } as Partial<FleetSession>),
      canReply: () => true,
    });
    const [row] = viewOf(f).sessions;
    expect(row).not.toHaveProperty("sessionId");
    expect(row).not.toHaveProperty("actions");
    expect(row).not.toHaveProperty("source");
  });

  it("answers a reply addressed by a Squeak chat's handle, with every check", async () => {
    const f = fixture({ session: native(), canReply: () => true });
    // A Squeak chat has no turn id, and a phone leaves out a turn it does not know.
    f.replier.lastTurnId.mockReturnValue(null as never);
    await f.pair();
    await f.store.set(
      `${f.channel}/commands/n1`,
      f.command({ sessionId: "squeak:n1", answersTurn: undefined as never }),
    );
    await f.bridge.tick();
    expect(f.result("n1")).toMatchObject({ status: "sent" });
    expect(f.sends).toEqual([{ sessionId: "squeak:n1", text: "B" }]);
  });

  it("refuses a reply to a fleet key the phone is not shown or may not reply to", async () => {
    const f = fixture({ session: native(), canReply: () => true });
    await f.pair();
    await f.store.set(`${f.channel}/commands/a`, f.command({ sessionId: "claude-transcript:other" }));
    await f.bridge.tick();
    expect(f.result("a")).toMatchObject({ status: "refused" });
    const quiet = fixture({ session: native(), canReply: () => false });
    await quiet.pair();
    await quiet.store.set(`${quiet.channel}/commands/b`, quiet.command({ sessionId: "squeak:n1" }));
    await quiet.bridge.tick();
    expect(quiet.result("b")).toMatchObject({ status: "refused" });
    expect(f.sends).toEqual([]);
    expect(quiet.sends).toEqual([]);
  });

  it("still checks signature, expiry and repeats for a handle-addressed command", async () => {
    const f = fixture({ session: native(), canReply: () => true });
    await f.pair();
    const stranger = device();
    await f.store.set(`${f.channel}/commands/x`, f.command({ sessionId: "squeak:n1" }, stranger));
    await f.bridge.tick();
    expect(f.store.docs.has(`${f.channel}/results/x`)).toBe(false);
    const stale = f.command({ sessionId: "squeak:n1", expiresAt: NOW - 1 });
    await f.store.set(`${f.channel}/commands/y`, stale);
    await f.bridge.tick();
    expect(f.result("y")).toMatchObject({ status: "refused" });
    const once = f.command({ sessionId: "squeak:n1" });
    await f.store.set(`${f.channel}/commands/z1`, once);
    await f.bridge.tick();
    await f.store.set(`${f.channel}/commands/z2`, once);
    await f.bridge.tick();
    expect(f.result("z1")).toMatchObject({ status: "sent" });
    expect(f.result("z2")).toMatchObject({ status: "refused" });
  });

  it("still takes a Conductor id for a host chat (older phones), and the host handle too", async () => {
    const closed: string[] = [];
    const f = fixture({
      session: hosted({ conductorSessionId: "legacy-id", hostSessionId: "host-id" }),
      closer: { close: (id) => (closed.push(id), "closed") },
    });
    await f.pair();
    await f.store.set(
      `${f.channel}/commands/a`,
      f.renameCommand({ kind: "close", title: undefined, sessionId: "legacy-id" }),
    );
    await f.bridge.tick();
    await f.store.set(
      `${f.channel}/commands/b`,
      f.renameCommand({ kind: "close", title: undefined, sessionId: "host-id" }),
    );
    await f.bridge.tick();
    expect(closed).toEqual(["legacy-id", "host-id"]);
  });

  it("sends the new notify spelling and front-app kind only to a phone that names the cap", async () => {
    const notify = {
      state: () => ({ telegram: { finished: "replyable" }, cliq: { finished: "all" } }),
      apply: () => ({ ok: false as const, reason: "no" }),
    };
    const old = fixture({ notify });
    expect(viewOf(old).notify).toEqual({ telegram: { finished: "conductor" }, cliq: { finished: "all" } });
    const fresh = fixture({ notify, streaming: true });
    await fresh.pair();
    await presence(fresh, ["generic-sessions"]);
    await fresh.bridge.tick();
    expect(viewOf(fresh).notify).toEqual({ telegram: { finished: "replyable" }, cliq: { finished: "all" } });
  });

  it("turns a host's front-app kind into groups for a phone that names the cap", async () => {
    const tabs = { app: { id: "x", name: "Conductor" }, kind: "conductor", title: "Conductor", workspaces: [] };
    const controls = {
      state: () => ({}) as never,
      apply: async () => ({ ok: true as const, state: {} as never, tabs }),
    };
    for (const [caps, kind] of [
      [undefined, "conductor"],
      [["generic-sessions"], "groups"],
    ] as const) {
      const f = fixture({ streaming: true });
      Object.assign((f.bridge as unknown as { deps: object }).deps, { controls });
      await f.pair();
      await presence(f, caps as string[] | undefined);
      await f.bridge.tick();
      await f.store.set(
        `${f.channel}/commands/t`,
        f.stopCommand({ kind: "controls", change: { listTabs: true }, answersTurn: undefined }),
      );
      await f.bridge.tick();
      expect((f.result("t") as { tabs?: { kind: string } }).tabs?.kind).toBe(kind);
    }
  });
});
