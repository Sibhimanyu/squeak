import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PhoneClient } from "./phone.js";
import { logger } from "../../utils/logger.js";
import { ConductorRelayService } from "./service.js";

/**
 * The service must be inert and never throw when the user has not set it up:
 * that is what makes it safe to ship into the always-on daemon.
 */
describe("ConductorRelayService fail-safe", () => {
  let dir: string;
  let dbPath: string;
  let statePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-svc-"));
    dbPath = path.join(dir, "conductor.db");
    statePath = path.join(dir, "conductor-relay.json");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.close();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const setOverride = (value: string) => {
    const db = new Database(dbPath);
    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)").run("roundhouse_client_url_override", value);
    db.close();
  };

  it("stays inert with no override and no state", () => {
    const svc = new ConductorRelayService({ conductorDbPath: dbPath, statePath });
    expect(() => svc.start()).not.toThrow();
    expect(svc.isReady()).toBe(false);
  });

  it("stays inert when the override is the real cloud URL", () => {
    setOverride("https://api.conductor.build");
    fs.writeFileSync(statePath, JSON.stringify({ credentials: { deviceId: "d", deviceToken: "t" } }));
    const svc = new ConductorRelayService({ conductorDbPath: dbPath, statePath });
    svc.start();
    expect(svc.isReady()).toBe(false);
  });

  it("stays inert when local override is set but no device is paired", () => {
    setOverride("http://127.0.0.1:8788");
    const svc = new ConductorRelayService({ conductorDbPath: dbPath, statePath });
    svc.start();
    expect(svc.isReady()).toBe(false);
  });

  it("send before ready returns a soft failure, not a throw", async () => {
    const svc = new ConductorRelayService({ conductorDbPath: dbPath, statePath });
    const r = await svc.send({ workspaceId: "w", sessionId: "s", text: "hi" });
    expect(r).toEqual({ ok: false, reason: "relay not connected" });
  });

  it("missing conductor.db does not throw", () => {
    const svc = new ConductorRelayService({ conductorDbPath: path.join(dir, "nope.db"), statePath });
    expect(() => svc.start()).not.toThrow();
    expect(svc.isReady()).toBe(false);
  });
});

