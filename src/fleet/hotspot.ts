import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

import { logger } from "../utils/logger.js";
import { runHands } from "./conductor-ui.js";

const execFileAsync = promisify(execFile);

/**
 * Hotspot failover: when the Mac's internet goes away while you are relying on
 * it (an awake session, or an agent working), it joins your iPhone's Personal
 * Hotspot, so the phone channel, Telegram and the agents keep going.
 *
 * What macOS allows shaped this. Since macOS 14.4 every command-line view of
 * Wi-Fi names is redacted (`networksetup -getairportnetwork` says "not
 * associated", `ipconfig` and `system_profiler` print `<redacted>`), so Squeak
 * cannot see which network it is on or which are nearby. That includes
 * `networksetup -setairportnetwork`'s own scan: on macOS 26 it answered
 * "Could not find network" for a hotspot that was on, every time. So the join
 * goes through Squeak Hands (CoreWLAN, with Location Services permission): a
 * scan filtered to the one name, then associate with what it returned — how
 * Insomnia does it. `networksetup` is only the fallback for a Hands too old
 * to know the mode. The address an iPhone hotspot always hands out
 * (172.20.10.0/28) still says "on a hotspot" without a name. Going back is turning Wi-Fi off and on, after which macOS
 * joins your usual network itself; it also happens on its own when you turn
 * the hotspot off. iOS lets no app turn Personal Hotspot on, so that part is
 * yours.
 *
 * The password lives only in the login Keychain (`security`, service
 * "Squeak hotspot"); `hotspot.json` holds the name and the switch.
 */

export const HOTSPOT_KEYCHAIN_SERVICE = "Squeak hotspot";
/** How often the internet is looked at while failover is armed. */
export const HOTSPOT_CHECK_MS = 10_000;
/** Consecutive failed looks before switching: 10–20 seconds offline. */
export const HOTSPOT_FAILURES_TO_SWITCH = 2;
/**
 * Waits between automatic tries within one outage, then the last one
 * forever: a phone whose hotspot starts a moment late is caught in seconds,
 * not minutes (Insomnia's 5/10/20/30 s, at Squeak's 10 s look).
 */
export const HOTSPOT_RETRY_BACKOFF_MS = [10_000, 20_000, 30_000];
/** After you switch by hand, no automatic switch for this long. */
export const HOTSPOT_MANUAL_QUIET_MS = 5 * 60_000;
const SETTLE_MS = 20_000;
const SETTLE_POLL_MS = 2_000;
/** Squeak Hands' join: Location's first answer (20 s), two scans and two associations. */
const HANDS_JOIN_TIMEOUT_MS = 60_000;
const IPHONE_HOTSPOT_PREFIX = "172.20.10.";

export interface HotspotSettings {
  enabled: boolean;
  ssid: string | null;
}

export interface HotspotEvent {
  at: string;
  to: "hotspot" | "wifi";
  ok: boolean;
  /** One line for every surface: what happened, or what to do. */
  note: string;
  automatic: boolean;
}

export interface HotspotState {
  /** A name and a stored password. */
  configured: boolean;
  ssid: string | null;
  enabled: boolean;
  onHotspot: boolean;
  last: HotspotEvent | null;
}

export type HotspotRequest =
  | { action: "configure"; ssid: string; password?: string; enabled: boolean }
  | { action: "join" }
  | { action: "leave" }
  /** Forget the hotspot: its name, and its password in the Keychain. */
  | { action: "clear" };

export interface HotspotSystem {
  /** The Wi-Fi interface (`en0` on most Macs), or null without Wi-Fi. */
  wifiDevice(): Promise<string | null>;
  /** The interface's IPv4 address, or null. */
  address(device: string): Promise<string | null>;
  /** Whether the internet answers (Apple's captive-portal check). */
  online(): Promise<boolean>;
  /** Join a network; null on success, else why not, in words for the user. */
  join(device: string, ssid: string, password: string): Promise<string | null>;
  /** Asks for Location Services once, so a later join can find the hotspot. Never throws. */
  prepare?(): Promise<void>;
  /** Wi-Fi off, then on: macOS rejoins its preferred network itself. */
  cycle(device: string): Promise<void>;
  readPassword(): Promise<string | null>;
  storePassword(password: string): Promise<void>;
  /** Removes the stored password (`clear`); absent: it stays, unused. */
  deletePassword?(): Promise<void>;
}

