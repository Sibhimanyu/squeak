import type { TranscriptResult } from "./transcript.js";
import type { WorkSteps } from "./work-steps.js";
import type { FleetReplier } from "./fleet-controller.js";
import type { AddonReplier } from "../addons.js";
import {
  STEER_UNAVAILABLE_NOTE,
  type ReplyFailureHandler,
  type ReplyOptions,
  type ReplyOutcome,
  type QueueAction,
} from "./reply-types.js";
import type { TerminalReplier } from "./terminal-reply.js";
import { NATIVE_HOST_DOWN, isNativeKey, type NativeReplier } from "./native-reply.js";
import type { FleetSession } from "./types.js";

/**
 * What a reply is addressed to: a host app's chat id (Conductor's, an add-on's), or — for a session no host
 * knows — its fleet key. The two cannot collide: fleet keys always carry their observer's prefix
 * (`claude-transcript:…`), and a host's ids are bare UUIDs. Stored as-is in `fleet_reply_target`
 * (its column is still named `conductor_session_id`), so a swipe-reply still finds its chat after a restart.
 */
export function replyTargetFor(session: FleetSession): string {
  return session.hostSessionId ?? session.conductorSessionId ?? session.key;
}

function isFleetKey(target: string): boolean {
  return target.includes(":");
}

export const HOST_NOT_ENABLED = "That chat's app isn't added to Squeak. Add it in Squeak › Settings › Add-ons.";

export interface FleetReplyRouterDependencies {
  /** The host repliers add-ons supply, enabled ones only, looked up at call time. */
  hosts: () => AddonReplier[];
  /** Without it only host chats can be answered, as before. */
  terminal?: TerminalReplier | null;
  /** Squeak's own session host's chats; without it they are watch-only. */
  native?: NativeReplier | null;
  /** The monitor's current view, to resolve a fleet key back to its session. */
  sessions: () => FleetSession[];
}

/**
 * One replier for every surface — Telegram, the Mac window, the phone — that sends each target to whichever side
 * can answer it. A host app's chats keep their route (its window, then the background CLI); a terminal agent is
 * typed into. It also carries the host's extras (queue, stop, setup) to whoever asks, by chat id.
 */
export class FleetReplyRouter implements FleetReplier {
  constructor(private readonly deps: FleetReplyRouterDependencies) {}

  private host(target: string): AddonReplier | null {
    return this.deps.hosts().find((replier) => replier.ownsTarget(target)) ?? null;
  }

  private hostFor(session: FleetSession): AddonReplier | null {
    return this.deps.hosts().find((replier) => replier.canHandle(session)) ?? null;
  }

  canReply(session: FleetSession): boolean {
    if (session.hostId) {
      return this.hostFor(session) !== null;
    }
    if (session.origin === "squeak") {
      return this.deps.native?.canReply(session) ?? false;
    }
    return this.deps.terminal?.canReply(session) ?? false;
  }

  lastTurnText(target: string): string | null {
    if (!isFleetKey(target)) {
      return this.host(target)?.lastTurnText(target) ?? null;
    }
    const session = this.resolve(target);
    if (isNativeKey(target)) {
      return session ? (this.deps.native?.lastTurnText(session) ?? null) : null;
    }
    return session && this.deps.terminal?.canReply(session) ? this.deps.terminal.lastTurnText(session) : null;
  }

  /**
   * The newest turn's id, for refusing an answer to a turn that has moved on.
   * A host chat reads its database; a terminal agent its transcript.
   */
  lastTurnId(target: string): string | null {
    if (!isFleetKey(target)) {
      return this.host(target)?.lastTurnId?.(target) ?? null;
    }
    const session = this.resolve(target);
    const hosted = session ? this.hostFor(session) : null;
    if (session && hosted) {
      return hosted.lastTurnId?.(session.hostSessionId ?? session.conductorSessionId ?? target) ?? null;
    }
    if (isNativeKey(target)) {
      return null;
    }
    return session && this.deps.terminal?.canReply(session) ? this.deps.terminal.lastTurnId(session) : null;
  }

  /** Why a host chat's newest turn failed. Terminal agents have no such record. */
  lastTurnError(target: string): string | null {
    return isFleetKey(target) ? null : (this.host(target)?.lastTurnError?.(target) ?? null);
  }

  /** Readable history. Terminal agents have no cheap reader yet, so they get none. */
  transcript(target: string, limit: number, before?: number | null): TranscriptResult {
    if (!isFleetKey(target)) {
      return (
        this.host(target)?.transcript?.(target, limit, before) ?? { messages: [], complete: false, nextBefore: null }
      );
    }
    const session = this.resolve(target);
    const hosted = session ? this.hostFor(session) : null;
    if (session && hosted?.transcript) {
      return hosted.transcript(session.hostSessionId ?? session.conductorSessionId ?? target, limit, before);
    }
    return { messages: [], complete: false, nextBefore: null };
  }

