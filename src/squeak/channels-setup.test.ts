import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { logger } from "../utils/logger.js";
import { ChannelsSetup, LINK_WINDOW_MS } from "./channels-setup.js";
import { TelegramStatus } from "./telegram-status.js";

const TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_0123456789";
const HOOK = "https://cliq.zoho.in/api/v2/bots/squeak/incoming?zapikey=SECRETZAPIKEY123";
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(options: { env?: string; sender?: boolean; allowed?: number[] | null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channels-setup-"));
  dirs.push(dir);
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, options.env ?? "# mine\nOTHER=1\n");
  const sendMessage = vi.fn(async () => undefined);
  const status = new TelegramStatus({
    sender: options.sender === false ? null : { sendMessage },
    allowedChatIds: options.allowed === null || options.allowed === undefined ? null : new Set(options.allowed),
    redact: [TOKEN],
  });
  let now = 1_000_000;
  const restart = vi.fn();
  const channels = new ChannelsSetup({
    envPath,
    namesPath: path.join(dir, "telegram-chats.json"),
    status,
    live: () => ({ cliqOneWay: false, cliqTwoWay: false }),
    restart,
    now: () => now,
    restartDelayMs: 10,
  });
  return { channels, envPath, status, restart, sendMessage, dir, advance: (ms: number) => (now += ms) };
}
const env = (p: string) => fs.readFileSync(p, "utf8");

describe("ChannelsSetup (Telegram)", () => {
  it("saves a valid token to .env (0600), keeps other lines, restarts once, and never shows it", async () => {
    const t = setup();
    expect(await t.channels.telegram({ token: TOKEN })).toMatchObject({ ok: true });
    expect(env(t.envPath)).toContain(`SQUEAK_BOT_TOKEN=${TOKEN}`);
    expect(env(t.envPath)).toContain("# mine");
    expect(fs.statSync(t.envPath).mode & 0o777).toBe(0o600);
    await t.channels.telegram({ token: TOKEN });
    await new Promise((r) => setTimeout(r, 30));
    expect(t.restart).toHaveBeenCalledTimes(1);
    const view = JSON.stringify(t.channels.state());
    expect(view).not.toContain(TOKEN);
    expect(view).not.toContain("ABCdef");
    expect(t.channels.state()).toMatchObject({ telegram: { tokenSet: true, open: true }, restarting: true });
  });

  it("refuses a bad token, and every malformed or extra-key change, writing nothing", async () => {
    const t = setup();
    const before = env(t.envPath);
    const bad: unknown[] = [
      { token: "nope" },
      { token: 5 },
      { token: `${TOKEN}\nSQUEAK_REMOTE_SHARED=1` },
      { token: TOKEN, off: true },
      {},
      null,
      [],
      "token",
      { off: false },
      { off: true },
      { link: 5 },
      { link: "5" },
      { link: 0 },
      { link: 1.5 },
      { unlink: 7 },
      { test: 1 },
      { startLink: false },
      { weird: true },
    ];
    for (const change of bad) {
      expect(await t.channels.telegram(change)).toMatchObject({ ok: false });
    }
    expect(env(t.envPath)).toBe(before);
    expect(t.restart).not.toHaveBeenCalled();
  });

  it("links only a chat that messaged the bot while linking was open, and names it", async () => {
    const t = setup({ env: `SQUEAK_BOT_TOKEN=${TOKEN}\n`, allowed: null });
    expect(await t.channels.telegram({ link: 42 })).toMatchObject({ ok: false });
    expect(await t.channels.telegram({ startLink: true })).toMatchObject({ ok: true });
    t.status.noteChat({ id: 42, type: "private", first_name: "Ada" });
    expect((t.channels.state().telegram as { linking: { candidates: unknown[] } }).linking.candidates).toEqual([
      { id: 42, name: "Ada", type: "private" },
    ]);
    expect(await t.channels.telegram({ link: 99 })).toMatchObject({ ok: false });
    expect(await t.channels.telegram({ link: 42 })).toMatchObject({ ok: true });
    expect(env(t.envPath)).toContain("SQUEAK_ALLOWED_CHAT_IDS=42");
    expect(t.channels.state()).toMatchObject({
      telegram: { chats: [{ id: 42, name: "Ada" }], open: false, linking: null },
    });
  });

  it("closes the link window after 10 minutes and on stopLink", async () => {
    const t = setup({ env: `SQUEAK_BOT_TOKEN=${TOKEN}\n`, allowed: [1] });
    await t.channels.telegram({ startLink: true });
    t.status.noteChat({ id: 42, type: "private", first_name: "Ada" });
    t.advance(LINK_WINDOW_MS + 1);
    expect((t.channels.state().telegram as { linking: unknown }).linking).toBeNull();
    expect(await t.channels.telegram({ link: 42 })).toMatchObject({ ok: false });
    await t.channels.telegram({ startLink: true });
    await t.channels.telegram({ stopLink: true });
    expect((t.channels.state().telegram as { linking: unknown }).linking).toBeNull();
  });

  it("will not start linking without a token", async () => {
    const t = setup({ sender: false });
    expect(await t.channels.telegram({ startLink: true })).toMatchObject({ ok: false });
  });

  it("unlinks one chat but never the last (that would open the bot to anyone)", async () => {
    const t = setup({ env: `SQUEAK_BOT_TOKEN=${TOKEN}\nSQUEAK_ALLOWED_CHAT_IDS=1,2\n`, allowed: [1, 2] });
    expect(await t.channels.telegram({ unlink: 3 })).toMatchObject({ ok: false });
    expect(await t.channels.telegram({ unlink: 1 })).toMatchObject({ ok: true });
    expect(env(t.envPath)).toContain("SQUEAK_ALLOWED_CHAT_IDS=2");
    expect(await t.channels.telegram({ unlink: 2 })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("another chat"),
    });
  });

  it("turns off by removing the token only, and says so when it was never set", async () => {
    const t = setup({ env: `OTHER=1\nSQUEAK_BOT_TOKEN=${TOKEN}\nSQUEAK_ALLOWED_CHAT_IDS=5\n` });
    expect(await t.channels.telegram({ off: true })).toMatchObject({ ok: true });
    expect(env(t.envPath)).toBe("OTHER=1\nSQUEAK_ALLOWED_CHAT_IDS=5\n");
    const none = setup();
    expect(await none.channels.telegram({ off: true })).toMatchObject({ ok: false });
  });

  it("sends a test to the linked chats and records how it went, with the token redacted", async () => {
    const t = setup({ env: `SQUEAK_BOT_TOKEN=${TOKEN}\nSQUEAK_ALLOWED_CHAT_IDS=1\n`, allowed: [1] });
    expect(await t.channels.telegram({ test: true })).toMatchObject({ ok: true, message: "Sent to 1 chat." });
    expect(t.sendMessage).toHaveBeenCalledTimes(1);
    t.sendMessage.mockRejectedValueOnce(new Error(`failed for bot${TOKEN} ${TOKEN}`));
    const failed = await t.channels.telegram({ test: true });
    expect(failed.ok).toBe(false);
    expect(JSON.stringify([failed, t.channels.state()])).not.toContain(TOKEN);
    expect(JSON.stringify(failed)).not.toContain("ABCdef");
  });
});

