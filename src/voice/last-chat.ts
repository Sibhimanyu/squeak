import fs from "node:fs";
import path from "node:path";

import { logger } from "../utils/logger.js";

/**
 * The chat last used by phone (a message sent, or a question or status asked), saved in `voice-last-chat.json` so a
 * restart keeps it. One reply target and when; the call-in offers it first ("Press 1 for ..., the last one you used").
 */
export class LastChatStore {
  private current: { target: string; at: number } | null;

  constructor(private readonly file: string) {
    this.current = this.load();
  }

  get(): string | null {
    return this.current?.target ?? null;
  }

  /** The chat used last, only if that was within `maxAgeMs`: one used this morning is not "the last one" tonight. */
  recent(maxAgeMs: number, now = Date.now()): string | null {
    return this.current && now - this.current.at <= maxAgeMs ? this.current.target : null;
  }

  set(target: string, at = Date.now()): void {
    if (!target || target.length > 300) return;
    this.current = { target, at };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(this.current), { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch (error) {
      logger.warn("voice last chat could not be saved", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private load(): { target: string; at: number } | null {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (raw && typeof raw === "object") {
        const { target, at } = raw as { target?: unknown; at?: unknown };
        if (typeof target === "string" && target && typeof at === "number") return { target, at };
      }
    } catch {
      // Missing or damaged: nothing remembered.
    }
    return null;
  }
}
