import { describe, expect, it, vi } from "vitest";

import type { HeatState } from "./heat.js";
import { type ControlsSystem, MacControls, parseVolumeSettings, readControlChange } from "./mac-controls.js";

describe("reading a control change", () => {
  it("takes exactly one known key with an exact value", () => {
    expect(readControlChange({ volume: 0 })).toEqual({ volume: 0 });
    expect(readControlChange({ brightness: 100 })).toEqual({ brightness: 100 });
    expect(readControlChange({ muted: true })).toEqual({ muted: true });
    expect(readControlChange({ fans: "max" })).toEqual({ fans: "max" });
    expect(readControlChange({ displaySleep: true })).toEqual({ displaySleep: true });
    for (const bad of [
      { volume: 101 },
      { volume: 1.5 },
      { volume: "9" },
      { fans: "90" },
      { muted: 1 },
      { displaySleep: false },
      { x: 1 },
      {},
      { volume: 1, muted: true },
      null,
      [],
      "volume",
    ]) {
      expect(readControlChange(bad)).toBeNull();
    }
  });

  it("reads AppleScript's volume settings", () => {
    expect(parseVolumeSettings("output volume:40, input volume:60, alert volume:100, output muted:false")).toEqual({
      volume: 40,
      muted: false,
    });
    expect(parseVolumeSettings("output volume:missing value, output muted:missing value")).toEqual({
      volume: null,
      muted: null,
    });
  });
});

describe("MacControls", () => {
  function setup(options: { brightnessWorks?: boolean } = {}) {
    const calls: string[] = [];
    let volume = 40;
    const system: ControlsSystem = {
      volume: async () => ({ volume, muted: false }),
      setVolume: async (v) => {
        calls.push(`volume ${v}`);
        volume = v;
        return true;
      },
      setMuted: async (m) => (calls.push(`muted ${m}`), true),
      brightness: async () => 57,
      setBrightness: async (b) => (calls.push(`brightness ${b}`), options.brightnessWorks !== false),
      displaySleep: async () => (calls.push("displaySleep"), true),
    };
    const heatState = { fanMode: "auto", fanChoice: "auto", fanControl: true, fansRpm: [2300] } as HeatState;
    const heat = { state: heatState, setFanChoice: vi.fn(async () => ({ ok: true as const })) };
    const onChange = vi.fn();
    return { controls: new MacControls(system, heat, onChange), calls, heat, onChange };
  }

  it("applies a change, reads the Mac again, and says what it is now", async () => {
    const t = setup();
    const outcome = await t.controls.apply({ volume: 25 });
    expect(t.calls).toEqual(["volume 25"]);
    expect(outcome).toMatchObject({
      ok: true,
      state: { volume: 25, brightness: 57, fans: { mode: "auto", available: true } },
    });
    expect(t.onChange).toHaveBeenCalled();
  });

  it("sends fans through heat, so heat can still raise them", async () => {
    const t = setup();
    await t.controls.apply({ fans: "80" });
    expect(t.heat.setFanChoice).toHaveBeenCalledWith("80");
    expect(t.calls).toEqual([]);
  });

  it("says why brightness did not change with the lid closed", async () => {
    const t = setup({ brightnessWorks: false });
    expect(await t.controls.apply({ brightness: 30 })).toEqual({
      ok: false,
      reason: "Brightness only changes while the Mac's lid is open.",
    });
  });
});
