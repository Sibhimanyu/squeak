import { canReplyFromCard, type FleetReplier } from "../fleet/fleet-controller.js";
import type { FleetMonitor } from "../fleet/fleet-monitor.js";
import { cardLabel } from "../fleet/radar.js";
import { replyTargetFor } from "../fleet/reply-router.js";
import type { AttentionItem } from "../fleet/types.js";
import { turnStamp } from "../cliq/channel.js";
import { logger } from "../utils/logger.js";
import type { CallResult } from "./baresip-line.js";
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
  /** Whether a PIN exists where the keys are taken; without one a call only tells you. */
  canTakeKeys: boolean;
  policy: CallPolicy;
  graceMs?: number;
  /** A one-off note to Telegram and Cliq: what an answer by phone did, or why a call failed. */
  note: (text: string) => void;
  now?: () => number;
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
    const now = this.now();
    const refusal = this.deps.policy.refusal(episode, now);
    if (refusal) {
      logger.info("voice call skipped", { reason: refusal });
      return;
    }
    const target = replyTargetFor(current.session);
    const text = safely(() => this.deps.replier.lastTurnText(target));
    const stamp = turnStamp(text);
    const canAnswer = canReplyFromCard(current, this.deps.replier) && this.deps.canTakeKeys;
    const script = composeScript(current, text, canAnswer);

    this.calling = true;
    this.deps.policy.record(episode, now);
    let result: CallResult;
    try {
      result = await this.deps.line.call(script, canAnswer);
    } finally {
      this.calling = false;
    }
    if (result.status === "failed") {
      logger.warn("voice call could not be placed", { reason: result.reason });
      if (this.now() - this.lastFailureNote > FAILURE_NOTE_GAP_MS) {
        this.lastFailureNote = this.now();
        this.deps.note(`Squeak could not call you: ${result.reason}`);
      }
      return;
    }
    if (result.status === "answered" && result.letter) {
      await this.answer(current, target, stamp, result.letter);
    }
  }

  private async answer(item: AttentionItem, target: string, stamp: string, letter: string): Promise<void> {
    const label = cardLabel(item.session);
    // The call can last a minute: only answer the turn that was read out.
    if (turnStamp(safely(() => this.deps.replier.lastTurnText(target))) !== stamp) {
      this.deps.note(`You pressed ${letter} for ${label}, but it has moved on since the call, so I sent nothing.`);
      return;
    }
    const outcome = await this.deps.replier.send(target, letter, (message) => {
      this.deps.note(`The ${letter} you pressed for ${label} did not go through: ${message}`);
    });
    if (outcome.status === "refused" || outcome.status === "unconfirmed") {
      this.deps.note(`The ${letter} you pressed for ${label} was not sent: ${outcome.reason}`);
      return;
    }
    // Look again now, so the turn this starts registers and its finish pushes a card.
    void this.deps.monitor.refresh().catch(() => undefined);
    this.deps.note(`Answered by phone: sent ${letter} to ${label}.`);
  }
}

function safely<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}
