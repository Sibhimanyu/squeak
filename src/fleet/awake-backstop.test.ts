import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { backstopPlist, backstopScript, ensureBackstop } from "./awake-backstop.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs the real script with a fake sudo (records its arguments) and a fake launchctl. */
function runScript(journal: Record<string, unknown> | null, daemonRunning: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak backstop '"));
  dirs.push(dir);
  const journalPath = path.join(dir, "lid-journal.json");
  if (journal) fs.writeFileSync(journalPath, JSON.stringify(journal));
  const log = path.join(dir, "sudo.log");
  const sudo = path.join(dir, "sudo");
  fs.writeFileSync(sudo, `#!/bin/bash\necho "$*" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
  const launchctl = path.join(dir, "launchctl");
  fs.writeFileSync(launchctl, `#!/bin/bash\n${daemonRunning ? 'echo "state = running"' : "exit 113"}\n`, {
    mode: 0o755,
  });
  const script = path.join(dir, "backstop.sh");
  fs.writeFileSync(script, backstopScript(journalPath));
  execFileSync("/bin/bash", [script], {
    env: { ...process.env, SQUEAK_BACKSTOP_SUDO: sudo, SQUEAK_BACKSTOP_LAUNCHCTL: launchctl },
    stdio: ["ignore", "ignore", "ignore"],
  });
  return {
    sudo: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [],
    journalLeft: fs.existsSync(journalPath),
  };
}

describe("the awake backstop script", () => {
  it("does nothing without a journal", () => {
    expect(runScript(null, false)).toEqual({ sudo: [], journalLeft: false });
  });

  it("leaves a running daemon's session alone until two minutes past its end", () => {
    const now = Date.now();
    expect(runScript({ sleepDisabled: true, lowPower: false, until: now + 60_000 }, true).sudo).toEqual([]);
    expect(runScript({ sleepDisabled: true, lowPower: false, until: now - 60_000 }, true).sudo).toEqual([]);
    expect(runScript({ sleepDisabled: true, lowPower: false, until: null }, true).sudo).toEqual([]);
    const late = runScript({ sleepDisabled: true, lowPower: true, until: now - 3 * 60_000 }, true);
    expect(late.sudo).toEqual(["-n /usr/bin/pmset -b lowpowermode 0", "-n /usr/bin/pmset -a disablesleep 0"]);
    expect(late.journalLeft).toBe(false);
  });

  it("undoes everything when the daemon is not running, whatever the end", () => {
    const left = runScript({ sleepDisabled: true, lowPower: false, until: Date.now() + 3_600_000 }, false);
    expect(left.sudo).toEqual(["-n /usr/bin/pmset -a disablesleep 0"]);
    expect(left.journalLeft).toBe(false);
  });

  it("reads the first journal's shape", () => {
    expect(runScript({ disabledSleepAt: 1 }, false).sudo).toEqual(["-n /usr/bin/pmset -a disablesleep 0"]);
  });
});

describe("ensureBackstop", () => {
  it("writes the script and agent and loads it once; a second call changes nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-backstop-"));
    dirs.push(dir);
    const calls: string[] = [];
    let loaded = false;
    const launchctl = async (args: string[]) => {
      calls.push(args[0]!);
      if (args[0] === "bootstrap") loaded = true;
      return args[0] === "print" ? loaded : true;
    };
    const options = { supportDir: dir, journalPath: path.join(dir, "j.json"), launchAgentsDir: dir, launchctl };
    await ensureBackstop(options);
    await ensureBackstop(options);
    expect(calls).toEqual(["print", "bootstrap", "print"]);
    expect(fs.statSync(path.join(dir, "awake-backstop.sh")).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(dir, "com.squeak.awake-backstop.plist"), "utf8")).toBe(
      backstopPlist(path.join(dir, "awake-backstop.sh"), path.join(dir, "awake-backstop.log")),
    );
  });
});
