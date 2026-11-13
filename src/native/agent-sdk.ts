import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { resolveSqueakEnvPath } from "../squeak/paths.js";
import { logger } from "../utils/logger.js";
import { AGENT_SDK_PIN } from "./agent-sdk-pin.js";

/**
 * Squeak does not ship Anthropic's `@anthropic-ai/claude-agent-sdk` (all rights reserved, no redistribution grant).
 * A dev checkout resolves it from node_modules as before; the Mac app fetches the pinned tarball from the npm registry
 * on this Mac, checks it against the sha512 baked into Squeak at build time, and keeps it under
 * `<support dir>/agent-sdk/<version>/node_modules`.
 */
export type AgentSdk = typeof import("@anthropic-ai/claude-agent-sdk");

export interface PinnedPackage {
  name: string;
  version: string;
  integrity: string;
}
export interface AgentSdkPin {
  version: string;
  packages: readonly PinnedPackage[];
}

export interface AgentSdkOptions {
  supportDir?: string;
  pin?: AgentSdkPin;
  registry?: string;
  fetchImpl?: typeof fetch;
  /** Tries the normal module resolution; tests replace it. */
  importInstalled?: () => Promise<AgentSdk>;
  /** Called once when a download really starts (a chat shows "Getting Claude ready…"). */
  onFetch?: () => void;
  timeoutMs?: number;
  /** How long to wait for another process's download before giving up. */
  lockWaitMs?: number;
}

const PACKAGE = "@anthropic-ai/claude-agent-sdk";
const REGISTRY = "https://registry.npmjs.org";
const MARKER = ".squeak-verified";
const MAX_BYTES = 200 * 1024 * 1024;
const LOCK_STALE_MS = 10 * 60_000;
const run = promisify(execFile);

export class AgentSdkUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `Couldn't download Claude's agent kit from npm: ${reason.replace(/[.\s]+$/, "")}. Check the internet connection and send again.`,
    );
    this.name = "AgentSdkUnavailableError";
  }
}

function defaultSupportDir(): string {
  return path.dirname(resolveSqueakEnvPath());
}

function defaultImportInstalled(): Promise<AgentSdk> {
  return import("@anthropic-ai/claude-agent-sdk");
}

function isMissing(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  return e?.code === "ERR_MODULE_NOT_FOUND" && String(e.message ?? "").includes(PACKAGE);
}

function installRoot(supportDir: string, pin: AgentSdkPin): string {
  return path.join(supportDir, "agent-sdk", pin.version);
}

/** An earlier download is used only if every package carries the marker written after its hash matched this pin. */
function installedEntry(supportDir: string, pin: AgentSdkPin): string | null {
  const root = installRoot(supportDir, pin);
  try {
    for (const p of pin.packages) {
      const dir = path.join(root, "node_modules", p.name);
      const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER), "utf8")) as Partial<PinnedPackage>;
      if (marker.integrity !== p.integrity || marker.version !== p.version) return null;
      const meta = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { version?: string };
      if (meta.version !== p.version) return null;
    }
    const main = path.join(root, "node_modules", PACKAGE, "sdk.mjs");
    return fs.existsSync(main) ? main : null;
  } catch {
    return null;
  }
}

function tarballUrl(registry: string, p: PinnedPackage): string {
  const base = p.name.split("/").pop()!;
  return `${registry.replace(/\/+$/, "")}/${p.name}/-/${base}-${p.version}.tgz`;
}

