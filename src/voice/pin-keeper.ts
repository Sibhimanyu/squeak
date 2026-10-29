import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { logger } from "../utils/logger.js";
import { PIN_FORMAT } from "./relay-protocol.js";

const WRONG_TRIES = 5;
const LOCKOUT_MS = 10 * 60_000;

/** "set": a pin is required; "off": the requirement was turned off; "none": nothing was ever set. */
export type PinState = "set" | "off" | "none";
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
  private wrong: number[] = [];

  constructor(
    private readonly optionPin: string | null,
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { pin?: unknown; off?: unknown };
      if (raw.off === true) this.saved = { off: true };
      else if (typeof raw.pin === "string" && PIN_FORMAT.test(raw.pin)) this.saved = { pin: raw.pin };
    } catch {
      // None saved yet: the option stands.
    }
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

  /** A call can take a key answer: a pin is required, or the requirement is deliberately off. */
  answerable(): boolean {
    return this.status() !== "none";
  }

  requiresPin(): boolean {
    return this.status() === "set";
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

  private save(next: { pin: string } | { off: true }): PinOutcome {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch (error) {
      logger.warn("voice pin could not be saved", { error: error instanceof Error ? error.message : String(error) });
      return { ok: false, reason: "The pin could not be saved." };
    }
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
