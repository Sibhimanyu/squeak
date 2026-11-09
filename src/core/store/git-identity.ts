import type { RepositoryReference } from "../types.js";

/** Runs a command and returns trimmed stdout; rejects/throws on failure. */
export type CommandRunner = (cmd: string, args: string[]) => Promise<string> | string;

async function tryRun(run: CommandRunner, args: string[]): Promise<string | undefined> {
  try {
    const out = (await run("git", args)).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** Reads a directory's repository identity. Never throws; failed lookups leave fields undefined. */
export async function readRepositoryReference(dir: string, run: CommandRunner): Promise<RepositoryReference> {
  const [remoteUrl, gitRoot] = await Promise.all([
    tryRun(run, ["-C", dir, "remote", "get-url", "origin"]),
    tryRun(run, ["-C", dir, "rev-parse", "--show-toplevel"]),
  ]);
  const ref: RepositoryReference = { localPath: dir };
  if (remoteUrl) ref.remoteUrl = remoteUrl;
  if (gitRoot) ref.gitRoot = gitRoot;
  return ref;
}
