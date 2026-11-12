import type { ChatStarter } from "../../src/fleet/chat-starter.js";
import type { RelayRequest } from "./answer-relay.js";
import type { ConductorRelaySender } from "./replier.js";

/** The service name the relay add-on provides its route under (`AddonServices`). */
export const CONDUCTOR_ROUTE_SERVICE = "conductor.route";
/** Provided by this add-on for the relay add-on: where Conductor's database is. */
export const CONDUCTOR_SERVICE = "conductor";

export interface ConductorService {
  dbPath: string;
}

/** A way into a Conductor chat besides typing into its window and the background CLI; tried first when ready. */
export interface ConductorRoute extends ConductorRelaySender, ChatStarter {
  isReady(): boolean;
  lastHostAt(): number | null;
  requestFn(): RelayRequest | null;
  start(): void;
  stop(): Promise<void>;
}

export const RELAY_OFF_REASON = "Conductor's relay isn't available in this build.";

/** The route when no add-on supplies one: never connected, so every caller falls through to the other routes. */
export class NoConductorRoute implements ConductorRoute {
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

/**
 * The relay add-on's route, looked up at call time (it loads at start, after this add-on) and refused with a plain
 * sentence while Conductor is not enabled.
 */
export class LateConductorRoute implements ConductorRoute {
  constructor(
    private readonly lookup: () => ConductorRoute | undefined,
    private readonly enabled: () => boolean,
    private readonly notEnabled: string,
  ) {}
  private inner(): ConductorRoute {
    return this.enabled() ? (this.lookup() ?? new NoConductorRoute()) : new NoConductorRoute();
  }
  isReady(): boolean {
    return this.inner().isReady();
  }
  lastHostAt(): number | null {
    return this.inner().lastHostAt();
  }
  requestFn(): RelayRequest | null {
    return this.inner().requestFn();
  }
  send: ConductorRoute["send"] = async (args) =>
    this.enabled() ? this.inner().send(args) : { ok: false, reason: this.notEnabled };
  startChat: ChatStarter["startChat"] = async (args) =>
    this.enabled() ? this.inner().startChat(args) : { ok: false, reason: this.notEnabled };
  start(): void {}
  async stop(): Promise<void> {}
}
