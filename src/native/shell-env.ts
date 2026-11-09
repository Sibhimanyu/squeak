import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

/**
 * launchd starts the host with only /usr/bin:/bin:/usr/sbin:/sbin, so an agent's commands could not find node, npm,
 * Homebrew or anything the person installed. The host takes the PATH the person's own login shell sets (read once at
 * start, interactive so .zshrc counts, between markers so shell chatter is ignored), then the usual install places.
 */

const MARK = "__SQUEAK_PATH__";

export function readLoginShellPath(shell: string, timeoutMs = 5000): string | null {
  try {
    const out = execFileSync(shell, ["-ilc", `printf '${MARK}%s${MARK}' "$PATH"`], {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, TERM: "dumb" },
    });
    const m = new RegExp(`${MARK}(.*?)${MARK}`, "s").exec(out);
    return m?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

/** The shell's entries first, then what we had, then the usual places; no duplicates or blanks. */
export function mergePath(shellPath: string | null, current: string | undefined, home = os.homedir()): string {
  const usual = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", path.join(home, ".local/bin")];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of [...(shellPath ?? "").split(":"), ...(current ?? "").split(":"), ...usual]) {
    if (part && !seen.has(part)) {
      seen.add(part);
      out.push(part);
    }
  }
  return out.join(":");
}

/** Sets process.env.PATH for everything the host starts. Returns where it came from, for the log. */
export function adoptLoginShellPath(env: NodeJS.ProcessEnv = process.env): "shell" | "fallback" {
  const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : "/bin/zsh";
  const shellPath = readLoginShellPath(shell);
  env.PATH = mergePath(shellPath, env.PATH);
  return shellPath ? "shell" : "fallback";
}
