import type { TranscriptResult } from "./transcript.js";
import type { FleetReplier } from "./fleet-controller.js";
import {
  STEER_UNAVAILABLE_NOTE,
  type ReplyFailureHandler,
  type ReplyOptions,
  type ReplyOutcome,
} from "./session-reply.js";
import type { TerminalReplier } from "./terminal-reply.js";
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
  lastTurnError?(conductorSessionId: string): string | null;
  transcript(conductorSessionId: string, limit: number): TranscriptResult;
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
    return this.deps.terminal?.canReply(session) ?? false;
  }

  lastTurnText(target: string): string | null {
    if (!isFleetKey(target)) {
      return this.deps.conductor.lastTurnText(target);
    }
    const session = this.resolve(target);
    return session && this.deps.terminal?.canReply(session) ? this.deps.terminal.lastTurnText(session) : null;
  }

  /** Why a Conductor chat's newest turn failed. Terminal agents have no such record. */
  lastTurnError(target: string): string | null {
    return isFleetKey(target) ? null : (this.deps.conductor.lastTurnError?.(target) ?? null);
  }

  /** Readable history. Terminal agents have no cheap reader yet, so they get none. */
  transcript(target: string, limit: number): TranscriptResult {
    if (!isFleetKey(target)) {
      return this.deps.conductor.transcript(target, limit);
    }
    const session = this.resolve(target);
    if (session?.conductorSessionId) {
      return this.deps.conductor.transcript(session.conductorSessionId, limit);
    }
    return { messages: [], complete: false };
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
