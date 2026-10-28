import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { logger } from "../utils/logger.js";
import { PIN_FORMAT } from "./relay-protocol.js";

const WRONG_TRIES = 5;
const LOCKOUT_MS = 10 * 60_000;

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * The gateway's pin. It starts as the add-on's `pin` option; a change from an app is saved beside it (a 0600 file
 * in the add-on's own storage) and wins from then on. Changing needs the current pin, so whoever merely holds the
 * channel key cannot set their own, and a run of wrong guesses locks changes for ten minutes.
 */
export class PinKeeper {
  private saved: string | null = null;
  private wrong: number[] = [];

  constructor(
    private readonly optionPin: string | null,
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { pin?: unknown };
      if (typeof raw.pin === "string" && PIN_FORMAT.test(raw.pin)) this.saved = raw.pin;
    } catch {
      // None saved yet: the option stands.
    }
  }

  /** The pin in force: a changed one, else the option; null if neither exists. */
  current(): string | null {
    return this.saved ?? this.optionPin;
  }

  change(currentPin: string, nextPin: string): { ok: true } | { ok: false; reason: string } {
    const now = this.now();
    this.wrong = this.wrong.filter((at) => now - at < LOCKOUT_MS);
    if (this.wrong.length >= WRONG_TRIES) {
      return { ok: false, reason: "Too many wrong pins. Try again in ten minutes." };
    }
    const have = this.current();
    if (have === null) return { ok: false, reason: "No pin is set on the add-on to change." };
    if (!same(currentPin, have)) {
      this.wrong.push(now);
      return { ok: false, reason: "That is not your current pin." };
    }
    if (!PIN_FORMAT.test(nextPin)) return { ok: false, reason: "A pin is 4 to 12 digits." };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify({ pin: nextPin })}\n`, { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch (error) {
      logger.warn("voice pin could not be saved", { error: error instanceof Error ? error.message : String(error) });
      return { ok: false, reason: "The add-on could not save the new pin." };
    }
    this.saved = nextPin;
    this.wrong = [];
    return { ok: true };
  }
}
