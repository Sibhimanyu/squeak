import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { logger } from "../utils/logger.js";
import { PIN_FORMAT } from "./relay-protocol.js";

const WRONG_TRIES = 5;
const LOCKOUT_MS = 10 * 60_000;

/** "set": a pin is required; "off": the requirement was turned off; "none": nothing was ever set. */
export type PinState = "set" | "off" | "none";
export type PinChoice = "ask" | "skip";
/** When the pin is asked: on calls Squeak makes to you (`outgoing`) and on calls you make to Squeak (`incoming`). */
export interface PinPolicy {
  outgoing: PinChoice;
  incoming: PinChoice;
}
export type PinOutcome = { ok: true; state: PinState } | { ok: false; reason: string };

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * The calling pin, in the Home Assistant add-on's storage or (direct mode) the Mac's support directory. It starts as
 * the `pin` option (the env value in direct mode); a saved file wins from then on: `{ "pin": "4821" }` (required) or
 * `{ "off": true }` (the requirement is off). Changing, turning off and the lockout need the current pin, so whoever
 * only holds the channel key cannot guess one; `reset` needs none, and its callers prove who the owner is first.
 */
export class PinKeeper {
  private saved: { pin: string } | { off: true } | null = null;
  private savedPolicy: PinPolicy | null = null;
  private wrong: number[] = [];

  /** `legacyIncoming`: the old `call_in_pin` option; it only seeds `incoming` until a policy is saved. */
  constructor(
    private readonly optionPin: string | null,
    private readonly file: string,
    private readonly now: () => number = Date.now,
    private readonly legacyIncoming: PinChoice = "ask",
  ) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { pin?: unknown; off?: unknown; policy?: unknown };
      if (raw.off === true) this.saved = { off: true };
      else if (typeof raw.pin === "string" && PIN_FORMAT.test(raw.pin)) this.saved = { pin: raw.pin };
      const p = raw.policy as { outgoing?: unknown; incoming?: unknown } | null | undefined;
      const choice = (v: unknown): v is PinChoice => v === "ask" || v === "skip";
      if (p && typeof p === "object" && choice(p.outgoing) && choice(p.incoming)) {
        this.savedPolicy = { outgoing: p.outgoing, incoming: p.incoming };
      }
    } catch {
      // None saved yet: the option stands.
    }
  }

  policy(): PinPolicy {
    return this.savedPolicy ?? { outgoing: "ask", incoming: this.legacyIncoming };
  }

  /** Needs no current pin: the caller has proved the owner, as for `reset`. Never logs a value but the two words. */
  setPolicy(next: PinPolicy): PinOutcome {
    if (!this.write(this.saved, next)) return { ok: false, reason: "The setting could not be saved." };
    this.savedPolicy = { outgoing: next.outgoing, incoming: next.incoming };
    return { ok: true, state: this.status() };
  }

  status(): PinState {
    if (this.saved) return "pin" in this.saved ? "set" : "off";
    return this.optionPin !== null ? "set" : "none";
  }

  /** The pin in force; null when the requirement is off or nothing is set. */
  current(): string | null {
    if (this.saved) return "pin" in this.saved ? this.saved.pin : null;
    return this.optionPin;
  }

  /** A call Squeak makes can take a key answer: a pin exists (or was turned off), or outgoing is "skip". */
  answerable(): boolean {
    return this.status() !== "none" || this.policy().outgoing === "skip";
  }

  /** A call Squeak makes asks for the pin first. */
  requiresPin(): boolean {
    return this.status() === "set" && this.policy().outgoing === "ask";
  }

  /** A call you make to Squeak asks for the pin. */
  incomingAsksPin(): boolean {
    return this.status() === "set" && this.policy().incoming === "ask";
  }

  /** A call you make to Squeak is accepted at all: "skip" trusts the extension; otherwise a pin must have been dealt with. */
  incomingAllowed(): boolean {
    return this.policy().incoming === "skip" || this.status() !== "none";
  }

  private locked(): boolean {
    const now = this.now();
    this.wrong = this.wrong.filter((at) => now - at < LOCKOUT_MS);
    return this.wrong.length >= WRONG_TRIES;
  }

  /** Checks the current pin under the lockout; null when it is right. */
  private proveCurrent(currentPin: string): { ok: false; reason: string } | null {
    if (this.locked()) return { ok: false, reason: "Too many wrong pins. Try again in ten minutes." };
    const have = this.current();
    if (have === null) return { ok: false, reason: "No pin is on to check." };
    if (!same(currentPin, have)) {
      this.wrong.push(this.now());
      return { ok: false, reason: "That is not your current pin." };
    }
    return null;
  }

  private write(pin: { pin: string } | { off: true } | null, policy: PinPolicy | null): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      const body = {
        ...(pin ?? {}),
        ...(policy ? { policy: { outgoing: policy.outgoing, incoming: policy.incoming } } : {}),
      };
      fs.writeFileSync(temp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
      fs.renameSync(temp, this.file);
      return true;
    } catch (error) {
      logger.warn("voice pin could not be saved", { error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  private save(next: { pin: string } | { off: true }): PinOutcome {
    if (!this.write(next, this.savedPolicy)) return { ok: false, reason: "The pin could not be saved." };
    this.saved = next;
    this.wrong = [];
    return { ok: true, state: this.status() };
  }

  change(currentPin: string, nextPin: string): PinOutcome {
    if (this.status() !== "set") return { ok: false, reason: "No pin is set to change." };
    const refused = this.proveCurrent(currentPin);
    if (refused) return refused;
    if (!PIN_FORMAT.test(nextPin)) return { ok: false, reason: "A pin is 4 to 12 digits." };
    return this.save({ pin: nextPin });
  }

  disable(currentPin: string): PinOutcome {
    if (this.status() !== "set") return { ok: false, reason: "No pin is on to turn off." };
    const refused = this.proveCurrent(currentPin);
    if (refused) return refused;
    return this.save({ off: true });
  }

  enable(nextPin: string): PinOutcome {
    if (this.status() === "set") return { ok: false, reason: "A pin is already on." };
    if (!PIN_FORMAT.test(nextPin)) return { ok: false, reason: "A pin is 4 to 12 digits." };
    return this.save({ pin: nextPin });
  }

  /** A forgotten pin: no current needed and no lockout. The caller has proved the owner is asking. */
  reset(nextPin: string | null): PinOutcome {
    if (nextPin === null) return this.save({ off: true });
    if (!PIN_FORMAT.test(nextPin)) return { ok: false, reason: "A pin is 4 to 12 digits." };
    return this.save({ pin: nextPin });
  }
}

/** What a call into Squeak needs from the keeper: the pin to ask for (null: none) and whether to take the call at all. */
export function incomingGate(keeper: Pick<PinKeeper, "incomingAsksPin" | "current" | "incomingAllowed">): {
  pin: () => string | null;
  allowed: () => boolean;
} {
  return {
    pin: () => (keeper.incomingAsksPin() ? keeper.current() : null),
    allowed: () => keeper.incomingAllowed(),
  };
}
