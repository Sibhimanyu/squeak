import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The watchdog for an app-managed daemon whose Squeak.app was dragged to the Trash: when the app is
 * provably gone for about ten minutes, run `squeak uninstall --orphan --yes` once, detached.
 * Contract: `.context/orphan-uninstall-contract.md`. Every outside effect is injected, so tests touch no
 * disk, Spotlight, launchd or process. A daemon with no claim file (`app-install.json`) never watches.
 */

export const APP_BUNDLE_ID = "com.squeak.mac";
export const FIRST_LOOK_MS = 2 * 60_000;
export const LOOK_EVERY_MS = 5 * 60_000;
export const MISSES_TO_ORPHAN = 3;
export const RETRY_AFTER_FAILURE_MS = 24 * 60 * 60_000;

export interface InstallClaim {
  v: 1;
  appPath: string;
  bundleId: string;
  version: string;
  writtenAt: number;
}

export interface OrphanWatchDeps {
  /** The claim file, or null when absent or unreadable. */
  readClaim(): InstallClaim | null;
  /** Points the claim at the app's new place. */
  writeClaim(claim: InstallClaim): void;
  /** True when `appPath` is a directory with Contents/Info.plist whose CFBundleIdentifier is com.squeak.mac. */
  appPresent(appPath: string): Promise<boolean>;
  /** Candidate copies: the standard folders plus Spotlight's answer for the bundle id (unfiltered). */
  findCopies(): Promise<string[]>;
  /** A `Squeak*.app` sits in ~/.Trash. */
  trashHasSqueak(): Promise<boolean>;
  /** Spotlight demonstrably answers (a query for Finder returns something). */
  spotlightWorks(): Promise<boolean>;
  /** Starts the detached uninstall; throws if it cannot start. */
  spawnUninstall(): void;
  now(): number;
  log(message: string): void;
  home: string;
}

const IGNORED_FRAGMENTS = ["/.Trash/", "/.Trashes/", "/.build/", "/build/", "/DerivedData/", "/.squeak-release/"];

/** A copy that may count as "the app moved": not trashed, not on a mounted volume, not a build product. */
export function usableCopy(appPath: string, home: string): boolean {
  const p = appPath.endsWith("/") ? appPath : appPath + "/";
  if (p.startsWith(path.join(home, ".Trash") + "/") || p.startsWith("/Volumes/")) return false;
  return !IGNORED_FRAGMENTS.some((fragment) => p.includes(fragment));
}

