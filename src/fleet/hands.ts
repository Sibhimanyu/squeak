import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { logger } from "../utils/logger.js";

/** Squeak Hands: the signed helper that holds the Accessibility/Automation grants. Shared by every source that types or drives a window. */
export const DEFAULT_HANDS_APP = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "squeak",
  "Squeak Hands.app",
);

const HELPER_TIMEOUT_MS = 30_000;

export type HandsOutcome =
  | { status: "missing" }
  | { status: "no-result"; detail: string }
  | { status: "result"; result: Record<string, unknown> };

/**
 * One run of Squeak Hands in `mode`, with `request` handed over as a 0600
 * file. Launched through LaunchServices so macOS attributes it to Squeak
 * Hands' own grants, not to whoever spawned it.
 */
export async function runHands(
  appPath: string,
  mode: string,
  request: unknown,
  timeoutMs = HELPER_TIMEOUT_MS,
): Promise<HandsOutcome> {
  if (!fs.existsSync(appPath)) {
    return { status: "missing" };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-hands-"));
  const requestPath = path.join(dir, "request.json");
  const resultPath = path.join(dir, "result.json");
  try {
    fs.writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
    const launched = await new Promise<boolean>((resolve) => {
      execFile(
        "/usr/bin/open",
        ["-W", "-n", appPath, "--args", mode, requestPath, resultPath],
        { timeout: timeoutMs },
        (error) => resolve(!error),
      );
    });
    const raw = fs.existsSync(resultPath) ? fs.readFileSync(resultPath, "utf8") : null;
    if (!raw) {
      return { status: "no-result", detail: launched ? "no result" : "launch failed or timed out" };
    }
    return { status: "result", result: JSON.parse(raw) as Record<string, unknown> };
  } catch (error) {
    logger.warn("squeak hands failed", { mode, error: error instanceof Error ? error.message : String(error) });
    return { status: "no-result", detail: "unreadable result" };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
