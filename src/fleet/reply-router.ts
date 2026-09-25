import type { FleetReplier } from "./fleet-controller.js";
import type { ReplyFailureHandler, ReplyOutcome } from "./session-reply.js";
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
  send(conductorSessionId: string, text: string, onFailed: ReplyFailureHandler): Promise<ReplyOutcome>;
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

  async send(target: string, text: string, onFailed: ReplyFailureHandler): Promise<ReplyOutcome> {
    if (!isFleetKey(target)) {
      return this.deps.conductor.send(target, text, onFailed);
    }
    const session = this.resolve(target);
    if (!session) {
      return { status: "refused", reason: "That session is no longer being tracked." };
    }
    // A session Conductor adopted since the card was sent goes through Conductor.
    if (session.conductorSessionId) {
      return this.deps.conductor.send(session.conductorSessionId, text, onFailed);
    }
    if (!this.deps.terminal?.canReply(session)) {
      return { status: "refused", reason: "That session cannot be replied to from here." };
    }
    return this.deps.terminal.send(session, text);
  }

  private resolve(key: string): FleetSession | null {
    return this.deps.sessions().find((session) => session.key === key) ?? null;
  }
}