describe("ConductorRelayService queue", () => {
  const ID = "0f4c8a52-3c1e-4b9e-9a57-6f0e2d1c7b31";
  const OTHER = "1a2b3c4d-0000-4000-8000-000000000000";
  const state = {
    generation: 7,
    messages: [
      {
        messageId: OTHER,
        deliveryPayload: { message: "second" },
        mode: "queue",
        position: 2,
        revision: 0,
        deliveryStatus: "pending",
      },
      {
        messageId: ID,
        deliveryPayload: { message: "first" },
        mode: "steer",
        position: 1,
        revision: 3,
        deliveryStatus: "pending",
      },
      {
        messageId: "c",
        deliveryPayload: { message: "on its way" },
        mode: "queue",
        position: 0,
        revision: 0,
        deliveryStatus: "claimed",
      },
    ],
  };

  /** A service with a connected client stand-in, without a relay or a database. */
  function connected(client: Partial<PhoneClient>) {
    const svc = new ConductorRelayService({ conductorDbPath: "/nonexistent", statePath: "/nonexistent" });
    (svc as unknown as { client: Partial<PhoneClient> }).client = client;
    return svc;
  }

  it("lists only messages still waiting, in queue order", async () => {
    const svc = connected({ pendingMessages: async () => ({ status: 200, state }) });
    expect(await svc.queue("ws", "s1")).toEqual({
      ok: true,
      items: [
        { id: ID, text: "first", mode: "steer", position: 1 },
        { id: OTHER, text: "second", mode: "queue", position: 2 },
      ],
    });
  });

  it("stops a turn through Conductor's own stop route", async () => {
    const request = vi.fn(async () => ({ status: 200, headers: {}, body: "{}" }));
    const svc = connected({ request } as unknown as Partial<PhoneClient>);
    expect(await svc.stopTurn("ws 1", "s1")).toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      target: "/workspaces/ws%201/sessions/s1/stop",
      headers: { "content-type": "application/json" },
      body: {},
    });
    const refused = connected({
      request: async () => ({ status: 500, headers: {}, body: "" }),
    } as unknown as Partial<PhoneClient>);
    expect(await refused.stopTurn("ws", "s1")).toEqual({ ok: false, reason: "relay HTTP 500" });
  });

  it("promotes and cancels with the revision and generation it reads itself", async () => {
    const promote = vi.fn(async () => ({ status: 200, headers: {}, body: "{}" }));
    const cancel = vi.fn(async () => ({ status: 200, headers: {}, body: "{}" }));
    const svc = connected({
      pendingMessages: async () => ({ status: 200, state }),
      promoteMessage: promote,
      cancelMessage: cancel,
    });
    expect(await svc.promote("ws", "s1", ID)).toEqual({ ok: true });
    expect(await svc.cancel("ws", "s1", OTHER)).toEqual({ ok: true });
    expect(promote).toHaveBeenCalledWith({
      workspaceLocalId: "ws",
      sessionId: "s1",
      messageId: ID,
      expectedRevision: 3,
      expectedGeneration: 7,
    });
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ messageId: OTHER, expectedRevision: 0 }));
  });

  it("refuses a message that is not waiting any more, without writing", async () => {
    const promote = vi.fn();
    const svc = connected({ pendingMessages: async () => ({ status: 200, state }), promoteMessage: promote });
    expect(await svc.promote("ws", "s1", "c")).toEqual({ ok: false, reason: "not in the queue" });
    expect(await svc.promote("ws", "s1", "gone")).toEqual({ ok: false, reason: "not in the queue" });
    expect(promote).not.toHaveBeenCalled();
  });

  it("is a soft failure before it is connected, and when Conductor refuses", async () => {
    const svc = new ConductorRelayService({ conductorDbPath: "/nonexistent", statePath: "/nonexistent" });
    expect(await svc.queue("ws", "s1")).toEqual({ ok: false, reason: "relay not connected" });
    const refusing = connected({
      pendingMessages: async () => ({ status: 200, state }),
      cancelMessage: async () => ({ status: 409, headers: {}, body: "{}" }),
    });
    expect(await refusing.cancel("ws", "s1", ID)).toEqual({ ok: false, reason: "relay HTTP 409" });
  });

  it("refuses a caller's message id that is not a lowercase UUID, and passes a good one", async () => {
    const sendChatMessage = vi.fn(async () => ({ status: 200, headers: {}, body: "{}" }));
    const svc = connected({ sendChatMessage });
    expect(await svc.send({ workspaceId: "ws", sessionId: "s1", text: "hi", messageId: ID.toUpperCase() })).toEqual({
      ok: false,
      reason: "invalid message id",
    });
    expect(await svc.send({ workspaceId: "ws", sessionId: "s1", text: "hi", messageId: ID })).toEqual({ ok: true });
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    expect(sendChatMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: ID }));
  });
});

