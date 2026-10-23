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
  journal: Record<string, unknown> | string | null,
  daemonRunning: boolean,
  actions: Record<string, unknown> | null = null,
  fakes: {
    sudoFails?: boolean;
    osascriptFails?: boolean;
    plutilDiagnosticsOnStdout?: boolean;
    heat?: Record<string, unknown>;
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak backstop '"));
  dirs.push(dir);
  const journalPath = path.join(dir, "lid-journal.json");
  if (journal) fs.writeFileSync(journalPath, typeof journal === "string" ? journal : JSON.stringify(journal));
  const actionsPath = path.join(dir, "lid-actions.json");
  if (actions) fs.writeFileSync(actionsPath, JSON.stringify(actions));
  const heatPath = path.join(dir, "heat-journal.json");
  if (fakes.heat) fs.writeFileSync(heatPath, JSON.stringify(fakes.heat));
  const taskpolicyLog = path.join(dir, "taskpolicy.log");
  const taskpolicy = path.join(dir, "taskpolicy");
  fs.writeFileSync(taskpolicy, `#!/bin/bash\necho "$*" >> ${JSON.stringify(taskpolicyLog)}\n`, { mode: 0o755 });
  const osascriptLog = path.join(dir, "osascript.log");
  const osascript = path.join(dir, "osascript");
  fs.writeFileSync(
    osascript,
    `#!/bin/bash\necho "$*" >> ${JSON.stringify(osascriptLog)}\n${fakes.osascriptFails ? "exit 1\n" : ""}`,
    { mode: 0o755 },
  );
  const log = path.join(dir, "sudo.log");
  const sudo = path.join(dir, "sudo");
  fs.writeFileSync(sudo, `#!/bin/bash\necho "$*" >> ${JSON.stringify(log)}\n${fakes.sudoFails ? "exit 1\n" : ""}`, {
    mode: 0o755,
  });
  const launchctl = path.join(dir, "launchctl");
  fs.writeFileSync(launchctl, `#!/bin/bash\n${daemonRunning ? 'echo "state = running"' : "exit 113"}\n`, {
    mode: 0o755,
  });
  const script = path.join(dir, "backstop.sh");
  let text = backstopScript(journalPath, actionsPath, heatPath);
  if (fakes.plutilDiagnosticsOnStdout) {
    // The macOS 15 runner's plutil reported "Could not extract value" on
    // stdout, not stderr. Same real plutil, with its stderr folded into stdout.
    const plutil = path.join(dir, "plutil");
    fs.writeFileSync(
      plutil,
      `#!/bin/bash\nout="$(/usr/bin/plutil "$@" 2>&1)"\nrc=$?\nprintf '%s\\n' "$out"\nexit $rc\n`,
      {
        mode: 0o755,
      },
    );
    expect(text).toContain("/usr/bin/plutil");
    text = text.split("/usr/bin/plutil").join(`'${plutil.replace(/'/g, `'\\''`)}'`);
  }
  fs.writeFileSync(script, text);
  execFileSync("/bin/bash", [script], {
    env: {
      ...process.env,
      SQUEAK_BACKSTOP_SUDO: sudo,
      SQUEAK_BACKSTOP_LAUNCHCTL: launchctl,
      SQUEAK_BACKSTOP_OSASCRIPT: osascript,
      SQUEAK_BACKSTOP_TASKPOLICY: taskpolicy,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  return {
    sudo: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [],
    journalLeft: fs.existsSync(journalPath),
    actionsLeft: fs.existsSync(actionsPath),
    heatLeft: fs.existsSync(heatPath),
    taskpolicy: fs.existsSync(taskpolicyLog) ? fs.readFileSync(taskpolicyLog, "utf8").trim().split("\n") : [],
    osascript: fs.existsSync(osascriptLog) ? fs.readFileSync(osascriptLog, "utf8").trim() : "",
  };
}

describe("the awake backstop script", { timeout: 30_000 }, () => {
  it("gives the fans back and agents every core when the daemon is gone, only for the same process", () => {
    const startedAt = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], {
      env: { ...process.env, TZ: "UTC" },
    })
      .toString()
      .trim()
      .replace(/\s+/g, " ");
    const heat = {
      fansMax: true,
      slowed: [
        { pid: process.pid, startedAt },
        { pid: process.pid, startedAt: "Thu Jan 1 00:00:00 1970" },
      ],
    };
    const gone = runScript(null, false, null, { heat });
    expect(gone.sudo).toEqual(["-n /Library/PrivilegedHelperTools/com.squeak.fans auto"]);
    expect(gone.taskpolicy).toEqual([`-B -p ${process.pid}`]);
    expect(gone.heatLeft).toBe(false);
    const running = runScript(null, true, null, { heat });
    expect(running).toMatchObject({ sudo: [], taskpolicy: [], heatLeft: true });
    // A refused `auto` keeps the journal, so the next minute tries again.
    expect(runScript(null, false, null, { heat, sudoFails: true }).heatLeft).toBe(true);
  });

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

  it("an unreadable journal still restores sleep, even beside a running daemon, and stays until that works", () => {
    for (const running of [true, false]) {
      const undone = runScript('{"sleepDisab', running);
      expect(undone.sudo).toEqual(["-n /usr/bin/pmset -a disablesleep 0"]);
      expect(undone.journalLeft).toBe(false);
    }
    const failed = runScript("garbage", false, null, { sudoFails: true });
    expect(failed.sudo).toEqual(["-n /usr/bin/pmset -a disablesleep 0"]);
    expect(failed.journalLeft).toBe(true);
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

describe("the awake backstop and paused apps' identities", { timeout: 30_000 }, () => {
  const startedAt = (pid: number) =>
    execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, TZ: "UTC" } })
      .toString()
      .trim()
      .split(/\s+/)
      .join(" ");
  const boot = () => execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]).toString().trim();

  it("resumes a paused app only while its start time and boot still match", () => {
    const sleeper = spawn("/bin/sleep", ["30"]);
    try {
      const pid = sleeper.pid!;
      const entry = { pid, startedAt: startedAt(pid), path: "/bin/sleep" };
      process.kill(pid, "SIGSTOP");
      runScript(null, false, { muted: false, boot: "another-boot", frozen: [entry] });
      expect(processState(pid)).toMatch(/^T/);
      runScript(null, false, {
        muted: false,
        boot: boot(),
        frozen: [{ ...entry, startedAt: "Thu Jan 1 00:00:00 1970" }],
      });
      expect(processState(pid)).toMatch(/^T/);
      const undone = runScript(null, false, { muted: false, boot: boot(), frozen: [entry] });
      expect(undone.actionsLeft).toBe(false);
      expect(processState(pid)).not.toMatch(/^T/);
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("resumes by identity even when plutil prints its missing-key diagnostics on stdout", () => {
    const sleeper = spawn("/bin/sleep", ["30"]);
    try {
      const pid = sleeper.pid!;
      const entry = { pid, startedAt: startedAt(pid), path: "/bin/sleep" };
      process.kill(pid, "SIGSTOP");
      const fakes = { plutilDiagnosticsOnStdout: true };
      // A journal with no boot is a legacy one: resumed on the start time alone.
      runScript(null, false, { muted: false, frozen: [entry] }, fakes);
      expect(processState(pid)).not.toMatch(/^T/);
      process.kill(pid, "SIGSTOP");
      runScript(null, false, { muted: false, boot: "another-boot", frozen: [entry] }, fakes);
      expect(processState(pid)).toMatch(/^T/);
      const started = Date.now();
      const undone = runScript(null, false, { muted: false, boot: boot(), frozen: [entry] }, fakes);
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(undone.actionsLeft).toBe(false);
      expect(processState(pid)).not.toMatch(/^T/);
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("keeps the journal when the unmute fails", () => {
    const left = runScript(null, false, { muted: true, frozen: [] }, { osascriptFails: true });
    expect(left).toMatchObject({ actionsLeft: true, osascript: "-e set volume without output muted" });
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
