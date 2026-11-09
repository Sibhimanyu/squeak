import type { ChatStarter } from "./new-chat.js";
import type { RelayRequest } from "./answer-relay.js";

/**
 * Stands in for Conductor's local relay (`conductor-relay/`) when it is not loaded, which is every build we
 * distribute: it is never connected, so `ConductorReplier` skips that route and answers through Conductor's
 * window or the background CLI. Imports nothing from the relay folder, so none of its code is in the bundle.
 */
export const RELAY_OFF_REASON = "Conductor's relay isn't available in this build.";

export class OffConductorRelay {
  isReady(): boolean {
    return false;
  }
  lastHostAt(): number | null {
    return null;
  }
  requestFn(): RelayRequest | null {
    return null;
  }
  async send(): Promise<{ ok: false; reason: string }> {
    return { ok: false, reason: RELAY_OFF_REASON };
  }
  startChat: ChatStarter["startChat"] = async () => ({ ok: false, reason: RELAY_OFF_REASON });
  start(): void {}
  async stop(): Promise<void> {}
}

/** `SQUEAK_CONDUCTOR_RELAY=on` is the only switch that loads the relay. */
export function relayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SQUEAK_CONDUCTOR_RELAY?.trim().toLowerCase() === "on";
}
