import type { TelegramClient } from "../telegram/client.js";
import { isTelegramMessageNotModifiedError } from "../telegram/client.js";
import type { TelegramConversationTarget, TelegramInlineKeyboard } from "../types.js";
import { logger } from "../utils/logger.js";
import { splitMarkdown } from "../utils/tg-format.js";
import { DiffReader, renderDiffSummary, renderFilePatch, type WorkspaceDiff } from "./diff-view.js";
import type { FleetMonitor, FleetSnapshot } from "./fleet-monitor.js";
import type { FleetStore } from "./fleet-store.js";
import type { HookIngressServer } from "./hook-ingress.js";
import { parseChoices, type ParsedChoices } from "./choices.js";
import {
  attentionCardKeyboard,
  cardLabel,
  diffSummaryKeyboard,
  radarKeyboard,
  renderAttentionCard,
  renderQuotaAlert,
  renderRadar,
  sessionLabel,
} from "./radar.js";
import { replyTargetFor } from "./reply-router.js";
import type { ReplyFailureHandler, ReplyOptions, ReplyOutcome } from "./session-reply.js";
import type { AttentionItem, FleetSession } from "./types.js";

/** Radar edits are cheap but not free; Telegram rate-limits edits per chat. */
const RADAR_MIN_EDIT_INTERVAL_MS = 8_000;
const SNOOZE_MS = 60 * 60 * 1000;
/** Paging through a diff should not re-shell git for every tap. */
const DIFF_CACHE_TTL_MS = 60_000;

/**
 * What the controller needs from a replier; narrow so tests can fake it.
 * `target` is `replyTargetFor(session)`: a Conductor chat's id, or a fleet
 * key for a session outside Conductor.
 */
export interface FleetReplier {
  lastTurnText(target: string): string | null;
  send(target: string, text: string, onFailed: ReplyFailureHandler, options?: ReplyOptions): Promise<ReplyOutcome>;
  /** Whether a session outside Conductor can be answered at all. Absent: only Conductor chats can. */
  canReply?(session: FleetSession): boolean;
}

export interface FleetControllerDependencies {
  /** Null when no bot token is set: the fleet still runs, nothing is sent to Telegram. */
  telegram: TelegramClient | null;
  store: FleetStore;
  monitor: FleetMonitor;
  ingress: HookIngressServer | null;
  /**
   * Hand a Conductor session back to the bridge's normal chat flow. Absent
   * for Squeak, which has no conversation view — it answers through
   * `replier` instead.
   */
  openConductorSession?: ((location: TelegramConversationTarget, conductorSessionId: string) => Promise<void>) | null;
  /**
   * Continue a Conductor chat from Telegram. With it, finish cards carry
   * Reply and one button per lettered option, and a swipe-reply to a card is
   * delivered to that chat. Without it the bot only reports.
   */
  replier?: FleetReplier | null;
  /**
   * The https link that opens a Conductor session on the paired phone, or
   * null when no phone is paired (then the button is not offered at all).
   */
  phoneLink?: ((conductorSessionId: string) => string | null) | null;
  /** Chats allowed to use the bridge, used to pick a default push target. */
  fallbackChatIds: number[];
  /** Optional: without it the Diff button is simply never offered. */
  diff?: DiffReader | null;
  now?: () => number;
}

/**
 * Owns the Telegram half of the fleet: one live radar message per subscribed
 * conversation, plus push cards for sessions that are actually blocked.
 *
 * Subscription is implicit — running /radar anywhere anchors a radar there,
 * and anchors double as the push target list. That keeps "where do
 * notifications go" answerable without another setting to configure.
 */
export class FleetController {
  private readonly deps: FleetControllerDependencies;
  private readonly now: () => number;
  private readonly lastRadarText = new Map<string, string>();
  private readonly lastRadarEditAt = new Map<string, number>();
  /**
   * File lists behind the per-file buttons. Callback data only has room for an
   * index, so the list it indexes into has to survive between the two taps.
   */
  private readonly diffCache = new Map<string, { diff: WorkspaceDiff; readAt: number }>();
  private unsubscribe: Array<() => void> = [];

