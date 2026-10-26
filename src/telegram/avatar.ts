import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { TelegramClient } from "./client.js";

/** The brand's avatar (DESIGN.md §6.1: the full duck at ~65% on Ink), as the JPG Telegram's setMyProfilePhoto wants. */
export const AVATAR_FILE = "squeak-bot-avatar-640.jpg";
export const AVATAR_MIN_INTERVAL_MS = 30_000;

/**
 * Where the logo lives: `brand/logo/png/` two folders above this module's folder, which is the same relative
 * place in the checkout (`src/telegram` or `dist/telegram`) and in the app-bundled daemon
 * (`daemon/dist/telegram`, `daemon/brand/logo/png`, copied by macos/scripts/embed-daemon.sh).
 */
export function defaultAvatarPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "brand", "logo", "png", AVATAR_FILE);
}

export type AvatarOutcome = { ok: true; message: string } | { ok: false; reason: string; retry?: boolean };

export interface TelegramAvatarOptions {
  /** Null when no bot token is set. */
  telegram: Pick<TelegramClient, "setMyProfilePhoto"> | null;
  logoPath?: string;
  now?: () => number;
  minIntervalMs?: number;
}

/**
 * Sets the bot's profile photo to Squeak's logo. The Mac app's `POST /control/telegram/avatar` and the phone's
 * signed `telegramAvatar` command both end in `apply`, so one rate limit (a try per 30 s) covers both. Answers
 * are fixed sentences: never the token, a path or Telegram's own words.
 */
export class TelegramAvatar {
  private lastTryAt = 0;
  private busy = false;
  private readonly logoPath: string;
  private readonly now: () => number;
  private readonly minIntervalMs: number;

  constructor(private readonly options: TelegramAvatarOptions) {
    this.logoPath = options.logoPath ?? defaultAvatarPath();
    this.now = options.now ?? Date.now;
    this.minIntervalMs = options.minIntervalMs ?? AVATAR_MIN_INTERVAL_MS;
  }

  async apply(request: unknown): Promise<AvatarOutcome> {
    if (!isAvatarRequest(request)) {
      return { ok: false, reason: "Not a request this Mac understands." };
    }
    const telegram = this.options.telegram;
    if (!telegram) {
      return { ok: false, reason: "Telegram is not set up" };
    }
    const now = this.now();
    if (this.busy || (this.lastTryAt !== 0 && now - this.lastTryAt < this.minIntervalMs)) {
      return { ok: false, reason: "Try again in a minute", retry: true };
    }
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(this.logoPath);
    } catch {
      return { ok: false, reason: "Squeak's logo file is missing from this install" };
    }
    this.busy = true;
    this.lastTryAt = now;
    try {
      await telegram.setMyProfilePhoto(bytes);
      return { ok: true, message: "Done" };
    } catch (error) {
      const status = (error as { status?: unknown } | null)?.status;
      return {
        ok: false,
        reason: typeof status === "number" ? "Telegram refused the photo" : "Telegram could not be reached",
      };
    } finally {
      this.busy = false;
    }
  }
}

/** `{}` or exactly `{ which: "logo" }`. */
export function isAvatarRequest(request: unknown): boolean {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return false;
  }
  const keys = Object.keys(request);
  if (keys.length === 0) {
    return true;
  }
  return keys.length === 1 && keys[0] === "which" && (request as { which?: unknown }).which === "logo";
}
