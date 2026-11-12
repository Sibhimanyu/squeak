import type { TranscriptResult } from "./transcript.js";
import type { WorkSteps } from "./work-steps.js";
import type { FleetReplier } from "./fleet-controller.js";
import {
  STEER_UNAVAILABLE_NOTE,
  type ReplyFailureHandler,
  type ReplyOptions,
  type ReplyOutcome,
} from "./reply-types.js";
import type { TerminalReplier } from "./terminal-reply.js";
import { NATIVE_HOST_DOWN, isNativeKey, type NativeReplier } from "./native-reply.js";
import type { FleetSession } from "./types.js";

/**
 * What a reply is addressed to: a Conductor chat's id, or — for a session
 * Conductor does not know — its fleet key. The two cannot collide: fleet
 * keys always carry their observer's prefix (`claude-transcript:…`), and
 * Conductor's ids are bare UUIDs. Stored as-is in `fleet_reply_target`, so a
 * swipe-reply still finds its chat after a restart.
 */
export function replyTargetFor(session: FleetSession): string {
  return session.conductorSessionId ?? session.key;
}

function isFleetKey(target: string): boolean {
  return target.includes(":");
}

interface ConductorSide {
  lastTurnText(conductorSessionId: string): string | null;
  lastTurnId?(conductorSessionId: string): string | null;
  lastTurnError?(conductorSessionId: string): string | null;
  transcript(conductorSessionId: string, limit: number, before?: number | null): TranscriptResult;
  workBetween?(conductorSessionId: string, messageId: string): WorkSteps | null;
  send(
    conductorSessionId: string,
    text: string,
    onFailed: ReplyFailureHandler,
    options?: ReplyOptions,
  ): Promise<ReplyOutcome>;
}

export interface FleetReplyRouterDependencies {
  conductor: ConductorSide;
  /** Without it only Conductor chats can be answered, as before. */
  terminal?: TerminalReplier | null;
  /** Squeak's own session host's chats; without it they are watch-only. */
  native?: NativeReplier | null;
  /** The monitor's current view, to resolve a fleet key back to its session. */
  sessions: () => FleetSession[];
}

/**
 * One replier for every surface — Telegram, the Mac window — that sends each
 * target to whichever side can answer it. Conductor chats keep their route
 * (its window, then the background CLI); a terminal agent is typed into.
 */
export class FleetReplyRouter implements FleetReplier {
  constructor(private readonly deps: FleetReplyRouterDependencies) {}

  canReply(session: FleetSession): boolean {
    if (session.conductorSessionId) {
      return true;
    }
    if (session.origin === "squeak") {
      return this.deps.native?.canReply(session) ?? false;
    }
    return this.deps.terminal?.canReply(session) ?? false;
  }

  lastTurnText(target: string): string | null {
    if (!isFleetKey(target)) {
      return this.deps.conductor.lastTurnText(target);
    }
    const session = this.resolve(target);
    if (isNativeKey(target)) {
      return session ? (this.deps.native?.lastTurnText(session) ?? null) : null;
    }
    return session && this.deps.terminal?.canReply(session) ? this.deps.terminal.lastTurnText(session) : null;
  }

  /**
   * The newest turn's id, for refusing an answer to a turn that has moved on.
   * A Conductor chat reads its database; a terminal agent its transcript.
   */
  lastTurnId(target: string): string | null {
    if (!isFleetKey(target)) {
      return this.deps.conductor.lastTurnId?.(target) ?? null;
    }
    const session = this.resolve(target);
    if (session?.conductorSessionId) {
      return this.deps.conductor.lastTurnId?.(session.conductorSessionId) ?? null;
    }
    if (isNativeKey(target)) {
      return null;
    }
    return session && this.deps.terminal?.canReply(session) ? this.deps.terminal.lastTurnId(session) : null;
  }

  /** Why a Conductor chat's newest turn failed. Terminal agents have no such record. */
  lastTurnError(target: string): string | null {
    return isFleetKey(target) ? null : (this.deps.conductor.lastTurnError?.(target) ?? null);
  }

  /** Readable history. Terminal agents have no cheap reader yet, so they get none. */
  transcript(target: string, limit: number, before?: number | null): TranscriptResult {
    if (!isFleetKey(target)) {
      return this.deps.conductor.transcript(target, limit, before);
    }
    const session = this.resolve(target);
    if (session?.conductorSessionId) {
      return this.deps.conductor.transcript(session.conductorSessionId, limit, before);
    }
    return { messages: [], complete: false, nextBefore: null };
  }

  /** The work between two messages of a Conductor chat; terminal agents have none. */
  workBetween(target: string, messageId: string): WorkSteps | null {
    if (isFleetKey(target)) return null;
    return this.deps.conductor.workBetween?.(target, messageId) ?? null;
  }

  async send(
    target: string,
    text: string,
    onFailed: ReplyFailureHandler,
    options: ReplyOptions = {},
  ): Promise<ReplyOutcome> {
    if (!isFleetKey(target)) {
      return this.deps.conductor.send(target, text, onFailed, options);
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
    // A session Conductor adopted since the card was sent goes through Conductor.
    if (session.conductorSessionId) {
      return this.deps.conductor.send(session.conductorSessionId, text, onFailed, options);
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
