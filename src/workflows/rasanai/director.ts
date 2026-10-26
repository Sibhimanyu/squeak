import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * RasanAI's director command (`<engine>/scripts/director.mjs`, RasanAI 1.28+): `status`, `resume`, `stop`
 * and `install-tool` on a project folder. Every subcommand prints one JSON line and exits 0, with errors as
 * `{ok:false, reason}` in a fixed human sentence.
 *
 * An older RasanAI does not have it. That is a normal state, not an error: the phone then sees
 * `canResume`/`canStop` false and an engine note, and nothing here is run.
 *
 * The engine is named by the run's own `console.json` (`skill`), a file the film's agent can write, so it is
 * never trusted by itself: the folder must sit under a root where a RasanAI engine is installed, must hold
 * RasanAI's SKILL.md, and must not be inside the film's own folder.
 */

export type DirectorOp = "resume" | "stop" | "install-tool";

export interface DirectorOutcome {
  ok: boolean;
  /** A sentence for the person, fixed by RasanAI or by Squeak; never raw output. */
  reason: string | null;
}

export interface DirectorDeps {
  /** Roots an engine may live under. */
  engineRoots: string[];
  /** Runs `node <script> <args…>`; swapped in tests. */
  run: (script: string, args: string[], timeoutMs: number) => Promise<string>;
}

/** Where RasanAI's engine is installed: Studio's bundle, the skill folders, Application Support, a dev checkout. */
export function defaultEngineRoots(): string[] {
  const home = os.homedir();
  const extra = (process.env.SQUEAK_RASANAI_ENGINE_DIRS ?? "").split(":").filter(Boolean);
  return [
    "/Applications",
    path.join(home, "Applications"),
    path.join(home, ".claude"),
    path.join(home, ".agents"),
    path.join(home, "Library", "Application Support"),
    ...extra,
  ];
}

export const realDirectorDeps: DirectorDeps = {
  engineRoots: defaultEngineRoots(),
  run: (script, args, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(process.execPath, [script, ...args], { timeout: timeoutMs, maxBuffer: 256 * 1024 }, (error, stdout) => {
        if (error && !stdout) {
          reject(error);
        } else {
          resolve(stdout);
        }
      });
    }),
};

/** The engine folder a run names, when it is one this Mac may run a script from; else null. */
export function engineDir(skill: string | null, projectDir: string, roots: string[]): string | null {
  if (!skill || !path.isAbsolute(skill)) {
    return null;
  }
  let real: string;
  let project: string;
  try {
    real = fs.realpathSync(skill);
    project = fs.realpathSync(projectDir);
    if (!fs.statSync(real).isDirectory() || !fs.statSync(path.join(real, "SKILL.md")).isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);
  if (inside(real, project)) {
    return null;
  }
  const rooted = roots.some((root) => {
    try {
      return inside(real, fs.realpathSync(root));
    } catch {
      return false;
    }
  });
  return rooted ? real : null;
}

/** The engine's `director.mjs`, or null when this RasanAI does not have it. */
export function directorScript(skill: string | null, projectDir: string, roots: string[]): string | null {
  const dir = engineDir(skill, projectDir, roots);
  if (!dir) {
    return null;
  }
  const script = path.join(dir, "scripts", "director.mjs");
  try {
    const real = fs.realpathSync(script);
    return fs.statSync(real).isFile() && real.startsWith(dir + path.sep) ? real : null;
  } catch {
    return null;
  }
}

const SENTENCE = /^[A-Z][^\n\r<>`\\/]{2,198}[.!?…]$/;

const GENERIC: Record<DirectorOp, string> = {
  resume: "RasanAI couldn't wake the director. Try from RasanAI Studio.",
  stop: "RasanAI couldn't stop the director. Try from RasanAI Studio.",
  "install-tool": "RasanAI couldn't install that. Try from RasanAI Studio.",
};

/**
 * Run one director subcommand. A reason is returned verbatim only in RasanAI's fixed-sentence form (one
 * sentence, no paths, markup or stack); anything else is a generic sentence for the operation.
 */
export async function runDirector(
  script: string,
  op: DirectorOp,
  projectDir: string,
  extra: string[],
  deps: DirectorDeps = realDirectorDeps,
): Promise<DirectorOutcome> {
  const args = [op, projectDir, ...extra];
  if (op !== "install-tool") {
    args.push("--source", "squeak-phone");
  }
  let out: string;
  try {
    out = await deps.run(script, args, op === "install-tool" ? 10 * 60_000 : 30_000);
  } catch {
    return { ok: false, reason: GENERIC[op] };
  }
  const line = out
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .pop();
  const parsed = parseLine(line);
  if (parsed?.ok === true) {
    return { ok: true, reason: null };
  }
  const reason =
    typeof parsed?.reason === "string" && SENTENCE.test(parsed.reason.trim()) ? parsed.reason.trim() : null;
  return { ok: false, reason: reason ?? GENERIC[op] };
}

function parseLine(line: string | undefined): { ok?: unknown; reason?: unknown } | null {
  try {
    return line ? (JSON.parse(line) as { ok?: unknown; reason?: unknown }) : null;
  } catch {
    return null;
  }
}
