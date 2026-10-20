import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_LID_ACTIONS, LidActions, readProcesses, readSettings } from "./lid-actions.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const SLACK = "/Applications/Slack.app/Contents/MacOS/Slack";
const HELPER = "/Applications/Slack.app/Contents/Frameworks/Slack Helper.app/Contents/MacOS/Slack Helper";

interface FakeProcess {
  pid: number;
  stat: string;
  startedAt: string;
  path: string;
}

function setup(
  options: {
    muted?: boolean;
    settings?: Record<string, boolean>;
    processes?: FakeProcess[];
    unmuteFails?: boolean;
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-lid-actions-"));
  dirs.push(dir);
  const settingsPath = path.join(dir, "awake-settings.json");
  if (options.settings) fs.writeFileSync(settingsPath, JSON.stringify(options.settings));
  const journalPath = path.join(dir, "lid-actions.json");
  let closed: boolean | null = false;
  let lidOn = true;
  let muted = options.muted ?? false;
  let unmuteFails = options.unmuteFails ?? false;
  let boot = "boot-A";
  let processes: FakeProcess[] = options.processes ?? [
    { pid: 101, stat: "S", startedAt: "Mon Oct 20 08:00:00 2026", path: SLACK },
    { pid: 102, stat: "S", startedAt: "Mon Oct 20 08:00:01 2026", path: HELPER },
  ];
  const psLine = (p: FakeProcess) => `  ${p.pid} ${p.stat}    ${p.startedAt.replace(" 8", "  8")}     ${p.path}`;
  const calls: string[] = [];
  const signals: string[] = [];
  const lowPower: boolean[] = [];
  const actions = new LidActions({
    settingsPath,
    journalPath,
    uid: 501,
    setLowPowerWanted: (wanted) => lowPower.push(wanted),
    lidSessionOn: () => lidOn,
    run: async (command, args) => {
      calls.push([command.split("/").pop(), ...args].join(" "));
      if (command.endsWith("ioreg")) {
        if (closed === null) return { ok: false, stdout: "" };
        return { ok: true, stdout: `"AppleClamshellState" = ${closed ? "Yes" : "No"}\n` };
      }
      if (command.endsWith("sysctl")) return { ok: true, stdout: `${boot}\n` };
      if (args[1] === "/bin/ps") {
        const pids = args[2] === "-p" ? args[3]!.split(",").map(Number) : null;
        const shown = processes.filter((p) => pids === null || pids.includes(p.pid));
        return { ok: shown.length > 0, stdout: shown.map(psLine).join("\n") + (shown.length ? "\n" : "") };
      }
      if (args[1] === "output muted of (get volume settings)") return { ok: true, stdout: `${muted}\n` };
      if (args[1] === "set volume with output muted") muted = true;
      if (args[1] === "set volume without output muted") {
        if (unmuteFails) return { ok: false, stdout: "" };
        muted = false;
      }
      return { ok: true, stdout: "" };
    },
    signal: (pid, signal) => {
      signals.push(`${signal}:${pid}`);
    },
  });
  return {
    actions,
    journalPath,
    calls,
    signals,
    lowPower,
    muted: () => muted,
    close: (value: boolean | null) => (closed = value),
    lidSession: (value: boolean) => (lidOn = value),
    unmuteFails: (value: boolean) => (unmuteFails = value),
    reboot: () => (boot = "boot-B"),
    processes: (value: FakeProcess[]) => (processes = value),
    /** Two polls: a close has to be read twice before anything happens. */
    closeAndSettle: async () => {
      closed = true;
      await actions.check();
      await actions.check();
    },
  };
}

describe("LidActions", () => {
  it("on close: mute, Low Power Mode, display off; on open: unmute and let Low Power Mode go", async () => {
    const t = setup();
    await t.actions.check();
    expect(t.actions.active).toBe(false);
    await t.closeAndSettle();
    expect(t.actions.active).toBe(true);
    expect(t.muted()).toBe(true);
    expect(t.lowPower).toEqual([true]);
    expect(t.calls).toContain("pmset displaysleepnow");
    expect(t.signals).toEqual([]);
    t.close(false);
    await t.actions.check();
    expect(t.muted()).toBe(false);
    expect(t.lowPower).toEqual([true, false]);
    expect(fs.existsSync(t.journalPath)).toBe(false);
  });

  it("waits for a second closed read before acting", async () => {
    const t = setup();
    t.close(true);
    await t.actions.check();
    expect(t.actions.active).toBe(false);
    expect(t.muted()).toBe(false);
    // An open read in between starts the count again.
    t.close(false);
    await t.actions.check();
    t.close(true);
    await t.actions.check();
    expect(t.actions.active).toBe(false);
    await t.actions.check();
    expect(t.actions.active).toBe(true);
  });

  it("an unreadable lid changes nothing either way", async () => {
    const t = setup({ settings: { freezeApps: true } });
    await t.closeAndSettle();
    t.close(null);
    await t.actions.check();
    expect(t.actions.active).toBe(true);
    expect(t.signals).toEqual(["SIGSTOP:101", "SIGSTOP:102"]);
    expect(t.muted()).toBe(true);
  });

  it("puts the display to sleep again on every poll while the lid stays shut", async () => {
    const t = setup();
    await t.closeAndSettle();
    await t.actions.check();
    await t.actions.check();
    expect(t.calls.filter((call) => call === "pmset displaysleepnow")).toHaveLength(3);
  });

  it("does nothing with the lid closed unless a lid session is on, and reverts when it ends", async () => {
    const t = setup();
    t.lidSession(false);
    await t.closeAndSettle();
    expect(t.actions.active).toBe(false);
    t.lidSession(true);
    await t.closeAndSettle();
    expect(t.actions.active).toBe(true);
    t.lidSession(false);
    await t.actions.check();
    expect(t.actions.active).toBe(false);
  });

  it("leaves sound the user had muted muted", async () => {
    const t = setup({ muted: true });
    await t.closeAndSettle();
    t.close(false);
    await t.actions.check();
    expect(t.muted()).toBe(true);
    expect(t.calls.filter((call) => call.includes("without output muted"))).toEqual([]);
  });

  it("an unmute that fails stays journalled and is tried again", async () => {
    const t = setup({ unmuteFails: true });
    await t.closeAndSettle();
    t.close(false);
    await t.actions.check();
    expect(t.muted()).toBe(true);
    expect(JSON.parse(fs.readFileSync(t.journalPath, "utf8"))).toMatchObject({ muted: true });
    t.unmuteFails(false);
    await t.actions.check();
    expect(t.muted()).toBe(false);
    expect(fs.existsSync(t.journalPath)).toBe(false);
  });

  it("freezes this user's chat apps only when asked, journals who they are first, and thaws them on open", async () => {
    const t = setup({ settings: { freezeApps: true, mute: false } });
    await t.closeAndSettle();
    expect(t.calls).toContain("env TZ=UTC /bin/ps -U 501 -o pid=,stat=,lstart=,comm=");
    expect(t.signals).toEqual(["SIGSTOP:101", "SIGSTOP:102"]);
    expect(JSON.parse(fs.readFileSync(t.journalPath, "utf8"))).toEqual({
      muted: false,
      boot: "boot-A",
      frozen: [
        { pid: 101, startedAt: "Mon Oct 20 08:00:00 2026", path: SLACK },
        { pid: 102, startedAt: "Mon Oct 20 08:00:01 2026", path: HELPER },
      ],
    });
    t.close(false);
    await t.actions.check();
    expect(t.signals).toEqual(["SIGSTOP:101", "SIGSTOP:102", "SIGCONT:101", "SIGCONT:102"]);
  });

  it("never pauses an app that is already stopped, or anything outside the chat apps", async () => {
    const t = setup({
      settings: { freezeApps: true, mute: false },
      processes: [
        { pid: 101, stat: "T", startedAt: "Mon Oct 20 08:00:00 2026", path: SLACK },
        { pid: 103, stat: "S", startedAt: "Mon Oct 20 08:00:00 2026", path: "/usr/bin/vim" },
        { pid: 104, stat: "S", startedAt: "Mon Oct 20 08:00:00 2026", path: "/tmp/Slack.app.fake/Slack" },
        {
          pid: 105,
          stat: "Ss",
          startedAt: "Mon Oct 20 08:00:00 2026",
          path: "/Applications/Discord.app/Contents/MacOS/Discord",
        },
      ],
    });
    await t.closeAndSettle();
    expect(t.signals).toEqual(["SIGSTOP:105"]);
  });

  it("resumes only a process that is still the one it paused", async () => {
    const t = setup({ settings: { freezeApps: true, mute: false } });
    await t.closeAndSettle();
    // 101 quit and its pid went to something else; 102 is gone.
    t.processes([{ pid: 101, stat: "T", startedAt: "Mon Oct 20 09:30:00 2026", path: "/usr/bin/vim" }]);
    t.close(false);
    await t.actions.check();
    expect(t.signals).toEqual(["SIGSTOP:101", "SIGSTOP:102"]);
    expect(fs.existsSync(t.journalPath)).toBe(false);
  });

  it("a journal from another boot resumes nothing", async () => {
    const t = setup({ settings: { freezeApps: true, mute: false } });
    await t.closeAndSettle();
    t.reboot();
    await t.actions.recover();
    expect(t.signals).toEqual(["SIGSTOP:101", "SIGSTOP:102"]);
    expect(fs.existsSync(t.journalPath)).toBe(false);
  });

  it("a start after a crash undoes what the journal says", async () => {
    const t = setup();
    t.lidSession(false);
    fs.writeFileSync(t.journalPath, JSON.stringify({ muted: true, frozen: [7, "x", 1] }));
    await t.actions.recover();
    expect(t.signals).toEqual(["SIGCONT:7"]);
    expect(t.calls).toContain("osascript -e set volume without output muted");
    expect(fs.existsSync(t.journalPath)).toBe(false);
  });

  it("a resumed lid session with the lid still shut keeps what was done instead of undoing and redoing it", async () => {
    const first = setup({ settings: { freezeApps: true } });
    await first.closeAndSettle();
    const t = setup({ settings: { freezeApps: true } });
    fs.copyFileSync(first.journalPath, t.journalPath);
    t.close(true);
    await t.actions.recover();
    expect(t.actions.active).toBe(true);
    expect(t.signals).toEqual([]);
    expect(t.calls.filter((call) => call.includes("without output muted"))).toEqual([]);
    expect(t.lowPower).toEqual([true]);
    t.close(false);
    await t.actions.check();
    expect(t.signals).toEqual(["SIGCONT:101", "SIGCONT:102"]);
  });

  it("writes the journal owner-only", async () => {
    const t = setup();
    await t.closeAndSettle();
    expect(fs.statSync(t.journalPath).mode & 0o777).toBe(0o600);
  });

  it("settings fall back to the defaults field by field, and are saved", () => {
    expect(readSettings({ mute: false, freezeApps: "yes" })).toEqual({ ...DEFAULT_LID_ACTIONS, mute: false });
    const t = setup();
    expect(t.actions.updateSettings({ freezeApps: true })).toMatchObject({ freezeApps: true, mute: true });
  });
});

describe("readProcesses", () => {
  it("reads ps lines with spaces in the path and collapses lstart's padding", () => {
    expect(
      readProcesses(
        `  115 Ss   Mon Oct  9 23:38:21 2026     ${HELPER}\n  2 S Mon Oct 19 23:38:21 2026 /bin/x\nnonsense\n`,
      ),
    ).toEqual([
      { pid: 115, stat: "Ss", startedAt: "Mon Oct 9 23:38:21 2026", path: HELPER },
      { pid: 2, stat: "S", startedAt: "Mon Oct 19 23:38:21 2026", path: "/bin/x" },
    ]);
  });
});
