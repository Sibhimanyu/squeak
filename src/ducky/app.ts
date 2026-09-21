import process from "node:process";

import { FleetController } from "../fleet/fleet-controller.js";
import { createFleetRuntime, type FleetRuntime } from "../fleet/runtime.js";
import { defaultHookInstallPaths, fleetHooksInstalled } from "../fleet/hook-install.js";
import { TelegramClient, isTransientTelegramError, summarizeTelegramError } from "../telegram/client.js";
import type { TelegramConversationTarget, TelegramUpdate } from "../types.js";
import { logger } from "../utils/logger.js";
import { normalizeTelegramCommand } from "../utils/telegram-command.js";
import { splitMarkdown } from "../utils/tg-format.js";
import type { DuckyConfig } from "./config.js";

const COMMANDS = [
  { command: "radar", description: "Show what every agent is doing right now" },
  { command: "mute", description: "Silence alerts for an hour" },
  { command: "unmute", description: "Resume alerts" },
  { command: "hooks", description: "Check whether live signal is wired up" },
  { command: "help", description: "What the duck does" },
];

function helpText(): string {
  return [
    "**Rubber ducky** watches every coding agent on the Mac and pings you when one",
    "of them wants something. It reports; it does not drive. To actually reply to a",
    "session, use Conductor or the conductor-tg bot.",
    "",
    "It messages you when a session:",
    "· is blocked waiting for your approval",
    "· is blocked waiting for an answer",
    "· has finished",
    "",
    "Everything else — errors, sessions running low on context — waits on the radar.",
    "",
    "/radar  what is running right now",
    "/mute  silence for an hour · /unmute  resume",
    "/hooks  check live-signal wiring",
  ].join("\n");
}

/**
 * The rubber ducky: a notification-only daemon with its own bot.
 *
 * Deliberately separate from the bridge. The bridge is a conversation — you
 * navigate it and talk to agents through it. This is a pager, and mixing the
 * two in one chat means status pings bury the conversation and vice versa.
 */
export class DuckyApp {
  private readonly config: DuckyConfig;
  private readonly telegram: TelegramClient;
  private readonly runtime: FleetRuntime;
  private readonly controller: FleetController;
  private lastUpdateId = 0;
  private stopped = false;

  constructor(config: DuckyConfig) {
    this.config = config;
    this.telegram = new TelegramClient(config.botToken);
    this.runtime = createFleetRuntime({
      conductorDbPath: config.conductorDbPath,
      workspacesRoot: config.workspacesRoot,
      defaultFallbackModel: config.defaultFallbackModel,
      defaultPermissionMode: config.defaultPermissionMode,
      stateDbPath: config.dbPath,
      supportDir: config.supportDir,
      hookPort: config.hookPort,
      pollIntervalMs: config.pollIntervalMs,
      activeWindowMs: config.activeWindowMs,
      idleAfterMs: config.idleAfterMs,
      contextPressurePercent: config.contextPressurePercent,
    });

    this.controller = new FleetController({
      telegram: this.telegram,
      store: this.runtime.store,
      monitor: this.runtime.monitor,
      ingress: this.runtime.ingress,
      diff: this.runtime.diff,
      // No control channel: this bot reports and nothing more.
      openConductorSession: null,
      fallbackChatIds: config.allowedChatIds ? Array.from(config.allowedChatIds) : [],
    });
  }

  async start(): Promise<void> {
    await this.controller.start();
    await this.telegram.setMyCommands(COMMANDS).catch((error) => {
      logger.warn("could not publish ducky commands", { error: summarizeTelegramError(error) });
    });

    process.on("SIGINT", () => void this.stop());
    process.on("SIGTERM", () => void this.stop());

    logger.info("rubber ducky started", { hookPort: this.config.hookPort });
    await this.pollLoop();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    await this.controller.stop().catch(() => undefined);
    logger.info("rubber ducky stopped");
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = await this.telegram.getUpdates(this.lastUpdateId + 1, this.config.pollTimeoutSeconds);
        for (const update of updates) {
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (!isTransientTelegramError(error)) {
          logger.error("ducky poll failed", { error: summarizeTelegramError(error) });
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  private authorized(chatId: number): boolean {
    return !this.config.allowedChatIds || this.config.allowedChatIds.has(chatId);
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      const message = update.callback_query.message;
      if (!message || !this.authorized(message.chat.id)) {
        return;
      }
      const location: TelegramConversationTarget = {
        chatId: message.chat.id,
        messageThreadId: message.message_thread_id ?? null,
      };
      await this.telegram.answerCallbackQuery(update.callback_query.id).catch(() => undefined);
      const result = await this.controller.handleCallback(location, update.callback_query.data ?? "");
      if (result.notice) {
        await this.send(location, result.notice);
      }
      return;
    }

    const message = update.message;
    if (!message?.text || !this.authorized(message.chat.id)) {
      return;
    }
    const location: TelegramConversationTarget = {
      chatId: message.chat.id,
      messageThreadId: message.message_thread_id ?? null,
    };

    const command = normalizeTelegramCommand(message.text.trim());
    switch (command) {
      case "/start":
      case "/radar":
      case "/status":
        await this.controller.showRadar(location);
        return;
      case "/mute":
        await this.controller.handleCallback(location, "fleet:mute:60");
        await this.send(location, "Muted for an hour.");
        return;
      case "/unmute":
        await this.controller.handleCallback(location, "fleet:unmute");
        await this.send(location, "Unmuted.");
        return;
      case "/hooks":
        await this.send(location, this.hookStatus());
        return;
      case "/help":
        await this.send(location, helpText());
        return;
      default:
        // Everything that is not a command is a person talking to a pager.
        await this.send(location, "I only report. Try /radar, or /help.");
    }
  }

  private hookStatus(): string {
    const installed = fleetHooksInstalled(defaultHookInstallPaths(this.config.supportDir));
    if (installed) {
      return [
        "**Hooks: installed**",
        `Ingress: 127.0.0.1:${this.config.hookPort}`,
        "",
        "Agents report state as it happens, and permission prompts reach you within a second.",
      ].join("\n");
    }
    return [
      "**Hooks: not installed**",
      `Ingress: 127.0.0.1:${this.config.hookPort}`,
      "",
      `Without them I poll every ${Math.round(this.config.pollIntervalMs / 1000)}s and **cannot see permission prompts at all**.`,
      "",
      "Install with `rubber-ducky install-hooks` on this Mac.",
    ].join("\n");
  }

  private async send(location: TelegramConversationTarget, text: string): Promise<void> {
    for (const chunk of splitMarkdown(text)) {
      await this.telegram
        .sendMessage(location.chatId, chunk, {
          ...(location.messageThreadId !== null ? { message_thread_id: location.messageThreadId } : {}),
        })
        .catch((error) => {
          logger.warn("ducky send failed", { error: summarizeTelegramError(error) });
        });
    }
  }
}
