import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_LID_ACTIONS, LidActions, readSettings } from "./lid-actions.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(options: { muted?: boolean; settings?: Record<string, boolean> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-lid-actions-"));
  dirs.push(dir);
  const settingsPath = path.join(dir, "awake-settings.json");
  if (options.settings) fs.writeFileSync(settingsPath, JSON.stringify(options.settings));
  const journalPath = path.join(dir, "lid-actions.json");
  let closed = false;
  let lidOn = true;
  let muted = options.muted ?? false;
  const calls: string[] = [];
  const signals: string[] = [];
  const lowPower: boolean[] = [];
  const actions = new LidActions({
    settingsPath,
    journalPath,
    setLowPowerWanted: (wanted) => lowPower.push(wanted),
    lidSessionOn: () => lidOn,
    run: async (command, args) => {
      calls.push([command.split("/").pop(), ...args].join(" "));
      if (command.endsWith("ioreg")) return { ok: true, stdout: `"AppleClamshellState" = ${closed ? "Yes" : "No"}\n` };
      if (args[1] === "output muted of (get volume settings)") return { ok: true, stdout: `${muted}\n` };
      if (args[1] === "set volume with output muted") muted = true;
      if (args[1] === "set volume without output muted") muted = false;
      if (command.endsWith("pgrep")) return { ok: true, stdout: args[1]!.includes("Slack") ? "101\n102\n" : "" };
      return { ok: true, stdout: "" };
    },
    signal: (pid, signal) => signals.push(`${signal}:${pid}`),
  });
  return {
    actions,
    journalPath,
    calls,
    signals,
    lowPower,
    muted: () => muted,
    close: (value: boolean) => (closed = value),
    lidSession: (value: boolean) => (lidOn = value),
  };
}

describe("LidActions", () => {
  it("on close: mute, Low Power Mode, display off; on open: unmute and let Low Power Mode go", async () => {
    const t = setup();
    await t.actions.check();
    expect(t.actions.active).toBe(false);
    t.close(true);
    await t.actions.check();
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

  it("does nothing with the lid closed unless a lid session is on, and reverts when it ends", async () => {
    const t = setup();
    t.close(true);
    t.lidSession(false);
    await t.actions.check();
    expect(t.actions.active).toBe(false);
    t.lidSession(true);
    await t.actions.check();
    expect(t.actions.active).toBe(true);
    t.lidSession(false);
    await t.actions.check();
    expect(t.actions.active).toBe(false);
  });

  it("leaves sound the user had muted muted", async () => {
    const t = setup({ muted: true });
    t.close(true);
    await t.actions.check();
    t.close(false);
    await t.actions.check();
    expect(t.muted()).toBe(true);
    expect(t.calls.filter((call) => call.includes("without output muted"))).toEqual([]);
  });

  it("freezes the chat apps only when asked, and thaws them on open", async () => {
    const t = setup({ settings: { freezeApps: true, mute: false } });
    t.close(true);
    await t.actions.check();
    expect(t.signals).toEqual(["SIGSTOP:101", "SIGSTOP:102"]);
    expect(JSON.parse(fs.readFileSync(t.journalPath, "utf8"))).toEqual({ muted: false, frozen: [101, 102] });
    t.close(false);
    await t.actions.check();
    expect(t.signals).toEqual(["SIGSTOP:101", "SIGSTOP:102", "SIGCONT:101", "SIGCONT:102"]);
  });

  it("a start after a crash undoes what the journal says", async () => {
    const t = setup();
    fs.writeFileSync(t.journalPath, JSON.stringify({ muted: true, frozen: [7, "x", 1] }));
    await t.actions.recover();
    expect(t.signals).toEqual(["SIGCONT:7"]);
    expect(t.calls).toContain("osascript -e set volume without output muted");
    expect(fs.existsSync(t.journalPath)).toBe(false);
  });

  it("settings fall back to the defaults field by field, and are saved", () => {
    expect(readSettings({ mute: false, freezeApps: "yes" })).toEqual({ ...DEFAULT_LID_ACTIONS, mute: false });
    const t = setup();
    expect(t.actions.updateSettings({ freezeApps: true })).toMatchObject({ freezeApps: true, mute: true });
  });
});
