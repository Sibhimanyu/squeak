import { execFile } from "node:child_process";

const IOREG = "/usr/sbin/ioreg";

/** Seconds since the last key or mouse movement, from `ioreg -c IOHIDSystem`'s `HIDIdleTime` (nanoseconds). Null when unreadable. */
export function parseIdleSeconds(ioregOutput: string): number | null {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioregOutput);
  if (!match) return null;
  const nanoseconds = Number(match[1]);
  return Number.isFinite(nanoseconds) ? nanoseconds / 1e9 : null;
}

/** How long the person has been away from this Mac's keyboard and mouse; null when it cannot be told (not macOS, ioreg failed). */
export function readIdleSeconds(timeoutMs = 3_000): Promise<number | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(IOREG, ["-c", "IOHIDSystem", "-d", "4"], { timeout: timeoutMs, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? null : parseIdleSeconds(stdout));
    });
  });
}
