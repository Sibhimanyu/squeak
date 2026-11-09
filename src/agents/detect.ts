import { execFile } from "node:child_process";
import type { ProviderSpec } from "./providers.js";

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one executable with fixed arguments. A missing executable rejects with `code: "ENOENT"`. */
export type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;

/** Finds an executable by name (the caller's PATH rules); undefined when absent. */
export type BinaryLocator = (command: string) => string | undefined;

export type Availability = "available" | "missing" | "unsupported-version" | "error";

export interface DetectResult {
  status: Availability;
  executable?: string;
  version?: string;
  /** A fixed sentence, never the process's own output. */
  problem?: string;
}

export function parseVersion(text: string): string | undefined {
  return /\b(\d+)\.(\d+)\.(\d+)\b/.exec(text)?.[0];
}

/** Negative when a < b. Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Installed state, path and version of a provider. The only command ever run is `<command> <versionFlag>`.
 * Providers with no command (ACP, custom) are never probed.
 */
export async function detectProvider(
  spec: ProviderSpec,
  run: CommandRunner,
  locate: BinaryLocator = (c) => c,
): Promise<DetectResult> {
  if (!spec.command || !spec.versionFlag) {
    return { status: "error", problem: `${spec.label} has no fixed command to check.` };
  }
  const executable = locate(spec.command);
  if (!executable) return { status: "missing", problem: `${spec.label} is not installed.` };
  let result: CommandResult;
  try {
    result = await run(executable, [spec.versionFlag]);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return { status: "missing", problem: `${spec.label} is not installed.` };
    }
    return { status: "error", executable, problem: `${spec.label} could not be started to check its version.` };
  }
  if (result.exitCode !== 0) {
    return { status: "error", executable, problem: `${spec.label} did not answer its version check.` };
  }
  const version = parseVersion(`${result.stdout}\n${result.stderr}`);
  if (!version) {
    return { status: "error", executable, problem: `${spec.label} reported a version Squeak cannot read.` };
  }
  if (spec.minVersion && compareVersions(version, spec.minVersion) < 0) {
    return {
      status: "unsupported-version",
      executable,
      version,
      problem: `${spec.label} ${version} is older than ${spec.minVersion}, the oldest Squeak supports.`,
    };
  }
  return { status: "available", executable, version };
}

/** The real runner: `execFile`, no shell, short timeout. Tests inject a fake instead. */
export const nodeCommandRunner: CommandRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error && (error as { code?: unknown }).code === "ENOENT") return reject(error);
      const code = error
        ? typeof (error as { code?: unknown }).code === "number"
          ? Number((error as { code?: unknown }).code)
          : null
        : 0;
      resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
