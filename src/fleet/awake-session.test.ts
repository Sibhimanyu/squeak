import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PowerReading } from "./power-monitor.js";
import {
  applyAwakeAction,
  AwakeSession,
  CLOCK_CHECK_MS,
  MAX_AWAKE_MINUTES,
  readAwakeAction,
  RESTORE_RETRY_MS,
  validMinutes,
} from "./awake-session.js";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup(file?: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-19T10:00:00Z"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-awake-session-"));
  dirs.push(dir);
  const holds: boolean[] = [];
  const changes = vi.fn();
  const sessionPath = file ?? path.join(dir, "keep-awake.json");
  const make = () => new AwakeSession({ path: sessionPath, hold: (on) => holds.push(on), onChange: changes });
  return { session: make(), make, holds, changes, sessionPath };
}

describe("AwakeSession", () => {
  it("a timed session holds the Mac awake and lets go at its end", () => {
    const t = setup();
    const state = t.session.start(60);
    expect(state.until).toBe("2026-10-19T11:00:00.000Z");
    expect(t.holds).toEqual([true]);
    vi.advanceTimersByTime(59 * 60_000);
    expect(t.session.active).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(t.session.active).toBe(false);
    expect(t.holds).toEqual([true, false]);
    expect(JSON.parse(fs.readFileSync(t.sessionPath, "utf8"))).toEqual({ session: null });
  });

  it("an untimed session lasts until ended", () => {
    const t = setup();
    expect(t.session.start(null).until).toBeNull();
    vi.advanceTimersByTime(MAX_AWAKE_MINUTES * 60_000 * 2);
    expect(t.session.active).toBe(true);
    t.session.end();
    expect(t.holds).toEqual([true, false]);
  });

  it("adding time moves the end, and never past a week from now", () => {
    const t = setup();
    t.session.start(30);
    expect(t.session.extend(60)?.until).toBe("2026-10-19T11:30:00.000Z");
    vi.advanceTimersByTime(80 * 60_000);
    expect(t.session.active).toBe(true);
    vi.advanceTimersByTime(10 * 60_000);
    expect(t.session.active).toBe(false);
    t.session.start(60);
    const capped = t.session.extend(MAX_AWAKE_MINUTES)!;
    expect(Date.parse(capped.until!) - Date.now()).toBe(MAX_AWAKE_MINUTES * 60_000);
    expect(setup().session.extend(10)).toBeNull();
  });

  it("a restart resumes the saved session, but not one whose end has passed", () => {
    const t = setup();
    t.session.start(60);
    t.session.stop();
    const resumed = t.make();
    resumed.restore();
    expect(resumed.state?.until).toBe("2026-10-19T11:00:00.000Z");
    resumed.stop();

    vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
    const late = t.make();
    late.restore();
    expect(late.active).toBe(false);
    expect(JSON.parse(fs.readFileSync(t.sessionPath, "utf8"))).toEqual({ session: null });
  });

  it("reads the first switch's file as an untimed session", () => {
    const t = setup();
    fs.writeFileSync(t.sessionPath, JSON.stringify({ keepAwake: true }));
    t.session.restore();
    expect(t.session.state?.until).toBeNull();
    expect(t.holds).toEqual([true]);
    fs.writeFileSync(t.sessionPath, JSON.stringify({ keepAwake: false }));
    const off = t.make();
    off.restore();
    expect(off.active).toBe(false);
  });

  it("a new start replaces the running session's end", () => {
    const t = setup();
    t.session.start(10);
    t.session.start(null);
    vi.advanceTimersByTime(20 * 60_000);
    expect(t.session.active).toBe(true);
  });

  it("accepts whole minutes up to a week, nothing else", () => {
    expect(validMinutes(1)).toBe(1);
    expect(validMinutes(MAX_AWAKE_MINUTES)).toBe(MAX_AWAKE_MINUTES);
    for (const bad of [0, -5, 1.5, MAX_AWAKE_MINUTES + 1, "60", null, undefined, Number.NaN]) {
      expect(validMinutes(bad)).toBeNull();
    }
  });
});

