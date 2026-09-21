import type { TelegramClient } from "../telegram/client.js";
import { isTelegramMessageNotModifiedError } from "../telegram/client.js";
import type { TelegramConversationTarget, TelegramInlineKeyboard } from "../types.js";
import { logger } from "../utils/logger.js";
import { splitMarkdown } from "../utils/tg-format.js";
import { DiffReader, renderDiffSummary, renderFilePatch, type WorkspaceDiff } from "./diff-view.js";
import type { FleetMonitor, FleetSnapshot } from "./fleet-monitor.js";
import type { FleetStore } from "./fleet-store.js";
import type { HookIngressServer } from "./hook-ingress.js";
import {
  attentionCardKeyboard,
  diffSummaryKeyboard,
  radarKeyboard,
  renderAttentionCard,
  renderRadar,
  sessionLabel,
} from "./radar.js";
import type { AttentionItem, FleetSession } from "./types.js";

/** Radar edits are cheap but not free; Telegram rate-limits edits per chat. */
const RADAR_MIN_EDIT_INTERVAL_MS = 8_000;
const SNOOZE_MS = 60 * 60 * 1000;
/** Paging through a diff should not re-shell git for every tap. */
const DIFF_CACHE_TTL_MS = 60_000;

export interface FleetControllerDependencies {
  telegram: TelegramClient;
  store: FleetStore;
  monitor: FleetMonitor;
  ingress: HookIngressServer | null;
  /** Hand a Conductor session back to the bridge's normal chat flow. */
  openConductorSession: (location: TelegramConversationTarget, conductorSessionId: string) => Promise<void>;
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

    this.deps.monitor.start();
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

    const messageId = await this.deps.telegram.sendMessage(location.chatId, text, {
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
        if (session.conductorSessionId) {
          await this.deps.openConductorSession(location, session.conductorSessionId);
          return { handled: true };
        }
        await this.sendExternalSessionDetail(location, session);
        return { handled: true };
      }
      case "reply": {
        const session = this.resolveHandle(argument);
        if (!session?.conductorSessionId) {
          return { handled: true, notice: "That session cannot be replied to from Telegram." };
        }
        await this.deps.openConductorSession(location, session.conductorSessionId);
        return { handled: true };
      }
      case "snooze": {
        const key = this.resolveHandleKey(argument);
        if (!key) {
          return { handled: true, notice: "That session is no longer being tracked." };
        }
        this.deps.store.snooze(key, new Date(this.now() + SNOOZE_MS).toISOString());
        return { handled: true, notice: "Snoozed for an hour." };
      }
      case "reviewed": {
        const key = this.resolveHandleKey(argument);
        if (!key) {
          return { handled: true, notice: "That session is no longer being tracked." };
        }
        this.deps.store.markReviewed(key, new Date(this.now()).toISOString());
        void this.deps.monitor.refresh();
        return { handled: true, notice: "Marked reviewed." };
      }
      default:
        return { handled: true, notice: "Unknown fleet action." };
    }
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
    lines.push("");
    lines.push("_This session was not started by Conductor, so the bridge can watch it but not drive it._");

    const handle = this.deps.store.handleFor(session.key);
    const rows: TelegramInlineKeyboard = [];
    if (session.cwd) {
      rows.push([{ text: "View Diff", callback_data: `fleet:diff:${handle}` }]);
    }
    rows.push([{ text: "Snooze 1h", callback_data: `fleet:snooze:${handle}` }]);
    rows.push([{ text: "Radar", callback_data: "fleet:radar" }]);
    await this.send(location, lines.join("\n"), rows);
  }

  private async refreshRadars(snapshot: FleetSnapshot): Promise<void> {
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
        await this.deps.telegram.editMessageText(anchor.chatId, anchor.messageId, text, keyboard);
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
      const text = renderAttentionCard(item, this.now());
      const keyboard = attentionCardKeyboard(item, handle);
      for (const target of targets) {
        await this.send(target, text, keyboard);
      }
    }
  }

  /**
   * Anchored radars are the subscription list. Before the user has run /radar
   * once there is no anchor, so fall back to the configured chat — otherwise
   * the very first blocked session, the one that proves the feature works,
   * would go nowhere.
   */
  private pushTargets(): TelegramConversationTarget[] {
    const anchors = this.deps.store.listRadarAnchors();
    if (anchors.length > 0) {
      return anchors.map((anchor) => ({
        chatId: anchor.chatId,
        messageThreadId: anchor.messageThreadId === 0 ? null : anchor.messageThreadId,
      }));
    }
    return this.deps.fallbackChatIds.map((chatId) => ({ chatId, messageThreadId: null }));
  }

  private async send(
    location: TelegramConversationTarget,
    text: string,
    keyboard?: TelegramInlineKeyboard,
  ): Promise<void> {
    const parts = splitMarkdown(text);
    const chunks = parts.length > 0 ? parts : [text];
    for (const [index, chunk] of chunks.entries()) {
      const isLast = index === chunks.length - 1;
      try {
        await this.deps.telegram.sendMessage(location.chatId, chunk, {
          ...(keyboard && isLast ? { reply_markup: { inline_keyboard: keyboard } } : {}),
          ...(location.messageThreadId !== null ? { message_thread_id: location.messageThreadId } : {}),
        });
      } catch (error) {
        logger.warn("fleet message send failed", {
          chatId: location.chatId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
  }
}

function anchorKey(chatId: number, messageThreadId: number | null): string {
  return `${chatId}:${messageThreadId ?? 0}`;
}