export interface HotspotOptions {
  settingsPath: string;
  system?: HotspotSystem;
  /** Whether anything relies on the Mac being reachable right now. */
  wanted: () => boolean;
  onChange?: () => void;
  /** A switch made by itself, told to Telegram and Cliq. */
  notify?: (text: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** A Wi-Fi network name: 1–32 bytes, no control characters. */
export function validSsid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= 32 &&
    ![...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)
  );
}

/** A WPA passphrase: 8–63 printable ASCII characters, which is all a hotspot accepts. */
export function validPassword(value: unknown): value is string {
  return typeof value === "string" && /^[\x20-\x7e]{8,63}$/.test(value);
}

/** Reads the request shape a phone or the Mac app sends; null for anything else. */
export function readHotspotRequest(value: unknown): HotspotRequest | null {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!record) {
    return null;
  }
  if (record.action === "join" || record.action === "leave" || record.action === "clear") {
    return { action: record.action };
  }
  if (record.action !== "configure" || typeof record.enabled !== "boolean" || !validSsid(record.ssid)) {
    return null;
  }
  if (record.password !== undefined && !validPassword(record.password)) {
    return null;
  }
  return {
    action: "configure",
    ssid: record.ssid,
    enabled: record.enabled,
    ...(typeof record.password === "string" ? { password: record.password } : {}),
  };
}