  constructor(deps: FleetControllerDependencies) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** Whether this bot can hand a Conductor chat to a conversation view of its own. */
  private get canDrive(): boolean {
    return Boolean(this.deps.openConductorSession);
  }

  async start(): Promise<void> {
    this.deps.store.init();

    if (this.deps.ingress) {
      try {
        await this.deps.ingress.start();
      } catch (error) {
        // Hooks are an accelerator, not a requirement: without the ingress the
        // monitor still polls. A busy port must not take the bridge down.
        logger.warn("fleet hook ingress failed to start; falling back to polling only", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.unsubscribe.push(
      this.deps.monitor.onSnapshot((snapshot) => {
        void this.refreshRadars(snapshot).catch((error) => {
          logger.warn("fleet radar refresh failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }),
    );
    this.unsubscribe.push(
      this.deps.monitor.onPush((items) => {
        void this.pushAttention(items).catch((error) => {
          logger.warn("fleet push failed", { error: error instanceof Error ? error.message : String(error) });
        });
      }),
    );
    this.unsubscribe.push(
      this.deps.monitor.onQuotaAlert((usage, window) => {
        void this.pushQuotaAlert(usage, window).catch((error) => {
          logger.warn("fleet quota push failed", { error: error instanceof Error ? error.message : String(error) });
        });
      }),
    );

    this.deps.monitor.start();
  }

  /**
   * Account-wide, so unlike an AttentionItem there is no session to attach
   * this to — it goes to the same targets an attention card would, just
   * rendered from renderQuotaAlert instead.
   */
  private async pushQuotaAlert(
    usage: Parameters<Parameters<FleetMonitor["onQuotaAlert"]>[0]>[0],
    window: "primary" | "secondary",
  ): Promise<void> {
    const targets = this.pushTargets();
    if (targets.length === 0) {
      return;
    }
    const text = renderQuotaAlert(usage, window, this.now());
    for (const target of targets) {
      await this.send(target, text);
    }
  }

  async stop(): Promise<void> {
    for (const off of this.unsubscribe) {
      off();
    }
    this.unsubscribe = [];
    this.deps.monitor.stop();
    if (this.deps.ingress) {
      await this.deps.ingress.stop();
    }
    this.deps.store.close();
  }

  /** Anchor (or re-anchor) the radar in this conversation and draw it. */
  async showRadar(location: TelegramConversationTarget): Promise<void> {
    const snapshot = await this.deps.monitor.refresh();
    const text = renderRadar(snapshot, this.now());
    const keyboard = radarKeyboard(snapshot, (key) => this.deps.store.handleFor(key));

    const messageId = await this.tg().sendMessage(location.chatId, text, {
      reply_markup: { inline_keyboard: keyboard },
      disable_web_page_preview: true,
      ...(location.messageThreadId !== null ? { message_thread_id: location.messageThreadId } : {}),
    });

    if (messageId === null) {
      return;
    }

    this.deps.store.setRadarAnchor(location.chatId, location.messageThreadId, messageId);
    this.lastRadarText.set(anchorKey(location.chatId, location.messageThreadId), text);
    this.lastRadarEditAt.set(anchorKey(location.chatId, location.messageThreadId), this.now());
  }

  /**
   * Returns true when the callback belonged to the fleet, so the bridge can
   * fall through to its own handling otherwise.
   */
  async handleCallback(
    location: TelegramConversationTarget,
    data: string,
    /** The message the button was on, so a choice can mark its card as answered. */
    messageId: number | null = null,
  ): Promise<{ handled: boolean; notice?: string }> {
    if (!data.startsWith("fleet:")) {
      return { handled: false };
    }

    const parts = data.split(":");
    const action = parts[1];
    const argument = parts[2];

    switch (action) {
      case "diff":
        await this.showDiff(location, argument, parts[3]);
        return { handled: true };
      case "diffp":
        await this.showDiffPage(location, argument, Number.parseInt(parts[3] ?? "0", 10));
        return { handled: true };
      case "radar":
      case "refresh":
        await this.showRadar(location);
        return { handled: true };
      case "mute": {
        const minutes = Number.parseInt(argument ?? "60", 10);
        const until = new Date(this.now() + (Number.isFinite(minutes) ? minutes : 60) * 60_000).toISOString();
        this.deps.store.setMute("*", until);
        return { handled: true, notice: `Fleet alerts muted for ${Number.isFinite(minutes) ? minutes : 60} minutes.` };
      }
      case "unmute":
        this.deps.store.clearMute("*");
        return { handled: true, notice: "Fleet alerts unmuted." };
      case "open": {
        const session = this.resolveHandle(argument);
        if (!session) {
          return { handled: true, notice: "That session is no longer being tracked." };
        }
        const open = this.deps.openConductorSession;
        if (open && session.conductorSessionId) {
          await open(location, session.conductorSessionId);
          return { handled: true };
        }
        await this.sendExternalSessionDetail(location, session);
        return { handled: true };
      }
      case "reply": {
        const session = this.resolveHandle(argument);
        if (session && this.canAnswer(session)) {
          await this.promptForReply(location, session);
          return { handled: true };
        }
        const open = this.deps.openConductorSession;
        if (!open || !session?.conductorSessionId) {
          return { handled: true, notice: "That session cannot be replied to from here." };
        }
        await open(location, session.conductorSessionId);
        return { handled: true };
      }
      case "pick": {
        const session = this.resolveHandle(argument);
        const letter = parts[3];
        if (!session || !this.canAnswer(session) || !letter || !/^[A-H]$/.test(letter)) {
          return { handled: true, notice: "That session cannot be replied to from here." };
        }
        return this.sendChoice(location, session, letter, messageId);
      }
      case "full": {
        const session = this.resolveHandle(argument);
        if (!session || !this.canAnswer(session)) {
          return { handled: true, notice: "That session is no longer being tracked." };
        }
        await this.sendFullMessage(location, session);
        return { handled: true };
      }
      case "noop":
        return { handled: true };
      case "snooze": {
        const key = this.resolveHandleKey(argument);
        if (!key) {
          return { handled: true, notice: "That session is no longer being tracked." };
        }
        this.deps.store.snooze(key, new Date(this.now() + SNOOZE_MS).toISOString());
        return { handled: true, notice: "Snoozed for an hour." };
      }
      default:
        return { handled: true, notice: "Unknown fleet action." };
    }
  }

  /**
   * A message the user swiped to reply to. Returns false when it was not
   * replying to anything this controller sent, so the caller can say so.
   */
  async handleReplyMessage(
    location: TelegramConversationTarget,
    replyToMessageId: number,
    text: string,
  ): Promise<boolean> {
    const replier = this.deps.replier;
    const target = replier ? this.deps.store.getReplyTarget(location.chatId, replyToMessageId) : null;
    if (!replier || !target) {
      return false;
    }
    const outcome = await replier.send(target.target, text, this.failureNotifier(location, target.label));
    if (outcome.status === "refused" || outcome.status === "unconfirmed") {
      await this.send(location, outcome.reason);
      return true;
    }
    this.afterReplyStarted();
    await this.send(location, deliveredText(`Sent to **${target.label}**`, outcome));
    return true;
  }

  /**
   * One tap on a lettered button sends that letter, which is exactly what the
   * agent asked for. The card's buttons then collapse to a record of the
   * answer, so the same choice cannot be sent twice by a second tap.
   */
  private async sendChoice(
    location: TelegramConversationTarget,
    session: FleetSession,
    letter: string,
    messageId: number | null,
  ): Promise<{ handled: boolean; notice?: string }> {
    const label = cardLabel(session);
    const outcome = await this.deps.replier!.send(
      replyTargetFor(session),
      letter,
      this.failureNotifier(location, label),
    );
    if (outcome.status === "refused" || outcome.status === "unconfirmed") {
      return { handled: true, notice: outcome.reason };
    }
    this.afterReplyStarted();

    const where =
      outcome.via === "conductor"
        ? "in Conductor"
        : outcome.via === "terminal"
          ? "in its terminal"
          : "in the background";
    const answered: TelegramInlineKeyboard = [[{ text: `✓ Sent ${letter} ${where}`, callback_data: "fleet:noop" }]];
    if (messageId !== null) {
      try {
        await this.tg().editMessageReplyMarkup(location.chatId, messageId, answered);
        // A background send also needs its reason, which does not fit a button.
        return outcome.via !== "background"
          ? { handled: true }
          : { handled: true, notice: deliveredText(`Sent **${letter}** to **${label}**`, outcome) };
      } catch (error) {
        logger.debug("could not mark card as answered", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { handled: true, notice: deliveredText(`Sent **${letter}** to **${label}**`, outcome) };
  }

  /**
   * Open the reply box on the user's side, already quoting this prompt, so
   * whatever they type comes back addressed to the right chat.
   */
  private async promptForReply(location: TelegramConversationTarget, session: FleetSession): Promise<void> {
    const label = cardLabel(session);
    try {
      const messageId = await this.tg().sendForceReply(location.chatId, `Reply to **${label}**:`, {
        placeholder: `Message for ${label}`,
        messageThreadId: location.messageThreadId,
      });
      if (messageId !== null) {
        this.deps.store.setReplyTarget(location.chatId, messageId, replyTargetFor(session), label);
      }
    } catch (error) {
      logger.warn("fleet reply prompt failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** The agent's whole last message, for when the card's gist is not enough to decide. */
  private async sendFullMessage(location: TelegramConversationTarget, session: FleetSession): Promise<void> {
    const text = this.deps.replier!.lastTurnText(replyTargetFor(session));
    if (!text) {
      await this.send(location, "There is no finished message to show — the chat may be working again.");
      return;
    }
    const handle = this.deps.store.handleFor(session.key);
    const choices = parseChoices(text);
    const keyboard: TelegramInlineKeyboard = [];
    if (choices) {
      keyboard.push(
        ...attentionCardKeyboard(
          { session: { ...session, cwd: null }, kind: "finished_unreviewed", since: "", score: 0 },
          handle,
          {
            reply: true,
            open: false,
            choices,
            external: !session.conductorSessionId,
          },
        ),
      );
    } else {
      keyboard.push([{ text: "Reply", callback_data: `fleet:reply:${handle}` }]);
    }
    const messageId = await this.send(location, `**${cardLabel(session)}**\n\n${text}`, keyboard);
    if (messageId !== null) {
      this.deps.store.setReplyTarget(location.chatId, messageId, replyTargetFor(session), cardLabel(session));
    }
  }

  private failureNotifier(location: TelegramConversationTarget, label: string): ReplyFailureHandler {
    return (message) => {
      void this.send(location, `🟣 **${label}** — the reply did not go through: ${message}`);
    };
  }

  /**
   * Look again straight away. The turn just started, and recording it as
   * working now is what lets its finish register as a new state — and so push
   * a new card — even if the whole turn is over before the next poll.
   */
  private afterReplyStarted(): void {
    void this.deps.monitor.refresh().catch(() => undefined);
  }

  private resolveHandleKey(argument: string | undefined): string | null {
    const handle = Number.parseInt(argument ?? "", 10);
    return Number.isFinite(handle) ? this.deps.store.keyForHandle(handle) : null;
  }

  private resolveHandle(argument: string | undefined): FleetSession | null {
    const key = this.resolveHandleKey(argument);
    if (!key) {
      return null;
    }
    return this.deps.monitor.snapshot.sessions.find((session) => session.key === key) ?? null;
  }

  /**
   * Show what a session changed. Two steps: a file list, then one file's
   * patch, because a whole diff does not fit in a Telegram message and
   * scrolling one is miserable anyway.
   *
   * This works for sessions the bridge cannot drive — reading a working tree
   * needs no control channel — so a terminal Claude session's output is
   * reviewable here too.
   */
  private async showDiff(
    location: TelegramConversationTarget,
    handleArgument: string | undefined,
    fileArgument: string | undefined,
  ): Promise<void> {
    if (fileArgument === undefined) {
      await this.showDiffPage(location, handleArgument, 0);
      return;
    }

    const session = this.resolveHandle(handleArgument);
    const reader = this.deps.diff;
    if (!reader || !session?.cwd) {
      await this.send(location, "That session is no longer being tracked.");
      return;
    }

    const cached = this.diffCache.get(session.key);
    const index = Number.parseInt(fileArgument, 10);
    const file = cached && Number.isFinite(index) ? cached.diff.files[index] : undefined;
    if (!file) {
      // The list is gone or has shifted under the button; redraw it rather
      // than showing the wrong file's patch.
      await this.showDiffPage(location, handleArgument, 0);
      return;
    }

    const patch = await reader.readFilePatch(session.cwd, session.baseRef, file);
    const handle = this.deps.store.handleFor(session.key);
    await this.send(location, renderFilePatch(file, patch ?? ""), [
      [{ text: "Back to files", callback_data: `fleet:diff:${handle}` }],
      [{ text: "Radar", callback_data: "fleet:radar" }],
    ]);
  }

  /**
   * Show what a session changed, one page of files at a time. Paging reuses
   * the cached file list so flipping pages does not re-run git.
   */
  private async showDiffPage(
    location: TelegramConversationTarget,
    handleArgument: string | undefined,
    page: number,
  ): Promise<void> {
    const reader = this.deps.diff;
    const session = this.resolveHandle(handleArgument);
    if (!reader || !session) {
      await this.send(location, "That session is no longer being tracked.");
      return;
    }
    if (!session.cwd) {
      await this.send(location, "This session has no working directory on record, so there is nothing to diff.");
      return;
    }

    const cached = this.diffCache.get(session.key);
    const fresh = cached && this.now() - cached.readAt < DIFF_CACHE_TTL_MS ? cached.diff : null;
    const diff = fresh ?? (await reader.readSummary(session.cwd, session.baseRef));
    if (!diff) {
      await this.send(location, `\`${session.cwd}\` is not a git repository, or it no longer exists.`);
      return;
    }
    this.diffCache.set(session.key, { diff, readAt: fresh ? (cached?.readAt ?? this.now()) : this.now() });

    const handle = this.deps.store.handleFor(session.key);
    await this.send(
      location,
      renderDiffSummary(diff, sessionLabel(session), page),
      diffSummaryKeyboard(diff, handle, page),
    );
  }

  private async sendExternalSessionDetail(location: TelegramConversationTarget, session: FleetSession): Promise<void> {
    const lines = [
      `**${session.title ?? session.sourceId.slice(0, 8)}**`,
      `${session.agent} · ${session.origin} · ${session.state}`,
    ];
    if (session.cwd) {
      lines.push(`\`${session.cwd}\``);
    }
    if (session.detail) {
      lines.push("");
      lines.push(session.detail);
    }
    const answerable = this.canAnswer(session);
    lines.push("");
    lines.push(
      answerable
        ? "_This session runs in a terminal. A reply is typed into it there._"
        : "_This session was not started by Conductor, so the bridge can watch it but not drive it._",
    );

    const handle = this.deps.store.handleFor(session.key);
    const rows: TelegramInlineKeyboard = [];
    if (answerable) {
      rows.push([
        { text: "Reply", callback_data: `fleet:reply:${handle}` },
        { text: "Full message", callback_data: `fleet:full:${handle}` },
      ]);
    }
    if (session.cwd) {
      rows.push([{ text: "View Diff", callback_data: `fleet:diff:${handle}` }]);
    }
    rows.push([{ text: "Snooze 1h", callback_data: `fleet:snooze:${handle}` }]);
    rows.push([{ text: "Radar", callback_data: "fleet:radar" }]);
    await this.send(location, lines.join("\n"), rows);
  }

  private tg(): TelegramClient {
    if (!this.deps.telegram) {
      throw new Error("Telegram is not set up");
    }
    return this.deps.telegram;
  }

  private async refreshRadars(snapshot: FleetSnapshot): Promise<void> {
    if (!this.deps.telegram) {
      return;
    }
    const text = renderRadar(snapshot, this.now());
    const keyboard = radarKeyboard(snapshot, (key) => this.deps.store.handleFor(key));

    for (const anchor of this.deps.store.listRadarAnchors()) {
      const key = anchorKey(anchor.chatId, anchor.messageThreadId);
      if (this.lastRadarText.get(key) === text) {
        continue;
      }
      const lastEdit = this.lastRadarEditAt.get(key) ?? 0;
      if (this.now() - lastEdit < RADAR_MIN_EDIT_INTERVAL_MS) {
        continue;
      }

      try {
        await this.tg().editMessageText(anchor.chatId, anchor.messageId, text, keyboard);
        this.lastRadarText.set(key, text);
        this.lastRadarEditAt.set(key, this.now());
      } catch (error) {
        if (isTelegramMessageNotModifiedError(error)) {
          this.lastRadarText.set(key, text);
          continue;
        }
        // The anchor is usually gone: deleted message, or a topic that was
        // closed. Drop it rather than retrying forever.
        logger.warn("fleet radar anchor dropped", {
          chatId: anchor.chatId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.deps.store.clearRadarAnchor(anchor.chatId, anchor.messageThreadId || null);
        this.lastRadarText.delete(key);
      }
    }
  }

  private async pushAttention(items: AttentionItem[]): Promise<void> {
    const targets = this.pushTargets();
    if (targets.length === 0) {
      logger.debug("fleet push skipped: no radar anchored and no fallback chat");
      return;
    }

    for (const item of items) {
      const handle = this.deps.store.handleFor(item.session.key);
      const replyable = this.canReplyFrom(item);
      const choices = replyable ? this.readChoices(item.session) : null;
      const text = renderAttentionCard(item, this.now(), choices);
      const conductorSessionId = item.session.conductorSessionId;
      const keyboard = attentionCardKeyboard(item, handle, {
        reply: replyable || (this.canDrive && !this.deps.replier),
        open: this.canDrive,
        full: replyable,
        choices,
        external: replyable && !conductorSessionId,
        phoneLink: conductorSessionId ? (this.deps.phoneLink?.(conductorSessionId) ?? null) : null,
      });
      for (const target of targets) {
        const messageId = await this.send(target, text, keyboard);
        if (replyable && messageId !== null) {
          this.deps.store.setReplyTarget(
            target.chatId,
            messageId,
            replyTargetFor(item.session),
            cardLabel(item.session),
          );
        }
      }
    }
  }

  private canReplyFrom(item: AttentionItem): boolean {
    return canReplyFromCard(item, this.deps.replier);
  }

  /** Whether the replier can answer this session at all, whatever it is doing now. */
  private canAnswer(session: FleetSession): boolean {
    return canAnswerSession(session, this.deps.replier);
  }

  private readChoices(session: FleetSession): ParsedChoices | null {
    try {
      return parseChoices(this.deps.replier!.lastTurnText(replyTargetFor(session)));
    } catch (error) {
      // A card without buttons is still a card; never lose the push over this.
      logger.warn("could not read the last message for choices", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Anchored radars are the subscription list. Before the user has run /radar
   * once there is no anchor, so fall back to the configured chat — otherwise
   * the very first blocked session, the one that proves the feature works,
   * would go nowhere.
   */
  private pushTargets(): TelegramConversationTarget[] {
    if (!this.deps.telegram) {
      return [];
    }
    const anchors = this.deps.store.listRadarAnchors();
    if (anchors.length > 0) {
      return anchors.map((anchor) => ({
        chatId: anchor.chatId,
        messageThreadId: anchor.messageThreadId === 0 ? null : anchor.messageThreadId,
      }));
    }
    return this.deps.fallbackChatIds.map((chatId) => ({ chatId, messageThreadId: null }));
  }

  /** Returns the id of the last message sent — the one carrying the keyboard. */
  private async send(
    location: TelegramConversationTarget,
    text: string,
    keyboard?: TelegramInlineKeyboard,
  ): Promise<number | null> {
    const parts = splitMarkdown(text);
    const chunks = parts.length > 0 ? parts : [text];
    let lastId: number | null = null;
    for (const [index, chunk] of chunks.entries()) {
      const isLast = index === chunks.length - 1;
      try {
        lastId = await this.tg().sendMessage(location.chatId, chunk, {
          ...(keyboard && isLast ? { reply_markup: { inline_keyboard: keyboard } } : {}),
          ...(location.messageThreadId !== null ? { message_thread_id: location.messageThreadId } : {}),
        });
      } catch (error) {
        logger.warn("fleet message send failed", {
          chatId: location.chatId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }
    return lastId;
  }
}

/**
 * A Conductor chat is answered only from a finish: a blocked one is holding
 * its question open inside Conductor's own process, and a second writer
 * would talk past it. A terminal agent is typed into, so one waiting for
 * input can be answered too — but never one waiting on an approval, whose
 * prompt a typed digit would answer. The send checks again either way.
 *
 * Shared by every surface that puts answer buttons on a card.
 */
export function canReplyFromCard(item: AttentionItem, replier: FleetReplier | null | undefined): boolean {
  if (!canAnswerSession(item.session, replier)) {
    return false;
  }
  // A question a finished chat asks is answered like any finish: it is idle, so a reply is allowed.
  const finish = item.kind === "finished_unreviewed" || item.kind === "asked_question";
  if (item.session.conductorSessionId) {
    return finish;
  }
  return finish || item.kind === "blocked_question";
}

/**
 * Whether a message could be typed into this session *now*: the card rules
 * applied to its current state, for surfaces that offer a send without a
 * card (the Cliq assistant). The send checks again either way.
 */
export function canTakeMessageNow(session: FleetSession, replier: FleetReplier | null | undefined): boolean {
  if (!canAnswerSession(session, replier)) {
    return false;
  }
  if (session.state === "working" || session.state === "awaiting_approval") {
    return false;
  }
  // A blocked Conductor chat holds its question open inside Conductor's own process.
  return !(session.conductorSessionId && session.state === "awaiting_input");
}

/** Whether the replier can answer this session at all, whatever it is doing now. */
export function canAnswerSession(session: FleetSession, replier: FleetReplier | null | undefined): boolean {
  if (!replier) {
    return false;
  }
  return session.conductorSessionId ? true : (replier.canReply?.(session) ?? false);
}

/**
 * Whether it went through Conductor's window matters to the reader: only
 * then is it already visible there. A background reply is not, until
 * Conductor reloads the chat.
 */
export function deliveredText(sent: string, outcome: Extract<ReplyOutcome, { status: "started" }>): string {
  if (outcome.via === "conductor") {
    return `${sent} in Conductor. I'll message you when it answers.`;
  }
  if (outcome.via === "terminal") {
    return `${sent} in its terminal.`;
  }
  const why = outcome.fallbackReason ? ` because ${outcome.fallbackReason}` : "";
  return `${sent} in the background${why}. Conductor will show it the next time it loads the chat. I'll message you when it answers.`;
}

function anchorKey(chatId: number, messageThreadId: number | null): string {
  return `${chatId}:${messageThreadId ?? 0}`;
}
