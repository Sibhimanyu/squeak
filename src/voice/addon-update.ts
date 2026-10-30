/**
 * The add-on updating itself on the Mac's word (docs: .context/addon-update-contract.md). It learns the newest
 * version on its own, from a fixed address, and only ever asks Home Assistant's Supervisor (a fixed address too) to
 * update it when that version is newer than the running one. Nothing in a message chooses a URL, a version or a
 * token; the Supervisor token comes from the environment and is never logged, stored or sent anywhere else.
 */

/** Where the newest version is read from: the add-on's own config.yaml on master. Fixed. */
export const LATEST_CONFIG_URL =
  "https://raw.githubusercontent.com/Sibhimanyu/squeak/master/homeassistant/squeak-voice/config.yaml";
/** Home Assistant's Supervisor, as an add-on reaches it. Fixed. */
export const SUPERVISOR_UPDATE_URL = "http://supervisor/addons/self/update";

const LOOK_MS = 6 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
/** The Supervisor answers once the update is installed, which can take a while; the add-on is stopped by it anyway. */
const SUPERVISOR_TIMEOUT_MS = 90_000;
const MAX_CONFIG_BYTES = 64 * 1024;

export const SEMVER = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

/** `x.y.z` and nothing else, or null. */
export function cleanVersion(value: unknown): string | null {
  return typeof value === "string" && SEMVER.test(value) ? value : null;
}

/** Strictly newer, numerically per part; false when either side is not `x.y.z`. */
export function isNewer(latest: string | null | undefined, current: string | null | undefined): boolean {
  const a = SEMVER.exec(latest ?? "");
  const b = SEMVER.exec(current ?? "");
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i += 1) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (x !== y) return x > y;
  }
  return false;
}

/** The `version: "x.y.z"` line of a config.yaml, strictly; null for anything else. */
export function parseConfigVersion(text: string): string | null {
  return cleanVersion(/^version:[ \t]*"([^"\r\n]*)"[ \t]*\r?$/m.exec(text)?.[1]);
}

export type UpdateOutcome = { ok: true } | { ok: false; reason: string };

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface AddonUpdaterOptions {
  /** The running version (config.yaml's). */
  version: string;
  fetch?: FetchLike;
  /** `SUPERVISOR_TOKEN`, read by the caller from the environment; absent: the add-on cannot update itself. */
  token?: string | undefined;
}

const NO_TOKEN = "This add-on can't reach Home Assistant's update service. Update it in Home Assistant.";
const REFUSED =
  "Home Assistant refused: the add-on needs the 'manager' permission; update it in Home Assistant once, then this button works.";

export class AddonUpdater {
  private latestSeen: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private updating = false;
  private readonly fetchFn: FetchLike;

  constructor(private readonly options: AddonUpdaterOptions) {
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init));
  }

  /** The newest version seen so far (the last good answer is kept when a look fails), or null. */
  latest(): string | null {
    return this.latestSeen;
  }

  /** Whether the newest version seen is newer than the running one. */
  available(): boolean {
    return isNewer(this.latestSeen, this.options.version);
  }

  /** Looks now and every 6 hours. */
  start(): void {
    void this.look();
    this.timer = setInterval(() => void this.look(), LOOK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Reads the newest version from the fixed address; a failure or an odd answer changes nothing. */
  async look(): Promise<string | null> {
    try {
      const response = await this.withTimeout(FETCH_TIMEOUT_MS, (signal) =>
        this.fetchFn(LATEST_CONFIG_URL, { signal }).then(async (r) => ({
          ok: r.ok,
          text: r.ok ? await r.text() : "",
        })),
      );
      if (response.ok && response.text.length <= MAX_CONFIG_BYTES) {
        const version = parseConfigVersion(response.text);
        if (version) this.latestSeen = version;
      }
    } catch {
      // Offline or slow: the last good answer stays.
    }
    return this.latestSeen;
  }

  /**
   * Asks the Supervisor to update this add-on, only if the newest version it found itself is newer. `started` runs
   * after every check and BEFORE the Supervisor call, since the update stops this process: the reply to the Mac must
   * already be written. A refusal before that is returned and `started` never runs.
   */
  async update(started: () => Promise<void> | void): Promise<UpdateOutcome> {
    // Look again right now so a version the Mac just found is honoured at once; the cache stands if this fails.
    const latest = await this.look();
    if (!isNewer(latest, this.options.version)) return { ok: false, reason: "Already on the newest version." };
    const token = this.options.token;
    if (!token) return { ok: false, reason: NO_TOKEN };
    if (this.updating) return { ok: false, reason: "The update is already under way." };
    this.updating = true;
    try {
      await started();
      return await this.callSupervisor(token);
    } finally {
      this.updating = false;
    }
  }

  private async callSupervisor(token: string): Promise<UpdateOutcome> {
    try {
      const status = await this.withTimeout(SUPERVISOR_TIMEOUT_MS, (signal) =>
        this.fetchFn(SUPERVISOR_UPDATE_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          signal,
        }).then((r) => (r.ok ? 200 : r.status)),
      );
      if (status === 200) return { ok: true };
      if (status === 401 || status === 403) return { ok: false, reason: REFUSED };
      return { ok: false, reason: "Home Assistant could not update the add-on. Update it in Home Assistant." };
    } catch {
      return {
        ok: false,
        reason: "Home Assistant's update service did not answer. Update it in Home Assistant.",
      };
    }
  }

  private async withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}
