import { canReplyFromCard, type FleetReplier } from "../fleet/fleet-controller.js";
import type { FleetMonitor } from "../fleet/fleet-monitor.js";
import { cardLabel } from "../fleet/radar.js";
import { replyTargetFor } from "../fleet/reply-router.js";
import type { AttentionItem } from "../fleet/types.js";
import { turnStamp } from "../cliq/channel.js";
import type { NotifyChannel, NotifySettings } from "../fleet/notify-settings.js";
import { logger } from "../utils/logger.js";
import type { CallResult } from "./baresip-line.js";
import type { CallHistory, CallReason } from "./call-history.js";
import { answeredSummary } from "./call-summary.js";
import { MissedCallFollowUp } from "./missed-call.js";
import { LINE_BUSY_REASON } from "./phone.js";
import type { CallPolicy } from "./policy.js";
import type { VoiceLine } from "./relay-line.js";
import { composeScript, shouldCall } from "./script.js";

/** How long a card waits before Squeak rings: long enough that you may have answered it already. */
export const DEFAULT_GRACE_MS = 45_000;
const FAILURE_NOTE_GAP_MS = 60 * 60_000;
/** A call that finds the line busy (a call in, usually) waits this long in all for it to end, looking this often. */
export const BUSY_WAIT_MS = 3 * 60_000;
export const BUSY_POLL_MS = 10_000;

export interface VoiceChannelDependencies {
  monitor: Pick<FleetMonitor, "onPush" | "snapshot" | "refresh">;
  replier: FleetReplier;
  line: VoiceLine;
  /**
   * Whether keys can answer where the call is taken (a PIN is set, or was turned off on purpose); without one a call
   * only tells you. A function is read at each call, since an app can change the pin at runtime.
   */
  canTakeKeys: boolean | (() => boolean);
  /** The call may offer a message for the chat (9) and its status (0): the Mac's inbox and the add-on can take them. */
  followUp?: () => boolean;
  policy: CallPolicy;
  /** True while the person has paused calls (voice/settings.ts); cards still go everywhere else. */
  paused?: () => boolean;
  graceMs?: number;
  /** A one-off note to Telegram and Cliq: what an answer by phone did, or why a call failed. */
  note: (text: string) => void;
  now?: () => number;
  /** Where each call is written down (voice/call-history.ts); absent in tests that do not look. */
  history?: Pick<CallHistory, "record">;
  /** The call's step-by-step log (voice/call-trace.ts), for the apps' Calls page; absent in tests that do not look. */
  trace?: (kind: "step" | "said" | "warn" | "key", text: string, extra?: { ms?: number; label?: string }) => void;
  /** Waits between looks at a busy line; tests pass a fast one. */
  sleep?: (ms: number) => Promise<void>;
  busyWaitMs?: number;
  /**
   * After a missed call (voice/missed-call.ts): the notify settings and a per-channel text sender, so a question the
   * channel's rules allow and that was not pushed yet goes out once. `retryDelayMs` 0 turns the one retry off.
   */
  notify?: {
    settings: () => NotifySettings;
    push: (channel: NotifyChannel, text: string) => void;
    retryDelayMs?: number;
  };
}

/**
 * Squeak rings you when an agent is stuck on you (`script.ts` says which): it reads the question,
 * and, after your PIN, a key press answers it. It listens to the same `onPush` as Telegram, so the
 * monitor has already applied snoozes and mutes, and it answers through the same replier with the
 * same checks: the key goes only to the turn that was read out.
 */
export class VoiceChannel {
  private readonly now: () => number;
  private unsubscribe: (() => void) | null = null;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private calling = false;
  private lastFailureNote = Number.NEGATIVE_INFINITY;

  private readonly followUp: MissedCallFollowUp;

  constructor(private readonly deps: VoiceChannelDependencies) {
    this.now = deps.now ?? Date.now;
    this.followUp = new MissedCallFollowUp({
      settings: deps.notify?.settings,
      push: deps.notify?.push,
      retryDelayMs: deps.notify?.retryDelayMs,
      stillWaiting: (item) => this.stillWaiting(item),
      retry: (item, episode) => this.ring(item, episode, true),
      now: this.now,
    });
  }

