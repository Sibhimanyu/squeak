import os from "node:os";
import path from "node:path";
import process from "node:process";

import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { CodexAppServerAdapter } from "../adapters/codex-app-server.js";
import { CliqChannel } from "../cliq/channel.js";
import { CliqWebhook } from "../cliq/client.js";
import { CliqRelayInbox } from "../cliq/inbox.js";
import { claudeCliRunner, FleetAssistant } from "../fleet/assistant.js";
import { ClaudeLimitsStore } from "../fleet/claude-limits.js";
import { CLAUDE_PROBE_SCHEMA, CLAUDE_PROBE_SYSTEM, ClaudeLimitsRefresher } from "../fleet/claude-limits-refresh.js";
import { Caffeinator } from "../fleet/caffeinate.js";
import { applyAwakeAction, type AwakeEnd, AwakeSession, readAwakeAction } from "../fleet/awake-session.js";
import { LidSleepGuard, SUDOERS_PATH, sudoersRule } from "../fleet/lid-sleep.js";
import { ensureBackstop } from "../fleet/awake-backstop.js";
import { readPower, type PowerReading } from "../fleet/power-monitor.js";
import { LidActions, readSettings as readLidActionSettings } from "../fleet/lid-actions.js";
import { readPendingAsk, readPendingQuestion } from "../fleet/question.js";
import { AnswerService, answerControl } from "../fleet/answer.js";
import { answerRelayFrom } from "../fleet/answer-relay.js";
import { canTakeMessageNow, FleetController } from "../fleet/fleet-controller.js";
import { SqueakHandsSender } from "../fleet/conductor-ui.js";
import { readActivity } from "../fleet/activity.js";
import { parseChoices } from "../fleet/choices.js";
import { renderUsage } from "../fleet/radar.js";
import { FleetReplyRouter, replyTargetFor } from "../fleet/reply-router.js";
import { ConductorReplier } from "../fleet/session-reply.js";
import { listNewChatWorkspaces, newChatControl } from "../fleet/new-chat.js";
import { ConductorRelayService } from "../fleet/conductor-relay/service.js";
import { SqueakHandsTerminal, TerminalReplier } from "../fleet/terminal-reply.js";
import { FirestoreRest } from "../remote/firestore-rest.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { RemoteBridge } from "../remote/remote-bridge.js";
import { createFleetRuntime, type FleetRuntime } from "../fleet/runtime.js";
import { defaultHookInstallPaths, fleetHooksInstalled } from "../fleet/hook-install.js";
import { TelegramClient, isTransientTelegramError, summarizeTelegramError } from "../telegram/client.js";
import type { TelegramChat, TelegramConversationTarget, TelegramUpdate } from "../types.js";
import { logger } from "../utils/logger.js";
import { normalizeTelegramCommand } from "../utils/telegram-command.js";
import { splitMarkdown } from "../utils/tg-format.js";
import type { SqueakConfig } from "./config.js";
import { channelsControl, TelegramStatus } from "./telegram-status.js";

