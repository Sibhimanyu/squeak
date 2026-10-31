import { logger } from "../utils/logger.js";
import type { RtdbRest } from "../remote/rtdb-rest.js";
import type { CallResult } from "./baresip-line.js";
import type { Clip } from "./clips.js";
import { CallDialog } from "./dialog.js";
import {
  readGatewayCommand,
  readPinChange,
  readPinControl,
  readRequest,
  requestPath,
  REQUEST_KIND,
  resultPath,
  sealResult,
  type CallResultDoc,
} from "./relay-protocol.js";
import { audioPath, callAudioId, readAudio } from "./memo-protocol.js";
import type { PinKeeper } from "./pin-keeper.js";
import type { AddonUpdater } from "./addon-update.js";

export type GatewayStore = Pick<RtdbRest, "get" | "list" | "set" | "delete" | "watch">;

export interface GatewayDependencies {
  store: GatewayStore;
  channel: string;
  key: string;
  /** Places the call to the owner's phone and runs the dialog (`BaresipLine.call`). */
  line: {
    call(
      callee: string,
      dialog: CallDialog,
      audio?: Clip[],
      macVoice?: boolean,
      followUp?: { callId: string; label: string },
    ): Promise<CallResult>;
  };
  /** The extension to ring when a request names none. A request may name one, but only an internal extension (checked on reading it). */
  callee: string | null;
  /** Read at each call, so a pin changed from an app applies at once. Null: calls tell, never take an answer. */
  pin: () => string | null;
  /** Read at each call: false when the pin was turned off on purpose, so keys answer without one. Default true. */
  pinRequired?: () => boolean;
  /** Answers pin changes and controls; absent: such a request is refused. */
  /** Read at each call: whether a call can take a key answer at all (the keeper's rule); default true. */
  canAnswer?: () => boolean;
  pins?: Pick<PinKeeper, "change" | "disable" | "enable" | "reset" | "status" | "policy" | "setPolicy"> | null;
  /** Updates the add-on on the Mac's word; absent: such a command is refused. */
  updater?: (Pick<AddonUpdater, "update" | "latest"> & Partial<Pick<AddonUpdater, "look" | "reloadStore">>) | null;
  /** Publishes the add-on's status now (`startStatusReporter`'s send); absent: the next 30 s report carries it. */
  publishStatus?: () => void;
  /**
   * Hands the Mac's clips to the phone as they arrive during a call (a request with `audioFollows`); absent: they are
   * ignored and the add-on speaks everything itself.
   */
  seed?: (clips: Clip[]) => void;
  now?: () => number;
  /** A plain sentence for the apps' gateway log; never a pin, a question or a key. */
  onEvent?: (level: "info" | "warn", text: string) => void;
}

function pinControlSentence(action: "disable" | "enable" | "reset", ok: boolean): string {
  const done = { disable: "PIN turned off", enable: "PIN turned on", reset: "PIN reset" }[action];
  const refused = { disable: "PIN turn-off", enable: "PIN turn-on", reset: "PIN reset" }[action];
  return ok ? done : `${refused} refused`;
}

/** Only the two words each; never a pin. */
function policySentence(p: { outgoing: string; incoming: string }, ok: boolean): string {
  return ok ? `PIN policy changed: outgoing ${p.outgoing}, incoming ${p.incoming}` : "PIN policy change refused";
}

const SAFETY_POLL_MS = 60_000;
const REMEMBER = 200;

/**
 * The Home Assistant half of voice: watches the channel for call requests from the Mac, places each call
 * over the LAN through the SBC, and writes the signed result back. The same checks as every other pipe
 * to the Mac, mirrored: a request counts only if it is sealed with the key, names its own id, is fresh and
 * is new; it is claimed (deleted) before the call so a copy cannot ring twice.
 */
/** Clip documents read at once while a call follows the Mac's clips. */
const CLIP_BATCH = 6;

export class VoiceGateway {
  private readonly now: () => number;
  private unwatch: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = false;
  private dirty = false;
  private readonly handled: string[] = [];

