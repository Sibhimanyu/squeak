import type { AgentEvent } from "./events.js";
import type { AgentProvider, AgentSession, SessionId } from "./types.js";

export interface AgentCapabilities {
  readonly messaging: boolean;
  readonly questions: boolean;
  readonly approvals: boolean;
  readonly steering: boolean;
  readonly startSession: boolean;
  readonly stopSession: boolean;
  readonly structuredTools: boolean;
}

export type AgentCapability = keyof AgentCapabilities;

export interface StartSessionRequest {
  projectId: string;
  workspacePath?: string;
  prompt?: string;
  model?: string;
}

export interface AgentResponse {
  /** Answers a question or permission request by its id. */
  requestId: string;
  actionId?: string;
  text?: string;
}

/**
 * Optional methods must be present exactly when the matching capability is
 * true: `startSession` <-> startSession, `stop` <-> stopSession, `send` <->
 * messaging, `respond` <-> questions or approvals.
 */
export interface SqueakAgentAdapter {
  readonly provider: AgentProvider;
  readonly capabilities: AgentCapabilities;
  discoverSessions(): Promise<AgentSession[]>;
  startSession?(request: StartSessionRequest): Promise<AgentSession>;
  send?(sessionId: SessionId, text: string): Promise<void>;
  stop?(sessionId: SessionId): Promise<void>;
  respond?(sessionId: SessionId, response: AgentResponse): Promise<void>;
  eventStream(sessionId: SessionId): AsyncIterable<AgentEvent>;
}

/** True only when the capability is claimed AND its method exists. */
export function supports(adapter: SqueakAgentAdapter, cap: AgentCapability): boolean {
  if (!adapter.capabilities[cap]) return false;
  switch (cap) {
    case "startSession":
      return typeof adapter.startSession === "function";
    case "stopSession":
      return typeof adapter.stop === "function";
    case "messaging":
      return typeof adapter.send === "function";
    case "questions":
    case "approvals":
      return typeof adapter.respond === "function";
    default:
      return true;
  }
}