export class HotspotFailover {
  private readonly options: HotspotOptions;
  private readonly system: HotspotSystem;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private settings: HotspotSettings;
  private hasPassword = false;
  private onHotspot = false;
  private last: HotspotEvent | null = null;
  private failures = 0;
  /** Automatic tries in the current outage; 0 when online. */
  private tries = 0;
  private nextTryAt = Number.NEGATIVE_INFINITY;
  private quietUntil = Number.NEGATIVE_INFINITY;
  /** When the current outage began; null when online. */
  private outageSince: number | null = null;
  /**
   * The newest failed automatic try of this outage. Said when the Mac is
   * back online, not when it happens: with no internet, Telegram and Cliq
   * cannot carry it, and every such notice was lost.
   */
  private failedTry: string | null = null;
  private busy = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: HotspotOptions) {
    this.options = options;
    this.system = options.system ?? macHotspotSystem();
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.settings = readSettings(options.settingsPath);
  }

  get state(): HotspotState {
    return {
      configured: Boolean(this.settings.ssid) && this.hasPassword,
      ssid: this.settings.ssid,
      enabled: this.settings.enabled,
      onHotspot: this.onHotspot,
      last: this.last,
    };
  }

  async start(): Promise<void> {
    this.hasPassword = Boolean(await this.system.readPassword().catch(() => null));
    await this.refreshOnHotspot();
    this.timer = setInterval(() => void this.tick(), HOTSPOT_CHECK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async apply(request: HotspotRequest): Promise<{ ok: true; state: HotspotState } | { ok: false; reason: string }> {
    if (request.action === "configure") {
      if (request.password !== undefined) {
        await this.system.storePassword(request.password);
        this.hasPassword = true;
      } else if (!this.hasPassword || request.ssid !== this.settings.ssid) {
        return { ok: false, reason: "Enter the hotspot's password too." };
      }
      this.settings = { enabled: request.enabled, ssid: request.ssid };
      writeSettings(this.options.settingsPath, this.settings);
      this.failures = 0;
      this.tries = 0;
      // Now, while someone is at the Mac to answer macOS's prompt; not at
      // the moment the Wi-Fi drops, perhaps with the lid shut.
      if (request.enabled) void this.system.prepare?.();
      this.options.onChange?.();
      return { ok: true, state: this.state };
    }
    if (request.action === "clear") {
      await this.system.deletePassword?.();
      this.hasPassword = false;
      this.settings = { enabled: false, ssid: null };
      writeSettings(this.options.settingsPath, this.settings);
      this.failures = 0;
      this.tries = 0;
      this.options.onChange?.();
      return { ok: true, state: this.state };
    }
    if (!this.state.configured) {
      return { ok: false, reason: "Set up your hotspot's name and password first." };
    }
    if (this.busy) {
      return { ok: false, reason: "Your Mac is already switching networks." };
    }
    const event = request.action === "join" ? await this.join(false) : await this.leave();
    return event.ok ? { ok: true, state: this.state } : { ok: false, reason: event.note };
  }

  /** One look at the network; switches when it has been gone long enough and something needs the Mac. */
  async tick(): Promise<void> {
    if (this.busy) {
      return;
    }
    const was = this.onHotspot;
    await this.refreshOnHotspot();
    if (was !== this.onHotspot) {
      this.options.onChange?.();
    }
    if (!this.settings.enabled || !this.state.configured) {
      this.resetOutage();
      return;
    }
    if (await this.system.online().catch(() => false)) {
      this.endOutage();
      return;
    }
    this.outageSince ??= this.now();
    if (this.onHotspot) {
      // On the hotspot already, and it has no internet either: nothing to switch to.
      this.failures = 0;
      return;
    }
    this.failures += 1;
    if (
      this.failures >= HOTSPOT_FAILURES_TO_SWITCH &&
      this.options.wanted() &&
      this.now() >= this.nextTryAt &&
      this.now() >= this.quietUntil
    ) {
      const wait = HOTSPOT_RETRY_BACKOFF_MS[Math.min(this.tries, HOTSPOT_RETRY_BACKOFF_MS.length - 1)]!;
      this.tries += 1;
      this.nextTryAt = this.now() + wait;
      await this.join(true);
    }
  }

  /** Online again: says what the failed tries could not say while offline. */
  private endOutage(): void {
    if (this.failedTry && this.outageSince !== null) {
      const where = this.onHotspot ? `, on ${this.settings.ssid},` : "";
      const tried = this.tries > 1 ? ` Squeak tried ${this.tries} times.` : "";
      this.options.notify?.(
        `The Mac is back online${where} after ${describeDuration(this.now() - this.outageSince)} offline. ${this.failedTry}${tried}`,
      );
    }
    this.resetOutage();
  }

  private resetOutage(): void {
    this.outageSince = null;
    this.failedTry = null;
    this.failures = 0;
    this.tries = 0;
    this.nextTryAt = Number.NEGATIVE_INFINITY;
  }

  private async join(automatic: boolean): Promise<HotspotEvent> {
    this.busy = true;
    if (!automatic) this.quietUntil = this.now() + HOTSPOT_MANUAL_QUIET_MS;
    const ssid = this.settings.ssid!;
    try {
      const device = await this.system.wifiDevice();
      const password = await this.system.readPassword().catch(() => null);
      if (!device) {
        return this.record("hotspot", false, "This Mac has no Wi-Fi to join a hotspot with.", automatic);
      }
      if (!password) {
        this.hasPassword = false;
        return this.record(
          "hotspot",
          false,
          "The hotspot's password isn't in the Keychain any more. Set it up again.",
          automatic,
        );
      }
      const complaint = await this.system.join(device, ssid, password);
      if (complaint) {
        return this.record("hotspot", false, `Couldn't join ${ssid}: ${complaint}`, automatic);
      }
      if (!(await this.settle(true))) {
        return this.record("hotspot", false, `Couldn't join ${ssid}: is Personal Hotspot on?`, automatic);
      }
      return this.record(
        "hotspot",
        true,
        automatic ? `The Mac's Wi-Fi dropped, so it joined ${ssid}.` : `Your Mac is on ${ssid}.`,
        automatic,
      );
    } finally {
      this.busy = false;
    }
  }

  private async leave(): Promise<HotspotEvent> {
    this.busy = true;
    this.quietUntil = this.now() + HOTSPOT_MANUAL_QUIET_MS;
    try {
      const device = await this.system.wifiDevice();
      if (!device) {
        return this.record("wifi", false, "This Mac has no Wi-Fi.", false);
      }
      await this.system.cycle(device);
      if (await this.settle(false)) {
        return this.record("wifi", true, "Your Mac is back on its usual Wi-Fi.", false);
      }
      await this.refreshOnHotspot();
      return this.record(
        "wifi",
        false,
        this.onHotspot
          ? "Your Mac rejoined the hotspot. Turn Personal Hotspot off and it moves to your Wi-Fi."
          : "Your Mac isn't online yet. It joins your Wi-Fi when it is in range.",
        false,
      );
    } finally {
      this.busy = false;
    }
  }

  /** Waits for the hotspot address (or its absence) and the internet together. */
  private async settle(wantHotspot: boolean): Promise<boolean> {
    for (let waited = 0; waited <= SETTLE_MS; waited += SETTLE_POLL_MS) {
      await this.refreshOnHotspot();
      if (this.onHotspot === wantHotspot && (await this.system.online().catch(() => false))) {
        return true;
      }
      await this.sleep(SETTLE_POLL_MS);
    }
    return false;
  }

  private async refreshOnHotspot(): Promise<void> {
    const device = await this.system.wifiDevice().catch(() => null);
    const address = device ? await this.system.address(device).catch(() => null) : null;
    this.onHotspot = Boolean(address?.startsWith(IPHONE_HOTSPOT_PREFIX));
  }

  private record(to: HotspotEvent["to"], ok: boolean, note: string, automatic: boolean): HotspotEvent {
    const event: HotspotEvent = { at: new Date(this.now()).toISOString(), to, ok, note, automatic };
    this.last = event;
    logger.info("hotspot", { to, ok, automatic, note, ...(automatic ? { attempt: this.tries } : {}) });
    // A success is said at once (the hotspot carries it); a failure waits
    // for the internet in endOutage.
    if (automatic && ok) {
      this.failedTry = null;
      this.options.notify?.(note);
    } else if (automatic) {
      this.failedTry = note;
    }
    this.options.onChange?.();
    return event;
  }
}

/** "under a minute", "1 min", "12 min", "2 h 5 min". */
export function describeDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""}`;
}

function readSettings(file: string): HotspotSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<HotspotSettings>;
    return { enabled: raw.enabled === true, ssid: validSsid(raw.ssid) ? raw.ssid : null };
  } catch {
    return { enabled: false, ssid: null };
  }
}

function writeSettings(file: string, settings: HotspotSettings): void {
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

const JOIN_ADVICE =
  "is Personal Hotspot on? Open Personal Hotspot on the iPhone, or set System Settings › Wi-Fi › Ask to join hotspots to Automatic.";

/** What Squeak Hands' `wifi-join` said, in words; null when it joined. */
export function describeHandsJoin(result: Record<string, unknown>): string | null {
  if (result.ok === true) return null;
  const location = result.location;
  if (location === "denied" || location === "restricted") {
    return "Squeak Hands needs Location Services to find a hotspot by name (System Settings › Privacy & Security › Location Services).";
  }
  switch (result.error) {
    case "not-found":
      return location === "allowed"
        ? JOIN_ADVICE
        : "Squeak Hands has not been allowed Location Services yet, which macOS needs to find a hotspot by name. Turn the hotspot off and on in Squeak on the Mac to be asked again.";
    case "no-interface":
      return "this Mac's Wi-Fi could not be opened.";
    case "join-failed":
      return `the hotspot refused the join (${String(result.detail ?? "wrong password?")}).`;
    default:
      return `Squeak Hands could not join (${String(result.error ?? "no answer")}).`;
  }
}

/**
 * Whether the internet answers. Apple's captive-portal page is only one of the
 * looks: a managed network can drop it while everything else works (measured
 * on this Mac, 2026-10-20: captive.apple.com timed out every time, direct and
 * through the system proxy, while HTTPS to Google answered in 0.2 s, and
 * Squeak "lost" its internet 429 times on working Wi-Fi). So any one answer
 * counts, and only all of them failing is an outage.
 */
export async function probeInternet(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const looks: Array<() => Promise<boolean>> = [
    async () => {
      const res = await fetchImpl("http://captive.apple.com/hotspot-detect.html", {
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok && (await res.text()).includes("Success");
    },
    // Any HTTP answer over TLS proves a route out; a captive portal cannot fake a certificate.
    async () =>
      (await fetchImpl("https://www.google.com/generate_204", { signal: AbortSignal.timeout(5_000) })).status < 500,
    async () =>
      (await fetchImpl("https://www.cloudflare.com/cdn-cgi/trace", { signal: AbortSignal.timeout(5_000) })).status <
      500,
  ];
  try {
    await Promise.any(looks.map(async (look) => (await look()) || Promise.reject(new Error("no"))));
    return true;
  } catch {
    return false;
  }
}

/** For `security -i`, which reads commands from stdin: a double-quoted word. */
function securityQuote(value: string): string {
  return `"${value.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;
}

