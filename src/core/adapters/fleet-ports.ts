import type { AgentEvent } from "../events.js";
import { asSessionId, type AgentProvider, type AgentSession, type SessionId } from "../types.js";
import type { FleetSession } from "../../fleet/types.js";
import { providerFor, toAgentSession } from "./state-map.js";

/** The fleet's current sessions, however the caller gets them (monitor snapshot, observers). */
export type FleetObservation = () => Promise<FleetSession[]>;

/** Sessions Squeak's own host runs belong to no provider here. */
export function ownedBy(provider: AgentProvider, session: FleetSession): boolean {
  return session.origin !== "squeak" && providerFor(session) === provider;
}

export async function discoverFor(observe: FleetObservation, provider: AgentProvider): Promise<AgentSession[]> {
  return (await observe()).filter((s) => ownedBy(provider, s)).map((s) => toAgentSession(s));
}

export async function findOwned(
  observe: FleetObservation,
  provider: AgentProvider,
  sessionId: SessionId,
): Promise<FleetSession> {
  const found = (await observe()).find((s) => asSessionId(s.key) === sessionId && ownedBy(provider, s));
  if (!found) throw new Error(`No ${provider} session ${sessionId}`);
  return found;
}

/** No adapter streams yet: live events still come from the fleet's own feeds. */
export async function* noEvents(): AsyncIterable<AgentEvent> {}
