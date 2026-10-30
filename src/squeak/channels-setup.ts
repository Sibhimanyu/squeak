import fs from "node:fs";
import path from "node:path";

import { parseCliqWebhookUrl } from "../cliq/client.js";
import { setEnvValues } from "../cliq/setup.js";
import { logger } from "../utils/logger.js";
import type { TelegramStatus } from "./telegram-status.js";

/**
 * Telegram and Cliq setup from the phone (docs/remote-channel.md, "Channel setup from a phone"). The Mac app writes the
 * same `.env` keys itself (`ChannelsModel`); this is the daemon's own writer for the signed `telegram` and `cliq`
 * phone commands, with the same keys, the same validation rules (the Cliq host list is the daemon's own) and the same
 * restart, because the daemon reads `.env` only at start.
 *
 * Secrets (the bot token, the webhook URL) arrive only in a request, go only into `.env` (0600), and are never logged,
 * returned, held after the write or put in `state()`. Every answer is a fixed sentence.
 */

export const TOKEN_KEY = "SQUEAK_BOT_TOKEN";
export const ALLOWED_KEY = "SQUEAK_ALLOWED_CHAT_IDS";
export const WEBHOOK_KEY = "SQUEAK_CLIQ_WEBHOOK_URL";
export const EMAIL_KEY = "SQUEAK_CLIQ_OWNER_EMAIL";
export const OWNER_ID_KEY = "SQUEAK_CLIQ_OWNER_ID";

/** How long the "link a chat" window shows who messaged the bot. */
export const LINK_WINDOW_MS = 10 * 60_000;
/** The daemon restarts this long after a save, so the command's answer is written first. */
export const RESTART_DELAY_MS = 4_000;

export type SetupOutcome = { ok: true; message: string } | { ok: false; reason: string };

const BOT_TOKEN = /^\d{3,20}:[A-Za-z0-9_-]{20,80}$/;
const OWNER_EMAIL = /^[^\s@"'#\\]{1,64}@[^\s@"'#\\]{1,200}$/;
const OWNER_ID = /^[A-Za-z0-9_.-]{1,64}$/;

export function isBotToken(value: string): boolean {
  return BOT_TOKEN.test(value);
}

/** What `.env` says, for the keys this owns. */
function readEnvValues(envPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = fs.readFileSync(envPath, "utf8");
  } catch {
    return out;
  }
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const at = line.indexOf("=");
    if (at <= 0) continue;
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, at).trim()] = value;
  }
  return out;
}

