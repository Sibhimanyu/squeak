import type { AgentCapabilities, AgentResponse, SqueakAgentAdapter } from "../adapter.js";
import type { AgentEvent } from "../events.js";
import type { AgentSession, SessionId } from "../types.js";
import type { ReplyFailureHandler, ReplyOptions, ReplyOutcome } from "../../fleet/session-reply.js";
import { replyTargetFor } from "../../fleet/reply-router.js";
import { discoverFor, findOwned, noEvents, type FleetObservation } from "./fleet-ports.js";

/** Narrow slice of ConductorReplier / FleetReplyRouter: `send` by target. */
export interface ConductorSendPort {
  send(target: string, text: string, onFailed: ReplyFailureHandler, options?: ReplyOptions): Promise<ReplyOutcome>;
}

export interface ConductorAdapterDeps {
  observe: FleetObservation;
  replier: ConductorSendPort;
  /** Told when a background reply fails after `send` returned. */
  onReplyFailed?: (sessionId: SessionId, message: string) => void;
}

/**
 * Conductor chats. No start/stop/steering: `close-chat.ts` only closes a tab
 * and `chat-setup.ts` resolves settings, and steering exists only as a reply
 * mode inside the relay, so none is claimed. `respond` answers a question by
 * replying with its text (the replier refuses a chat Conductor holds blocked).
 */
export class ConductorAdapter implements SqueakAgentAdapter {
  readonly provider = "conductor" as const;
  readonly capabilities: AgentCapabilities = {
    messaging: true,
    questions: true,
    approvals: false,
    steering: false,
    startSession: false,
    stopSession: false,
    structuredTools: false,
  };

  constructor(private readonly deps: ConductorAdapterDeps) {}

  discoverSessions(): Promise<AgentSession[]> {
    return discoverFor(this.deps.observe, this.provider);
  }

  async send(sessionId: SessionId, text: string): Promise<void> {
    const session = await findOwned(this.deps.observe, this.provider, sessionId);
    const outcome = await this.deps.replier.send(replyTargetFor(session), text, (message) =>
      this.deps.onReplyFailed?.(sessionId, message),
    );
    assertSent(outcome);
  }

  async respond(sessionId: SessionId, response: AgentResponse): Promise<void> {
    const text = response.text ?? response.actionId;
    if (!text) throw new Error("A response needs text or an actionId");
    return this.send(sessionId, text);
  }

  eventStream(): AsyncIterable<AgentEvent> {
    return noEvents();
  }
}

export function assertSent(outcome: ReplyOutcome): void {
  if (outcome.status === "started") return;
  throw new Error(outcome.reason);
}