describe("readAwakeAction", () => {
  it("reads the action shape and the first switch's shape", () => {
    expect(readAwakeAction({ action: "start", minutes: 60 })).toEqual({ kind: "start", minutes: 60, lid: false });
    expect(readAwakeAction({ action: "start", minutes: null })).toEqual({ kind: "start", minutes: null, lid: false });
    expect(readAwakeAction({ action: "extend", minutes: 30 })).toEqual({ kind: "extend", minutes: 30 });
    expect(readAwakeAction({ action: "end" })).toEqual({ kind: "end" });
    expect(readAwakeAction({ on: true })).toEqual({ kind: "start", minutes: null, lid: false });
    expect(readAwakeAction({ on: true, minutes: 120 })).toEqual({ kind: "start", minutes: 120, lid: false });
    expect(readAwakeAction({ on: true, extend: 60 })).toEqual({ kind: "extend", minutes: 60 });
    expect(readAwakeAction({ on: false })).toEqual({ kind: "end" });
  });

  it("refuses anything else", () => {
    for (const bad of [
      null,
      "on",
      {},
      { on: "yes" },
      { action: "nap" },
      { action: "start", minutes: 0 },
      { action: "extend" },
      { on: true, minutes: 1.5 },
      { on: true, extend: -1 },
    ]) {
      expect(readAwakeAction(bad)).toBeNull();
    }
  });

  it("extending with nothing running is refused, not a new session", () => {
    const t = setup();
    expect(applyAwakeAction(t.session, { kind: "extend", minutes: 10 })).toMatchObject({ ok: false });
    expect(t.session.active).toBe(false);
  });
});