  start(): void {
    this.unsubscribe = this.deps.monitor.onPush((items) => {
      for (const item of items) {
        this.followUp.observe(item, this.episode(item));
        this.consider(item);
      }
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.followUp.stop();
  }

  private episode(item: AttentionItem): string {
    return `${item.session.key}|${item.kind}|${item.since}`;
  }

  private consider(item: AttentionItem): void {
    if (!shouldCall(item)) return;
    const episode = this.episode(item);
    if (this.timers.has(episode)) return;
    const timer = setTimeout(() => {
      this.timers.delete(episode);
      void this.ring(item, episode).catch((error: unknown) => {
        logger.warn("voice call failed", { error: error instanceof Error ? error.message : String(error) });
      });
    }, this.deps.graceMs ?? DEFAULT_GRACE_MS);
    timer.unref();
    this.timers.set(episode, timer);
  }

  /** The item as it is now, or null when it has been answered or moved on during the grace. */
  private stillWaiting(item: AttentionItem): AttentionItem | null {
    const current = this.deps.monitor.snapshot.attention.find(
      (candidate) =>
        candidate.session.key === item.session.key && candidate.kind === item.kind && candidate.since === item.since,
    );
    return current ?? null;
  }

  /** Runs one call if everything still holds; exposed for tests. */
  async ring(item: AttentionItem, episode = this.episode(item), retry = false): Promise<void> {
    const current = this.stillWaiting(item);
    if (!current || this.calling) return;
    if (this.deps.paused?.()) {
      logger.info("voice call skipped: paused");
      return;
    }
    const now = this.now();
    const refusal = this.deps.policy.refusal(episode, now, retry);
    if (refusal) {
      logger.info("voice call skipped", { reason: refusal });
      return;
    }
    const target = replyTargetFor(current.session);
    const text = safely(() => this.deps.replier.lastTurnText(target));
    const stamp = turnStamp(text);
    const canAnswer =
      canReplyFromCard(current, this.deps.replier) &&
      (typeof this.deps.canTakeKeys === "function" ? this.deps.canTakeKeys() : this.deps.canTakeKeys);
    const script = composeScript(current, text, canAnswer, safely(() => this.deps.followUp?.() ?? false) ?? false);
    const follow = script.followUp ? { target, label: script.followUp.label } : undefined;

    this.calling = true;
    this.deps.policy.record(episode, now, retry);
    const placedAt = this.now();
    const label = cardLabel(current.session);
    this.trace("step", `Call placed: ${label}`);
    this.trace("said", `${script.greeting} ${script.question}`);
    let result: CallResult;
    try {
      result = await this.deps.line.call(script, canAnswer, follow);
      // The line is in use (a call in, or another call out): the request is not lost, it rings once the line is free.
      if (result.status === "failed" && result.reason === LINE_BUSY_REASON) {
        const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
        const cap = this.deps.busyWaitMs ?? BUSY_WAIT_MS;
        const waitFrom = this.now();
        this.trace("warn", "Line busy, will ring when the call ends");
        let waited = 0;
        while (result.status === "failed" && result.reason === LINE_BUSY_REASON) {
          if (waited >= cap) {
            this.trace(
              "warn",
              `Line still busy after ${Math.round(cap / 1000)} s, gave up; the question stays in the app`,
            );
            break;
          }
          await sleep(BUSY_POLL_MS);
          waited = Math.max(waited + BUSY_POLL_MS, this.now() - waitFrom);
          if (!this.stillWaiting(item) || this.deps.paused?.()) {
            this.trace("warn", "No longer waiting, so the call was not placed after the line freed up");
            break;
          }
          result = await this.deps.line.call(script, canAnswer, follow);
          if (result.status !== "failed" || result.reason !== LINE_BUSY_REASON)
            this.trace("step", `Line free after ${Math.round(waited / 1000)} s, ringing now`);
        }
      }
    } catch (error) {
      this.trace("warn", `Failed: ${error instanceof Error ? error.message : String(error)}`);
      this.writeDown(current, placedAt, {
        outcome: "failed",
        failure: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.calling = false;
    }
    if (result.status === "failed") {
      this.trace("warn", `Failed: ${result.reason}`);
      this.writeDown(current, placedAt, { outcome: "failed", failure: result.reason });
      logger.warn("voice call could not be placed", { reason: result.reason });
      if (this.now() - this.lastFailureNote > FAILURE_NOTE_GAP_MS) {
        this.lastFailureNote = this.now();
        this.deps.note(`Squeak could not call you: ${result.reason}`);
      }
      // A busy line is waited out above; any other failure gets the one retry and the question as a text.
      if (result.reason !== LINE_BUSY_REASON) this.followUp.missed(current, episode, retry, text);
      return;
    }
    if (result.status === "answered" && result.quality) this.trace("step", `Line quality: ${result.quality.verdict}`);
    if (result.status === "answered" && result.letter) {
      this.trace("key", `Answered ${result.letter}`);
      const what = await this.answer(current, target, stamp, result.letter);
      this.writeDown(current, placedAt, {
        outcome: what === "moved_on" ? "moved_on" : "answered",
        letter: result.letter,
        sent: what === "sent",
        ...(what === "sent" ? summaryOf(answeredSummary(script.options, result.letter)) : {}),
      });
      return;
    }
    this.trace("step", "Not answered");
    this.writeDown(current, placedAt, { outcome: result.status === "answered" ? "answered" : "unanswered" });
    if (result.status !== "answered") this.followUp.missed(current, episode, retry, text);
  }

  private trace(kind: "step" | "said" | "warn" | "key", text: string, extra?: { ms?: number; label?: string }): void {
    try {
      this.deps.trace?.(kind, text, extra);
    } catch {
      // A log line never matters more than the call.
    }
  }

  /** One line in the call history: never the question, a PIN or any key but the answer letter. */
  private writeDown(
    item: AttentionItem,
    placedAt: number,
    what: {
      outcome: "answered" | "unanswered" | "failed" | "moved_on";
      letter?: string;
      sent?: boolean;
      failure?: string;
      summary?: string;
    },
  ): void {
    try {
      this.deps.history?.record({
        at: placedAt,
        kind: "agent",
        reason: item.kind as CallReason,
        label: cardLabel(item.session),
        durationMs: Math.max(0, this.now() - placedAt),
        ...what,
      });
    } catch (error) {
      logger.warn("call history write failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async answer(
    item: AttentionItem,
    target: string,
    stamp: string,
    letter: string,
  ): Promise<"sent" | "moved_on" | "not_sent"> {
    const label = cardLabel(item.session);
    // The call can last a minute: only answer the turn that was read out.
    if (turnStamp(safely(() => this.deps.replier.lastTurnText(target))) !== stamp) {
      this.deps.note(`You pressed ${letter} for ${label}, but it has moved on since the call, so I sent nothing.`);
      this.trace("warn", `Moved on: ${label} changed since the call, nothing sent`);
      return "moved_on";
    }
    const outcome = await this.deps.replier.send(target, letter, (message) => {
      this.deps.note(`The ${letter} you pressed for ${label} did not go through: ${message}`);
    });
    if (outcome.status === "refused" || outcome.status === "unconfirmed") {
      this.deps.note(`The ${letter} you pressed for ${label} was not sent: ${outcome.reason}`);
      this.trace("warn", `${letter} not sent to ${label}: ${outcome.reason}`);
      return "not_sent";
    }
    // Look again now, so the turn this starts registers and its finish pushes a card.
    void this.deps.monitor.refresh().catch(() => undefined);
    this.deps.note(`Answered by phone: sent ${letter} to ${label}.`);
    this.trace("step", `Sent ${letter} to ${label}`);
    return "sent";
  }
}

const summaryOf = (summary: string | null): { summary?: string } => (summary ? { summary } : {});

function safely<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}