export class OrphanWatch {
  private misses = 0;
  private claimStamp = 0;
  private spawned = false;
  private blockedUntil = 0;
  private warnedNoProof = false;
  private ticking = false;
  private first: NodeJS.Timeout | null = null;
  private every: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: OrphanWatchDeps,
    private readonly timing = { firstMs: FIRST_LOOK_MS, everyMs: LOOK_EVERY_MS },
  ) {}

  /** Arms only with a claim file at start; no file, no watching. */
  start(): boolean {
    if (!this.deps.readClaim()) return false;
    this.deps.log("orphan watch armed");
    this.first = setTimeout(() => {
      void this.tick();
      this.every = setInterval(() => void this.tick(), this.timing.everyMs);
      this.every.unref();
    }, this.timing.firstMs);
    this.first.unref();
    return true;
  }

  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.every) clearInterval(this.every);
    this.first = this.every = null;
  }

  private reset(): void {
    this.misses = 0;
    this.claimStamp = 0;
    this.warnedNoProof = false;
  }

  /** One look. Exposed for tests; never throws. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.look();
    } catch {
      this.deps.log("orphan watch look failed; not acting");
    } finally {
      this.ticking = false;
    }
  }

  private async look(): Promise<void> {
    const { deps } = this;
    if (this.spawned || deps.now() < this.blockedUntil) return;
    const claim = deps.readClaim();
    if (!claim) {
      this.reset();
      return;
    }
    // The app wrote a newer claim after our first miss: it launched again, so it is not gone.
    if (this.misses > 0 && claim.writtenAt > this.claimStamp) {
      deps.log("claim file is newer than the first miss; resetting");
      this.reset();
    }
    if (await deps.appPresent(claim.appPath)) {
      if (this.misses > 0) deps.log("app is back; resetting");
      this.reset();
      return;
    }
    for (const candidate of await deps.findCopies()) {
      if (candidate === claim.appPath || !usableCopy(candidate, deps.home)) continue;
      if (await deps.appPresent(candidate)) {
        deps.log(`app moved to ${candidate}; updating the claim`);
        deps.writeClaim({ ...claim, appPath: candidate });
        this.reset();
        return;
      }
    }
    const evidence = (await deps.trashHasSqueak()) || (await deps.spotlightWorks());
    if (!evidence) {
      if (!this.warnedNoProof) deps.log("app not found, not acting: can't prove it was removed");
      this.warnedNoProof = true;
      return;
    }
    if (this.misses === 0) this.claimStamp = claim.writtenAt;
    this.misses += 1;
    deps.log(`app missing (${this.misses}/${MISSES_TO_ORPHAN})`);
    if (this.misses < MISSES_TO_ORPHAN) return;
    try {
      deps.spawnUninstall();
      this.spawned = true;
      deps.log("app is gone: started the orphan uninstall");
    } catch {
      this.blockedUntil = deps.now() + RETRY_AFTER_FAILURE_MS;
      deps.log("could not start the orphan uninstall; trying again in 24 h");
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The real effects

function run(file: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) =>
    execFile(file, args, { timeout: 15_000, encoding: "utf8" }, (error, stdout) =>
      resolve({ ok: !error, stdout: String(stdout ?? "") }),
    ),
  );
}

function parseClaim(text: string): InstallClaim | null {
  try {
    const o = JSON.parse(text) as Partial<InstallClaim>;
    if (o.v !== 1 || typeof o.appPath !== "string" || !o.appPath.startsWith("/")) return null;
    if (typeof o.writtenAt !== "number") return null;
    return {
      v: 1,
      appPath: o.appPath,
      bundleId: typeof o.bundleId === "string" ? o.bundleId : APP_BUNDLE_ID,
      version: typeof o.version === "string" ? o.version : "",
      writtenAt: o.writtenAt,
    };
  } catch {
    return null;
  }
}

export function claimPath(supportDir: string): string {
  return path.join(supportDir, "app-install.json");
}

export function realOrphanWatchDeps(
  supportDir: string,
  cliJs: string,
  log: (message: string) => void,
  home = os.homedir(),
): OrphanWatchDeps {
  const file = claimPath(supportDir);
  return {
    home,
    log,
    now: () => Date.now(),
    readClaim: () => {
      try {
        return parseClaim(fs.readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    },
    writeClaim: (claim) => {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(claim), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
    appPresent: async (appPath) => {
      try {
        if (!fs.statSync(appPath).isDirectory()) return false;
        const plist = path.join(appPath, "Contents/Info.plist");
        if (!fs.existsSync(plist)) return false;
        const out = await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist]);
        return out.ok && out.stdout.trim() === APP_BUNDLE_ID;
      } catch {
        return false;
      }
    },
    findCopies: async () => {
      const out = await run("/usr/bin/mdfind", [`kMDItemCFBundleIdentifier == '${APP_BUNDLE_ID}'`]);
      return [
        "/Applications/Squeak.app",
        path.join(home, "Applications/Squeak.app"),
        ...out.stdout.split("\n").filter((line) => line.startsWith("/")),
      ];
    },
    trashHasSqueak: async () => {
      try {
        return fs.readdirSync(path.join(home, ".Trash")).some((n) => /^Squeak.*\.app$/.test(n));
      } catch {
        return false;
      }
    },
    spotlightWorks: async () => {
      const out = await run("/usr/bin/mdfind", ["kMDItemCFBundleIdentifier == 'com.apple.finder'"]);
      return out.ok && out.stdout.trim().length > 0;
    },
    spawnUninstall: () => {
      const child = spawn(process.execPath, [cliJs, "uninstall", "--orphan", "--yes"], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => undefined);
      child.unref();
    },
  };
}
