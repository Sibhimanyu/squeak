import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  agentTree,
  fansSudoersRule,
  HeatGovernor,
  type HeatSystem,
  HOT_END_MS,
  parseFansRead,
  parseProcesses,
  readBatteryTemperature,
} from "./heat.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const PS = [
  "  100     1 Fri Oct 23 15:22:45 2026     /Applications/Conductor.app/Contents/MacOS/Conductor",
  "  200   100 Fri Oct 23 15:22:46 2026     /Users/me/Library/Application Support/com.conductor.app/agent-binaries/claude/2.1.300/claude",
  "  300   200 Fri Oct 23 15:30:00 2026     /bin/zsh",
  "  301   300 Fri Oct  3 15:30:01 2026     /usr/bin/swift-build",
  "  400     1 Fri Oct 23 06:22:01 2026     /Users/me/.codex/bin/codex",
  "  500     1 Fri Oct 23 06:22:01 2026     /Applications/Safari.app/Contents/MacOS/Safari",
].join("\n");

/** A Mac whose temperatures the test sets. */
function fakeMac(options: { fanControl?: boolean; fansWork?: boolean } = {}) {
  const calls: string[] = [];
  let die: number | null = 60;
  let rows = parseProcesses(PS);
  const system: HeatSystem = {
    read: async () => ({ die, fans: [{ rpm: 2300, min: 2300, max: 7800, manual: false }] }),
    fanControl: async () => options.fanControl !== false,
    setFans: async (max) => {
      calls.push(max ? "fans max" : "fans auto");
      return options.fansWork !== false;
    },
    processes: async () => rows,
    slow: async (pid, on) => {
      calls.push(`${on ? "slow" : "unslow"} ${pid}`);
      return true;
    },
  };
  return {
    system,
    calls,
    setDie: (value: number | null) => {
      die = value;
    },
    setRows: (text: string) => {
      rows = parseProcesses(text);
    },
  };
}

function governor(mac: ReturnType<typeof fakeMac>, clock = { now: 1_000_000 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "heat-"));
  dirs.push(dir);
  const journalPath = path.join(dir, "heat-journal.json");
  const setLowPower = vi.fn();
  const end = vi.fn();
  const notify = vi.fn();
  const heat = new HeatGovernor({
    system: mac.system,
    journalPath,
    setLowPower,
    end,
    notify,
    now: () => clock.now,
    selfPid: 999,
  });
  return { heat, journalPath, setLowPower, end, notify, clock };
}

const looks = async (heat: HeatGovernor, n: number, input: { battery: number | null; lidClosed: boolean | null }) => {
  for (let i = 0; i < n; i += 1) await heat.check(input, true);
};

describe("reading heat", () => {
  it("reads the helper's line, the battery and the process list", () => {
    expect(parseFansRead('{"die":43.0,"sensors":42,"fans":[{"rpm":0,"min":2317,"max":7826,"manual":false}]}')).toEqual({
      die: 43,
      fans: [{ rpm: 0, min: 2317, max: 7826, manual: false }],
    });
    expect(parseFansRead('{"die":null,"fans":[]}')).toEqual({ die: null, fans: [] });
    expect(parseFansRead("not json")).toBeNull();
    expect(readBatteryTemperature('  "Temperature" = 3047\n')).toBe(30.5);
    expect(readBatteryTemperature('"VirtualTemperature" = 3150')).toBeNull();
    const rows = parseProcesses(PS);
    expect(rows).toHaveLength(6);
    expect(rows[3]).toMatchObject({ pid: 301, ppid: 300, startedAt: "Fri Oct 3 15:30:01 2026" });
  });

  it("finds every agent and everything it started, never the daemon", () => {
    const tree = agentTree(parseProcesses(PS), [400]).map((row) => row.pid);
    expect(tree.sort()).toEqual([200, 300, 301]);
  });

  it("builds a sudoers rule for exactly two commands, for a plain account name", () => {
    expect(fansSudoersRule("sibhi")).toContain(
      "sibhi ALL=(root) NOPASSWD: /Library/PrivilegedHelperTools/com.squeak.fans max, /Library/PrivilegedHelperTools/com.squeak.fans auto",
    );
    expect(fansSudoersRule("ALL")).toBeNull();
    expect(fansSudoersRule("a b")).toBeNull();
  });
});

