import type { RtdbRest } from "../remote/rtdb-rest.js";
import type { CallResult } from "./baresip-line.js";
import type { Clip } from "./clips.js";
import type { CallScript } from "./dialog.js";
import type { ChannelDoc } from "../remote/firestore-rest.js";
import { audioPath, callAudioId, sealAudio } from "./memo-protocol.js";
import {
  newCallId,
  readResult,
  REQUEST_TTL_MS,
  requestPath,
  resultPath,
  sealGatewayCommand,
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
/** A request that carries the Mac's recorded voice: ~370 KB, at 28-65 KB/s behind this Mac's proxy. */
const AUDIO_WRITE_MS = 90_000;
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
  /**
   * The call's words in the Mac's own voice (voice/natural-voice.ts), made before the request goes out; absent or
   * failing, the add-on speaks everything itself.
   */
  clips?: (script: CallScript, answerable: boolean, onClip?: (clip: Clip) => void) => Promise<Clip[] | undefined>;
  /**
   * True when the add-on can take clips after the call is placed (0.11.0 and newer): the request then goes out at once
   * and `clips` is given an `onClip` to hand over each clip as it is made. False or absent: the old way, clips first.
   */
  lateClips?: () => boolean;
  /** A line for the call trace: when dialling started, and when each clip was made and sent. */
  trace?: (text: string) => void;
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
    if (this.options.clips && this.options.lateClips?.()) return this.callWithLateClips(id, script, answerable);
    // Made first: the request's clock starts when it is written, not while the voice is being recorded.
    const audio = await this.options.clips?.(script, answerable).catch(() => undefined);
    const at = this.now();
    const callee = this.options.callee?.() ?? null;
    const base = { v: 1 as const, id, at, expiresAt: at + REQUEST_TTL_MS, answerable, script };
    const doc = sealRequest(key, { ...base, ...(audio ? { audio } : {}), ...(callee ? { callee } : {}) });
    // The clips make the request big and this Mac's uplink is slow: a long write, and if it still fails the call
    // goes without them rather than not at all.
    const plain = audio ? sealRequest(key, { ...base, ...(callee ? { callee } : {}) }) : undefined;
    const result = await this.roundTrip(
      id,
      doc,
      script.options.map((option) => option.letter),
      at + REQUEST_TTL_MS + MAX_CALL_MS,
      undefined,
      plain,
    );
    if (result.status === "answered" || result.status === "unanswered" || result.status === "failed") return result;
    return { status: "failed", reason: "The gateway answered with something else." };
  }

  /**
   * The call goes out at once, so the phone rings now; the Mac's voice is made while it rings and each clip is written
   * as its own document the add-on picks up (`audioFollows`). Whatever is not there when a line is spoken is spoken
   * by the add-on's own voice, so a slow render never leaves the line silent.
   */
  private async callWithLateClips(id: string, script: CallScript, answerable: boolean): Promise<CallResult> {
    const { key, store, channel, trace } = this.options;
    const at = this.now();
    const callee = this.options.callee?.() ?? null;
    const doc = sealRequest(key, {
      v: 1,
      id,
      at,
      expiresAt: at + REQUEST_TTL_MS,
      answerable,
      script,
      audioFollows: true,
      ...(callee ? { callee } : {}),
    });
    const written: string[] = [];
    let finished = false;
    let chain: Promise<void> = Promise.resolve();
    const onClip = (clip: Clip): void => {
      chain = chain.then(async () => {
        if (finished) return;
        const docId = callAudioId(id, written.length);
        try {
          await store.set(audioPath(channel, docId), sealAudio(key, docId, id, [clip], this.now()), {
            timeoutMs: AUDIO_WRITE_MS,
          });
          written.push(docId);
          trace?.(
            `Voice clip ${written.length} sent to the add-on ${((this.now() - at) / 1000).toFixed(1)} s after dialling`,
          );
        } catch {
          trace?.("A voice clip could not be sent; the add-on speaks that line itself");
        }
      });
    };
    trace?.("Dialling started: the voice clips follow while it rings");
    // Rendering starts after the request is written (it must not delay the ring), and never throws.
    const rendering = this.options.clips!(script, answerable, onClip).catch(() => undefined);
    void rendering.then(() =>
      trace?.(`Voice clips finished ${((this.now() - at) / 1000).toFixed(1)} s after dialling`),
    );
    try {
      const result = await this.roundTrip(
        id,
        doc,
        script.options.map((option) => option.letter),
        at + REQUEST_TTL_MS + MAX_CALL_MS,
      );
      if (result.status === "answered" || result.status === "unanswered" || result.status === "failed") return result;
      return { status: "failed", reason: "The gateway answered with something else." };
    } finally {
      finished = true;
      await chain.catch(() => undefined);
      await Promise.allSettled(written.map((docId) => store.delete(audioPath(channel, docId))));
    }
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
  ): Promise<
    | { ok: true; state: "set" | "off" | "none"; policy?: { outgoing: "ask" | "skip"; incoming: "ask" | "skip" } }
    | { ok: false; reason: string }
  > {
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
      return result.ok
        ? { ok: true, state: result.state, ...(result.policy ? { policy: result.policy } : {}) }
        : { ok: false, reason: result.reason };
    return {
      ok: false,
      reason: result.status === "failed" ? result.reason : "The gateway answered with something else.",
    };
  }

  /**
   * Tells the add-on to update itself (it checks it is behind, then asks Home Assistant, which restarts it). The answer
   * says it was started, not that it finished: the add-on is gone a moment later. A silent add-on is one from before
   * `gwcmd`.
   */
  async gatewayCommand(action: "update"): Promise<{ ok: true } | { ok: false; reason: string }> {
    const id = newCallId();
    const at = this.now();
    const doc = sealGatewayCommand(this.options.key, {
      v: 1,
      id,
      at,
      expiresAt: at + PIN_WAIT_MS,
      kind: "gwcmd",
      action,
    });
    const result = await this.roundTrip(id, doc, [], at + PIN_WAIT_MS, OLD_ADDON);
    if (result.status === "gwcmd") return result.ok ? { ok: true } : { ok: false, reason: result.reason };
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
    withoutAudio?: ChannelDoc,
  ): Promise<CallResultBody> {
    const { store, channel, key } = this.options;
    try {
      try {
        await store.set(requestPath(channel, id), doc, withoutAudio ? { timeoutMs: AUDIO_WRITE_MS } : {});
      } catch (error) {
        if (!withoutAudio) throw error;
        await store.set(requestPath(channel, id), withoutAudio);
      }
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
  clips?: RelayLineOptions["clips"],
  extra: Pick<RelayLineOptions, "lateClips" | "trace"> = {},
): RelayLine {
  return new RelayLine({
    store,
    channel: relay.channel,
    key: relay.key,
    callee: () => settings.settings.callee,
    ...(clips ? { clips } : {}),
    ...extra,
  });
}
