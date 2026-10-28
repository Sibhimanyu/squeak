import fs from "node:fs";
import path from "node:path";

import { logger } from "../utils/logger.js";

/**
 * The one voice setting a person changes day to day, saved in `voice-settings.json` and edited from the
 * Mac app: which extension to ring. Only an internal extension (2 to 6 digits) is accepted, here and again by
 * the gateway: a stolen channel key must not be able to point the PBX at an outside number.
 */
export const EXTENSION = /^\d{2,6}$/;

export interface VoiceSettings {
  callee: string | null;
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

  constructor(private readonly file: string) {
    this.current = this.load();
  }

  get settings(): VoiceSettings {
    return this.current;
  }

  private load(): VoiceSettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
      return { callee: typeof raw.callee === "string" && EXTENSION.test(raw.callee) ? raw.callee : null };
    } catch {
      return { callee: null };
    }
  }

  apply(request: unknown): { ok: true; settings: VoiceSettings } | { ok: false; reason: string } {
    const change = readVoiceChange(request);
    if (!change) return { ok: false, reason: "That is not an extension: use 2 to 6 digits." };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(change, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch (error) {
      logger.warn("voice settings could not be saved", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, reason: "This Mac could not save the voice settings." };
    }
    this.current = change;
    return { ok: true, settings: { ...change } };
  }
}
