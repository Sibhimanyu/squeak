import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { FleetSnapshot } from "../fleet/fleet-monitor.js";
import type { ReplyOutcome } from "../fleet/session-reply.js";
import type { FleetSession } from "../fleet/types.js";
import type { ChannelDoc } from "./firestore-rest.js";
import { LocalAdvertiser, LocalChannelServer, parseDoc, parseTarget } from "./local-channel.js";
import {
  HEADER_MAC,
  HEADER_NONCE,
  HEADER_RESPONSE_MAC,
  HEADER_TS,
  deriveLocalKey,
  localTag,
  macEquals,
  signRequest,
  signResponse,
} from "./local-auth.js";
import { MirrorStore } from "./mirror-store.js";
import { RemoteBridge, type ChannelStore } from "./remote-bridge.js";
import { open, seal } from "./remote-crypto.js";

class MemoryStore implements ChannelStore {
  readonly docs = new Map<string, ChannelDoc>();
  failReads = false;
  async get(p: string) {
    if (this.failReads) throw new Error("offline");
    return this.docs.get(p) ?? null;
  }
  async set(p: string, doc: ChannelDoc) {
    this.docs.set(p, doc);
  }
  async list(collection: string) {
    if (this.failReads) throw new Error("offline");
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

function session(): FleetSession {
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
    lastActivityAt: new Date().toISOString(),
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

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function harness(options: { paired?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-channel-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cloud = new MemoryStore();
  const mirror = new MirrorStore(cloud);
  const sends: Array<{ sessionId: string; text: string }> = [];
  const replier = {
    lastTurnText: () => "Pick one?\nA) Arm now\nB) Later",
    lastTurnId: vi.fn(() => "turn-1"),
    send: vi.fn(async (sessionId: string, text: string) => {
      sends.push({ sessionId, text });
      return { status: "started", via: "conductor" } as ReplyOutcome;
    }),
  };
  const snapshot = {
    sessions: [session()],
    active: [session()],
    attention: [],
    generatedAt: "",
    codexUsage: null,
  } as unknown as FleetSnapshot;
  let server: LocalChannelServer | null = null;
  const bridge = new RemoteBridge({
    configPath: path.join(dir, "remote.json"),
    projectId: "squeak-test",
    store: mirror,
    replier,
    snapshot: () => snapshot,
    localEndpoint: () => server?.endpoint() ?? null,
    onDevicesChanged: () => void server?.refresh(),
    macName: "Test Mac",
  });
  const pairing = bridge.startPairing();
  const payload = JSON.parse(Buffer.from(new URL(pairing.url).searchParams.get("d")!, "base64url").toString()) as {
    c: string;
    k: string;
  };
  const channel = `channels/${payload.c}`;
  const phone = device();
  if (options.paired !== false) {
    await cloud.set(`${channel}/pairing/iphone-1`, { box: seal(payload.k, { name: "iPhone", publicKey: phone.x963 }) });
    await bridge.tick();
    await bridge.approve("iphone-1");
  }
  server = new LocalChannelServer({
    mirror,
    access: () => bridge.localAccess(),
    host: "127.0.0.1",
    port: 0,
    advertiser: null,
    hosts: () => ["192.168.1.20"],
  });
  await server.start();
  cleanups.push(() => server!.stop());
  const baseOf = () => `http://127.0.0.1:${server!.port}`;
  const localKey = deriveLocalKey(payload.k);

  /** A phone's signed request to the local server. */
  async function call(
    method: string,
    target: string,
    options: {
      body?: string;
      headers?: Record<string, string>;
      key?: Buffer;
      ts?: number;
      nonce?: string;
      sign?: boolean;
    } = {},
  ) {
    const body = options.body ?? "";
    const ts = String(options.ts ?? Date.now());
    const nonce = options.nonce ?? crypto.randomBytes(16).toString("hex");
    const headers: Record<string, string> = { ...options.headers };
    if (options.sign !== false) {
      headers[HEADER_TS] = ts;
      headers[HEADER_NONCE] = nonce;
      headers[HEADER_MAC] = signRequest(options.key ?? localKey, { method, target, ts, nonce, body });
    }
    const response = await fetch(`${baseOf()}${target}`, { method, headers, ...(body ? { body } : {}) });
    const text = await response.text();
    const mac = response.headers.get(HEADER_RESPONSE_MAC);
    const verified = mac
      ? macEquals(mac, signResponse(localKey, { nonce, status: response.status, body: Buffer.from(text) }))
      : false;
    return { status: response.status, text, verified, nonce, headers: response.headers };
  }

  const command = (overrides: Record<string, unknown> = {}, signer = phone) => {
    const body = {
      v: 1,
      sessionId: "s1",
      answersTurn: "turn-1",
      text: "B",
      nonce: crypto.randomBytes(16).toString("hex"),
      expiresAt: Date.now() + 60_000,
      ...overrides,
    };
    const box = seal(payload.k, body);
    return { box, sig: signer.sign(box), device: "iphone-1" };
  };

  return { cloud, mirror, bridge, server, call, command, payload, channel, sends, replier, phone, localKey, baseOf };
}

describe("the direct path's server", () => {
  it("answers only requests that carry a valid MAC, and says nothing about why it refused", async () => {
    const h = await harness();
    const target = "/state/snapshot.json";
    expect((await h.call("GET", target, { sign: false })).status).toBe(401);
    expect((await h.call("GET", target, { key: Buffer.alloc(32, 1) })).status).toBe(401);
    // Stamped two minutes ago: outside the window.
    expect((await h.call("GET", target, { ts: Date.now() - 120_000 })).status).toBe(401);
    const refused = await h.call("GET", target, { sign: false });
    expect(refused.text).toBe("");
    const ok = await h.call("GET", target);
    expect(ok.status).toBe(200);
    expect(ok.verified).toBe(true);
  });

  it("refuses a captured request when it is sent again", async () => {
    const h = await harness();
    const nonce = crypto.randomBytes(16).toString("hex");
    const ts = Date.now();
    expect((await h.call("GET", "/state/snapshot.json", { nonce, ts })).status).toBe(200);
    expect((await h.call("GET", "/state/snapshot.json", { nonce, ts })).status).toBe(401);
  });

  it("serves the sealed documents exactly as the bridge wrote them, with a response MAC bound to the request", async () => {
    const h = await harness();
    await h.bridge.tick();
    const cloudDoc = h.cloud.docs.get(`${h.channel}/state/snapshot`)!;
    const local = await h.call("GET", "/state/snapshot.json");
    expect(local.status).toBe(200);
    expect(local.verified).toBe(true);
    expect(JSON.parse(local.text).box).toBe(cloudDoc.box);
    const view = open<{ mac: string; local?: { port: number; hosts: string[]; tag: string } }>(
      h.payload.k,
      JSON.parse(local.text).box,
    );
    expect(view.mac).toBe("Test Mac");
    // The Mac's address and tag ride in the sealed view, for a phone that cannot find it by Bonjour.
    expect(view.local).toEqual({ port: h.server.port, hosts: ["192.168.1.20"], tag: localTag(h.payload.k) });
    // A response MAC made for another request does not verify for this one.
    const other = signResponse(h.localKey, { nonce: "0".repeat(32), status: 200, body: Buffer.from(local.text) });
    expect(
      macEquals(other, signResponse(h.localKey, { nonce: local.nonce, status: 200, body: Buffer.from(local.text) })),
    ).toBe(false);
    expect((await h.call("GET", "/results/nothing.json")).text).toBe("null");
  });

  it("serves nothing outside the channel's own paths, and never lets a phone write what the Mac writes", async () => {
    const h = await harness();
    for (const target of [
      "/pairing/iphone-1.json",
      "/commands.json",
      "/commands/x.json",
      "/media/x-0.json",
      "/state/presence.json",
      "/state/transport.json",
      "/state.json",
      "/..%2f..%2fetc.json",
      "/state/snapshot",
      "/state/snapshot.json?shallow=true",
      `/channels/${h.payload.c}/state/snapshot.json`,
      "/",
    ]) {
      const response = await h.call("GET", target);
      expect([target, response.status]).toEqual([target, 404]);
    }
    const doc = JSON.stringify({ box: "AAAA" });
    for (const target of [
      "/state/snapshot.json",
      "/results/x.json",
      "/live/x.json",
      "/pairing/x.json",
      "/state/alive.json",
    ]) {
      expect([target, (await h.call("PUT", target, { body: doc })).status]).toEqual([target, 404]);
    }
    expect((await h.call("DELETE", "/state/snapshot.json")).status).toBe(404);
    expect((await h.call("DELETE", "/pairing/iphone-1.json")).status).toBe(404);
    expect((await h.call("POST", "/commands/x.json", { body: doc })).status).toBe(401);
  });

  it("accepts only documents the database's own rules would", async () => {
    const h = await harness();
    const put = (body: string) => h.call("PUT", "/commands/c1.json", { body });
    expect((await put("not json")).status).toBe(400);
    expect((await put(JSON.stringify({ box: 5 }))).status).toBe(400);
    expect((await put(JSON.stringify({ box: "A", extra: 1 }))).status).toBe(400);
    expect((await put(JSON.stringify({ box: "A", device: "x".repeat(70) }))).status).toBe(400);
    expect((await put(JSON.stringify(["box"]))).status).toBe(400);
    expect((await h.call("PUT", "/commands/bad.id.json", { body: "{}" })).status).toBe(404);
    expect((await put(JSON.stringify({ box: "A", sig: "B", device: "iphone-1" }))).status).toBe(204);
  });

  it("caps request bodies", async () => {
    const h = await harness();
    const body = JSON.stringify({ box: "A".repeat(1_100_000) });
    const result = await h.call("PUT", "/commands/big.json", { body }).catch(() => ({ status: 413 }));
    expect(result.status).toBe(413);
    expect(h.mirror.tree.get(`${h.channel}/commands/big`)).toBeNull();
  });

  it("refuses a stranger's pile of idle connections before it runs out of descriptors", async () => {
    const h = await harness();
    const port = Number(new URL(h.baseOf()).port);
    const sockets: net.Socket[] = [];
    for (let i = 0; i < 30; i += 1) {
      const socket = net.connect(port, "127.0.0.1");
      socket.on("error", () => undefined);
      sockets.push(socket);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const alive = sockets.filter((socket) => !socket.destroyed).length;
    sockets.forEach((socket) => socket.destroy());
    expect(alive).toBeLessThanOrEqual(12);
    expect(alive).toBeGreaterThan(0);
  });

  it("blocks a client that keeps failing authentication", async () => {
    const h = await harness();
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await h.call("GET", "/state/snapshot.json", { sign: false })).status;
    expect(last).toBe(429);
    // Even a correctly signed request waits out the window for that address.
    expect((await h.call("GET", "/state/snapshot.json")).status).toBe(429);
  });

  it("listens, serves and advertises nothing until a phone is paired", async () => {
    const h = await harness({ paired: false });
    expect(h.server.port).toBeNull();
    expect(h.server.endpoint()).toBeNull();
    await h.cloud.set(`${h.channel}/pairing/iphone-1`, {
      box: seal(h.payload.k, { name: "iPhone", publicKey: h.phone.x963 }),
    });
    await h.bridge.tick();
    await h.bridge.approve("iphone-1");
    await h.server.refresh();
    expect(h.server.port).not.toBeNull();
    expect(h.server.endpoint()?.tag).toBe(localTag(h.payload.k));
  });

  it("closes its port when the last phone is revoked", async () => {
    const h = await harness();
    expect(h.server.port).not.toBeNull();
    h.bridge.revoke("iphone-1");
    await h.server.refresh();
    expect(h.server.port).toBeNull();
    await expect(h.call("GET", "/state/snapshot.json")).rejects.toThrow();
  });

  it("stops serving a channel that was reset, and drops its documents", async () => {
    const h = await harness();
    await h.bridge.tick();
    expect((await h.call("GET", "/state/snapshot.json")).status).toBe(200);
    h.bridge.reset();
    await h.server.refresh();
    // No channel, no listener.
    await expect(h.call("GET", "/state/snapshot.json")).rejects.toThrow();
    expect(h.mirror.tree.size).toBe(0);
  });

  it("serves a new channel's key, not the old one's, after a reset and a new pairing", async () => {
    const h = await harness();
    await h.bridge.tick();
    const oldKey = h.localKey;
    h.bridge.reset();
    const fresh = h.bridge.startPairing();
    const payload = JSON.parse(Buffer.from(new URL(fresh.url).searchParams.get("d")!, "base64url").toString()) as {
      c: string;
      k: string;
    };
    await h.cloud.set(`channels/${payload.c}/pairing/iphone-2`, {
      box: seal(payload.k, { name: "iPhone 2", publicKey: h.phone.x963 }),
    });
    await h.bridge.tick();
    await h.bridge.approve("iphone-2");
    await h.server.refresh();
    expect((await h.call("GET", "/state/snapshot.json", { key: oldKey })).status).toBe(401);
    expect((await h.call("GET", "/state/snapshot.json", { key: deriveLocalKey(payload.k) })).status).toBe(200);
  });

  describe("streams", () => {
    async function openStream(h: Awaited<ReturnType<typeof harness>>, target: string) {
      const ts = String(Date.now());
      const nonce = crypto.randomBytes(16).toString("hex");
      const controller = new AbortController();
      cleanups.push(() => controller.abort());
      const response = await fetch(`${h.baseOf()}${target}`, {
        headers: {
          accept: "text/event-stream",
          [HEADER_TS]: ts,
          [HEADER_NONCE]: nonce,
          [HEADER_MAC]: signRequest(h.localKey, { method: "GET", target, ts, nonce, body: "" }),
        },
        signal: controller.signal,
      });
      return { response, nonce, controller };
    }

    async function nextEvent(reader: ReadableStreamDefaultReader<Uint8Array>, buffer = { text: "" }): Promise<string> {
      const decoder = new TextDecoder();
      while (!buffer.text.includes("\n\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buffer.text += decoder.decode(value);
      }
      const at = buffer.text.indexOf("\n\n");
      const event = buffer.text.slice(0, at);
      buffer.text = buffer.text.slice(at + 2);
      return event;
    }

    it("tells the phone that something changed, never what", async () => {
      const h = await harness();
      const { response, nonce } = await openStream(h, "/state.json");
      expect(response.status).toBe(200);
      expect(
        macEquals(
          response.headers.get(HEADER_RESPONSE_MAC)!,
          signResponse(h.localKey, { nonce, status: 200, body: "" }),
        ),
      ).toBe(true);
      const reader = response.body!.getReader();
      const buffer = { text: "" };
      expect(await nextEvent(reader, buffer)).toBe('event: put\ndata: {"path":"/","data":"changed"}');
      await h.mirror.set(`${h.channel}/state/snapshot`, { box: "SECRETBOX", at: 1 });
      const event = await nextEvent(reader, buffer);
      expect(event).toBe('event: put\ndata: {"path":"/snapshot","data":"changed"}');
      expect(event).not.toContain("SECRETBOX");
      // A write elsewhere does not wake a stream on `state`.
      await h.mirror.set(`${h.channel}/results/r1`, { box: "x" });
      await h.mirror.set(`${h.channel}/state/alive`, { box: "y" });
      expect(await nextEvent(reader, buffer)).toBe('event: put\ndata: {"path":"/alive","data":"changed"}');
    });

    it("needs the MAC, only streams what a phone reads, and caps how many are open", async () => {
      const h = await harness();
      expect((await fetch(`${h.baseOf()}/state.json`, { headers: { accept: "text/event-stream" } })).status).toBe(401);
      expect((await openStream(h, "/commands.json")).response.status).toBe(404);
      expect((await openStream(h, "/pairing.json")).response.status).toBe(404);
      expect((await openStream(h, "/state/presence.json")).response.status).toBe(404);
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await openStream(h, "/results.json")).response.status);
      expect(statuses).toEqual([200, 200, 200, 200, 429, 429]);
    });
  });
});

describe("a command that arrives on the direct path", () => {
  it("runs through every check the cloud's commands do, and its result is visible on both paths", async () => {
    const h = await harness();
    const wake = vi.spyOn(h.bridge as unknown as { wake(): void }, "wake" as never);
    void wake;
    const sent = h.command();
    expect((await h.call("PUT", "/commands/cmd-1.json?print=silent", { body: JSON.stringify(sent) })).status).toBe(204);
    await h.bridge.tick();
    expect(h.sends).toEqual([{ sessionId: "s1", text: "B" }]);
    const local = await h.call("GET", "/results/cmd-1.json");
    const result = open<{ id: string; status: string }>(h.payload.k, JSON.parse(local.text).box);
    expect(result).toMatchObject({ id: "cmd-1", status: "sent" });
    // The same document is in the cloud too.
    const viaCloud = h.cloud.docs.get(`${h.channel}/results/cmd-1`)!;
    expect(viaCloud.box).toBe(JSON.parse(local.text).box);
    // The command is gone from the inbox, and the phone can clear the result it read.
    expect(h.mirror.tree.get(`${h.channel}/commands/cmd-1`)).toBeNull();
    expect((await h.call("DELETE", "/results/cmd-1.json?print=silent")).status).toBe(204);
    expect((await h.call("GET", "/results/cmd-1.json")).text).toBe("null");
  });

  it("is refused when it is not signed by a paired device, or names a stale turn", async () => {
    const h = await harness();
    const stranger = device();
    await h.call("PUT", "/commands/forged.json", { body: JSON.stringify(h.command({}, stranger)) });
    await h.call("PUT", "/commands/stale.json", { body: JSON.stringify(h.command({ answersTurn: "turn-0" })) });
    await h.call("PUT", "/commands/expired.json", {
      body: JSON.stringify(h.command({ expiresAt: Date.now() - 1_000 })),
    });
    await h.bridge.tick();
    expect(h.sends).toEqual([]);
    // An unsigned writer learns nothing; the others hear why.
    expect(h.mirror.tree.get(`${h.channel}/results/forged`)).toBeNull();
    for (const id of ["stale", "expired"]) {
      const result = open<{ status: string }>(h.payload.k, h.mirror.tree.get(`${h.channel}/results/${id}`)!.box);
      expect(result.status).toBe("refused");
    }
  });

  it("is run once when the same command is also written to the cloud, and its result is not overwritten", async () => {
    const h = await harness();
    const sent = h.command();
    await h.call("PUT", "/commands/dup.json", { body: JSON.stringify(sent) });
    await h.cloud.set(`${h.channel}/commands/dup`, sent);
    await h.bridge.tick();
    expect(h.sends).toHaveLength(1);
    // The cloud copy arrives again after the first ran (a retry on the other path).
    await h.cloud.set(`${h.channel}/commands/dup`, sent);
    await h.call("PUT", "/commands/dup.json", { body: JSON.stringify(sent) });
    await h.bridge.tick();
    expect(h.sends).toHaveLength(1);
    const result = open<{ status: string }>(h.payload.k, h.mirror.tree.get(`${h.channel}/results/dup`)!.box);
    expect(result.status).toBe("sent");
  });

  it("is run once, and the second copy refused, when two ids carry the same nonce", async () => {
    const h = await harness();
    const sent = h.command();
    await h.call("PUT", "/commands/one.json", { body: JSON.stringify(sent) });
    await h.cloud.set(`${h.channel}/commands/two`, sent);
    await h.bridge.tick();
    expect(h.sends).toHaveLength(1);
    const second = open<{ status: string; reason: string }>(
      h.payload.k,
      h.mirror.tree.get(`${h.channel}/results/two`)!.box,
    );
    expect(second.status).toBe("refused");
  });

  it("never runs a command the phone took back, and the same command can then go out through the cloud", async () => {
    const h = await harness();
    const sent = h.command();
    await h.call("PUT", "/commands/withdrawn.json", { body: JSON.stringify(sent) });
    expect((await h.call("DELETE", "/commands/withdrawn.json?print=silent")).status).toBe(204);
    await h.bridge.tick();
    expect(h.sends).toEqual([]);
    await h.cloud.set(`${h.channel}/commands/withdrawn`, sent);
    await h.bridge.tick();
    expect(h.sends).toHaveLength(1);
  });

  it("is still read when the cloud cannot be reached", async () => {
    const h = await harness();
    h.cloud.failReads = true;
    await h.call("PUT", "/commands/offline.json", { body: JSON.stringify(h.command()) });
    await h.bridge.tick();
    expect(h.sends).toHaveLength(1);
    expect(h.mirror.tree.get(`${h.channel}/results/offline`)).not.toBeNull();
  });

  it("wakes the bridge by itself when a streaming store is behind it", async () => {
    const wakes: string[] = [];
    const inner: ChannelStore = {
      ...new MemoryStore(),
      get: async () => null,
      set: async () => undefined,
      list: async () => [],
      delete: async () => undefined,
      watch: () => () => undefined,
    };
    const mirror = new MirrorStore(inner);
    mirror.watch!("channels/c/commands", () => wakes.push("woke"));
    mirror.putFromPhone("channels/c/commands/x", { box: "A" });
    mirror.putFromPhone("channels/c/state/presence", { box: "A" });
    expect(wakes).toEqual(["woke"]);
  });

  it("remembers a handled command's id, which hides later copies for a while", async () => {
    let now = 1_000_000;
    const cloud = new MemoryStore();
    const mirror = new MirrorStore(cloud, { now: () => now });
    await cloud.set("channels/c/commands/a", { box: "A" });
    expect((await mirror.list("channels/c/commands")).map((entry) => entry.id)).toEqual(["a"]);
    await mirror.delete("channels/c/commands/a");
    await cloud.set("channels/c/commands/a", { box: "A" });
    expect(await mirror.list("channels/c/commands")).toEqual([]);
    expect(mirror.putFromPhone("channels/c/commands/a", { box: "A" })).toBe(false);
    now += 16 * 60_000;
    expect(await mirror.list("channels/c/commands")).toHaveLength(1);
  });
});

describe("the advertisement", () => {
  function fakeSpawn() {
    const children: Array<EventEmitter & { kill: ReturnType<typeof vi.fn>; unref: () => void; args: string[] }> = [];
    const spawnImpl = vi.fn((_cmd: string, args: string[]) => {
      const child = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: () => undefined, args });
      children.push(child);
      return child;
    });
    return { children, spawnImpl: spawnImpl as unknown as typeof import("node:child_process").spawn };
  }

  it("registers _squeak._tcp with only the tag in its TXT record, restarts if it dies, and stops with the server", async () => {
    vi.useFakeTimers();
    try {
      const { children, spawnImpl } = fakeSpawn();
      const advertiser = new LocalAdvertiser(spawnImpl);
      advertiser.start(51234, "aa85f1343db6bfd6");
      expect(children[0]!.args).toEqual([
        "-R",
        "Squeak",
        "_squeak._tcp",
        "local",
        "51234",
        "t=aa85f1343db6bfd6",
        "v=1",
      ]);
      children[0]!.emit("exit");
      expect(advertiser.running).toBe(false);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(children).toHaveLength(2);
      expect(advertiser.running).toBe(true);
      advertiser.stop();
      expect(children[1]!.kill).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(children).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts when the first phone pairs and moves with a reset channel", async () => {
    const { children, spawnImpl } = fakeSpawn();
    const h = await harness();
    const advertiser = new LocalAdvertiser(spawnImpl);
    const server = new LocalChannelServer({
      mirror: h.mirror,
      access: () => h.bridge.localAccess(),
      host: "127.0.0.1",
      advertiser,
    });
    await server.start();
    cleanups.push(() => server.stop());
    expect(children).toHaveLength(1);
    expect(children[0]!.args.at(-2)).toBe(`t=${localTag(h.payload.k)}`);
    h.bridge.reset();
    server.endpoint();
    expect(children[0]!.kill).toHaveBeenCalled();
  });
});

describe("request targets", () => {
  it("parses only /<kind>[/<id>].json with at most print=silent", () => {
    expect(parseTarget("/state/snapshot.json")).toEqual({ kind: "state", id: "snapshot" });
    expect(parseTarget("/results.json?print=silent")).toEqual({ kind: "results", id: null });
    expect(parseTarget("/a/b/c.json")).toBeNull();
    expect(parseTarget("/a.json?x=1")).toBeNull();
    expect(parseTarget("/a/.json")).toBeNull();
    expect(parseTarget("/../a.json")).toBeNull();
    expect(parseDoc(Buffer.from('{"box":"x","at":1.5}'))).toEqual({ box: "x", at: 1.5 });
  });
});

describe("presence on two transports", () => {
  it("reads whichever path the phone pinged most recently", async () => {
    let now = 1_000_000;
    const cloud = new MemoryStore();
    const mirror = new MirrorStore(cloud, { now: () => now });
    const path = "channels/c/state/presence";
    await cloud.set(path, { box: "cloud-1" });
    expect((await mirror.get(path))?.box).toBe("cloud-1");
    now += 5_000;
    mirror.putFromPhone(path, { box: "local-1" });
    expect((await mirror.get(path))?.box).toBe("local-1");
    now += 20_000;
    await cloud.set(path, { box: "cloud-2" });
    expect((await mirror.get(path))?.box).toBe("cloud-2");
    now += 20_000;
    mirror.putFromPhone(path, { box: "local-2" });
    expect((await mirror.get(path))?.box).toBe("local-2");
  });
});
