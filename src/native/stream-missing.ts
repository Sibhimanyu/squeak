import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A chat whose folder is gone from disk (its Stream's working copy was removed, or moved). Node's `spawn` reports a
 * missing `cwd` as ENOENT on the command, which looks like a lost resume, so the host checks the folder itself before
 * any agent starts and says what is really wrong.
 */
export interface StreamMissing {
  /** The folder that no longer exists. */
  path: string;
  /** The Stream's branch, when known (it may still exist). */
  branch: string | null;
  /** The folder's own name, as people see it. */
  folder: string;
}

/** The plain sentence a send gets when the Duck's folder is gone. */
export function streamMissingText(duckName: string, folder: string): string {
  return `${duckName}'s Stream folder (${folder}) is gone, so it can't run there.`;
}

/** Thrown when an agent would be started in a folder that is not there. */
export class StreamMissingError extends Error {
  constructor(
    message: string,
    readonly missing: StreamMissing,
  ) {
    super(message);
    this.name = "StreamMissingError";
  }
}

export function folderName(p: string): string {
  return path.basename(p.replace(/\/+$/, "")) || p;
}

/**
 * Claude Code keeps a chat's transcript in `projects/<folder>/`, where `<folder>` is the working directory with every
 * character outside a-z, A-Z, 0-9 turned into "-" (a hash is added after 200 characters). A resume from another
 * working directory looks in that directory's folder only.
 */
export function claudeProjectFolder(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= 200) return name;
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = (Math.imul(31, h) + cwd.charCodeAt(i)) | 0;
  return `${name.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

function projectsRoot(projectsDir?: string): string {
  return projectsDir ?? path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
}

/**
 * Copies a Claude chat's transcript (`<id>.jsonl` and its sidecar folder `<id>/`) into the project folder of `toCwd`,
 * so a resume from the new working directory finds it. The old copy stays. Returns false when no transcript exists.
 */
export function carryTranscript(agentSessionId: string, toCwd: string, projectsDir?: string): boolean {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(agentSessionId)) return false;
  const root = projectsRoot(projectsDir);
  let from: string | null = null;
  try {
    for (const dir of fs.readdirSync(root)) {
      if (fs.existsSync(path.join(root, dir, `${agentSessionId}.jsonl`))) {
        from = path.join(root, dir);
        break;
      }
    }
  } catch {
    return false;
  }
  if (!from) return false;
  let real = toCwd;
  try {
    real = fs.realpathSync(toCwd);
  } catch {
    // the new folder is checked by the caller
  }
  const to = path.join(root, claudeProjectFolder(real));
  if (path.resolve(to) === path.resolve(from)) return true;
  fs.mkdirSync(to, { recursive: true });
  fs.copyFileSync(path.join(from, `${agentSessionId}.jsonl`), path.join(to, `${agentSessionId}.jsonl`));
  const side = path.join(from, agentSessionId);
  if (fs.existsSync(side)) fs.cpSync(side, path.join(to, agentSessionId), { recursive: true });
  return true;
}