async function downloadVerified(
  p: PinnedPackage,
  opts: Required<Pick<AgentSdkOptions, "registry" | "timeoutMs">> & { fetchImpl: typeof fetch },
): Promise<Buffer> {
  const url = tarballUrl(opts.registry, p);
  let res: Response;
  try {
    res = await opts.fetchImpl(url, { signal: AbortSignal.timeout(opts.timeoutMs), redirect: "follow" });
  } catch (error) {
    throw new AgentSdkUnavailableError(
      error instanceof Error ? ((error.cause as Error | undefined)?.message ?? error.message) : String(error),
    );
  }
  if (!res.ok) throw new AgentSdkUnavailableError(`npm answered ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) throw new AgentSdkUnavailableError("the download is larger than expected");
  let data: Buffer;
  try {
    data = Buffer.from(await res.arrayBuffer());
  } catch (error) {
    throw new AgentSdkUnavailableError(error instanceof Error ? error.message : String(error));
  }
  if (data.length > MAX_BYTES) throw new AgentSdkUnavailableError("the download is larger than expected");
  const got = `sha512-${crypto.createHash("sha512").update(data).digest("base64")}`;
  if (got !== p.integrity)
    throw new AgentSdkUnavailableError("the download did not match the checksum Squeak expects, so it was discarded");
  return data;
}

async function extract(tgz: string, into: string): Promise<void> {
  const { stdout } = await run("tar", ["-tzf", tgz], { maxBuffer: 32 * 1024 * 1024 });
  for (const entry of stdout.split("\n").filter(Boolean)) {
    if (path.isAbsolute(entry) || entry.split("/").includes("..")) throw new Error("the archive has an unsafe path");
  }
  fs.mkdirSync(into, { recursive: true });
  await run("tar", ["-xzf", tgz, "-C", into, "--strip-components=1"]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One download at a time across processes: an exclusive mkdir, stale after 10 minutes. */
async function withLock<T>(dir: string, waitMs: number, done: () => T | null, body: () => Promise<T>): Promise<T> {
  const lock = path.join(dir, ".lock");
  fs.mkdirSync(dir, { recursive: true });
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const ready = done();
      if (ready) return ready;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        /* released meanwhile */
      }
      if (Date.now() > until) throw new AgentSdkUnavailableError("another download is taking too long");
      await sleep(250);
    }
  }
  try {
    return done() ?? (await body());
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

async function install(supportDir: string, pin: AgentSdkPin, o: AgentSdkOptions): Promise<string> {
  const base = path.join(supportDir, "agent-sdk");
  return withLock(
    base,
    o.lockWaitMs ?? 180_000,
    () => installedEntry(supportDir, pin),
    async () => {
      o.onFetch?.();
      logger.info("agent kit: downloading from npm", { version: pin.version });
      const tmp = path.join(base, `.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
      try {
        fs.mkdirSync(tmp, { recursive: true });
        for (const p of pin.packages) {
          const data = await downloadVerified(p, {
            registry: o.registry ?? REGISTRY,
            timeoutMs: o.timeoutMs ?? 120_000,
            fetchImpl: o.fetchImpl ?? fetch,
          });
          const file = path.join(tmp, "pkg.tgz");
          fs.writeFileSync(file, data);
          const dest = path.join(tmp, "node_modules", p.name);
          try {
            await extract(file, dest);
          } catch (error) {
            throw new AgentSdkUnavailableError(
              `the download could not be unpacked (${error instanceof Error ? error.message.split("\n")[0] : "tar failed"})`,
            );
          } finally {
            fs.rmSync(file, { force: true });
          }
          const meta = JSON.parse(fs.readFileSync(path.join(dest, "package.json"), "utf8")) as {
            name?: string;
            version?: string;
          };
          if (meta.name !== p.name || meta.version !== p.version)
            throw new AgentSdkUnavailableError("the download is not the expected version");
          fs.writeFileSync(
            path.join(dest, MARKER),
            JSON.stringify({ name: p.name, version: p.version, integrity: p.integrity }),
          );
        }
        const final = installRoot(supportDir, pin);
        fs.rmSync(final, { recursive: true, force: true });
        fs.renameSync(tmp, final);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      const entry = installedEntry(supportDir, pin);
      if (!entry) throw new AgentSdkUnavailableError("the unpacked files are incomplete");
      return entry;
    },
  );
}

interface Flight {
  promise: Promise<AgentSdk>;
  listeners: Set<() => void>;
  started: boolean;
}
const flights = new Map<string, Flight>();
const loaded = new Map<string, AgentSdk>();

/** Test hook: forget what was loaded and any download in flight. */
export function resetAgentSdkForTests(): void {
  flights.clear();
  loaded.clear();
}

async function fromInstalled(o: AgentSdkOptions): Promise<AgentSdk | null> {
  try {
    return await (o.importInstalled ?? defaultImportInstalled)();
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function fromSupportDir(o: AgentSdkOptions): Promise<AgentSdk | null> {
  const entry = installedEntry(o.supportDir ?? defaultSupportDir(), o.pin ?? AGENT_SDK_PIN);
  return entry ? ((await import(pathToFileURL(entry).href)) as AgentSdk) : null;
}

/** The SDK only if it is already here (an install or a verified earlier download); never fetches. */
export async function loadAgentSdkIfPresent(options: AgentSdkOptions = {}): Promise<AgentSdk | null> {
  return (await fromInstalled(options)) ?? (await fromSupportDir(options));
}

export function agentSdkPresent(options: AgentSdkOptions = {}): boolean {
  return installedEntry(options.supportDir ?? defaultSupportDir(), options.pin ?? AGENT_SDK_PIN) !== null;
}

/** The SDK: an installed copy, else the verified download, else fetch it from npm (once, shared). */
export async function loadAgentSdk(options: AgentSdkOptions = {}): Promise<AgentSdk> {
  const supportDir = options.supportDir ?? defaultSupportDir();
  const pin = options.pin ?? AGENT_SDK_PIN;
  const present = await loadAgentSdkIfPresent({ ...options, supportDir, pin });
  if (present) return present;
  const key = `${supportDir}\0${pin.version}`;
  let flight = flights.get(key);
  if (!flight) {
    const listeners = new Set<() => void>();
    const f: Flight = { listeners, started: false, promise: undefined as never };
    f.promise = install(supportDir, pin, {
      ...options,
      onFetch: () => {
        f.started = true;
        for (const l of listeners) l();
      },
    })
      .then(async (entry) => (await import(pathToFileURL(entry).href)) as AgentSdk)
      .finally(() => flights.delete(key));
    flights.set(key, f);
    flight = f;
  }
  if (options.onFetch) {
    flight.listeners.add(options.onFetch);
    if (flight.started) options.onFetch();
  }
  return flight.promise;
}

/** Background fetch at start so the first chat rarely waits. Never throws; a failure is only logged. */
export async function prefetchAgentSdk(options: AgentSdkOptions = {}): Promise<void> {
  try {
    await loadAgentSdk(options);
  } catch (error) {
    logger.info("agent kit: prefetch skipped", { reason: error instanceof Error ? error.message : String(error) });
  }
}