/** Remove the uncommented `KEY=` lines for these keys, keeping every other line as it was. */
function removeEnvKeys(envPath: string, keys: string[]): void {
  if (!fs.existsSync(envPath)) return;
  const kept = fs
    .readFileSync(envPath, "utf8")
    .split("\n")
    .filter((raw) => {
      const line = raw.trim().replace(/^export\s+/, "");
      const key = /^([A-Za-z0-9_]+)\s*=/.exec(line)?.[1];
      return !(key && keys.includes(key));
    });
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  fs.writeFileSync(envPath, kept.length ? `${kept.join("\n")}\n` : "", { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
}

function onlyKey(change: unknown): { key: string; value: unknown } | null {
  if (typeof change !== "object" || change === null || Array.isArray(change)) return null;
  const keys = Object.keys(change);
  if (keys.length !== 1) return null;
  return { key: keys[0]!, value: (change as Record<string, unknown>)[keys[0]!] };
}

function chatId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value !== 0 ? value : null;
}

export interface ChannelsSetupOptions {
  envPath: string;
  /** Where chat names are remembered (`telegram-chats.json`; names only, no secret). */
  namesPath: string;
  status: TelegramStatus;
  /** What is running now (the env may be ahead of it until the restart). */
  live: () => { cliqOneWay: boolean; cliqTwoWay: boolean };
  /** Called once, {@link RESTART_DELAY_MS} after the first change that needs a restart. */
  restart: () => void;
  now?: () => number;
  restartDelayMs?: number;
}

export class ChannelsSetup {
  private linkUntil = 0;
  private restartPending = false;
  private lastTest: { at: string; ok: boolean; sentTo: number; reason: string | null } | null = null;
  private testing = false;

  constructor(private readonly options: ChannelsSetupOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The non-secret view for a phone: set or not, never a value. */
  state(): Record<string, unknown> {
    const env = readEnvValues(this.options.envPath);
    const ids = this.allowedFromEnv(env);
    const names = this.readNames();
    const status = this.options.status.telegramStatus();
    const linking = this.now() < this.linkUntil && status.configured;
    const live = this.options.live();
    return {
      telegram: {
        tokenSet: (env[TOKEN_KEY] ?? "").trim() !== "",
        bot: status.botUsername,
        polling: status.polling,
        lastError: status.lastError,
        chats: ids.map((id) => ({ id, name: names[String(id)] ?? null })),
        open: (env[TOKEN_KEY] ?? "").trim() !== "" && ids.length === 0,
        linking: linking
          ? {
              until: new Date(this.linkUntil).toISOString(),
              candidates: this.options.status
                .candidateList()
                .chats.filter((chat) => !ids.includes(chat.id))
                .map((chat) => ({ id: chat.id, name: chat.name, type: chat.type })),
            }
          : null,
        testing: this.testing,
        lastTest: this.lastTest,
      },
      cliq: {
        webhookSet: (env[WEBHOOK_KEY] ?? "").trim() !== "",
        ownerEmail: (env[EMAIL_KEY] ?? "").trim() || null,
        ownerId: (env[OWNER_ID_KEY] ?? "").trim() || null,
        oneWay: live.cliqOneWay,
        twoWay: live.cliqTwoWay,
      },
      restarting: this.restartPending,
    };
  }

  /** One Telegram change; exactly one key. */
  async telegram(change: unknown): Promise<SetupOutcome> {
    const one = onlyKey(change);
    if (!one) return { ok: false, reason: "Not a Telegram setting this Mac understands." };
    const env = readEnvValues(this.options.envPath);
    const tokenSet = (env[TOKEN_KEY] ?? "").trim() !== "";
    switch (one.key) {
      case "token": {
        if (typeof one.value !== "string" || !isBotToken(one.value.trim())) {
          return {
            ok: false,
            reason: "That doesn't look like a bot token. It is a number, a colon, then letters and digits.",
          };
        }
        return this.write(
          { [TOKEN_KEY]: one.value.trim() },
          [],
          "Saved. The Squeak service restarts for a few seconds.",
        );
      }
      case "off": {
        if (one.value !== true) return { ok: false, reason: "Not a Telegram setting this Mac understands." };
        if (!tokenSet) return { ok: false, reason: "Telegram is not set up." };
        return this.write({}, [TOKEN_KEY], "Telegram is off. Your linked chats are kept.");
      }
      case "startLink": {
        if (one.value !== true) return { ok: false, reason: "Not a Telegram setting this Mac understands." };
        if (!this.options.status.configured) {
          return { ok: false, reason: "Save the bot token first, so Squeak can hear the bot." };
        }
        this.linkUntil = this.now() + LINK_WINDOW_MS;
        return { ok: true, message: "Send any message to the bot, then pick the chat." };
      }
      case "stopLink": {
        if (one.value !== true) return { ok: false, reason: "Not a Telegram setting this Mac understands." };
        this.linkUntil = 0;
        return { ok: true, message: "Done." };
      }
      case "link": {
        const id = chatId(one.value);
        if (id === null) return { ok: false, reason: "Not a chat this Mac understands." };
        // Only a chat that has messaged the bot while linking was open: a phone can't allow a chat nobody saw.
        const seen =
          this.now() < this.linkUntil ? this.options.status.candidateList().chats.find((c) => c.id === id) : undefined;
        if (!seen)
          return { ok: false, reason: "That chat hasn't messaged the bot. Start linking, then send it a message." };
        const ids = this.allowedFromEnv(env);
        if (!ids.includes(id)) ids.push(id);
        this.rememberName(id, seen.name);
        this.linkUntil = 0;
        return this.write(
          { [ALLOWED_KEY]: ids.join(",") },
          [],
          "Linked. The Squeak service restarts for a few seconds.",
        );
      }
      case "unlink": {
        const id = chatId(one.value);
        if (id === null) return { ok: false, reason: "Not a chat this Mac understands." };
        const ids = this.allowedFromEnv(env);
        if (!ids.includes(id)) return { ok: false, reason: "That chat isn't linked." };
        if (ids.length === 1) {
          // With none left the bot would answer anyone who finds it.
          return { ok: false, reason: "Link another chat first, or turn Telegram off." };
        }
        return this.write(
          { [ALLOWED_KEY]: ids.filter((other) => other !== id).join(",") },
          [],
          "Removed. The Squeak service restarts for a few seconds.",
        );
      }
      case "test": {
        if (one.value !== true) return { ok: false, reason: "Not a Telegram setting this Mac understands." };
        if (this.testing) return { ok: false, reason: "A test is already on its way." };
        this.testing = true;
        try {
          const result = await this.options.status.sendTest();
          this.lastTest = {
            at: new Date(this.now()).toISOString(),
            ok: result.ok,
            sentTo: result.sentTo,
            reason: result.reason,
          };
          return result.ok
            ? { ok: true, message: `Sent to ${result.sentTo} chat${result.sentTo === 1 ? "" : "s"}.` }
            : { ok: false, reason: result.reason ? `Not sent: ${result.reason}` : "Not sent." };
        } finally {
          this.testing = false;
        }
      }
      default:
        return { ok: false, reason: "Not a Telegram setting this Mac understands." };
    }
  }

  /** One Cliq change; exactly one key. */
  cliq(change: unknown): SetupOutcome {
    const one = onlyKey(change);
    if (!one) return { ok: false, reason: "Not a Cliq setting this Mac understands." };
    const env = readEnvValues(this.options.envPath);
    switch (one.key) {
      case "webhook": {
        if (typeof one.value !== "string" || /[^\u0021-\u007e]/.test(one.value.trim())) {
          return {
            ok: false,
            reason: "That should be an https link on zoho.com, like the one in the bot's webhook settings.",
          };
        }
        try {
          parseCliqWebhookUrl(one.value);
        } catch {
          return {
            ok: false,
            reason: "That should be an https link on zoho.com, like the one in the bot's webhook settings.",
          };
        }
        return this.write(
          { [WEBHOOK_KEY]: one.value.trim() },
          [],
          "Saved. The Squeak service restarts for a few seconds.",
        );
      }
      case "removeWebhook": {
        if (one.value !== true) return { ok: false, reason: "Not a Cliq setting this Mac understands." };
        if ((env[WEBHOOK_KEY] ?? "").trim() === "") return { ok: false, reason: "Zoho Cliq is not set up." };
        return this.write({}, [WEBHOOK_KEY], "Removed. The Squeak service restarts for a few seconds.");
      }
      case "owner": {
        const owner = one.value;
        if (
          typeof owner !== "object" ||
          owner === null ||
          Array.isArray(owner) ||
          Object.keys(owner).sort().join(",") !== "email,id"
        ) {
          return { ok: false, reason: "Not a Cliq setting this Mac understands." };
        }
        const { email, id } = owner as { email: unknown; id: unknown };
        const cleanEmail = typeof email === "string" ? email.trim() : email === null ? "" : null;
        const cleanId = typeof id === "string" ? id.trim() : id === null ? "" : null;
        if (cleanEmail === null || cleanId === null) {
          return { ok: false, reason: "Not a Cliq setting this Mac understands." };
        }
        if (cleanEmail !== "" && !OWNER_EMAIL.test(cleanEmail)) {
          return { ok: false, reason: "That doesn't look like an email address." };
        }
        if (cleanId !== "" && !OWNER_ID.test(cleanId)) {
          return { ok: false, reason: "A Cliq user ID is letters, digits, dots, dashes and underscores." };
        }
        return this.write(
          {
            ...(cleanEmail ? { [EMAIL_KEY]: cleanEmail } : {}),
            ...(cleanId ? { [OWNER_ID_KEY]: cleanId } : {}),
          },
          [...(cleanEmail ? [] : [EMAIL_KEY]), ...(cleanId ? [] : [OWNER_ID_KEY])],
          "Saved. The Squeak service restarts for a few seconds.",
        );
      }
      default:
        return { ok: false, reason: "Not a Cliq setting this Mac understands." };
    }
  }

  private allowedFromEnv(env: Record<string, string>): number[] {
    return (env[ALLOWED_KEY] ?? "")
      .split(",")
      .map((part) => Number.parseInt(part.trim(), 10))
      .filter((id) => Number.isSafeInteger(id));
  }

  private write(set: Record<string, string>, remove: string[], message: string): SetupOutcome {
    try {
      if (remove.length > 0) removeEnvKeys(this.options.envPath, remove);
      if (Object.keys(set).length > 0) {
        fs.mkdirSync(path.dirname(this.options.envPath), { recursive: true, mode: 0o700 });
        setEnvValues(this.options.envPath, set);
      }
    } catch {
      // Fixed words: the error's text could carry a path.
      logger.warn("channel setup could not be saved");
      return { ok: false, reason: "Squeak couldn't save its settings file." };
    }
    logger.info("channel setup saved", { keys: [...Object.keys(set), ...remove] });
    this.scheduleRestart();
    return { ok: true, message };
  }

  private scheduleRestart(): void {
    if (this.restartPending) return;
    this.restartPending = true;
    setTimeout(() => this.options.restart(), this.options.restartDelayMs ?? RESTART_DELAY_MS);
  }

  private readNames(): Record<string, string> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.options.namesPath, "utf8")) as unknown;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
      return Object.fromEntries(
        Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
    } catch {
      return {};
    }
  }

  private rememberName(id: number, name: string): void {
    if (!name) return;
    try {
      const names = this.readNames();
      names[String(id)] = name.slice(0, 120);
      fs.writeFileSync(this.options.namesPath, JSON.stringify(names), { mode: 0o600 });
    } catch {
      // A missing name only shows the id.
    }
  }
}
