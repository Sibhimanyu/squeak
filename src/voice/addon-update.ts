/**
 * The add-on updating itself on the Mac's word (docs: .context/addon-update-contract.md). It learns the newest
 * version on its own, from a fixed address, and only ever asks Home Assistant's Supervisor (a fixed address too) to
 * update it when that version is newer than the running one. Nothing in a message chooses a URL, a version or a
 * token; the Supervisor token comes from the environment and is never logged, stored or sent anywhere else.
 */

/** Where the newest version is read from: the add-on's own config.yaml on master. Fixed. */
export const LATEST_CONFIG_URL =
  "https://raw.githubusercontent.com/Sibhimanyu/squeak/master/homeassistant/squeak-voice/config.yaml";
/**
 * Home Assistant's Supervisor, as an add-on reaches it (fixed addresses, `Authorization: Bearer $SUPERVISOR_TOKEN`).
 * Docs: https://contributors.home-assistant.io/apps/guides/communication/ and /apps/supervisor-api/.
 * An add-on CANNOT update itself through the Supervisor: `POST /addons/self/update` and `/store/addons/self/update`
 * answer 403 "can't update itself" whatever the role (supervisor/api/store.py `apps_app_update`). Core can: its
 * `update.install` service on this add-on's update entity, reached through the Core API proxy (`homeassistant_api`).
 */
export const SUPERVISOR_INFO_URL = "http://supervisor/addons/self/info";
/** Makes the Supervisor pull the add-on repositories again (needs `hassio_role: manager`). */
export const SUPERVISOR_RELOAD_URL = "http://supervisor/store/reload";
/** Core's entity states through the Supervisor's proxy (needs `homeassistant_api: true`). */
export const CORE_STATES_URL = "http://supervisor/core/api/states";
/** Core's `update.install` service: Core, not this add-on, asks the Supervisor, which is allowed. */
export const CORE_INSTALL_URL = "http://supervisor/core/api/services/update/install";

const LOOK_MS = 6 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
/** Core answers once the update is installed, which never happens: the Supervisor stops this process first. */
const INSTALL_TIMEOUT_MS = 90_000;
const RELOAD_TIMEOUT_MS = 20_000;
const INFO_TIMEOUT_MS = 10_000;
const MAX_STATES_BYTES = 16 * 1024 * 1024;
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

/** The add-on that takes the Mac's call clips after the call is placed, and speaks the question flow (docs/voice.md). */
export const LATE_CLIPS_ADDON = "0.11.0";

/** The add-on that offers 9 (a message for the chat that asked) and 0 (its status) on a call out. */
export const FOLLOW_UP_ADDON = "0.11.7";

/** The add-on that talks a call out through by voice (`talk`): listens after the question, answers, reads back, sends. */
export const VOICE_FIRST_ADDON = "0.12.0";

/** The add-on whose dialog talks a call with no options through (a call back: "call me back when you're done"). */
export const CALLBACK_ADDON = "0.14.0";

/** The add-on that can stay on the line while a chat works (`hold`: check-ins, and a key for what it is thinking). */
export const HOLD_ADDON = "0.15.0";

/** The add-on that plays a spoken answer sentence by sentence as the Mac makes it (`audioFollows` on an answer). */
export const ANSWER_STREAM_ADDON = "0.17.0";

/** Whether an add-on reporting `version` is at least `minimum`; false when its version is unknown. */
export function addonSupports(version: string | null | undefined, minimum: string): boolean {
  return cleanVersion(version) !== null && !isNewer(minimum, version);
}

/** The `version: "x.y.z"` line of a config.yaml, strictly; null for anything else. */
export function parseConfigVersion(text: string): string | null {
  return cleanVersion(/^version:[ \t]*"([^"\r\n]*)"[ \t]*\r?$/m.exec(text)?.[1]);
}

export type UpdateOutcome = { ok: true } | { ok: false; reason: string };

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
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
export const PERMISSION_REASON =
  "Home Assistant did not let this add-on update itself. Update Squeak Voice once in Home Assistant (Settings › Add-ons), then reinstall if this persists: it needs its new permission.";