describe("ConductorRelayService startChat while the relay reconnects", () => {
  const start = { workspaceId: "w1", agent: "claude" as const, text: "hello" };

  it("waits for Conductor's host to come back and then starts the chat", async () => {
    vi.useFakeTimers();
    try {
      const svc = new ConductorRelayService({ conductorDbPath: "/nonexistent", statePath: "/nonexistent" });
      const startChat = vi.fn().mockResolvedValue({ status: 200, body: "" });
      const pending = svc.startChat(start);
      await vi.advanceTimersByTimeAsync(1_000);
      (svc as unknown as { client: Partial<PhoneClient> }).client = { startChat };
      await vi.advanceTimersByTimeAsync(500);
      const res = await pending;
      expect(res.ok).toBe(true);
      expect(startChat).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still fails with the relay reason when it never comes back", async () => {
    vi.useFakeTimers();
    try {
      const svc = new ConductorRelayService({ conductorDbPath: "/nonexistent", statePath: "/nonexistent" });
      const pending = svc.startChat(start);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(await pending).toEqual({ ok: false, reason: "Conductor's relay isn't connected" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ConductorRelayService host connection (0.92 diagnostics)", () => {
  const conn = (client: Partial<PhoneClient>) => {
    const closers: Array<(i: { code: number; reason: string }) => void> = [];
    const close = vi.fn();
    return {
      conn: {
        client: client as PhoneClient,
        close,
        onClose: (cb: (i: { code: number; reason: string }) => void) => closers.push(cb),
      },
      close,
      drop: () => closers.forEach((cb) => cb({ code: 1006, reason: "gone" })),
    };
  };
  const make = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-host-"));
    const svc = new ConductorRelayService({
      conductorDbPath: path.join(dir, "x.db"),
      statePath: path.join(dir, "state.json"),
      stepTimeoutMs: 40,
    });
    (svc as unknown as { credentials: unknown }).credentials = { deviceId: "d", deviceToken: "t" };
    return { svc, onHost: (c: unknown) => (svc as unknown as { onHost(c: unknown): Promise<void> }).onHost(c) };
  };

  afterEach(() => vi.restoreAllMocks());

  it("becomes ready after handshake and auth, and not ready once the host socket closes", async () => {
    const { svc, onHost } = make();
    const c = conn({ handshake: async () => {}, authenticate: async () => {} });
    await onHost(c.conn);
    expect(svc.isReady()).toBe(true);
    c.drop();
    expect(svc.isReady()).toBe(false);
  });

  it("a stale connection closing does not clear a newer one", async () => {
    const { svc, onHost } = make();
    const first = conn({ handshake: async () => {}, authenticate: async () => {} });
    await onHost(first.conn);
    const second = conn({ handshake: async () => {}, authenticate: async () => {} });
    await onHost(second.conn);
    first.drop();
    expect(svc.isReady()).toBe(true);
  });

  it("times out a handshake that never answers, warns with a short reason and closes the socket", async () => {
    const warn = vi.spyOn(logger, "warn");
    const { svc, onHost } = make();
    const c = conn({ handshake: () => new Promise(() => {}) });
    await onHost(c.conn);
    expect(svc.isReady()).toBe(false);
    expect(c.close).toHaveBeenCalledWith("timeout");
    expect(warn).toHaveBeenCalledWith(
      "conductor relay auth failed",
      expect.objectContaining({ step: "handshake", error: expect.stringMatching(/handshake timed out/) }),
    );
  });

  it("times out an authentication that never answers", async () => {
    const warn = vi.spyOn(logger, "warn");
    const { onHost } = make();
    const c = conn({ handshake: async () => {}, authenticate: () => new Promise(() => {}) });
    await onHost(c.conn);
    expect(warn).toHaveBeenCalledWith(
      "conductor relay auth failed",
      expect.objectContaining({ step: "authentication" }),
    );
  });

  it("warns on an untested Conductor version and says so for a tested one, without leaking anything else", () => {
    const warn = vi.spyOn(logger, "warn");
    const info = vi.spyOn(logger, "info");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ver-"));
    const run = (version: string | undefined) => {
      const svc = new ConductorRelayService({
        conductorDbPath: path.join(dir, "x.db"),
        statePath: path.join(dir, "s.json"),
        conductorVersion: () => version,
      });
      (svc as unknown as { logConductorVersion(): void }).logConductorVersion();
    };
    run("0.92.0");
    expect(info).toHaveBeenCalledWith(expect.stringContaining("tested against"), { version: "0.92.0" });
    run("0.93.0");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("newer or older"),
      expect.objectContaining({ version: "0.93.0" }),
    );
    run(undefined);
    expect(info).toHaveBeenCalledWith(expect.stringContaining("could not read"));
  });

  it("says once when Conductor never dials in", async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.spyOn(logger, "warn");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-nohost-"));
      const svc = new ConductorRelayService({
        conductorDbPath: path.join(dir, "x.db"),
        statePath: path.join(dir, "s.json"),
        noHostWarnMs: 1000,
      });
      (svc as unknown as { armNoHostWatchdog(): void }).armNoHostWatchdog();
      await vi.advanceTimersByTimeAsync(1500);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("no host connection from Conductor"));
      await svc.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
