import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HookIngressServer } from "../fleet/hook-ingress.js";
import { loadSqueakConfig } from "./config.js";
import { channelsControl, TelegramStatus, TEST_MESSAGE } from "./telegram-status.js";

const BOT_TOKEN = "123456789:SECRET-bot-token-value";
const CLIQ_SECRET = "cliq-relay-secret-xyz";
const servers: HookIngressServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.stop();
  }
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function harness(status: TelegramStatus) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-channels-"));
  const tokenPath = path.join(dir, "hook-token");
  const port = await freePort();
  const server = new HookIngressServer({ port, tokenPath, onEvent: () => undefined });
  await server.start();
  servers.push(server);
  server.setControl({
    sessionMessage: () => ({}),
    reply: async () => ({}),
    ...channelsControl(status, () => ({ cliqOneWay: true, cliqTwoWay: false, phone: true })),
  });
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  return { base: `http://127.0.0.1:${port}`, auth: { "x-squeak-token": token } };
}

describe("config without a bot token", () => {
  it("loads, with Telegram off", () => {
    const keys = ["SQUEAK_BOT_TOKEN", "SQUEAK_ENV_PATH"];
    const saved = keys.map((key) => process.env[key]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-config-"));
    fs.writeFileSync(path.join(dir, ".env"), "# nothing yet\n");
    delete process.env.SQUEAK_BOT_TOKEN;
    process.env.SQUEAK_ENV_PATH = path.join(dir, ".env");
    try {
      expect(loadSqueakConfig().botToken).toBeNull();
    } finally {
      keys.forEach((key, index) => {
        if (saved[index] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[index];
        }
      });
    }
  });
});

describe("channel control routes", () => {
  type Send = (chatId: number, text: string) => Promise<unknown>;
  const make = (send: Send | null, ids = [1, 2]) =>
    new TelegramStatus({
      sender: send ? { sendMessage: send } : null,
      allowedChatIds: new Set(ids),
      redact: [BOT_TOKEN],
    });

  it("require the token and send no CORS header", async () => {
    const { base, auth } = await harness(make(null));
    for (const [method, route] of [
      ["GET", "/control/channels"],
      ["GET", "/control/telegram/candidates"],
      ["POST", "/control/telegram/test"],
    ] as const) {
      expect((await fetch(base + route, { method })).status).toBe(403);
      const ok = await fetch(base + route, { method, headers: auth });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect((await fetch(`${base}/control/channels`, { method: "POST", headers: auth })).status).toBe(405);
    expect((await fetch(`${base}/control/telegram/test`, { headers: auth })).status).toBe(405);
  });

  it("report shapes without secrets", async () => {
    const status = make(async () => 1);
    status.setBot("squeak_bot");
    status.pollFailed(`getUpdates failed for https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`);
    const { base, auth } = await harness(status);
    const text = await (await fetch(`${base}/control/channels`, { headers: auth })).text();
    const body = JSON.parse(text);
    expect(body).toEqual({
      telegram: {
        configured: true,
        polling: "error",
        lastError: expect.any(String),
        botUsername: "squeak_bot",
        allowedChatIds: [1, 2],
        open: false,
      },
      cliq: { oneWay: true, twoWay: false },
      phone: { enabled: true },
    });
    for (const secret of [BOT_TOKEN, "SECRET-bot-token-value", CLIQ_SECRET]) {
      expect(text).not.toContain(secret);
    }
  });

  it("reports off and open states", async () => {
    const off = await harness(new TelegramStatus({ sender: null, allowedChatIds: null }));
    const offBody = await (await fetch(`${off.base}/control/channels`, { headers: off.auth })).json();
    expect(offBody.telegram).toMatchObject({ configured: false, polling: "off", open: false, allowedChatIds: [] });
    const open = new TelegramStatus({ sender: { sendMessage: async () => 1 }, allowedChatIds: null });
    expect(open.telegramStatus().open).toBe(true);
  });

  it("records only unauthorized chats, newest first, capped at 10", async () => {
    const status = make(null, [1]);
    status.noteChat({ id: 1, type: "private", first_name: "Allowed" });
    for (let id = 100; id < 112; id += 1) {
      status.noteChat({ id, type: "group", title: `g${id}` });
    }
    status.noteChat({ id: 200, type: "private", first_name: "Ada", last_name: "L" });
    status.noteChat({ id: 201, type: "private", username: "bob" });
    const { base, auth } = await harness(status);
    const { chats } = await (await fetch(`${base}/control/telegram/candidates`, { headers: auth })).json();
    expect(chats).toHaveLength(10);
    expect(chats[0]).toMatchObject({ id: 201, name: "@bob", type: "private" });
    expect(chats[1]).toMatchObject({ id: 200, name: "Ada L" });
    expect(chats.some((chat: { id: number }) => chat.id === 1)).toBe(false);
    expect(Date.parse(chats[0].at)).not.toBeNaN();
  });

  it("test-send goes to every allowed chat via the client", async () => {
    const sent: Array<[number, string]> = [];
    const { base, auth } = await harness(
      make(async (chatId, text) => {
        sent.push([chatId, text]);
      }),
    );
    const result = await (await fetch(`${base}/control/telegram/test`, { method: "POST", headers: auth })).json();
    expect(result).toEqual({ ok: true, sentTo: 2, reason: null });
    expect(sent).toEqual([
      [1, TEST_MESSAGE],
      [2, TEST_MESSAGE],
    ]);
  });

  it("test-send reports failures and an unconfigured bot", async () => {
    const failing = make(async (chatId) => {
      if (chatId === 2) {
        throw new Error(`boom ${BOT_TOKEN}`);
      }
    });
    const result = await failing.sendTest();
    expect(result).toMatchObject({ ok: false, sentTo: 1 });
    expect(result.reason).not.toContain(BOT_TOKEN);
    const none = await new TelegramStatus({ sender: null, allowedChatIds: null }).sendTest();
    expect(none).toEqual({ ok: false, sentTo: 0, reason: "Telegram is not set up" });
  });
});
