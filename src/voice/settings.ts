import fs from "node:fs";
import path from "node:path";

import { logger } from "../utils/logger.js";

/**
 * The one voice setting a person changes day to day, saved in `voice-settings.json` and edited from the
 * Mac app: which extension to ring. Only an internal extension (2 to 6 digits) is accepted, here and again by
 * the gateway: a stolen channel key must not be able to point the PBX at an outside number.
 */
export const EXTENSION = /^\d{2,6}$/;

export interface VoicePause {
  /** Ms epoch the pause ends, or null: until the person turns calls back on. */
  until: number | null;
}

export interface VoiceSettings {
  callee: string | null;
  /** Present only while calls are paused. */
  pause?: VoicePause;
}

export const PAUSE_CHOICES = ["1h", "4h", "tomorrow", "forever", "resume"] as const;
export type PauseChoice = (typeof PAUSE_CHOICES)[number];

/** `{ pause: choice }`, exactly that one key, or null. */
export function readPauseChange(value: unknown): PauseChoice | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "pause") return null;
  const choice = (value as Record<string, unknown>).pause;
  return PAUSE_CHOICES.find((c) => c === choice) ?? null;
}

/** When a pause ends: "tomorrow" is the next 08:00 local time. Null means until resumed. */
export function pauseUntil(choice: Exclude<PauseChoice, "resume">, now: number): number | null {
  if (choice === "1h") return now + 60 * 60_000;
  if (choice === "4h") return now + 4 * 60 * 60_000;
  if (choice === "forever") return null;
  const next = new Date(now);
  next.setHours(8, 0, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

/** One change, strictly: exactly `{ callee }`, an extension or null to clear it. */
export function readVoiceChange(value: unknown): VoiceSettings | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "callee") return null;
  const callee = record.callee;
  if (callee === null) return { callee: null };
  return typeof callee === "string" && EXTENSION.test(callee) ? { callee } : null;
}

export class VoiceSettingsStore {
  private current: VoiceSettings;
  private readonly now: () => number;

  constructor(
    private readonly file: string,
    now: () => number = Date.now,
  ) {
    this.now = now;
    this.current = this.load();
  }

  get settings(): VoiceSettings {
    return this.current;
  }

  /** The pause in force now, or null; an elapsed one is cleared here, in memory and in the file. */
  pause(): VoicePause | null {
    const pause = this.current.pause;
    if (!pause) return null;
    if (pause.until !== null && pause.until <= this.now()) {
      const { callee } = this.current;
      this.save({ callee });
      return null;
    }
    return { ...pause };
  }

  private load(): VoiceSettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
      const settings: VoiceSettings = {
        callee: typeof raw.callee === "string" && EXTENSION.test(raw.callee) ? raw.callee : null,
      };
      const pause = raw.pause;
      if (typeof pause === "object" && pause !== null && !Array.isArray(pause)) {
        const until = (pause as Record<string, unknown>).until;
        if (until === null || (typeof until === "number" && Number.isFinite(until))) {
          settings.pause = { until };
        }
      }
      return settings;
    } catch {
      return { callee: null };
    }
  }

  private save(next: VoiceSettings): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch (error) {
      logger.warn("voice settings could not be saved", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    this.current = next;
    return true;
  }

  apply(request: unknown): { ok: true; settings: VoiceSettings } | { ok: false; reason: string } {
    const failed = { ok: false as const, reason: "This Mac could not save the voice settings." };
    const isPause = typeof request === "object" && request !== null && !Array.isArray(request) && "pause" in request;
    let next: VoiceSettings;
    if (isPause) {
      const choice = readPauseChange(request);
      if (!choice) return { ok: false, reason: "Pause for 1h, 4h, tomorrow, forever, or resume." };
      next = { callee: this.current.callee };
      if (choice !== "resume") next.pause = { until: pauseUntil(choice, this.now()) };
    } else {
      const change = readVoiceChange(request);
      if (!change) return { ok: false, reason: "That is not an extension: use 2 to 6 digits." };
      next = { callee: change.callee, ...(this.current.pause ? { pause: this.current.pause } : {}) };
    }
    if (!this.save(next)) return failed;
    return { ok: true, settings: { ...next } };
  }
}
