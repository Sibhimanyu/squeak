import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SpawnedProcess, SpawnSpec, Spawner } from "./supervisor.js";

export function tmpDir(prefix = "squeak-ws-"): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** A real repository with one commit on `main`. */
export function makeRepo(name = "demo"): string {
  const dir = path.join(tmpDir(), name);
  fs.mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  fs.writeFileSync(path.join(dir, "README.md"), "hi\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

export interface FakeProc extends SpawnedProcess {
  spec: SpawnSpec;
  signals: string[];
  written: string[];
  emitOutput(stream: "stdout" | "stderr", chunk: string): void;
  exit(code: number | null, signal?: string | null): void;
}

/** Spawns nothing. `ignoreTerm` makes SIGTERM do nothing, so only SIGKILL ends it. */
export function fakeSpawner(options: { ignoreTerm?: boolean; failSpawn?: boolean } = {}): {
  spawner: Spawner;
  procs: FakeProc[];
} {
  const procs: FakeProc[] = [];
  let pid = 40_000;
  const spawner: Spawner = (spec) => {
    if (options.failSpawn) throw new Error("ENOENT");
    let out: (s: "stdout" | "stderr", c: string) => void = () => {};
    let ex: (c: number | null, s: string | null) => void = () => {};
    let done = false;
    const p: FakeProc = {
      spec,
      pid: pid++,
      signals: [],
      written: [],
      onOutput: (cb) => void (out = cb),
      onExit: (cb) => void (ex = cb),
      onError: () => {},
      write: (d) => void p.written.push(d),
      kill(signal) {
        p.signals.push(signal);
        if (signal === "SIGKILL" || (signal === "SIGTERM" && !options.ignoreTerm)) p.exit(null, signal);
      },
      emitOutput: (s, c) => out(s, c),
      exit(code, signal = null) {
        if (done) return;
        done = true;
        ex(code, signal);
      },
    };
    procs.push(p);
    return p;
  };
  return { spawner, procs };
}