describe("HeatGovernor", () => {
  it("does nothing on a Mac at rest, or outside an awake session", async () => {
    const mac = fakeMac();
    const { heat, setLowPower } = governor(mac);
    await looks(heat, 5, { battery: 33, lidClosed: true });
    mac.setDie(99);
    for (let i = 0; i < 5; i += 1) await heat.check({ battery: 46, lidClosed: true }, false);
    expect(mac.calls).toEqual([]);
    expect(setLowPower).not.toHaveBeenCalled();
    expect(heat.state).toMatchObject({ level: "ok", die: 99, battery: 46 });
  });

  it("makes less heat when warm, journalled, and undoes it all once cool", async () => {
    const mac = fakeMac();
    const { heat, journalPath, setLowPower } = governor(mac);
    await looks(heat, 1, { battery: 41, lidClosed: true });
    expect(mac.calls).toEqual([]);
    await looks(heat, 1, { battery: 41, lidClosed: true });
    expect(mac.calls).toEqual(["slow 200", "slow 300", "slow 301", "slow 400", "fans max"]);
    expect(setLowPower).toHaveBeenLastCalledWith(
      true,
      "Running warm · chip 60°C, battery 41°C · fans on full · agents slowed",
    );
    expect(JSON.parse(fs.readFileSync(journalPath, "utf8"))).toMatchObject({ fansMax: true });
    expect(heat.state).toMatchObject({ level: "warm", fansMax: true, slowed: 4 });
    // A build started while warm is slowed on the next look.
    mac.setRows(`${PS}\n  302   300 Fri Oct 23 15:40:00 2026     /usr/bin/clang`);
    await looks(heat, 1, { battery: 39, lidClosed: true });
    expect(mac.calls.at(-1)).toBe("slow 302");
    // Between the two lines nothing changes; a minute under them, everything is undone.
    await looks(heat, 3, { battery: 36, lidClosed: true });
    expect(heat.state.level).toBe("warm");
    await looks(heat, 1, { battery: 36, lidClosed: true });
    expect(heat.state).toMatchObject({ level: "ok", fansMax: false, slowed: 0 });
    expect(mac.calls.slice(-6)).toEqual([
      "unslow 200",
      "unslow 300",
      "unslow 301",
      "unslow 400",
      "unslow 302",
      "fans auto",
    ]);
    expect(setLowPower).toHaveBeenLastCalledWith(false, null);
    expect(fs.existsSync(journalPath)).toBe(false);
  });

  it("counts a hot die only with the lid shut, where the Mac cannot shed it", async () => {
    const mac = fakeMac();
    mac.setDie(95);
    const { heat } = governor(mac);
    await looks(heat, 3, { battery: 35, lidClosed: false });
    expect(heat.state.level).toBe("ok");
    await looks(heat, 2, { battery: 35, lidClosed: true });
    expect(heat.state.level).toBe("warm");
  });

  it("works without fan control: slows agents, leaves the fans to macOS", async () => {
    const mac = fakeMac({ fanControl: false });
    const { heat } = governor(mac);
    await looks(heat, 2, { battery: 42, lidClosed: true });
    expect(mac.calls).not.toContain("fans max");
    expect(heat.state).toMatchObject({ level: "warm", fanControl: false, fansMax: false, slowed: 4 });
  });

  it("says a hot Mac at once, and lets it sleep after two minutes of it", async () => {
    const mac = fakeMac();
    const { heat, notify, end, clock } = governor(mac);
    await looks(heat, 2, { battery: 46, lidClosed: true });
    expect(heat.state.level).toBe("hot");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toContain("battery 46°C");
    clock.now += HOT_END_MS - 1;
    await looks(heat, 1, { battery: 46, lidClosed: true });
    expect(end).not.toHaveBeenCalled();
    clock.now += 1;
    await looks(heat, 1, { battery: 46, lidClosed: true });
    expect(end).toHaveBeenCalledWith("Your Mac stayed hot (chip 60°C, battery 46°C)");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(heat.state).toMatchObject({ level: "ok", fansMax: false, slowed: 0 });
  });

  it("does not end a session for a hot spell that passes", async () => {
    const mac = fakeMac();
    const { heat, end, clock } = governor(mac);
    await looks(heat, 2, { battery: 46, lidClosed: true });
    clock.now += 90_000;
    await looks(heat, 1, { battery: 43, lidClosed: true });
    clock.now += 90_000;
    await looks(heat, 1, { battery: 46, lidClosed: true });
    expect(end).not.toHaveBeenCalled();
    expect(heat.state.level).toBe("hot");
  });

  it("undoes at start what a previous run journalled, only for the same processes", async () => {
    const mac = fakeMac();
    const { heat, journalPath } = governor(mac);
    fs.writeFileSync(
      journalPath,
      JSON.stringify({
        fansMax: true,
        slowed: [
          { pid: 200, startedAt: "Fri Oct 23 15:22:46 2026" },
          { pid: 300, startedAt: "Thu Oct 22 10:00:00 2026" },
        ],
      }),
    );
    await heat.recover();
    expect(mac.calls).toEqual(["unslow 200", "fans auto"]);
    expect(fs.existsSync(journalPath)).toBe(false);
  });

  it("keeps the journal when the fans refuse to go back, so the backstop retries", async () => {
    const mac = fakeMac({ fansWork: false });
    const { heat, journalPath } = governor(mac);
    fs.writeFileSync(journalPath, JSON.stringify({ fansMax: true, slowed: [] }));
    await heat.recover();
    expect(JSON.parse(fs.readFileSync(journalPath, "utf8"))).toMatchObject({ fansMax: true });
  });
});
