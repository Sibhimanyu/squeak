import { execFile } from "node:child_process";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git without a shell; never throws, a failure is `code !== 0`. */
export function runGit(cwd: string, args: string[], timeoutMs = 30_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr });
        const code = (error as { code?: unknown }).code;
        resolve({ code: typeof code === "number" ? code : 1, stdout: stdout ?? "", stderr: stderr || error.message });
      },
    );
  });
}

export async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await runGit(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args[0] ?? ""} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}
