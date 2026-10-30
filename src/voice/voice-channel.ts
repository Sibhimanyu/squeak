import { canReplyFromCard, type FleetReplier } from "../fleet/fleet-controller.js";
import type { FleetMonitor } from "../fleet/fleet-monitor.js";
import { cardLabel } from "../fleet/radar.js";
import { replyTargetFor } from "../fleet/reply-router.js";
import type { AttentionItem } from "../fleet/types.js";
import { turnStamp } from "../cliq/channel.js";
import { logger } from "../utils/logger.js";
import type { CallResult } from "./baresip-line.js";
import type { CallHistory, CallReason } from "./call-history.js";
import type { CallPolicy } from "./policy.js";
import type { VoiceLine } from "./relay-line.js";
import { composeScript, shouldCall } from "./script.js";

/** How long a card waits before Squeak rings: long enough that you may have answered it already. */
export const DEFAULT_GRACE_MS = 45_000;
const FAILURE_NOTE_GAP_MS = 60 * 60_000;

export interface VoiceChannelDependencies {
  monitor: Pick<FleetMonitor, "onPush" | "snapshot" | "refresh">;
  replier: FleetReplier;
  line: VoiceLine;
  /**
   * Whether keys can answer where the call is taken (a PIN is set, or was turned off on purpose); without one a call
   * only tells you. A function is read at each call, since an app can change the pin at runtime.
   */
  canTakeKeys: boolean | (() => boolean);
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

  constructor(private readonly deps: VoiceChannelDependencies) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.unsubscribe = this.deps.monitor.onPush((items) => {
      for (const item of items) this.consider(item);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
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
  async ring(item: AttentionItem, episode = this.episode(item)): Promise<void> {
    const current = this.stillWaiting(item);
    if (!current || this.calling) return;
    if (this.deps.paused?.()) {
      logger.info("voice call skipped: paused");
      return;
    }
    const now = this.now();
    const refusal = this.deps.policy.refusal(episode, now);
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
    const script = composeScript(current, text, canAnswer);

    this.calling = true;
    this.deps.policy.record(episode, now);
    const placedAt = this.now();
    const label = cardLabel(current.session);
    this.trace("step", `Call placed: ${label}`);
    this.trace("said", `${script.greeting} ${script.question}`);
    let result: CallResult;
    try {
      result = await this.deps.line.call(script, canAnswer);
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
      return;
    }
    if (result.status === "answered" && result.letter) {
      this.trace("key", `Answered ${result.letter}`);
      const what = await this.answer(current, target, stamp, result.letter);
      this.writeDown(current, placedAt, {
        outcome: what === "moved_on" ? "moved_on" : "answered",
        letter: result.letter,
        sent: what === "sent",
      });
      return;
    }
    this.trace("step", "Not answered");
    this.writeDown(current, placedAt, { outcome: result.status === "answered" ? "answered" : "unanswered" });
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

function safely<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}
