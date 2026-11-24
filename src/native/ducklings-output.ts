import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeSteps, type ActivityStep } from "../fleet/activity.js";
import { isTaskOutputPath, OUTPUT_BYTES, OUTPUT_LINES, tailOutput, type DucklingOutput } from "./ducklings.js";

/** The last bytes of a file as text; `cut` says the start was left out. Null when it cannot be read. */
function tailBytes(file: string, bytes: number): { text: string; cut: boolean } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return { text: buf.toString("utf8"), cut: start > 0 };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * A background shell's output, from the file the agent recorded for it. Only a regular file at a validated task-output
 * path is read (a symlink is not followed), and only its tail, so a chatty command costs a bounded read.
 */
export function readShellOutput(file: string | undefined, lines = OUTPUT_LINES): DucklingOutput {
  const none: DucklingOutput = { text: "", truncated: false, exists: false };
  if (!isTaskOutputPath(file)) return none;
  try {
    if (!fs.lstatSync(file).isFile()) return none;
  } catch {
    return none;
  }
  const read = tailBytes(file, OUTPUT_BYTES);
  return read ? tailOutput(read.text, read.cut, lines) : none;
}

/**
 * A subagent's own transcript, when its output file is the link Claude Code makes to it
 * (`~/.claude/projects/<dir>/<session>/subagents/agent-<id>.jsonl`): the steps it took, for a duckling whose rows the
 * host holds none of. Anything resolving elsewhere is not read.
 */
export function readAgentSteps(file: string | undefined, home = os.homedir()): ActivityStep[] {
  if (!isTaskOutputPath(file)) return [];
  let real: string;
  let root: string;
  try {
    real = fs.realpathSync(file);
    root = path.join(fs.realpathSync(path.join(home, ".claude", "projects")), path.sep);
  } catch {
    return [];
  }
  if (!real.startsWith(root) || !real.endsWith(".jsonl") || !real.includes(`${path.sep}subagents${path.sep}`))
    return [];
  const read = tailBytes(real, 1024 * 1024);
  if (!read) return [];
  const entries: Record<string, unknown>[] = [];
  const rows = read.text.split("\n");
  if (read.cut) rows.shift();
  for (const line of rows) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v))
        entries.push({ ...(v as Record<string, unknown>), isSidechain: true });
    } catch {
      // a half-written last line
    }
  }
  return claudeSteps(entries, 40, { sidechain: true });
}