describe("AwakeSession with the lid closed", () => {
  function lidSetup(options: { failDisable?: string; rule?: boolean; userLowPower?: boolean; foreign?: boolean } = {}) {
    const t = setup();
    const calls: string[] = [];
    let restoreWorks = true;
    let bit: boolean | null = true;
    const warnings: string[] = [];
    const lid = {
      ruleInstalled: vi.fn(async () => options.rule ?? true),
      sleepDisabled: vi.fn(async () => bit),
      disableSleep: vi.fn(async () => {
        calls.push("disable");
        if (options.failDisable) throw new Error(options.failDisable);
      }),
      restoreSleep: vi.fn(async () => {
        calls.push(restoreWorks ? "restore" : "restore-failed");
        return restoreWorks;
      }),
      recover: vi.fn(async (owns: boolean) => {
        calls.push(`recover:${owns}`);
        return { foreignDisable: Boolean(options.foreign) };
      }),
      lowPowerOn: vi.fn(async () => {
        calls.push("lowPowerOn");
        return !options.userLowPower;
      }),
      lowPowerOff: vi.fn(async () => {
        calls.push("lowPowerOff");
      }),
      updateUntil: vi.fn((until: number | null) => {
        calls.push(`until:${until}`);
      }),
    };
    const make = () =>
      new AwakeSession({
        path: t.sessionPath,
        hold: () => undefined,
        lid,
        onChange: t.changes,
        onWarning: (text) => warnings.push(text),
      });
    return {
      ...t,
      lid,
      calls,
      warnings,
      session: make(),
      make,
      restoreWorks: (value: boolean) => (restoreWorks = value),
      bit: (value: boolean | null) => (bit = value),
    };
  }

  it("disables sleep for a lid session and restores it at the end", async () => {
    const t = lidSetup();
    await t.session.refreshLidRule();
    const started = applyAwakeAction(t.session, { kind: "start", minutes: 60, lid: true });
    expect(started).toMatchObject({ ok: true });
    await t.session.lidSettled();
    expect(t.session.state).toMatchObject({ lid: true, lidStatus: "on" });
    vi.advanceTimersByTime(60 * 60_000);
    await t.session.lidSettled();
    expect(t.calls).toEqual(["disable", `until:${Date.now()}`, "restore"]);
  });

  it("an early end moves the journal's end to now before restoring", async () => {
    const t = lidSetup();
    await t.session.refreshLidRule();
    t.session.start(60, { lid: true });
    await t.session.lidSettled();
    vi.advanceTimersByTime(5 * 60_000);
    t.session.end();
    await t.session.lidSettled();
    expect(t.calls).toEqual(["disable", `until:${Date.now()}`, "restore"]);
  });

  it("starting a new lid session over a running one moves the journal's end to the new one", async () => {
    const t = lidSetup();
    await t.session.refreshLidRule();
    t.session.start(10, { lid: true });
    await t.session.lidSettled();
    t.calls.length = 0;
    const later = Date.now() + 90 * 60_000;
    t.session.start(90, { lid: true });
    await t.session.lidSettled();
    expect(t.calls).toEqual([`until:${later}`]);
    expect(t.lid.disableSleep).toHaveBeenCalledTimes(1);
  });

  it("a timed session ends by the wall clock even when its timer slept through the end", async () => {
    const t = lidSetup();
    await t.session.refreshLidRule();
    t.session.start(10, { lid: true });
    await t.session.lidSettled();
    // The Mac slept 20 minutes: the clock moved, the timer did not.
    vi.setSystemTime(Date.now() + 20 * 60_000);
    expect(t.session.active).toBe(true);
    await vi.advanceTimersByTimeAsync(CLOCK_CHECK_MS);
    await t.session.lidSettled();
    expect(t.session.active).toBe(false);
    expect(t.calls.at(-1)).toBe("restore");
    expect(t.session.lastEnd?.reason).toBe("expired");
  });

  it("a restore that fails is said, warned once, and retried until it works", async () => {
    const t = lidSetup();
    await t.session.refreshLidRule();
    t.session.start(60, { lid: true });
    await t.session.lidSettled();
    t.restoreWorks(false);
    t.session.end();
    await t.session.lidSettled();
    expect(t.session.state).toBeNull();
    expect(t.session.sleepProblem).toMatch(/could not turn sleep back on.*sudo pmset -a disablesleep 0/);
    await vi.advanceTimersByTimeAsync(RESTORE_RETRY_MS);
    await t.session.lidSettled();
    expect(t.calls.filter((call) => call.startsWith("restore"))).toEqual(["restore-failed", "restore-failed"]);
    expect(t.warnings).toHaveLength(1);
    t.restoreWorks(true);
    await vi.advanceTimersByTimeAsync(RESTORE_RETRY_MS);
    await t.session.lidSettled();
    expect(t.session.sleepProblem).toBeNull();
    await vi.advanceTimersByTimeAsync(RESTORE_RETRY_MS * 3);
    expect(t.calls.filter((call) => call.startsWith("restore"))).toHaveLength(3);
  });

  it("sleep turned back on mid-session marks the lid failed and says so", async () => {
    const t = lidSetup();
    await t.session.refreshLidRule();
    t.session.start(60, { lid: true });
    await t.session.lidSettled();
    await t.session.verifyLid();
    expect(t.session.state?.lidStatus).toBe("on");
    t.bit(null);
    await t.session.verifyLid();
    expect(t.session.state?.lidStatus).toBe("on");
    t.bit(false);
    await t.session.verifyLid();
    expect(t.session.state).toMatchObject({
      lidStatus: "failed",
      lidProblem: expect.stringMatching(/turned sleep back on/),
    });
    expect(t.warnings).toEqual([expect.stringMatching(/turned sleep back on/)]);
    // Still restored (and the journal cleared) at the end.
    t.session.end();
    await t.session.lidSettled();
    expect(t.calls.at(-1)).toBe("restore");
  });

  it("sleep disabled by someone else at start is reported once and left alone", async () => {
    const t = lidSetup({ foreign: true });
    await t.session.restore();
    expect(t.session.sleepProblem).toMatch(/not by Squeak.*sudo pmset -a disablesleep 0/);
    expect(t.warnings).toHaveLength(1);
    expect(t.calls).toEqual(["recover:false"]);
  });

  it("refuses a lid session with no end, or before the rule is installed", async () => {
    const t = lidSetup({ rule: false });
    await t.session.refreshLidRule();
    expect(applyAwakeAction(t.session, { kind: "start", minutes: null, lid: true })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/end time/),
    });
    expect(applyAwakeAction(t.session, { kind: "start", minutes: 60, lid: true })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/setting up/),
    });
    expect(t.session.active).toBe(false);
    expect(t.lid.disableSleep).not.toHaveBeenCalled();
  });

  it("says why when sleep cannot be disabled, and keeps the Mac awake with the lid open", async () => {
    const t = lidSetup({ failDisable: "Something on this Mac turned sleep back on." });
    await t.session.refreshLidRule();
    t.session.start(60, { lid: true });
    await t.session.lidSettled();
    expect(t.session.state).toMatchObject({
      lid: true,
      lidStatus: "failed",
      lidProblem: expect.stringMatching(/turned sleep back on/),
    });
    expect(t.session.active).toBe(true);
  });

  it("a session without the lid replacing a lid session restores sleep", async () => {
    const t = lidSetup();
    await t.session.refreshLidRule();
    t.session.start(60, { lid: true });
    await t.session.lidSettled();
    t.session.start(30);
    await t.session.lidSettled();
    expect(t.calls).toEqual(["disable", `until:${Date.now()}`, "restore"]);
    expect(t.session.state).toMatchObject({ lid: false, lidStatus: "off" });
  });

  it("a lid session replaced before sleep was disabled never touches it", async () => {
    const t = lidSetup();
    await t.session.refreshLidRule();
    t.session.start(60, { lid: true });
    t.session.start(30);
    await t.session.lidSettled();
    expect(t.calls).toEqual([`until:${Date.now()}`]);
  });

  it("adding time keeps the lid", async () => {
    const t = lidSetup();
    await t.session.refreshLidRule();
    t.session.start(60, { lid: true });
    t.session.extend(30);
    await t.session.lidSettled();
    expect(t.session.state?.lid).toBe(true);
    expect(t.calls).toEqual([`until:${Date.now() + 90 * 60_000}`, "disable"]);
  });

  it("stopping Squeak restores sleep but keeps the session, and the next start disables it again", async () => {
    const t = lidSetup();
    await t.session.refreshLidRule();
    t.session.start(60, { lid: true });
    await t.session.lidSettled();
    await t.session.stop();
    expect(t.calls).toEqual(["disable", "restore"]);
    const next = t.make();
    await next.restore();
    expect(next.state).toMatchObject({ lid: true, lidStatus: "on" });
    expect(t.calls).toEqual(["disable", "restore", "recover:true", "disable"]);
    await next.stop();
  });

  it("with no session to resume, a start undoes a disable left behind", async () => {
    const t = lidSetup();
    await t.session.restore();
    expect(t.calls).toEqual(["recover:false"]);
  });

  it("a saved lid session without an end is resumed without the lid", async () => {
    const t = lidSetup();
    fs.writeFileSync(t.sessionPath, JSON.stringify({ session: { startedAt: Date.now(), until: null, lid: true } }));
    await t.session.restore();
    expect(t.session.state).toMatchObject({ lid: false });
    expect(t.lid.disableSleep).not.toHaveBeenCalled();
  });

  it("reads lid from a request, and only as a boolean", () => {
    expect(readAwakeAction({ action: "start", minutes: 60, lid: true })).toEqual({
      kind: "start",
      minutes: 60,
      lid: true,
    });
    expect(readAwakeAction({ on: true, minutes: 60, lid: true })).toEqual({ kind: "start", minutes: 60, lid: true });
    expect(readAwakeAction({ action: "start", minutes: 60, lid: "yes" })).toBeNull();
  });
});

