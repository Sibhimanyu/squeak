import fs from "node:fs";
import path from "node:path";

import { logger } from "../utils/logger.js";

/**
 * What a message sent to a working chat does when the sender names no mode: wait its turn (`queue`, the
 * default) or go into the turn in progress (`steer`). One saved choice (`send-default.json`) shared by the
 * Mac app and the phone; a message that names its mode keeps it, and an idle chat just sends either way.
 */
export const SEND_DEFAULTS = ["queue", "steer"] as const;
export type SendDefault = (typeof SEND_DEFAULTS)[number];

export const DEFAULT_SEND_DEFAULT: SendDefault = "queue";

/** One change, strictly: exactly `{ mode: "queue" | "steer" }`; null for anything else. */
export function readSendDefaultRequest(value: unknown): SendDefault | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "mode") return null;
  return record.mode === "queue" || record.mode === "steer" ? record.mode : null;
}

/** The mode a send uses: the one it named, else the shared default. */
export function resolveSendMode(explicit: SendDefault | undefined, shared: SendDefault | undefined): SendDefault {
  return explicit ?? shared ?? DEFAULT_SEND_DEFAULT;
}

export class SendDefaultStore {
  private current: SendDefault;

  constructor(private readonly file: string) {
    this.current = this.load();
  }

  get mode(): SendDefault {
    return this.current;
  }

  private load(): SendDefault {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
      return raw?.mode === "steer" ? "steer" : DEFAULT_SEND_DEFAULT;
    } catch {
      return DEFAULT_SEND_DEFAULT;
    }
  }

  /** Applies one strictly validated change and saves; the new mode, or why not. */
  apply(request: unknown): { ok: true; mode: SendDefault } | { ok: false; reason: string } {
    const mode = readSendDefaultRequest(request);
    if (!mode) {
      return { ok: false, reason: "Not a send setting this Mac understands." };
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify({ mode }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch (error) {
      logger.warn("send default could not be saved", { error: error instanceof Error ? error.message : String(error) });
      return { ok: false, reason: "This Mac could not save that setting." };
    }
    this.current = mode;
    return { ok: true, mode };
  }
}