export const LOCAL_REASON =
  "This add-on was installed from local files, so Home Assistant has nothing newer to offer. Copy the new add-on files again, then press Update in Home Assistant.";
export const ALREADY_REASON =
  "Already on the newest version Home Assistant knows of. If a newer one is out, reload the list: Settings › Add-ons › Add-on Store › ⋮ › Check for updates.";
export const notSeenReason = (latest: string): string =>
  `Home Assistant has not seen ${latest} yet. Reload its list (Settings › Add-ons › Add-on Store › ⋮ › Check for updates), then press Check again.`;
const NO_ENTITY =
  "Home Assistant has no update entry for this add-on. Press Update in Settings › Add-ons › Squeak Voice.";

/** What the Supervisor says about this add-on (`GET /addons/self/info`, no extra permission). */
export interface SelfInfo {
  slug: string;
  name: string;
  version: string;
  versionLatest: string | null;
  updateAvailable: boolean;
}

/** The update entity of an add-on among Core's states, or null. Matches by the add-on's icon path, else its title. */
export function pickUpdateEntity(states: unknown, info: Pick<SelfInfo, "slug" | "name" | "version">): string | null {
  if (!Array.isArray(states)) return null;
  const candidates: Array<{ id: string; byIcon: boolean }> = [];
  for (const raw of states) {
    if (typeof raw !== "object" || raw === null) continue;
    const s = raw as { entity_id?: unknown; attributes?: unknown };
    if (typeof s.entity_id !== "string" || !/^update\.[a-z0-9_]+$/.test(s.entity_id)) continue;
    const a = (typeof s.attributes === "object" && s.attributes !== null ? s.attributes : {}) as Record<
      string,
      unknown
    >;
    if (typeof a.installed_version === "string" && a.installed_version !== info.version) continue;
    const byIcon = typeof a.entity_picture === "string" && a.entity_picture.includes(`/addons/${info.slug}/`);
    const byTitle = a.title === info.name;
    if (byIcon || byTitle) candidates.push({ id: s.entity_id, byIcon });
  }
  return (candidates.find((c) => c.byIcon) ?? candidates[0])?.id ?? null;
}

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
   * Updates this add-on the way Home Assistant allows it, in this order: reload the store (so a version published
   * minutes ago is seen), read this add-on's own info (installed, latest, update available), then ask Core to install
   * the update. `started` runs after every check and BEFORE the install, since the update stops this process: the
   * reply to the Mac must already be written. A refusal before that is returned and `started` never runs. A request
   * to Core that never answers or is cut off is the update stopping this process: reported as ok, and the Mac
   * confirms by the add-on coming back with the new version.
   */
  async update(started: () => Promise<void> | void, note?: (text: string) => void): Promise<UpdateOutcome> {
    const token = this.options.token;
    if (!token) return { ok: false, reason: NO_TOKEN };
    if (this.updating) return { ok: false, reason: "The update is already under way." };
    this.updating = true;
    try {
      return await this.run(token, started, note);
    } finally {
      this.updating = false;
    }
  }

  private async run(
    token: string,
    started: () => Promise<void> | void,
    note?: (text: string) => void,
  ): Promise<UpdateOutcome> {
    const reload = await this.reloadStore();
    if (!reload.ok) note?.(`Could not ask Home Assistant to refresh: ${reload.reason}`);
    const latest = await this.look();
    const info = await this.readInfo(token);
    if (info === "denied") return { ok: false, reason: PERMISSION_REASON };
    if (!info) {
      return isNewer(latest, this.options.version)
        ? { ok: false, reason: "Home Assistant did not answer. Update it in Settings › Add-ons › Squeak Voice." }
        : { ok: false, reason: ALREADY_REASON };
    }
    if (!info.updateAvailable) {
      if (info.slug.startsWith("local_")) return { ok: false, reason: LOCAL_REASON };
      return isNewer(latest, info.version)
        ? { ok: false, reason: notSeenReason(latest ?? "the new version") }
        : { ok: false, reason: ALREADY_REASON };
    }
    const entity = await this.findEntity(token, info);
    if (entity === null) return { ok: false, reason: NO_ENTITY };
    if (typeof entity === "object") return entity;
    await started();
    return await this.install(token, entity, note);
  }

  /** Asks the Supervisor to re-read the add-on repositories (fixed address, own token); never throws. */
  async reloadStore(): Promise<UpdateOutcome> {
    const token = this.options.token;
    if (!token) return { ok: false, reason: NO_TOKEN };
    try {
      const status = await this.withTimeout(RELOAD_TIMEOUT_MS, (signal) =>
        this.fetchFn(SUPERVISOR_RELOAD_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          signal,
        }).then((r) => (r.ok ? 200 : r.status)),
      );
      if (status === 200) return { ok: true };
      if (status === 401 || status === 403) return { ok: false, reason: PERMISSION_REASON };
      return { ok: false, reason: "Home Assistant could not refresh its add-on list." };
    } catch {
      return { ok: false, reason: "Home Assistant's update service did not answer." };
    }
  }

  /** This add-on's own record; "denied" for 401/403, null when unreadable. Never throws. */
  async readInfo(token = this.options.token): Promise<SelfInfo | "denied" | null> {
    if (!token) return null;
    try {
      const answer = await this.withTimeout(INFO_TIMEOUT_MS, (signal) =>
        this.fetchFn(SUPERVISOR_INFO_URL, { headers: { authorization: `Bearer ${token}` }, signal }).then(
          async (r) => ({ status: r.status, ok: r.ok, text: r.ok ? await r.text() : "" }),
        ),
      );
      if (answer.status === 401 || answer.status === 403) return "denied";
      if (!answer.ok || answer.text.length > MAX_CONFIG_BYTES) return null;
      const data = (JSON.parse(answer.text) as { data?: Record<string, unknown> }).data;
      if (!data || typeof data.slug !== "string" || typeof data.version !== "string") return null;
      return {
        slug: data.slug,
        name: typeof data.name === "string" ? data.name : "",
        version: data.version,
        versionLatest: typeof data.version_latest === "string" ? data.version_latest : null,
        updateAvailable: data.update_available === true,
      };
    } catch {
      return null;
    }
  }

  /** The entity id, null when Core has none for this add-on, or a refusal to return. */
  private async findEntity(token: string, info: SelfInfo): Promise<string | null | { ok: false; reason: string }> {
    try {
      const answer = await this.withTimeout(INFO_TIMEOUT_MS, (signal) =>
        this.fetchFn(CORE_STATES_URL, { headers: { authorization: `Bearer ${token}` }, signal }).then(async (r) => ({
          status: r.status,
          ok: r.ok,
          text: r.ok ? await r.text() : "",
        })),
      );
      if (answer.status === 401 || answer.status === 403) return { ok: false, reason: PERMISSION_REASON };
      if (!answer.ok || answer.text.length > MAX_STATES_BYTES) {
        return { ok: false, reason: "Home Assistant could not list its updates. Update it in Settings › Add-ons." };
      }
      return pickUpdateEntity(JSON.parse(answer.text), info);
    } catch {
      return { ok: false, reason: "Home Assistant did not answer. Update it in Settings › Add-ons › Squeak Voice." };
    }
  }

  private async install(token: string, entity: string, note?: (text: string) => void): Promise<UpdateOutcome> {
    try {
      const status = await this.withTimeout(INSTALL_TIMEOUT_MS, (signal) =>
        this.fetchFn(CORE_INSTALL_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ entity_id: entity }),
          signal,
        }).then((r) => (r.ok ? 200 : r.status)),
      );
      if (status === 200) return { ok: true };
      if (status === 401 || status === 403) return { ok: false, reason: PERMISSION_REASON };
      return { ok: false, reason: "Home Assistant could not update the add-on. Update it in Settings › Add-ons." };
    } catch {
      // The update stops this process, so the answer never comes or the connection is cut: probably updating.
      note?.("Home Assistant did not answer: the add-on is probably being updated.");
      return { ok: true };
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
