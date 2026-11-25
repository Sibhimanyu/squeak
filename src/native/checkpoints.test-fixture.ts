import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { onTestFinished } from "vitest";

export function tempRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ckpt-")));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.log\nbuild/\n");
  fs.writeFileSync(path.join(dir, "a.txt"), "a1\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "b1\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return dir;
}
