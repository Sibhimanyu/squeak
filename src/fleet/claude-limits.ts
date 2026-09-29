import fs from "node:fs";
import path from "node:path";

/** One of the plan's windows: how much of it is used (0–1) and when it resets. */
export interface ClaudeLimitWindow {
  utilization: number;
  resetsAt: string;
}

/**
 * The account's Claude plan limits, as Claude Code last reported them.
 *
 * Claude Code never writes these to disk (see CLAUDE.md): they only appear
 * as a `rate_limit_event` in the live stream-json output of a process that
 * spawned the CLI. Squeak spawns one for every plain-language question it
 * answers (`assistant.ts`), so it reads the event off that output — a
 * reading that costs nothing extra, never a probe run just to check.
 */
export interface ClaudeLimits {
  fiveHour: ClaudeLimitWindow | null;
  sevenDay: ClaudeLimitWindow | null;
  observedAt: string;
}

/**
 * `{"type":"rate_limit_event","rate_limit_info":{…,"unifiedWindows":{"five_hour":
 * {"utilization":0.14,"resetsAt":1790689800},"seven_day":{…}}}}` — resetsAt in
 * unix seconds, as seen from Claude Code 2.1.280.
 */
export function parseRateLimitEvent(event: unknown, nowMs: number): ClaudeLimits | null {
  if (!event || typeof event !== "object" || (event as { type?: unknown }).type !== "rate_limit_event") {
    return null;
  }
  const windows = (event as { rate_limit_info?: { unifiedWindows?: Record<string, unknown> } }).rate_limit_info
    ?.unifiedWindows;
  const fiveHour = parseWindow(windows?.five_hour);
  const sevenDay = parseWindow(windows?.seven_day);
  if (!fiveHour && !sevenDay) {
    return null;
  }
  return { fiveHour, sevenDay, observedAt: new Date(nowMs).toISOString() };
}

function parseWindow(raw: unknown): ClaudeLimitWindow | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const { utilization, resetsAt } = raw as { utilization?: unknown; resetsAt?: unknown };
  if (typeof utilization !== "number" || !Number.isFinite(utilization) || typeof resetsAt !== "number") {
    return null;
  }
  return { utilization: Math.min(Math.max(utilization, 0), 1), resetsAt: new Date(resetsAt * 1000).toISOString() };
}

/** The latest reading, kept on disk so a restart does not forget it. */
export class ClaudeLimitsStore {
  private readonly filePath: string;
  private cached: ClaudeLimits | null | undefined;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  record(limits: ClaudeLimits): void {
    this.cached = limits;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(limits), { mode: 0o600 });
    } catch {
      // Losing the reading costs one "not seen yet"; not worth failing an answer over.
    }
  }

  latest(): ClaudeLimits | null {
    if (this.cached === undefined) {
      try {
        const value = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as ClaudeLimits;
        this.cached = typeof value?.observedAt === "string" ? value : null;
      } catch {
        this.cached = null;
      }
    }
    return this.cached;
  }
}
