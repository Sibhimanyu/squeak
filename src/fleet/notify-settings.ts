import fs from "node:fs";
import path from "node:path";

import { logger } from "../utils/logger.js";
import { PUSH_KINDS, shouldPush } from "./attention.js";
import type { AttentionKind, FleetSession } from "./types.js";

/**
 * What each channel may push, saved in `notify-settings.json` and edited from the Mac app and the phone.
 *
 * Only the kinds that push today are exposed (`PUSH_KINDS`): blocked sessions (`approval`), a finish that
 * ends on a question (`question`), a stall, a finish (`finished`) and the Codex quota alert (`quota`).
 * Errors and context pressure stay on the radar and have no switch, because they never push.
 *
 * This only filters pushes, per channel: a card held back stays on the radar and in every app, and the
 * slash commands are untouched. The defaults are today's behaviour exactly.
 */

export const NOTIFY_CHANNELS = ["telegram", "cliq"] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

export const FINISHED_MODES = ["conductor", "all", "off"] as const;
export type FinishedMode = (typeof FINISHED_MODES)[number];

/** Local clock times, "HH:MM" 24 h. `from` to `to` may cross midnight. */
export interface QuietHours {
  from: string;
  to: string;
}

export interface ChannelNotify {
  /** Nothing is pushed to this channel, quota alerts included. */
  muted: boolean;
  /** A session blocked on an approval or a question (`blocked_approval`, `blocked_question`). */
  approval: boolean;
  /** A finished turn that ends on a question (`asked_question`). */
  question: boolean;
  /** A session that seems stuck. */
  stalled: boolean;
  /** The account-wide Codex quota alert. */
  quota: boolean;
  /** Finishes: Conductor chats only (today), every agent, or none. */
  finished: FinishedMode;
  /**
   * Quiet hours hold back finishes, questions after a finish and stalls. A blocked approval or question
   * still pushes, and so does the quota alert: those wait on you or cost you something.
   */
  quiet: QuietHours | null;
}

export type NotifySettings = Record<NotifyChannel, ChannelNotify>;

/** One change, strictly: exactly one known key with its exact type. */
export type NotifyChange =
  | { muted: boolean }
  | { approval: boolean }
  | { question: boolean }
  | { stalled: boolean }
  | { quota: boolean }
  | { finished: FinishedMode }
  | { quiet: QuietHours | null };

export const DEFAULT_CHANNEL_NOTIFY: Readonly<ChannelNotify> = Object.freeze({
  muted: false,
  approval: true,
  question: true,
  stalled: true,
  quota: true,
  finished: "conductor",
  quiet: null,
});

export function defaultNotifySettings(): NotifySettings {
  return { telegram: { ...DEFAULT_CHANNEL_NOTIFY }, cliq: { ...DEFAULT_CHANNEL_NOTIFY } };
}

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOf(clock: string): number {
  const match = CLOCK.exec(clock)!;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** A quiet window with two valid, different clock times, or null. */
function readQuiet(value: unknown): QuietHours | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("from") || !keys.includes("to")) return null;
  const { from, to } = record;
  if (typeof from !== "string" || typeof to !== "string" || !CLOCK.test(from) || !CLOCK.test(to) || from === to) {
    return null;
  }
  return { from, to };
}

/** Whether `now` (local time) falls in the window; `from` to `to` crosses midnight when `to` is earlier. */
export function inQuietHours(quiet: QuietHours | null, now: Date): boolean {
  if (!quiet) return false;
  const from = minutesOf(quiet.from);
  const to = minutesOf(quiet.to);
  const at = now.getHours() * 60 + now.getMinutes();
  return from < to ? at >= from && at < to : at >= from || at < to;
}

/** One change, strictly: a single known key with its exact type; null for anything else. */
export function readNotifyChange(value: unknown): NotifyChange | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1) return null;
  const key = keys[0]!;
  const v = record[key];
  switch (key) {
    case "muted":
    case "approval":
    case "question":
    case "stalled":
    case "quota":
      return typeof v === "boolean" ? ({ [key]: v } as NotifyChange) : null;
    case "finished":
      return typeof v === "string" && (FINISHED_MODES as readonly string[]).includes(v)
        ? { finished: v as FinishedMode }
        : null;
    case "quiet": {
      if (v === null) return { quiet: null };
      const quiet = readQuiet(v);
      return quiet ? { quiet } : null;
    }
    default:
      return null;
  }
}

/** A request `{ channel, change }` (the route's body and the phone command's fields), strictly. */
export function readNotifyRequest(value: unknown): { channel: NotifyChannel; change: NotifyChange } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("channel") || !keys.includes("change")) return null;
  const channel = record.channel;
  if (typeof channel !== "string" || !(NOTIFY_CHANNELS as readonly string[]).includes(channel)) return null;
  const change = readNotifyChange(record.change);
  return change ? { channel: channel as NotifyChannel, change } : null;
}