describe("AwakeSession safety rules", () => {
  const reading = (fields: Partial<PowerReading>): PowerReading => ({
    onBattery: true,
    percent: 80,
    thermal: 0,
    lowPower: false,
    ...fields,
  });

  function safetySetup(options: { userLowPower?: boolean; rule?: boolean } = {}) {
    const t = setup();
    const calls: string[] = [];
    const lid = {
      ruleInstalled: vi.fn(async () => options.rule ?? true),
      sleepDisabled: vi.fn(async () => true),
      disableSleep: vi.fn(async () => undefined),
      restoreSleep: vi.fn(async () => true),
      recover: vi.fn(async () => undefined),
      lowPowerOn: vi.fn(async () => {
        calls.push("lowPowerOn");
        return !options.userLowPower;
      }),
      lowPowerOff: vi.fn(async () => {
        calls.push("lowPowerOff");
      }),
      updateUntil: vi.fn(),
    };
    const session = new AwakeSession({ path: t.sessionPath, hold: () => undefined, lid, onChange: t.changes });
    return { session, calls };
  }

  it("a low battery turns Low Power Mode on, and it goes off again when the session ends", async () => {
    const t = safetySetup();
    await t.session.refreshLidRule();
    t.session.start(120);
    await t.session.checkSafety(reading({ percent: 38 }));
    expect(t.session.state).toMatchObject({ lowPower: true, safety: "Battery at 38%" });
    t.session.end();
    await t.session.lidSettled();
    expect(t.calls).toEqual(["lowPowerOn", "lowPowerOff"]);
  });

  it("a flat battery ends the session and says why", async () => {
    const t = safetySetup();
    await t.session.refreshLidRule();
    t.session.start(120, { lid: true });
    await t.session.checkSafety(reading({ percent: 9 }));
    expect(t.session.active).toBe(false);
    expect(t.session.lastEnd).toMatchObject({ reason: "battery", why: "Battery at 9%" });
  });

  it("a critically hot Mac ends it; a hot one gets Low Power Mode", async () => {
    const t = safetySetup();
    await t.session.refreshLidRule();
    t.session.start(120);
    await t.session.checkSafety(reading({ onBattery: false, percent: 100, thermal: 2 }));
    expect(t.session.state).toMatchObject({ lowPower: true, safety: "Your Mac is running hot" });
    await t.session.checkSafety(reading({ onBattery: false, percent: 100, thermal: 3 }));
    expect(t.session.lastEnd).toMatchObject({ reason: "heat" });
  });

  it("cooling down turns Low Power Mode off again mid-session", async () => {
    const t = safetySetup();
    await t.session.refreshLidRule();
    t.session.start(120);
    await t.session.checkSafety(reading({ onBattery: false, thermal: 2 }));
    await t.session.checkSafety(reading({ onBattery: false, thermal: 0 }));
    expect(t.session.state).toMatchObject({ lowPower: false });
    expect(t.session.state).not.toHaveProperty("safety");
    expect(t.calls).toEqual(["lowPowerOn", "lowPowerOff"]);
  });

  it("never turns off Low Power Mode the user had on", async () => {
    const t = safetySetup({ userLowPower: true });
    await t.session.refreshLidRule();
    t.session.start(120);
    await t.session.checkSafety(reading({ percent: 30 }));
    t.session.end();
    await t.session.lidSettled();
    expect(t.calls).toEqual(["lowPowerOn"]);
  });

  it("without the sudoers rule, still ends on a flat battery but leaves Low Power Mode alone", async () => {
    const t = safetySetup({ rule: false });
    await t.session.refreshLidRule();
    t.session.start(120);
    await t.session.checkSafety(reading({ percent: 30 }));
    expect(t.calls).toEqual([]);
    await t.session.checkSafety(reading({ percent: 5 }));
    expect(t.session.lastEnd?.reason).toBe("battery");
  });

  it("tells onEnd how a session ended", async () => {
    const t = setup();
    const ends: unknown[] = [];
    const session = new AwakeSession({ path: t.sessionPath, hold: () => undefined, onEnd: (end) => ends.push(end) });
    session.start(60);
    await session.checkSafety(reading({ percent: 8 }));
    session.start(60);
    session.end();
    expect(ends).toMatchObject([{ reason: "battery", why: "Battery at 8%" }, { reason: "ended" }]);
  });

  it("a battery that cannot be read twice in a row on battery ends the session", async () => {
    const t = safetySetup();
    t.session.start(120);
    await t.session.checkSafety(reading({ percent: 70 }));
    await t.session.checkSafety(reading({ percent: null }));
    expect(t.session.active).toBe(true);
    await t.session.checkSafety(reading({ percent: 69 }));
    await t.session.checkSafety(reading({ percent: null, onBattery: null }));
    expect(t.session.active).toBe(true);
    await t.session.checkSafety(reading({ percent: null, onBattery: null }));
    expect(t.session.active).toBe(false);
    expect(t.session.lastEnd).toMatchObject({ reason: "battery", why: expect.stringMatching(/could not be read/) });
  });

  it("an unreadable battery is no reason on AC or on a Mac without one", async () => {
    const plugged = safetySetup();
    plugged.session.start(120);
    await plugged.session.checkSafety(reading({ percent: 70 }));
    for (let i = 0; i < 3; i++) await plugged.session.checkSafety(reading({ percent: null, onBattery: false }));
    expect(plugged.session.active).toBe(true);
    const desktop = safetySetup();
    desktop.session.start(120);
    for (let i = 0; i < 3; i++) {
      await desktop.session.checkSafety(reading({ percent: null, onBattery: null, hasBattery: false }));
    }
    expect(desktop.session.active).toBe(true);
  });

  it("plugged in, a low battery is not a reason", async () => {
    const t = safetySetup();
    await t.session.refreshLidRule();
    t.session.start(120);
    await t.session.checkSafety(reading({ onBattery: false, percent: 5 }));
    expect(t.session.active).toBe(true);
    expect(t.calls).toEqual([]);
  });
});