/** The real thing: Squeak Hands (CoreWLAN), networksetup, ipconfig, security and Apple's captive-portal page. */
export function macHotspotSystem(handsAppPath: string | null = null): HotspotSystem {
  let device: string | null | undefined;
  const run = async (file: string, args: string[], timeout = 15_000) =>
    (await execFileAsync(file, args, { timeout })).stdout.toString();
  return {
    async wifiDevice() {
      if (device !== undefined) return device;
      const ports = await run("/usr/sbin/networksetup", ["-listallhardwareports"]);
      const match = /Hardware Port: (?:Wi-Fi|AirPort)\s*\nDevice: (\S+)/.exec(ports);
      device = match?.[1] ?? null;
      return device;
    },
    async address(dev) {
      try {
        return (await run("/usr/sbin/ipconfig", ["getifaddr", dev], 5_000)).trim() || null;
      } catch {
        return null; // exits 1 when the interface has no address
      }
    },
    online: () => probeInternet(),
    async prepare() {
      if (!handsAppPath) return;
      const outcome = await runHands(handsAppPath, "wifi-location", {}).catch(() => null);
      logger.info("hotspot location permission", {
        location: outcome?.status === "result" ? outcome.result.location : (outcome?.status ?? "failed"),
      });
    },
    async join(dev, ssid, password) {
      if (handsAppPath) {
        // The password goes over as a 0600 file, never in a process's arguments.
        const outcome = await runHands(
          handsAppPath,
          "wifi-join",
          { device: dev, ssid, password },
          HANDS_JOIN_TIMEOUT_MS,
        );
        if (outcome.status === "result" && outcome.result.error !== "unknown-mode") {
          return describeHandsJoin(outcome.result);
        }
        logger.warn("squeak hands cannot join Wi-Fi; rebuild it with helpers/squeak-hands/build.sh", {
          status: outcome.status,
        });
      }
      try {
        // networksetup prints nothing on success and a reason (exit 0 or not) on failure.
        const out = (await run("/usr/sbin/networksetup", ["-setairportnetwork", dev, ssid, password], 30_000)).trim();
        return out ? `${JOIN_ADVICE} (${out.split("\n")[0]!.slice(0, 160)})` : null;
      } catch (error) {
        return `${JOIN_ADVICE} (${error instanceof Error ? error.message.split("\n")[0]!.slice(0, 160) : "networksetup failed"})`;
      }
    },
    async cycle(dev) {
      await run("/usr/sbin/networksetup", ["-setairportpower", dev, "off"]);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await run("/usr/sbin/networksetup", ["-setairportpower", dev, "on"]);
    },
    async readPassword() {
      try {
        return (
          (
            await run("/usr/bin/security", [
              "find-generic-password",
              "-a",
              "squeak",
              "-s",
              HOTSPOT_KEYCHAIN_SERVICE,
              "-w",
            ])
          ).replace(/\n$/, "") || null
        );
      } catch {
        return null; // exits 44 when there is no such item
      }
    },
    async storePassword(password) {
      // Through stdin (`security -i`), not argv, where `ps` would show it.
      const service = securityQuote(HOTSPOT_KEYCHAIN_SERVICE);
      const command = `add-generic-password -U -a squeak -s ${service} -l ${service} -w ${securityQuote(password)}\n`;
      await new Promise<void>((resolve, reject) => {
        const child = execFile("/usr/bin/security", ["-i"], { timeout: 15_000 }, (error) =>
          error ? reject(error) : resolve(),
        );
        child.stdin?.end(command);
      });
      if ((await this.readPassword()) !== password) {
        throw new Error("the Keychain did not keep the hotspot password");
      }
    },
    async deletePassword() {
      await new Promise<void>((resolve) => {
        // Exits 44 when there is no such item, which is the state wanted.
        execFile(
          "/usr/bin/security",
          ["delete-generic-password", "-a", "squeak", "-s", HOTSPOT_KEYCHAIN_SERVICE],
          { timeout: 15_000 },
          () => resolve(),
        );
      });
    },
  };
}