  constructor(private readonly deps: GatewayDependencies) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    this.unwatch = this.deps.store.watch(`channels/${this.deps.channel}/${REQUEST_KIND}`, () => this.wake(), {
      onError: (error) => logger.warn("voice gateway stream", { error: error.message }),
    });
    this.timer = setInterval(() => this.wake(), SAFETY_POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.unwatch?.();
    this.unwatch = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private wake(): void {
    if (this.stopped) return;
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.running = true;
    void this.pass()
      .catch((error: unknown) =>
        logger.warn("voice gateway pass failed", { error: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => {
        this.running = false;
        if (this.dirty) {
          this.dirty = false;
          this.wake();
        }
      });
  }

  /** One pass over the waiting requests; exposed for tests. */
  async pass(): Promise<void> {
    const { store, channel, key } = this.deps;
    const waiting = await store.list(`channels/${channel}/${REQUEST_KIND}`);
    for (const { id, doc } of waiting) {
      if (this.stopped) return;
      if (this.handled.includes(id)) {
        await store.delete(requestPath(channel, id)).catch(() => undefined);
        continue;
      }
      const read = readRequest(key, id, doc, this.now());
      // Not a call: it may be a pin change, which is also sealed with the key and needs the current pin.
      const pinChange = read.ok ? null : readPinChange(key, id, doc, this.now());
      const pinControl = read.ok || pinChange?.ok ? null : readPinControl(key, id, doc, this.now());
      const gwCommand =
        read.ok || pinChange?.ok || pinControl?.ok ? null : readGatewayCommand(key, id, doc, this.now());
      // Remember it first, synchronously: a second pass (the stream wakes one while another runs) must see
      // it as taken. Then claim: an undeletable document is left for the next pass, never run twice.
      this.handled.push(id);
      if (this.handled.length > REMEMBER) this.handled.shift();
      try {
        await store.delete(requestPath(channel, id));
      } catch (error) {
        this.handled.splice(this.handled.indexOf(id), 1);
        logger.warn("voice gateway could not claim a request", {
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (pinChange?.ok) {
        const outcome = this.deps.pins
          ? this.deps.pins.change(pinChange.request.current, pinChange.request.next)
          : { ok: false as const, reason: "This add-on cannot change its pin from an app." };
        logger.info("voice pin change", { ok: outcome.ok });
        this.deps.onEvent?.(outcome.ok ? "info" : "warn", outcome.ok ? "PIN changed" : "PIN change refused");
        const answer: CallResultDoc = outcome.ok
          ? { v: 1, id, at: this.now(), status: "pin", ok: true }
          : { v: 1, id, at: this.now(), status: "pin", ok: false, reason: outcome.reason };
        await store.set(resultPath(channel, id), sealResult(key, answer));
        continue;
      }
      if (pinControl?.ok) {
        const request = pinControl.request;
        const pins = this.deps.pins;
        const outcome = !pins
          ? { ok: false as const, reason: "This add-on cannot change its pin from an app." }
          : request.action === "status"
            ? { ok: true as const, state: pins.status() }
            : request.action === "policy"
              ? pins.setPolicy({ outgoing: request.outgoing, incoming: request.incoming })
              : request.action === "disable"
                ? pins.disable(request.current)
                : request.action === "enable"
                  ? pins.enable(request.next)
                  : pins.reset(request.next);
        // The action and whether it worked, never a pin.
        logger.info("voice pin control", { action: request.action, ok: outcome.ok });
        if (request.action === "policy")
          this.deps.onEvent?.(outcome.ok ? "info" : "warn", policySentence(request, outcome.ok));
        else if (request.action !== "status")
          this.deps.onEvent?.(outcome.ok ? "info" : "warn", pinControlSentence(request.action, outcome.ok));
        const answer: CallResultDoc = outcome.ok
          ? {
              v: 1,
              id,
              at: this.now(),
              status: "pinctl",
              ok: true,
              state: outcome.state,
              ...(pins ? { policy: pins.policy() } : {}),
            }
          : { v: 1, id, at: this.now(), status: "pinctl", ok: false, reason: outcome.reason };
        await store.set(resultPath(channel, id), sealResult(key, answer));
        continue;
      }
      if (gwCommand?.ok) {
        if (gwCommand.request.action === "check") await this.checkFromMac(id);
        else await this.updateFromMac(id);
        continue;
      }
      if (!read.ok) {
        logger.info("voice gateway dropped a request", { reason: read.reason });
        continue;
      }
      const { request } = read;
      const callee = request.callee ?? this.deps.callee;
      const answerable = request.answerable && (this.deps.canAnswer?.() ?? true);
      const stopFollowing = request.audioFollows ? this.followClips(id) : null;
      let result: CallResult;
      try {
        result = callee
          ? await this.deps.line.call(
              callee,
              // An unanswerable request (the Mac's word, or the keeper's: no pin and outgoing "ask") is tell-only;
              // "pin off" or outgoing "skip" only matters when keys are allowed.
              new CallDialog(
                request.script,
                answerable ? this.deps.pin() : null,
                answerable ? (this.deps.pinRequired?.() ?? true) : true,
              ),
              request.audio,
              request.audioFollows === true,
              request.script.followUp && answerable ? { callId: id, label: request.script.followUp.label } : undefined,
            )
          : { status: "failed", reason: "No phone extension is set. Set it in Squeak's settings on your Mac." };
      } finally {
        stopFollowing?.();
      }
      const body: CallResultDoc =
        result.status === "answered"
          ? {
              v: 1,
              id,
              at: this.now(),
              status: "answered",
              letter: result.letter,
              ...(result.quality ? { quality: result.quality } : {}),
            }
          : result.status === "unanswered"
            ? { v: 1, id, at: this.now(), status: "unanswered" }
            : { v: 1, id, at: this.now(), status: "failed", reason: result.reason };
      await store.set(resultPath(channel, id), sealResult(key, body));
    }
  }

  /**
   * While one call runs: picks up the Mac's clips as it writes them (`callaudio-<id>-<n>`, in order) and seeds each,
   * so the line uses the Mac's voice for every line spoken after it arrives. Stops with the call.
   */
  private followClips(id: string): (() => void) | null {
    const { store, channel, key, seed } = this.deps;
    if (!seed) return null;
    let next = 0;
    let stopped = false;
    let busy = false;
    let again = false;
    const began = this.now();
    const pull = async (): Promise<void> => {
      if (stopped) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        for (;;) {
          if (stopped) break;
          // Several at once: each read is a round trip on a slow link, and the clips are already all there.
          const first = next;
          const docs = await Promise.all(
            Array.from({ length: CLIP_BATCH }, (_, i) => {
              const docId = callAudioId(id, first + i);
              return store.get(audioPath(channel, docId)).then((doc) => ({ docId, doc }));
            }),
          );
          let got = 0;
          for (const { docId, doc } of docs) {
            if (!doc) break;
            got += 1;
            next += 1;
            const read = readAudio(key, docId, doc);
            if (read && read.version === id && !stopped) {
              seed(read.clips);
              this.deps.onEvent?.(
                "info",
                `Mac voice clip ${next} arrived ${((this.now() - began) / 1000).toFixed(1)} s into the call`,
              );
            }
          }
          if (got < CLIP_BATCH) break;
        }
      } catch {
        // The next event or poll tries again.
      } finally {
        busy = false;
        if (again) {
          again = false;
          void pull();
        }
      }
    };
    const unwatch = store.watch(`channels/${channel}/voicedir`, () => void pull());
    const poll = setInterval(() => void pull(), 2000);
    poll.unref?.();
    void pull();
    return () => {
      stopped = true;
      unwatch();
      clearInterval(poll);
    };
  }

  /**
   * The Mac asked this add-on to update itself. The updater checks that the newest version it found on its own is newer,
   * and tells us just before it asks Home Assistant, because that stops this process: the answer is written first.
   */
  private async updateFromMac(id: string): Promise<void> {
    const { store, channel, key, updater } = this.deps;
    let replied = false;
    const reply = async (answer: CallResultDoc): Promise<void> => {
      replied = true;
      await store.set(resultPath(channel, id), sealResult(key, answer));
    };
    const target = updater?.latest() ?? null;
    const outcome = updater
      ? await updater.update(
          async () => {
            this.deps.onEvent?.("info", `Update to ${target ?? "the newest version"} requested from the Mac`);
            await reply({ v: 1, id, at: this.now(), status: "gwcmd", ok: true });
          },
          (text) => this.deps.onEvent?.("warn", text),
        )
      : { ok: false as const, reason: "This add-on cannot update itself from an app." };
    logger.info("voice gateway update", { ok: outcome.ok, replied });
    if (outcome.ok) return;
    this.deps.onEvent?.("warn", `Update refused: ${outcome.reason}`);
    if (!replied) await reply({ v: 1, id, at: this.now(), status: "gwcmd", ok: false, reason: outcome.reason });
  }

  /** The Mac asked this add-on to look for a newer version now: Home Assistant refreshes, then the repo is read. */
  private async checkFromMac(id: string): Promise<void> {
    const { store, channel, key, updater } = this.deps;
    if (updater?.reloadStore) await updater.reloadStore().catch(() => undefined);
    if (updater?.look) await updater.look().catch(() => undefined);
    this.deps.publishStatus?.();
    this.deps.onEvent?.("info", "Looked for a newer version at the Mac's request");
    logger.info("voice gateway check", { latest: updater?.latest() ?? null });
    await store.set(resultPath(channel, id), sealResult(key, { v: 1, id, at: this.now(), status: "gwcmd", ok: true }));
  }
}
