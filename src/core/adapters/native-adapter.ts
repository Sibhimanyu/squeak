import type { AgentCapabilities, SqueakAgentAdapter } from "../adapter.js";
import type { AgentEvent } from "../events.js";
import type { AgentSession, SessionId } from "../types.js";
import { nativeSessionId } from "../../fleet/native-reply.js";
import { discoverFor, findOwned, noEvents, type FleetObservation } from "./fleet-ports.js";

/** Narrow slice of NativeHostClient: the two calls it really has for a chat. */
export interface NativeHostPort {
  send(id: string, text: string, mode?: "queue" | "steer"): Promise<{ queued: boolean }>;
  interrupt(id: string): Promise<void>;
}

export interface SqueakNativeAdapterDeps {
  observe: FleetObservation;
  client: NativeHostPort;
}

/**
 * Chats Squeak's own session host runs (`origin: "squeak"`). The host client can send a message and interrupt
 * the running turn, so those are claimed (`stop` interrupts the turn; the chat stays). It cannot start a chat
 * (no route in `src/native/client.ts`), answer a question by id here, or steer, so none of those is claimed.
 */
export class SqueakNativeAdapter implements SqueakAgentAdapter {
  readonly provider = "squeak" as const;
  readonly capabilities: AgentCapabilities = {
    messaging: true,
    questions: false,
    approvals: false,
    steering: false,
    startSession: false,
    stopSession: true,
    structuredTools: false,
  };

  constructor(private readonly deps: SqueakNativeAdapterDeps) {}

  discoverSessions(): Promise<AgentSession[]> {
    return discoverFor(this.deps.observe, this.provider);
  }

  async send(sessionId: SessionId, text: string): Promise<void> {
    const session = await findOwned(this.deps.observe, this.provider, sessionId);
    await this.deps.client.send(nativeSessionId(session.key), text);
  }

  async stop(sessionId: SessionId): Promise<void> {
    const session = await findOwned(this.deps.observe, this.provider, sessionId);
    await this.deps.client.interrupt(nativeSessionId(session.key));
  }

  eventStream(): AsyncIterable<AgentEvent> {
    return noEvents();
  }
}
