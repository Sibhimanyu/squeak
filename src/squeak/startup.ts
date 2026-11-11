import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What `squeak start` says about itself while it comes up, in `<support dir>/startup.json`, so the Mac app can show
 * progress (and the reason) when the daemon is slow or dies before it answers. Imports only node built-ins: it runs
 * before anything heavy is loaded.
 */
export type StartupPhase = "loading" | "config" | "database" | "fleet" | "listening" | "ready" | "failed";

export interface StartupRecord {
  pid: number;
  version: string;
  phase: StartupPhase;
  /** ISO-8601 time of this phase. */
  at: string;
  /** Only with phase "failed": a short sentence, never a secret. */
  error?: string;
}

export const STARTUP_FILE = "startup.json";

/** The daemon's version: `VERSION` (the embedded build, "<package>+<sha>") or package.json, two folders above this file. */
export function readDaemonVersion(here = path.dirname(fileURLToPath(import.meta.url))): string {
  for (const [name, parse] of [
    ["VERSION", (text: string) => text.trim()],
    ["package.json", (text: string) => String((JSON.parse(text) as { version?: unknown }).version ?? "")],
  ] as const) {
    try {
      const value = parse(fs.readFileSync(path.join(here, "..", "..", name), "utf8"));
      if (value) return value;
    } catch {
      // try the next
    }
  }
  return "unknown";
}

/** A short, secret-free one-liner out of an error. */
export function shortError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (text.split("\n")[0] ?? "")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[token]")
    .replace(/\/Users\/[^/\s]+/g, "/Users/[user]")
    .slice(0, 200);
}

export class StartupReporter {
  constructor(
    private readonly file: string,
    private readonly pid: number,
    private readonly version: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Atomic (temp file, then rename) and never throws: reporting must not stop the daemon from starting. */
  phase(phase: StartupPhase, error?: unknown): void {
    const record: StartupRecord = {
      pid: this.pid,
      version: this.version,
      phase,
      at: this.now().toISOString(),
      ...(phase === "failed" ? { error: shortError(error) } : {}),
    };
    const temp = `${this.file}.${this.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        // nothing more to do
      }
    }
  }
}

let current: StartupReporter | null = null;

/** The first thing `squeak start` does: one log line and phase "loading". */
export function beginStartup(supportDir: string, log: (line: string) => void = console.log): StartupReporter {
  const version = readDaemonVersion();
  log(`squeak ${version} starting, pid ${process.pid}, node ${process.version}`);
  current = new StartupReporter(path.join(supportDir, STARTUP_FILE), process.pid, version);
  current.phase("loading");
  return current;
}

/** Marks a milestone; a no-op when this process did not begin a startup (tests, other commands). */
export function startupPhase(phase: StartupPhase, error?: unknown): void {
  current?.phase(phase, error);
}
