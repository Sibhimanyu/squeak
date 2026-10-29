import { logger } from "../utils/logger.js";
import type { RtdbRest } from "../remote/rtdb-rest.js";
import type { CallResult } from "./baresip-line.js";
import { CallDialog } from "./dialog.js";
import {
  readPinChange,
  readPinControl,
  readRequest,
  requestPath,
  REQUEST_KIND,
  resultPath,
  sealResult,
  type CallResultDoc,
} from "./relay-protocol.js";
import type { PinKeeper } from "./pin-keeper.js";

export type GatewayStore = Pick<RtdbRest, "list" | "set" | "delete" | "watch">;

export interface GatewayDependencies {
  store: GatewayStore;
  channel: string;
  key: string;
  /** Places the call to the owner's phone and runs the dialog (`BaresipLine.call`). */
  line: { call(callee: string, dialog: CallDialog): Promise<CallResult> };
  /** The extension to ring when a request names none. A request may name one, but only an internal extension (checked on reading it). */
  callee: string | null;
  /** Read at each call, so a pin changed from an app applies at once. Null: calls tell, never take an answer. */
  pin: () => string | null;
  /** Read at each call: false when the pin was turned off on purpose, so keys answer without one. Default true. */
  pinRequired?: () => boolean;
  /** Answers pin changes and controls; absent: such a request is refused. */
  pins?: Pick<PinKeeper, "change" | "disable" | "enable" | "reset" | "status"> | null;
  now?: () => number;
}

const SAFETY_POLL_MS = 60_000;
const REMEMBER = 200;

/**
 * The Home Assistant half of voice: watches the channel for call requests from the Mac, places each call
 * over the LAN through the SBC, and writes the signed result back. The same checks as every other pipe
 * to the Mac, mirrored: a request counts only if it is sealed with the key, names its own id, is fresh and
 * is new; it is claimed (deleted) before the call so a copy cannot ring twice.
 */
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
            : request.action === "disable"
              ? pins.disable(request.current)
              : request.action === "enable"
                ? pins.enable(request.next)
                : pins.reset(request.next);
        // The action and whether it worked, never a pin.
        logger.info("voice pin control", { action: request.action, ok: outcome.ok });
        const answer: CallResultDoc = outcome.ok
          ? { v: 1, id, at: this.now(), status: "pinctl", ok: true, state: outcome.state }
          : { v: 1, id, at: this.now(), status: "pinctl", ok: false, reason: outcome.reason };
        await store.set(resultPath(channel, id), sealResult(key, answer));
        continue;
      }
      if (!read.ok) {
        logger.info("voice gateway dropped a request", { reason: read.reason });
        continue;
      }
      const { request } = read;
      const callee = request.callee ?? this.deps.callee;
      const result: CallResult = callee
        ? await this.deps.line.call(
            callee,
            // An unanswerable request is tell-only whatever the pin says; "pin off" only matters when keys are allowed.
            new CallDialog(
              request.script,
              request.answerable ? this.deps.pin() : null,
              request.answerable ? (this.deps.pinRequired?.() ?? true) : true,
            ),
          )
        : { status: "failed", reason: "No phone extension is set. Set it in Squeak's settings on your Mac." };
      const body: CallResultDoc =
        result.status === "answered"
          ? { v: 1, id, at: this.now(), status: "answered", letter: result.letter }
          : result.status === "unanswered"
            ? { v: 1, id, at: this.now(), status: "unanswered" }
            : { v: 1, id, at: this.now(), status: "failed", reason: result.reason };
      await store.set(resultPath(channel, id), sealResult(key, body));
    }
  }
}