describe("ChannelsSetup (Cliq)", () => {
  it("saves a Zoho webhook, never shows it, and refuses everything else", () => {
    const t = setup();
    expect(t.channels.cliq({ webhook: HOOK })).toMatchObject({ ok: true });
    expect(env(t.envPath)).toContain(`SQUEAK_CLIQ_WEBHOOK_URL=${HOOK}`);
    const view = JSON.stringify(t.channels.state());
    expect(view).not.toContain("SECRETZAPIKEY");
    expect(view).not.toContain("zapikey");
    expect(t.channels.state()).toMatchObject({ cliq: { webhookSet: true } });
    const before = env(t.envPath);
    for (const change of [
      { webhook: "http://cliq.zoho.in/x?zapikey=1" },
      { webhook: "https://evil.example.com/x?zapikey=1" },
      { webhook: "https://cliq.zoho.com.evil.io/x?zapikey=1" },
      { webhook: "https://cliq.zoho.in/x" },
      { webhook: `${HOOK}\nSQUEAK_REMOTE_SHARED=1` },
      { webhook: 3 },
      { webhook: HOOK, removeWebhook: true },
      { removeWebhook: false },
      { owner: { email: "a@b.co" } },
      { owner: { email: "a@b.co", id: "1", extra: 1 } },
      { owner: { email: "not an email", id: null } },
      { owner: { email: "a@b.co", id: "x y" } },
      { owner: { email: 5, id: null } },
      { owner: "a@b.co" },
      {},
      null,
      { nope: 1 },
    ]) {
      expect(t.channels.cliq(change)).toMatchObject({ ok: false });
    }
    expect(env(t.envPath)).toBe(before);
  });

  it("sets and clears the owner, and removes the webhook", () => {
    const t = setup({ env: `SQUEAK_CLIQ_WEBHOOK_URL=${HOOK}\nSQUEAK_CLIQ_OWNER_EMAIL=old@x.com\n` });
    expect(t.channels.cliq({ owner: { email: "me@zoho.com", id: "12345" } })).toMatchObject({ ok: true });
    expect(t.channels.state()).toMatchObject({ cliq: { ownerEmail: "me@zoho.com", ownerId: "12345" } });
    expect(t.channels.cliq({ owner: { email: null, id: null } })).toMatchObject({ ok: true });
    expect(t.channels.state()).toMatchObject({ cliq: { ownerEmail: null, ownerId: null } });
    expect(t.channels.cliq({ removeWebhook: true })).toMatchObject({ ok: true });
    expect(env(t.envPath)).not.toContain("WEBHOOK");
    expect(t.channels.cliq({ removeWebhook: true })).toMatchObject({ ok: false });
  });
});

describe("ChannelsSetup logging", () => {
  it("never logs a secret", async () => {
    const spies = [vi.spyOn(logger, "info"), vi.spyOn(logger, "warn"), vi.spyOn(logger, "error")];
    const t = setup();
    await t.channels.telegram({ token: TOKEN });
    t.channels.cliq({ webhook: HOOK });
    const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("SECRETZAPIKEY");
  });
});