/** Reads what is saved: unknown keys are ignored and anything invalid falls back to its default. */
export function normalizeChannel(raw: unknown): ChannelNotify {
  const out: ChannelNotify = { ...DEFAULT_CHANNEL_NOTIFY };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const record = raw as Record<string, unknown>;
  for (const key of ["muted", "approval", "question", "stalled", "quota"] as const) {
    if (typeof record[key] === "boolean") out[key] = record[key];
  }
  if (typeof record.finished === "string" && (FINISHED_MODES as readonly string[]).includes(record.finished)) {
    out.finished = record.finished as FinishedMode;
  }
  out.quiet = readQuiet(record.quiet);
  return out;
}

/**
 * Whether this attention reason goes to this channel, for this session, now (`now` read in local time).
 * `shouldPush` stays the base rule; the settings only narrow it, except `finished: "all"`, which also lets
 * a finish from a session Squeak cannot answer through.
 */
export function shouldPushTo(
  channel: NotifyChannel,
  kind: AttentionKind,
  session: FleetSession,
  settings: NotifySettings,
  now: Date | number,
): boolean {
  const mine = settings[channel];
  if (mine.muted || !PUSH_KINDS.has(kind)) return false;
  const base = shouldPush(kind, session);
  const when = typeof now === "number" ? new Date(now) : now;
  switch (kind) {
    case "blocked_approval":
    case "blocked_question":
      return mine.approval && base;
    case "asked_question":
      return mine.question && (base || mine.finished === "all") && !inQuietHours(mine.quiet, when);
    case "stalled":
      return mine.stalled && base && !inQuietHours(mine.quiet, when);
    case "finished_unreviewed":
      return mine.finished !== "off" && (mine.finished === "all" || base) && !inQuietHours(mine.quiet, when);
    default:
      return false;
  }
}

/** What a channel's push path asks: may this card go, may the quota alert go. */
export interface NotifyFilter {
  item(item: { kind: AttentionKind; session: FleetSession }): boolean;
  quota(): boolean;
}

/**
 * How many cards each channel was let push on the current local day, in memory (a restart starts at 0):
 * the Mac app offers "Fewer?" when one channel is noisy. Counts cards, never their content.
 */
export class PushCounter {
  private day = "";
  private counts: Record<NotifyChannel, number> = { telegram: 0, cliq: 0 };

  constructor(private readonly now: () => number = Date.now) {}

  private roll(): void {
    const d = new Date(this.now());
    const day = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (day !== this.day) {
      this.day = day;
      this.counts = { telegram: 0, cliq: 0 };
    }
  }

  record(channel: NotifyChannel): void {
    this.roll();
    this.counts[channel] += 1;
  }

  today(): Record<NotifyChannel, number> {
    this.roll();
    return { ...this.counts };
  }
}

/** The two checks a channel makes, read live from the store so an edit applies to the next push. */
export function channelFilter(
  store: Pick<NotifySettingsStore, "settings">,
  channel: NotifyChannel,
  now: () => number = Date.now,
  counter?: PushCounter,
): NotifyFilter {
  return {
    item: (item) => {
      const allowed = shouldPushTo(channel, item.kind, item.session, store.settings, now());
      if (allowed) {
        counter?.record(channel);
      }
      return allowed;
    },
    quota: () => {
      const mine = store.settings[channel];
      return !mine.muted && mine.quota;
    },
  };
}

/**
 * The monitor decides once per session whether a finish is news; a channel set to `finished: "all"`
 * needs it to say yes for sessions that are not Conductor's too, and each channel then filters its own.
 */
export function wantsAllFinishes(settings: NotifySettings): boolean {
  return NOTIFY_CHANNELS.some((channel) => !settings[channel].muted && settings[channel].finished === "all");
}

/** `notify-settings.json`: load, validate, save (0600, atomic). */
export class NotifySettingsStore {
  private current: NotifySettings;

  constructor(private readonly file: string) {
    this.current = this.load();
  }

  get settings(): NotifySettings {
    return this.current;
  }

  /** A copy, for a response. */
  snapshot(): NotifySettings {
    return { telegram: { ...this.current.telegram }, cliq: { ...this.current.cliq } };
  }

  private load(): NotifySettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
      return { telegram: normalizeChannel(raw?.telegram), cliq: normalizeChannel(raw?.cliq) };
    } catch {
      return defaultNotifySettings();
    }
  }

  /** Applies one strictly validated change to one channel and saves; the new settings, or why not. */
  apply(request: unknown): { ok: true; settings: NotifySettings } | { ok: false; reason: string } {
    const parsed = readNotifyRequest(request);
    if (!parsed) {
      return { ok: false, reason: "Not a notification setting this Mac understands." };
    }
    const next: NotifySettings = {
      ...this.current,
      [parsed.channel]: { ...this.current[parsed.channel], ...parsed.change },
    };
    try {
      this.save(next);
    } catch (error) {
      logger.warn("notify settings could not be saved", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, reason: "This Mac could not save the notification settings." };
    }
    this.current = next;
    return { ok: true, settings: this.snapshot() };
  }

  private save(settings: NotifySettings): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