const COMMANDS = [
  { command: "radar", description: "Show what every agent is doing right now" },
  // /mute still works — it is what the button and the older habit say — but one
  // of the two is enough in the menu.
  { command: "snooze", description: "Silence alerts for an hour" },
  { command: "unmute", description: "Resume alerts" },
  { command: "usage", description: "Codex quota and Claude's estimated cost" },
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
    "/usage  Codex quota and Claude's estimated cost",
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
  private readonly telegram: TelegramClient | null;
  private readonly telegramStatus: TelegramStatus;
  private readonly runtime: FleetRuntime;
  private readonly controller: FleetController;
  private readonly replier: ConductorReplier;
  /** The loopback relay into Conductor's composer; inert until set up. */
  private readonly conductorRelay: ConductorRelayService;
  /** Conductor chats through `replier`, terminal agents typed into; what every Mac-side surface uses. */
  private readonly router: FleetReplyRouter;
  private readonly remote: RemoteBridge | null;
  private readonly cliq: CliqChannel | null;
  /** The Cliq webhook the channel posts through, for one-off notes (an awake session's end). */
  private cliqWebhook: CliqWebhook | null = null;
  /** Plain-language questions from Cliq, answered through the Mac's own `claude`. */
  private readonly assistant: FleetAssistant;
  /** Claude's plan limits, as the assistant's own `claude` runs last reported them. */
  private readonly claudeLimits: ClaudeLimitsStore;
  private readonly claudeRefresher: ClaudeLimitsRefresher;
  /** Keeps the Mac awake while an agent works, and while plugged in (SQUEAK_CAFFEINATE). */
  private readonly caffeinator: Caffeinator;
  /** The user's awake session (menu bar, window, phone); held through the caffeinator. */
  private readonly awake: AwakeSession;
  /** What a closed lid does during a lid session: display off, mute, Low Power Mode, pause chat apps. */
  private readonly lidActions: LidActions;
  private lidRuleTimer: NodeJS.Timeout | null = null;
  private safetyTimer: NodeJS.Timeout | null = null;
  /** The Mac's last battery/heat/lid reading, for the phone; refreshed once a minute. */
  private power: PowerReading | null = null;
  private unwatchCaffeinate: (() => void) | null = null;
  private lastUpdateId = 0;
  private stopped = false;

  constructor(config: SqueakConfig) {
    this.config = config;
    this.caffeinator = new Caffeinator();
    this.awake = new AwakeSession({
      path: path.join(config.supportDir, "keep-awake.json"),
      hold: (on) => this.caffeinator.setKeepAwake(on),
      lid: new LidSleepGuard({ journalPath: path.join(config.supportDir, "lid-journal.json") }),
      onChange: () => this.remote?.changed(),
      onEnd: (end) => this.announceAwakeEnd(end),
    });
    this.lidActions = new LidActions({
      settingsPath: path.join(config.supportDir, "awake-settings.json"),
      journalPath: path.join(config.supportDir, "lid-actions.json"),
      setLowPowerWanted: (wanted) => void this.awake.setLidLowPower(wanted),
      lidSessionOn: () => this.awake.state?.lidStatus === "on",
    });
    this.telegram = config.botToken ? new TelegramClient(config.botToken) : null;
    const telegram = this.telegram;
    this.telegramStatus = new TelegramStatus({
      sender: telegram ? { sendMessage: (chatId, text) => telegram.sendMessage(chatId, text) } : null,
      allowedChatIds: config.allowedChatIds,
      redact: config.botToken ? [config.botToken] : [],
    });
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

    this.conductorRelay = new ConductorRelayService({
      conductorDbPath: config.conductorDbPath,
      statePath: path.join(config.supportDir, "conductor-relay.json"),
    });
    this.replier = new ConductorReplier({
      registry: this.runtime.registry,
      claude: new ClaudeCodeAdapter(config.claudeBin),
      codex: new CodexAppServerAdapter(config.codexBin),
      relay: this.conductorRelay,
      ui: config.handsAppPath ? new SqueakHandsSender(config.handsAppPath) : null,
    });
    this.router = new FleetReplyRouter({
      conductor: this.replier,
      // Typing into Terminal goes through Squeak Hands too, which holds the
      // Automation grant for it; without Hands, terminal agents stay watch-only.
      terminal: config.handsAppPath
        ? new TerminalReplier({ screen: new SqueakHandsTerminal(config.handsAppPath) })
        : null,
      sessions: () => this.runtime.monitor.snapshot.sessions,
    });
    this.runtime.setCanReply((session) => this.router.canReply(session));

    // Answers an agent's pending question or plan, for the Mac app and the phone
    // (docs/answering-questions.md): Conductor's API when it accepts answers,
    // else stop the waiting turn and send the answer as a message.
    const answers = new AnswerService({
      registry: this.runtime.registry,
      relay: answerRelayFrom({
        isReady: () => this.conductorRelay.isReady(),
        send: (args) => this.conductorRelay.send(args),
        request: () => this.conductorRelay.requestFn(),
      }),
      readAsk: (conductorSessionId) => {
        const session = this.runtime.monitor.snapshot.sessions.find(
          (candidate) => candidate.conductorSessionId === conductorSessionId,
        );
        return session?.agent === "claude" && session.transcriptPath ? readPendingAsk(session.transcriptPath) : null;
      },
    });

    // The phone channel, when a Firebase project is configured. Same replier,
    // same busy rules; the bridge adds pairing and signature checks on top.
    this.remote = config.remoteProjectId
      ? new RemoteBridge({
          configPath: path.join(config.supportDir, "remote.json"),
          projectId: config.remoteProjectId,
          // The Realtime Database when configured: streamed, billed by bytes not reads.
          store: config.remoteDatabaseUrl
            ? new RtdbRest(config.remoteDatabaseUrl)
            : new FirestoreRest(config.remoteProjectId),
          databaseUrl: config.remoteDatabaseUrl,
          announce: config.remoteDatabaseUrl ? new FirestoreRest(config.remoteProjectId) : null,
          replier: this.replier,
          snapshot: () => this.runtime.monitor.snapshot,
          onSnapshot: (listener) => this.runtime.monitor.onSnapshot(listener),
          activity: (session) => (session.transcriptPath ? readActivity(session.agent, session.transcriptPath) : null),
          question: (session) =>
            session.agent === "claude" && session.transcriptPath ? readPendingQuestion(session.transcriptPath) : null,
          liveActivity: (session, limit, stepChars) =>
            session.transcriptPath ? readActivity(session.agent, session.transcriptPath, limit, { stepChars }) : null,
          verbose: config.remoteVerbose,
          // The phone's "what changed": the same reader Telegram's diff pages use.
          diff: this.runtime.diff,
          claudeLimits: () => this.claudeLimits?.latest() ?? null,
          // The phone's Refresh on Usage: the same once-a-minute refresher as the Mac's button.
          refreshUsage: () => this.claudeRefresher.refresh(),
          awake: {
            state: () => this.awake.state,
            lidReady: () => this.awake.lidReady,
            power: () => (this.power ? phonePower(this.power) : null),
            apply: (request) => this.applyAwake(request),
          },
          // A signed phone may start a chat in a listed workspace; the bridge re-reads the list per command.
          answerer: answers,
          newChat: {
            workspaces: () => listNewChatWorkspaces(config.conductorDbPath, 20),
            start: (args) =>
              newChatControl({ conductorDbPath: config.conductorDbPath, relay: this.conductorRelay }).startChat(args),
          },
        })
      : null;

    // The Mac app answers chats through the same replier as Telegram, over
    // the loopback ingress, gated by the hook token.
    this.runtime.ingress.setControl({
      ...answerControl(answers),
      remote: async (action, deviceId) => {
        const remote = this.remote;
        if (!remote) {
          return { configured: false, available: false };
        }
        switch (action) {
          case "status":
            return { available: true, ...(remote.status() as object) };
          case "pair":
            return remote.startPairing();
          case "approve":
            return { ok: deviceId ? await remote.approve(deviceId) : false };
          case "reject":
            return { ok: deviceId ? await remote.reject(deviceId) : false };
          case "revoke":
            return { ok: deviceId ? remote.revoke(deviceId) : false };
          case "reset":
            remote.reset();
            return { ok: true };
          default:
            return { ok: false };
        }
      },
      ...newChatControl({ conductorDbPath: config.conductorDbPath, relay: this.conductorRelay }),
      ...channelsControl(this.telegramStatus, () => ({
        cliqOneWay: Boolean(config.cliqWebhookUrl),
        cliqTwoWay: Boolean(config.cliqTwoWay),
        phone: this.remote !== null,
      })),
      sessionMessage: (target) => {
        const text = this.router.lastTurnText(target);
        return { text, choices: parseChoices(text) };
      },
      refreshClaudeUsage: () => this.claudeRefresher.refresh(),
      awake: (request) => this.applyAwake(request),
      lidRule: () => {
        const rule = sudoersRule(os.userInfo().username);
        return rule ? { path: SUDOERS_PATH, rule } : null;
      },
      transcript: (target, limit) => this.router.transcript(target, limit),
      activity: (key) => {
        const session = this.runtime.monitor.snapshot.sessions.find((candidate) => candidate.key === key);
        return session?.transcriptPath ? readActivity(session.agent, session.transcriptPath) : { steps: [], total: 0 };
      },
      reply: (target, text, mode) =>
        this.router.send(
          target,
          text,
          (message) => {
            logger.warn("reply from the Mac app failed", { target, message });
          },
          { mode: mode ?? "queue" },
        ),
    });

    this.claudeLimits = new ClaudeLimitsStore(path.join(config.supportDir, "claude-limits.json"));
    this.runtime.setClaudeLimits(() => this.claudeLimits.latest());
    this.runtime.setAwake(() => ({
      state: this.awake.state,
      lidReady: this.awake.lidReady,
      lastEnd: this.awake.lastEnd,
      lidActions: this.lidActions.settings,
      lidClosedNow: this.lidActions.active,
    }));
    const claudeRunner = claudeCliRunner(config.claudeBin, path.join(config.supportDir, "assistant"), (limits) =>
      this.claudeLimits.record(limits),
    );
    this.assistant = new FleetAssistant(claudeRunner);
    // Only the Mac app's Refresh button reaches this: nothing probes on a timer.
    this.claudeRefresher = new ClaudeLimitsRefresher(this.claudeLimits, async () => {
      await claudeRunner({ system: CLAUDE_PROBE_SYSTEM, user: "Reply with: ok", schema: CLAUDE_PROBE_SCHEMA });
    });
    this.cliq = this.createCliq();

    this.controller = new FleetController({
      telegram: this.telegram,
      store: this.runtime.store,
      monitor: this.runtime.monitor,
      ingress: this.runtime.ingress,
      diff: this.runtime.diff,
      // No conversation view to hand a chat to — but a finished chat can be
      // answered in place, which is what the replier is for.
      openConductorSession: null,
      replier: this.router,
      // Telegram buttons only open https links, so the card points at a page
      // on the channel's own Firebase site that hands off to the phone app.
      phoneLink: (conductorSessionId) =>
        this.remote?.hasPairedPhone() && config.remoteProjectId
          ? `https://${config.remoteProjectId}.web.app/open/#s=${encodeURIComponent(conductorSessionId)}`
          : null,
      fallbackChatIds: config.allowedChatIds ? Array.from(config.allowedChatIds) : [],
    });
  }

  async start(): Promise<void> {
    // Before the controller, which starts the monitor: the first push must reach Cliq too.
    this.cliq?.start();
    if (this.config.caffeinate) {
      this.unwatchCaffeinate = this.runtime.monitor.onSnapshot((snapshot) => this.caffeinator.update(snapshot));
    }
    // The user's own switch is honoured even with SQUEAK_CAFFEINATE=off: they asked.
    // Undoes what a previous run left behind (sleep disabled, muted, apps paused) before anything else.
    await this.lidActions.recover();
    await this.awake.restore();
    this.lidActions.start();
    void this.refreshLidRule();
    this.lidRuleTimer = setInterval(() => void this.refreshLidRule(), 10 * 60_000);
    this.lidRuleTimer.unref?.();
    // The safety rules read the battery and heat once a minute while a session runs.
    this.safetyTimer = setInterval(() => void this.checkAwakeSafety(), 60_000);
    this.safetyTimer.unref?.();
    if (this.config.caffeinateOnPower) {
      this.caffeinator.holdOnPower();
    }
    await this.controller.start();
    this.conductorRelay.start();
    this.remote?.start();
    if (this.telegram) {
      await this.startTelegram(this.telegram);
    } else {
      logger.info("telegram is off: no SQUEAK_BOT_TOKEN; the fleet, phone channel and Cliq still run");
    }

    process.on("SIGINT", () => void this.stop());
    process.on("SIGTERM", () => void this.stop());

    logger.info("squeak started", { hookPort: this.config.hookPort });
    if (this.telegram) {
      await this.pollLoop(this.telegram);
    } else {
      // Nothing to poll: stay alive for the ingress, relay and Cliq until stopped.
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (this.stopped) {
            clearInterval(timer);
            resolve();
          }
        }, 1000);
      });
    }
  }

  private async startTelegram(telegram: TelegramClient): Promise<void> {
    if (!this.config.allowedChatIds) {
      logger.warn("SQUEAK_ALLOWED_CHAT_IDS is not set: every chat that messages the bot is trusted");
    }
    try {
      this.telegramStatus.setBot((await telegram.getMe()).username);
    } catch (error) {
      this.telegramStatus.setBot(null);
      this.telegramStatus.pollFailed(summarizeTelegramError(error).message);
    }
    await telegram.setMyCommands(COMMANDS).catch((error) => {
      logger.warn("could not publish squeak commands", { error: summarizeTelegramError(error) });
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.unwatchCaffeinate?.();
    if (this.lidRuleTimer) clearInterval(this.lidRuleTimer);
    if (this.safetyTimer) clearInterval(this.safetyTimer);
    await this.lidActions.stop().catch(() => undefined);
    await this.awake.stop().catch(() => undefined);
    this.caffeinator.stop();
    this.remote?.stop();
    this.cliq?.stop();
    await this.conductorRelay.stop().catch(() => undefined);
    await this.replier.stop().catch(() => undefined);
    await this.controller.stop().catch(() => undefined);
    logger.info("squeak stopped");
  }

  private async applyAwake(request: unknown) {
    // What a closed lid does: { action: "lid-actions", settings: { mute: false, ... } }.
    if ((request as { action?: unknown } | null)?.action === "lid-actions") {
      const settings = (request as { settings?: unknown }).settings;
      if (typeof settings !== "object" || settings === null) {
        return { ok: false as const, reason: "Expected settings." };
      }
      this.lidActions.updateSettings(readLidActionSettings({ ...this.lidActions.settings, ...settings }));
      return { ok: true as const, state: this.awake.state };
    }
    // The Mac app asks after installing or removing the lid rule.
    if ((request as { action?: unknown } | null)?.action === "recheck-lid") {
      await this.refreshLidRule();
      return { ok: true as const, state: this.awake.state };
    }
    const action = readAwakeAction(request);
    if (!action) {
      return { ok: false as const, reason: "Not a request to change the awake session." };
    }
    if (action.kind === "start" && action.lid) {
      await this.refreshLidRule();
    }
    const outcome = applyAwakeAction(this.awake, action);
    // A session started on 8% battery should end now, not in a minute.
    if (outcome.ok && action.kind === "start") {
      await this.checkAwakeSafety();
      return { ok: true as const, state: this.awake.state };
    }
    return outcome;
  }

  /** Re-checks the sudoers rule; with it in, makes sure the backstop agent is there too. */
  private async refreshLidRule(): Promise<void> {
    if (!(await this.awake.refreshLidRule())) {
      return;
    }
    await ensureBackstop({
      supportDir: this.config.supportDir,
      journalPath: path.join(this.config.supportDir, "lid-journal.json"),
      actionsPath: path.join(this.config.supportDir, "lid-actions.json"),
    }).catch((error: unknown) => {
      logger.warn("awake backstop failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }

  private async checkAwakeSafety(): Promise<void> {
    const before = JSON.stringify(this.power && phonePower(this.power));
    this.power = await readPower();
    if (JSON.stringify(phonePower(this.power)) !== before) this.remote?.changed();
    if (!this.awake.active) {
      return;
    }
    await this.awake.checkSafety(this.power, this.config.awakeSafety);
  }

  /** A safety rule ended a session: say so wherever the owner hears from Squeak. */
  private announceAwakeEnd(end: AwakeEnd): void {
    if (end.reason !== "battery" && end.reason !== "heat") {
      return;
    }
    const text = `Squeak let your Mac sleep again: ${end.why ?? (end.reason === "heat" ? "it was too hot" : "the battery was low")}.`;
    for (const chatId of this.config.allowedChatIds ?? []) {
      void this.telegram?.sendMessage(chatId, text).catch(() => undefined);
    }
    void this.cliqWebhook?.post(text).catch(() => null);
  }

  private async pollLoop(telegram: TelegramClient): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = await telegram.getUpdates(this.lastUpdateId + 1, this.config.pollTimeoutSeconds);
        this.telegramStatus.pollOk();
        for (const update of updates) {
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          await this.handleUpdate(update);
        }
      } catch (error) {
        this.telegramStatus.pollFailed(summarizeTelegramError(error).message);
        if (!isTransientTelegramError(error)) {
          logger.error("squeak poll failed", { error: summarizeTelegramError(error) });
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  /** A chat that is not allowed is remembered for the app to offer, never acted on. */
  private authorized(chat: TelegramChat): boolean {
    if (this.telegramStatus.isAllowed(chat.id)) {
      return true;
    }
    this.telegramStatus.noteChat(chat);
    return false;
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      const message = update.callback_query.message;
      if (!message || !this.authorized(message.chat)) {
        return;
      }
      const location: TelegramConversationTarget = {
        chatId: message.chat.id,
        messageThreadId: message.message_thread_id ?? null,
      };
      await this.telegram?.answerCallbackQuery(update.callback_query.id).catch(() => undefined);
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
    if (message && !message.text) {
      this.authorized(message.chat);
    }
    if (!message?.text || !this.authorized(message.chat)) {
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
      case "/usage":
        await this.send(
          location,
          renderUsage(await this.runtime.monitor.refresh(), Date.now(), this.claudeLimits.latest()),
        );
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

  /**
   * A bad URL turns Cliq off rather than failing startup: launchd would
   * restart the daemon in a loop, and Telegram and the duck with it.
   */
  private createCliq(): CliqChannel | null {
    const url = this.config.cliqWebhookUrl;
    if (!url) {
      return null;
    }
    try {
      const webhook = new CliqWebhook(url);
      this.cliqWebhook = webhook;
      const twoWay = this.config.cliqTwoWay;
      return new CliqChannel({
        webhook,
        monitor: this.runtime.monitor,
        store: this.runtime.store,
        claudeLimits: () => this.claudeLimits.latest(),
        inbound: twoWay
          ? {
              inbox: new CliqRelayInbox({
                // Streamed from the Realtime Database when configured, still
                // reading Firestore for handlers pasted before the move.
                store: this.config.remoteDatabaseUrl
                  ? new RtdbRest(this.config.remoteDatabaseUrl)
                  : new FirestoreRest(twoWay.projectId),
                legacy: this.config.remoteDatabaseUrl ? new FirestoreRest(twoWay.projectId) : null,
                relayId: twoWay.relayId,
                secret: twoWay.relaySecret,
                seen: this.runtime.store,
              }),
              replier: this.router,
              ownerId: twoWay.ownerId,
              ownerEmail: twoWay.ownerEmail,
              hookStatus: () => this.hookStatus(),
              ask: (question) =>
                this.assistant.ask(question, {
                  snapshot: this.runtime.monitor.snapshot,
                  lastTurnText: (session) => {
                    try {
                      return this.router.lastTurnText(replyTargetFor(session));
                    } catch {
                      return null;
                    }
                  },
                  activity: (session) =>
                    session.transcriptPath ? readActivity(session.agent, session.transcriptPath) : null,
                  canAnswer: (session) => canTakeMessageNow(session, this.router),
                  claudeLimits: this.claudeLimits.latest(),
                  nowMs: Date.now(),
                }),
              sessions: () => this.runtime.monitor.snapshot.sessions,
            }
          : null,
      });
    } catch (error) {
      logger.warn("cliq disabled", { error: error instanceof Error ? error.message : String(error) });
      return null;
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
    const telegram = this.telegram;
    if (!telegram) {
      return;
    }
    for (const chunk of splitMarkdown(text)) {
      await telegram
        .sendMessage(location.chatId, chunk, {
          ...(location.messageThreadId !== null ? { message_thread_id: location.messageThreadId } : {}),
        })
        .catch((error) => {
          logger.warn("squeak send failed", { error: summarizeTelegramError(error) });
        });
    }
  }
}

/** What the phone shows of the Mac's power: whole percent and watts, so a reading does not republish every minute. */
function phonePower(reading: PowerReading) {
  return {
    percent: reading.percent,
    onBattery: reading.onBattery,
    watts: reading.watts == null ? null : Math.round(reading.watts),
    lidClosed: reading.lidClosed ?? null,
  };
}
