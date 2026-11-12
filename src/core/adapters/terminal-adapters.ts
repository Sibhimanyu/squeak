import type { AgentCapabilities, SqueakAgentAdapter } from "../adapter.js";
import type { AgentEvent } from "../events.js";
import type { AgentProvider, AgentSession, SessionId } from "../types.js";
import type { FleetSession } from "../../fleet/types.js";
import type { ReplyOutcome } from "../../fleet/reply-types.js";
import { assertSent } from "./assert-sent.js";
import { discoverFor, findOwned, noEvents, type FleetObservation } from "./fleet-ports.js";

/** Narrow slice of TerminalReplier: it types into the session's Terminal tab. */
export interface TerminalSendPort {
  send(session: FleetSession, text: string): Promise<ReplyOutcome>;
}

export interface TerminalAdapterDeps {
  observe: FleetObservation;
  terminal: TerminalSendPort;
}

/** Messaging only: a terminal agent is typed into; it cannot be started, stopped or answered structurally. */
class TerminalAdapter implements SqueakAgentAdapter {
  readonly capabilities: AgentCapabilities = {
    messaging: true,
    questions: false,
    approvals: false,
    steering: false,
    startSession: false,
    stopSession: false,
    structuredTools: false,
  };

  constructor(
    readonly provider: AgentProvider,
    private readonly deps: TerminalAdapterDeps,
  ) {}

  discoverSessions(): Promise<AgentSession[]> {
    return discoverFor(this.deps.observe, this.provider);
  }

  async send(sessionId: SessionId, text: string): Promise<void> {
    const session = await findOwned(this.deps.observe, this.provider, sessionId);
    assertSent(await this.deps.terminal.send(session, text));
  }

  eventStream(): AsyncIterable<AgentEvent> {
    return noEvents();
  }
}

export class ClaudeCodeTerminalAdapter extends TerminalAdapter {
  constructor(deps: TerminalAdapterDeps) {
    super("claudeCode", deps);
  }
}

export class CodexTerminalAdapter extends TerminalAdapter {
  constructor(deps: TerminalAdapterDeps) {
    super("codex", deps);
  }
}
