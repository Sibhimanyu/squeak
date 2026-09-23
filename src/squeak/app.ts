import process from "node:process";

import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { CodexAppServerAdapter } from "../adapters/codex-app-server.js";
import { FleetController } from "../fleet/fleet-controller.js";
import { SqueakHandsSender } from "../fleet/conductor-ui.js";
import { ConductorReplier } from "../fleet/session-reply.js";
import { createFleetRuntime, type FleetRuntime } from "../fleet/runtime.js";
import { defaultHookInstallPaths, fleetHooksInstalled } from "../fleet/hook-install.js";
import { TelegramClient, isTransientTelegramError, summarizeTelegramError } from "../telegram/client.js";
import type { TelegramConversationTarget, TelegramUpdate } from "../types.js";
import { logger } from "../utils/logger.js";
import { normalizeTelegramCommand } from "../utils/telegram-command.js";
import { splitMarkdown } from "../utils/tg-format.js";
import type { SqueakConfig } from "./config.js";

const COMMANDS = [
  { command: "radar", description: "Show what every agent is doing right now" },
  // /mute still works — it is what the button and the older habit say — but one
  // of the two is enough in the menu.
  { command: "snooze", description: "Silence alerts for an hour" },
  { command: "unmute", description: "Resume alerts" },
  { command: "hooks", description: "Check whether live signal is wired up" },
  { command: "help", description: "What Squeak does" },
];

function helpText(): string {
  return [
    "**Squeak** watches every coding agent on the Mac and squeaks when one of them",
    "wants something.",
    "",
    "It messages you when a session:",
    "· is blocked waiting for your approval",
    "· is blocked waiting for an answer",
    "· is a Conductor chat and has finished",
    "",
    "**Answering a finished Conductor chat**",
    "· tap a letter when it asked you to pick one",
    "· tap Reply, or swipe left on the card, and type",
    "It is typed into Conductor's own window, so it shows there live. If the",
    "Mac is locked or the chat is not open as a tab, it runs in the background",
    "instead and Conductor shows it on its next reload. Either way the answer",
    "comes back here as a new card.",
    "",
    "Everything else — errors, sessions running low on context — waits on the radar.",
    "",
    "/radar  what is running right now",
    "/snooze  silence for an hour · /unmute  resume",
    "/hooks  check live-signal wiring",
  ].join("\n");
}

/**
 * Squeak: a notification-only daemon with its own bot.
 *
 * Deliberately separate from the bridge. The bridge is a conversation — you
 * navigate it and talk to agents through it. This is a pager, and mixing the
 * two in one chat means status pings bury the conversation and vice versa.
 */
export class SqueakApp {
  private readonly config: SqueakConfig;
  private readonly telegram: TelegramClient;
  private readonly runtime: FleetRuntime;
  private readonly controller: FleetController;
  private readonly replier: ConductorReplier;
  private lastUpdateId = 0;
  private stopped = false;

  constructor(config: SqueakConfig) {
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
      codexQuotaWarnPercent: config.codexQuotaWarnPercent,
    });

    this.replier = new ConductorReplier({
      registry: this.runtime.registry,
      claude: new ClaudeCodeAdapter(config.claudeBin),
      codex: new CodexAppServerAdapter(config.codexBin),
      ui: config.handsAppPath ? new SqueakHandsSender(config.handsAppPath) : null,
    });

    this.controller = new FleetController({
      telegram: this.telegram,
      store: this.runtime.store,
      monitor: this.runtime.monitor,
      ingress: this.runtime.ingress,
      diff: this.runtime.diff,
      // No conversation view to hand a chat to — but a finished chat can be
      // answered in place, which is what the replier is for.
      openConductorSession: null,
      replier: this.replier,
      fallbackChatIds: config.allowedChatIds ? Array.from(config.allowedChatIds) : [],
    });
  }

  async start(): Promise<void> {
    await this.controller.start();
    await this.telegram.setMyCommands(COMMANDS).catch((error) => {
      logger.warn("could not publish squeak commands", { error: summarizeTelegramError(error) });
    });

    process.on("SIGINT", () => void this.stop());
    process.on("SIGTERM", () => void this.stop());

    logger.info("squeak started", { hookPort: this.config.hookPort });
    await this.pollLoop();
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    await this.replier.stop().catch(() => undefined);
    await this.controller.stop().catch(() => undefined);
    logger.info("squeak stopped");
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
          logger.error("squeak poll failed", { error: summarizeTelegramError(error) });
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
      const result = await this.controller.handleCallback(
        location,
        update.callback_query.data ?? "",
        message.message_id,
      );
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

    // A swipe-reply to a card, or text typed into a Reply prompt, is an answer
    // for that card's chat — even if it happens to start with a slash.
    const replyTo = message.reply_to_message?.message_id;
    if (replyTo !== undefined && (await this.controller.handleReplyMessage(location, replyTo, message.text))) {
      return;
    }

    const command = normalizeTelegramCommand(message.text.trim());
    switch (command) {
      case "/start":
      case "/radar":
      case "/status":
        await this.controller.showRadar(location);
        return;
      case "/snooze":
      case "/mute":
        await this.controller.handleCallback(location, "fleet:mute:60");
        await this.send(location, "Snoozed for an hour.");
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
        // Loose text has no addressee: there may be several chats waiting, and
        // guessing which one it was for would put words in the wrong chat.
        await this.send(
          location,
          replyTo !== undefined
            ? "That message is not one I can answer through. Reply to a card, or tap its Reply button."
            : "To answer a chat, swipe left on its card and reply, or tap Reply. /radar shows what is running.",
        );
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
      "Install with `squeak install-hooks` on this Mac.",
    ].join("\n");
  }

  private async send(location: TelegramConversationTarget, text: string): Promise<void> {
    for (const chunk of splitMarkdown(text)) {
      await this.telegram
        .sendMessage(location.chatId, chunk, {
          ...(location.messageThreadId !== null ? { message_thread_id: location.messageThreadId } : {}),
        })
        .catch((error) => {
          logger.warn("squeak send failed", { error: summarizeTelegramError(error) });
        });
    }
  }
}
