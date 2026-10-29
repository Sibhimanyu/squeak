import type { RtdbRest } from "../remote/rtdb-rest.js";
import type { CallResult } from "./baresip-line.js";
import type { CallScript } from "./dialog.js";
import type { ChannelDoc } from "../remote/firestore-rest.js";
import {
  newCallId,
  readResult,
  REQUEST_TTL_MS,
  requestPath,
  resultPath,
  sealPinChange,
  sealPinControl,
  type PinAction,
  type PinControlAction,
  sealRequest,
  type CallResultBody,
} from "./relay-protocol.js";

/** What a call needs from a line: the script to read, and whether a key may answer it. */
export interface VoiceLine {
  call(script: CallScript, answerable: boolean): Promise<CallResult>;
}

/** After a request expires the gateway may still be mid-call; this is the longest one it allows. */
const MAX_CALL_MS = 4 * 60_000;
/** The stream only wakes a pass; this is the safety net and the way to notice a lost event. */
const POLL_MS = 10_000;
/** The gateway answers a pin change in a moment or not at all. */
const PIN_WAIT_MS = 25_000;

/** What a pin control says when nothing answers: an add-on from before `pinctl` ignores it. */
export const OLD_ADDON = "The Home Assistant add-on is too old to do that: update it.";

export type RelayStore = Pick<RtdbRest, "get" | "set" | "delete" | "watch">;

export interface RelayLineOptions {
  store: RelayStore;
  channel: string;
  /** The base64 key shared with the gateway (`squeak voice-relay` writes it). */
  key: string;
  /** The extension to ring now (the Mac's voice settings); null leaves it to the gateway's default. */
  callee?: () => string | null;
  now?: () => number;
}

/**
 * The Mac's line when the call is placed by the Home Assistant gateway: it writes a sealed request into
 * the Realtime Database and waits for the signed result. The Mac holds no SIP credentials and needs no
 * route to the PBX, so this works from any network.
 */
export class RelayLine implements VoiceLine {
  private readonly now: () => number;

  constructor(private readonly options: RelayLineOptions) {
    this.now = options.now ?? Date.now;
  }

  async call(script: CallScript, answerable: boolean): Promise<CallResult> {
    const { key } = this.options;
    const id = newCallId();
    const at = this.now();
    const callee = this.options.callee?.() ?? null;
    const doc = sealRequest(key, {
      v: 1,
      id,
      at,
      expiresAt: at + REQUEST_TTL_MS,
      answerable,
      script,
      ...(callee ? { callee } : {}),
    });
    const result = await this.roundTrip(
      id,
      doc,
      script.options.map((option) => option.letter),
      at + REQUEST_TTL_MS + MAX_CALL_MS,
    );
    if (result.status === "answered" || result.status === "unanswered" || result.status === "failed") return result;
    return { status: "failed", reason: "The gateway answered with something else." };
  }

  /**
   * Asks the gateway to change its pin. It needs the current one: a holder of the channel key alone cannot set their
   * own. The gateway answers within seconds; neither pin is kept here.
   */
  async changePin(current: string, next: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const id = newCallId();
    const at = this.now();
    const doc = sealPinChange(this.options.key, {
      v: 1,
      id,
      at,
      expiresAt: at + PIN_WAIT_MS,
      kind: "pin",
      current,
      next,
    });
    const result = await this.roundTrip(id, doc, [], at + PIN_WAIT_MS);
    if (result.status === "pin") return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    return {
      ok: false,
      reason: result.status === "failed" ? result.reason : "The gateway answered with something else.",
    };
  }

  /**
   * Turn the pin off or on, reset it, or ask its state; a `change` goes the older way, byte for byte. A gateway that
   * predates `pinctl` never answers, so a silent one is reported as too old rather than as unreachable.
   */
  async pinControl(
    action: PinAction | { action: "status" },
  ): Promise<{ ok: true; state: "set" | "off" | "none" } | { ok: false; reason: string }> {
    if (action.action === "change") {
      const done = await this.changePin(action.current, action.next);
      return done.ok ? { ok: true, state: "set" } : done;
    }
    const id = newCallId();
    const at = this.now();
    const request: PinControlAction = action;
    const doc = sealPinControl(this.options.key, {
      v: 1,
      id,
      at,
      expiresAt: at + PIN_WAIT_MS,
      kind: "pinctl",
      ...request,
    });
    const result = await this.roundTrip(id, doc, [], at + PIN_WAIT_MS, OLD_ADDON);
    if (result.status === "pinctl")
      return result.ok ? { ok: true, state: result.state } : { ok: false, reason: result.reason };
    return {
      ok: false,
      reason: result.status === "failed" ? result.reason : "The gateway answered with something else.",
    };
  }

  /** Writes one request and waits for its result; never throws, and leaves nothing behind. */
  private async roundTrip(
    id: string,
    doc: ChannelDoc,
    offered: readonly string[],
    deadline: number,
    silent = "The gateway did not answer. Is the Home Assistant add-on running?",
  ): Promise<CallResultBody> {
    const { store, channel, key } = this.options;
    try {
      await store.set(requestPath(channel, id), doc);
    } catch (error) {
      return {
        status: "failed",
        reason: `Could not reach the relay: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    try {
      return await new Promise<CallResultBody>((resolve) => {
        let settled = false;
        let reading = false;
        let again = false;
        const finish = (result: CallResultBody): void => {
          if (settled) return;
          settled = true;
          unwatch();
          clearInterval(poll);
          resolve(result);
        };
        const check = async (): Promise<void> => {
          if (settled) return;
          if (reading) {
            again = true;
            return;
          }
          reading = true;
          try {
            const got = await store.get(resultPath(channel, id));
            const result = got ? readResult(key, id, got, offered) : null;
            if (result) return finish(result);
            if (this.now() > deadline) {
              finish({ status: "failed", reason: silent });
            }
          } catch {
            // The next event or poll tries again; the deadline ends it.
            if (this.now() > deadline) finish({ status: "failed", reason: "The relay could not be read." });
          } finally {
            reading = false;
            if (again) {
              again = false;
              void check();
            }
          }
        };
        const unwatch = store.watch(`channels/${channel}/voiceresult`, () => void check());
        const poll = setInterval(() => void check(), POLL_MS);
        poll.unref?.();
      });
    } finally {
      // Either side may have left a document: nothing here should outlive the call.
      await Promise.allSettled([store.delete(requestPath(channel, id)), store.delete(resultPath(channel, id))]);
    }
  }
}

/**
 * The Mac's relay line, wired the way the daemon wires it: the extension to ring is read from the saved voice
 * settings each time, so a change in an app applies to the next call. One place, so a test can pin it.
 */
export function relayLineFor(
  store: RelayStore,
  relay: { channel: string; key: string },
  settings: { settings: { callee: string | null } },
): RelayLine {
  return new RelayLine({ store, channel: relay.channel, key: relay.key, callee: () => settings.settings.callee });
}
