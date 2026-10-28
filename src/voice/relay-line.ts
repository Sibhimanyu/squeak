import type { RtdbRest } from "../remote/rtdb-rest.js";
import type { CallResult } from "./baresip-line.js";
import type { CallScript } from "./dialog.js";
import { newCallId, readResult, REQUEST_TTL_MS, requestPath, resultPath, sealRequest } from "./relay-protocol.js";

/** What a call needs from a line: the script to read, and whether a key may answer it. */
export interface VoiceLine {
  call(script: CallScript, answerable: boolean): Promise<CallResult>;
}

/** After a request expires the gateway may still be mid-call; this is the longest one it allows. */
const MAX_CALL_MS = 4 * 60_000;
/** The stream only wakes a pass; this is the safety net and the way to notice a lost event. */
const POLL_MS = 10_000;

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
    const { store, channel, key } = this.options;
    const id = newCallId();
    const at = this.now();
    const offered = script.options.map((option) => option.letter);
    const callee = this.options.callee?.() ?? null;
    try {
      await store.set(
        requestPath(channel, id),
        sealRequest(key, {
          v: 1,
          id,
          at,
          expiresAt: at + REQUEST_TTL_MS,
          answerable,
          script,
          ...(callee ? { callee } : {}),
        }),
      );
    } catch (error) {
      return {
        status: "failed",
        reason: `Could not reach the relay: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const deadline = at + REQUEST_TTL_MS + MAX_CALL_MS;
    try {
      return await new Promise<CallResult>((resolve) => {
        let settled = false;
        let reading = false;
        let again = false;
        const finish = (result: CallResult): void => {
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
            const doc = await store.get(resultPath(channel, id));
            const result = doc ? readResult(key, id, doc, offered) : null;
            if (result) return finish(result);
            if (this.now() > deadline) {
              finish({ status: "failed", reason: "The gateway did not answer. Is the Home Assistant add-on running?" });
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
