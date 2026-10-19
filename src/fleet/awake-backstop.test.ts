import { execFileSync, spawn } from "node:child_process";
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
function runScript(
  journal: Record<string, unknown> | null,
  daemonRunning: boolean,
  actions: Record<string, unknown> | null = null,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak backstop '"));
  dirs.push(dir);
  const journalPath = path.join(dir, "lid-journal.json");
  if (journal) fs.writeFileSync(journalPath, JSON.stringify(journal));
  const actionsPath = path.join(dir, "lid-actions.json");
  if (actions) fs.writeFileSync(actionsPath, JSON.stringify(actions));
  const osascriptLog = path.join(dir, "osascript.log");
  const osascript = path.join(dir, "osascript");
  fs.writeFileSync(osascript, `#!/bin/bash\necho "$*" >> ${JSON.stringify(osascriptLog)}\n`, { mode: 0o755 });
  const log = path.join(dir, "sudo.log");
  const sudo = path.join(dir, "sudo");
  fs.writeFileSync(sudo, `#!/bin/bash\necho "$*" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
  const launchctl = path.join(dir, "launchctl");
  fs.writeFileSync(launchctl, `#!/bin/bash\n${daemonRunning ? 'echo "state = running"' : "exit 113"}\n`, {
    mode: 0o755,
  });
  const script = path.join(dir, "backstop.sh");
  fs.writeFileSync(script, backstopScript(journalPath, actionsPath));
  execFileSync("/bin/bash", [script], {
    env: {
      ...process.env,
      SQUEAK_BACKSTOP_SUDO: sudo,
      SQUEAK_BACKSTOP_LAUNCHCTL: launchctl,
      SQUEAK_BACKSTOP_OSASCRIPT: osascript,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  return {
    sudo: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [],
    journalLeft: fs.existsSync(journalPath),
    actionsLeft: fs.existsSync(actionsPath),
    osascript: fs.existsSync(osascriptLog) ? fs.readFileSync(osascriptLog, "utf8").trim() : "",
  };
}

describe("the awake backstop script", { timeout: 30_000 }, () => {
  it("does nothing without a journal", () => {
    expect(runScript(null, false)).toMatchObject({ sudo: [], journalLeft: false, osascript: "" });
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

describe("the awake backstop and paused apps", { timeout: 30_000 }, () => {
  it("resumes paused apps and unmutes when the daemon is gone, and leaves them to a running daemon", () => {
    const sleeper = spawn("/bin/sleep", ["30"]);
    try {
      process.kill(sleeper.pid!, "SIGSTOP");
      const kept = runScript(null, true, { muted: true, frozen: [sleeper.pid] });
      expect(kept).toMatchObject({ actionsLeft: true, osascript: "" });
      expect(processState(sleeper.pid!)).toMatch(/^T/);
      const undone = runScript(null, false, { muted: true, frozen: [sleeper.pid] });
      expect(undone).toMatchObject({ actionsLeft: false, osascript: "-e set volume without output muted" });
      expect(processState(sleeper.pid!)).not.toMatch(/^T/);
    } finally {
      sleeper.kill("SIGKILL");
    }
  });
});

function processState(pid: number): string {
  return execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)])
    .toString()
    .trim();
}

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
    const options = {
      supportDir: dir,
      journalPath: path.join(dir, "j.json"),
      actionsPath: path.join(dir, "a.json"),
      launchAgentsDir: dir,
      launchctl,
    };
    await ensureBackstop(options);
    await ensureBackstop(options);
    expect(calls).toEqual(["print", "bootstrap", "print"]);
    expect(fs.statSync(path.join(dir, "awake-backstop.sh")).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(dir, "com.squeak.awake-backstop.plist"), "utf8")).toBe(
      backstopPlist(path.join(dir, "awake-backstop.sh"), path.join(dir, "awake-backstop.log")),
    );
  });
});
