import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** What Claude's usage endpoint needs; `user:inference` alone is not enough. */
export const USAGE_SCOPE = "user:profile";

const KEYCHAIN_TIMEOUT_MS = 5_000;
const MAX_CREDENTIAL_BYTES = 256 * 1024;

export type ClaudeCredentialResult = { ok: true; accessToken: string } | { ok: false; error: string };

export interface ClaudeCredentialDeps {
  env: Record<string, string | undefined>;
  homedir: () => string;
  platform: NodeJS.Platform;
  now: () => number;
  /** Returns the file's text, or null when it does not exist. Anything else throws. */
  readFile: (filePath: string) => Promise<string | null>;
  /** The exact `Claude Code-credentials` item's text, or null when there is none. */
  readKeychain: () => Promise<string | null>;
}

/**
 * Reads, and never writes, the sign-in Claude Code already holds, so the usage
 * endpoint can be asked as that same account. Source ownership is fixed, not
 * ranked by expiry: a `CLAUDE_CONFIG_DIR` means that folder's file and nothing
 * else; otherwise `~/.claude/.credentials.json`, and only when that file does
 * not exist, the macOS Keychain item Claude Code itself uses.
 *
 * Every failure is a fixed sentence. Parser and process errors can quote the
 * secret they choked on, so none of their text is ever passed on.
 */
export async function resolveClaudeCredentials(
  overrides: Partial<ClaudeCredentialDeps> = {},
): Promise<ClaudeCredentialResult> {
  const deps: ClaudeCredentialDeps = {
    env: process.env,
    homedir: os.homedir,
    platform: process.platform,
    now: Date.now,
    readFile: readFileOrNull,
    readKeychain: readClaudeKeychain,
    ...overrides,
  };
  const customDir = deps.env.CLAUDE_CONFIG_DIR?.trim();
  const dir = customDir || path.join(deps.homedir(), ".claude");
  let text: string | null;
  try {
    text = await deps.readFile(path.join(dir, ".credentials.json"));
  } catch {
    return { ok: false, error: "Squeak could not read Claude Code's saved sign-in." };
  }
  if (text === null && !customDir && deps.platform === "darwin") {
    try {
      text = await deps.readKeychain();
    } catch {
      return {
        ok: false,
        error:
          "Squeak could not read Claude Code's sign-in from the Keychain. Allow access if macOS asks, then try again.",
      };
    }
  }
  if (text === null) {
    return {
      ok: false,
      error: customDir
        ? "Squeak found no readable Claude account sign-in in the selected Claude config directory, and does not fall back to the global one."
        : "Claude Code is not signed in on this Mac.",
    };
  }
  return parseCredentials(text, deps.now());
}

export function parseCredentials(text: string, nowMs: number): ClaudeCredentialResult {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { ok: false, error: "Claude Code's saved sign-in is not readable." };
  }
  const oauth = (root as { claudeAiOauth?: unknown } | null)?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") {
    const mcpOnly = !!root && typeof root === "object" && "mcpOAuth" in root;
    return {
      ok: false,
      error: mcpOnly
        ? "Claude Code holds only tool sign-ins here, not a Claude account. Sign in to Claude Code."
        : "Claude Code is not signed in with a Claude account.",
    };
  }
  const { accessToken, expiresAt, scopes } = oauth as { accessToken?: unknown; expiresAt?: unknown; scopes?: unknown };
  const token = typeof accessToken === "string" ? accessToken.trim() : "";
  // Printable ASCII only: anything else cannot ride in a header and would
  // surface as a misleading network error.
  if (!/^[\x21-\x7e]+$/.test(token) || typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    return { ok: false, error: "Claude Code's saved sign-in is not readable." };
  }
  if (expiresAt <= nowMs) {
    return { ok: false, error: "Claude Code's sign-in has expired. Open Claude Code to renew it, then try again." };
  }
  if (!Array.isArray(scopes) || !scopes.includes(USAGE_SCOPE)) {
    return {
      ok: false,
      error: "Claude Code's sign-in cannot read plan usage (it needs the user:profile scope). Sign in again.",
    };
  }
  return { ok: true, accessToken: token };
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > MAX_CREDENTIAL_BYTES) {
      throw new Error("too large");
    }
    return await fs.promises.readFile(filePath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw e;
  }
}

/**
 * The login Keychain item Claude Code writes. macOS may show its access prompt
 * the first time, which is why this runs only for a Refresh the owner pressed.
 * Exit 44 is "no such item".
 */
function readClaudeKeychain(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: MAX_CREDENTIAL_BYTES, encoding: "utf8" },
      (error, stdout) => {
        if (!error) {
          resolve(stdout.trim() || null);
        } else if ((error as { code?: unknown }).code === 44) {
          resolve(null);
        } else {
          reject(new Error("keychain"));
        }
      },
    );
  });
}
