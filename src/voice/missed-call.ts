import { summarizeOutcome } from "../fleet/card-text.js";
import { parseChoices } from "../fleet/choices.js";
import { cardLabel } from "../fleet/radar.js";
import { NOTIFY_CHANNELS, shouldPushTo, type NotifyChannel, type NotifySettings } from "../fleet/notify-settings.js";
import type { AttentionItem } from "../fleet/types.js";
import { logger } from "../utils/logger.js";
import { clipQuestion } from "./script.js";

/** A call that rang out unanswered (or failed, but not on a busy line) is tried once more after this. */
export const RETRY_DELAY_MS = 2 * 60_000;

export interface MissedCallDependencies {
  /** Live notify settings; absent: no card is pushed, only the one retry happens. */
  settings?: (() => NotifySettings) | undefined;
  /** Sends one short text to one channel (Telegram's allowed chats, Cliq's webhook). */
  push?: ((channel: NotifyChannel, text: string) => void) | undefined;
  /** The same item as it is now, or null when it was answered or has moved on. */
  stillWaiting: (item: AttentionItem) => AttentionItem | null;
  /** Places the second call; the voice channel's `ring` with the policy's retry rules. */
  retry: (item: AttentionItem, episode: string) => Promise<void>;
  now?: () => number;
  /** 0 or less turns the retry off. */
  retryDelayMs?: number | undefined;
}

/**
 * After a missed call: one retry about two minutes later if the question still waits, and the question as a text on
 * any channel that may carry it and has not had it. "Had it" is learned from `observe`, which sees every item the
 * monitor pushed (each channel's own notify rules already decided whether its card went), so a card that went out
 * is never sent again, while one held back (quiet hours, then ended; a setting changed) is made up for.
 */
export class MissedCallFollowUp {
  private readonly pushed = new Map<string, Set<NotifyChannel>>();
  private readonly retried = new Set<string>();
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(private readonly deps: MissedCallDependencies) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The monitor pushed `item`: remember which channels it reached. */
  observe(item: AttentionItem, episode: string): void {
    const settings = this.deps.settings?.();
    if (!settings) return;
    const reached = this.pushed.get(episode) ?? new Set<NotifyChannel>();
    for (const channel of NOTIFY_CHANNELS) {
      if (shouldPushTo(channel, item.kind, item.session, settings, this.now())) reached.add(channel);
    }
    this.pushed.set(episode, reached);
    while (this.pushed.size > 200) this.pushed.delete(this.pushed.keys().next().value as string);
  }

  /** A call for `episode` ended unanswered or failed (not busy). `second` is true when this was the retry. */
  missed(item: AttentionItem, episode: string, second: boolean, lastText: string | null): void {
    if (!second) this.pushQuestion(item, episode, questionOf(lastText));
    const delay = this.deps.retryDelayMs ?? RETRY_DELAY_MS;
    if (second || delay <= 0 || this.retried.has(episode)) return;
    this.retried.add(episode);
    while (this.retried.size > 500) this.retried.delete(this.retried.values().next().value as string);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      const current = this.deps.stillWaiting(item);
      if (!current) return;
      void this.deps.retry(current, episode).catch((error: unknown) => {
        logger.warn("voice retry failed", { error: error instanceof Error ? error.message : String(error) });
      });
    }, delay);
    timer.unref();
    this.timers.add(timer);
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /** The question as a short text to each channel that may carry it now and has not had it for this episode. */
  private pushQuestion(item: AttentionItem, episode: string, question: string | null): void {
    const settings = this.deps.settings?.();
    const push = this.deps.push;
    if (!settings || !push) return;
    const reached = this.pushed.get(episode) ?? new Set<NotifyChannel>();
    for (const channel of NOTIFY_CHANNELS) {
      if (reached.has(channel)) continue;
      if (!shouldPushTo(channel, item.kind, item.session, settings, this.now())) continue;
      reached.add(channel);
      try {
        push(
          channel,
          `${label(item)} is still waiting for you: ${question ? clipQuestion(question, 30).text : "open Squeak to answer."}`,
        );
      } catch (error) {
        logger.warn("missed-call card failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    this.pushed.set(episode, reached);
  }
}

const label = (item: AttentionItem): string => cardLabel(item.session);

/** What is being asked, from the agent's whole last message: the stated question, else its gist. */
export function questionOf(lastText: string | null): string | null {
  return parseChoices(lastText)?.question ?? summarizeOutcome(lastText, 600);
}