  /** The work between two messages of a host chat; terminal agents have none. */
  workBetween(target: string, messageId: string): WorkSteps | null {
    if (isFleetKey(target)) return null;
    return this.host(target)?.workBetween?.(target, messageId) ?? null;
  }

  isCompacting(target: string): boolean {
    return isFleetKey(target) ? false : (this.host(target)?.isCompacting?.(target) ?? false);
  }

  setOnQueueChange(listener: ((sessionId: string) => void) | null): void {
    this.queueListener = listener;
    for (const replier of this.deps.hosts()) replier.setOnQueueChange?.(listener);
  }

  /** Re-applied when an add-on is enabled after the listener was set. */
  private queueListener: ((sessionId: string) => void) | null = null;

  /** Hooks the queue listener into repliers that appeared since (an add-on enabled at run time). */
  attachListeners(): void {
    if (this.queueListener) for (const replier of this.deps.hosts()) replier.setOnQueueChange?.(this.queueListener);
  }

  /** A host chat's queue of messages waiting for the turn to end; null when it cannot be read. */
  async queue(target: string) {
    const replier = this.host(target);
    return replier?.queue ? replier.queue(target) : null;
  }

  async queueAction(target: string, messageId: string, action: QueueAction) {
    const replier = this.host(target);
    if (!replier?.queueAction) return { ok: false as const, reason: HOST_NOT_ENABLED };
    return replier.queueAction(target, messageId, action);
  }

  async stopTurn(target: string) {
    const replier = this.host(target);
    if (!replier?.stopTurn) return { ok: false as const, reason: HOST_NOT_ENABLED };
    return replier.stopTurn(target);
  }

  async setSetup(target: string, setup: { model: string; thinkingLevel?: string; fastMode: boolean }) {
    const replier = this.host(target);
    if (!replier?.setSetup) return { ok: false as const, reason: HOST_NOT_ENABLED };
    return replier.setSetup(target, setup);
  }

  /** The Mac app's chat actions (`stop`, `setup`, `pr`); a fixed sentence when no host owns the chat. */
  async action(target: string, action: "stop" | "setup" | "pr", body: Record<string, unknown>): Promise<unknown> {
    const replier = this.host(target);
    if (!replier?.action) return { ok: false, reason: HOST_NOT_ENABLED };
    return replier.action(target, action, body);
  }

  /** The chat's new title; false when no enabled host has such a chat. */
  rename(target: string, title: string): boolean {
    return this.host(target)?.rename?.(target, title) ?? false;
  }

  async close(target: string): Promise<"closed" | "busy" | "missing"> {
    const replier = this.host(target);
    return replier?.close ? await replier.close(target) : "missing";
  }

  /** Answers for the host that owns the chat, when it has a way to. */
  answers(target: string) {
    return this.host(target)?.answers ?? null;
  }

  async stop(): Promise<void> {
    for (const replier of this.deps.hosts()) await replier.stop?.().catch(() => undefined);
  }

  async send(
    target: string,
    text: string,
    onFailed: ReplyFailureHandler,
    options: ReplyOptions = {},
  ): Promise<ReplyOutcome> {
    if (!isFleetKey(target)) {
      const replier = this.host(target);
      return replier ? replier.send(target, text, onFailed, options) : { status: "refused", reason: HOST_NOT_ENABLED };
    }
    const session = this.resolve(target);
    if (!session) {
      return { status: "refused", reason: "That session is no longer being tracked." };
    }
    if (isNativeKey(target)) {
      if (!this.deps.native) {
        return { status: "refused", reason: NATIVE_HOST_DOWN };
      }
      // The host queues while the chat works and answers a blocked one: nothing to refuse here.
      return this.deps.native.send(session, text, { ...options, mode: "queue" });
    }
    // A session a host app adopted since the card was sent goes through that host.
    const hosted = this.hostFor(session);
    if (hosted) {
      return hosted.send(session.hostSessionId ?? session.conductorSessionId ?? target, text, onFailed, options);
    }
    if (!this.deps.terminal?.canReply(session)) {
      return { status: "refused", reason: "That session cannot be replied to from here." };
    }
    // A terminal agent is only typed into when idle, so there is nothing to
    // queue or steer; say so if steering was asked for.
    const outcome = await this.deps.terminal.send(session, text);
    if (outcome.status !== "started") {
      return outcome;
    }
    return {
      ...outcome,
      delivery: "sent",
      ...(options.mode === "steer" ? { note: STEER_UNAVAILABLE_NOTE } : {}),
    };
  }

  private resolve(key: string): FleetSession | null {
    return this.deps.sessions().find((session) => session.key === key) ?? null;
  }
}
