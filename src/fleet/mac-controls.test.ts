import { describe, expect, it, vi } from "vitest";

import type { HeatState } from "./heat.js";
import {
  type ControlsSystem,
  MacControls,
  parseAudioPlaying,
  parseVolumeSettings,
  rankApps,
  readControlChange,
} from "./mac-controls.js";

describe("reading a control change", () => {
  it("takes exactly one known key with an exact value", () => {
    expect(readControlChange({ volume: 0 })).toEqual({ volume: 0 });
    expect(readControlChange({ brightness: 100 })).toEqual({ brightness: 100 });
    expect(readControlChange({ muted: true })).toEqual({ muted: true });
    expect(readControlChange({ fans: "max" })).toEqual({ fans: "max" });
    expect(readControlChange({ power: "auto" })).toEqual({ power: "auto" });
    expect(readControlChange({ power: "low" })).toEqual({ power: "low" });
    expect(readControlChange({ power: "high" })).toEqual({ power: "high" });
    expect(readControlChange({ displaySleep: true })).toEqual({ displaySleep: true });
    expect(readControlChange({ open: "com.apple.Notes" })).toEqual({ open: "com.apple.Notes" });
    expect(readControlChange({ space: "left" })).toEqual({ space: "left" });
    expect(readControlChange({ media: "playPause" })).toEqual({ media: "playPause" });
    for (const bad of [
      { open: "-a Terminal" },
      { open: "com.x; rm -rf ~" },
      { open: "" },
      { quit: "../x" },
      { space: "up" },
      { media: "stop" },
      { lock: false },
      { listApps: 1 },
    ]) {
      expect(readControlChange(bad)).toBeNull();
    }
    for (const bad of [
      { volume: 101 },
      { volume: 1.5 },
      { volume: "9" },
      { fans: "90" },
      { power: "2" },
      { power: 2 },
      { power: "High" },
      { power: "high", fans: "max" },
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
  function setup(options: { brightnessWorks?: boolean; playing?: boolean; slow?: () => Promise<void> } = {}) {
    const calls: string[] = [];
    let volume = 40;
    const playing = options.playing ?? false;
    const system: ControlsSystem = {
      volume: async () => ({ volume, muted: false }),
      setVolume: async (v) => {
        calls.push(`volume ${v}`);
        await options.slow?.();
        volume = v;
        return true;
      },
      setMuted: async (m) => (calls.push(`muted ${m}`), true),
      brightness: async () => 57,
      setBrightness: async (b) => (calls.push(`brightness ${b}`), options.brightnessWorks !== false),
      displaySleep: async () => (calls.push("displaySleep"), true),
      wakeScreen: async () => (calls.push("wakeScreen"), true),
      holdScreen: (on) => (calls.push(`holdScreen ${on}`), true),
      mediaPlaying: async () => playing,
      running: async () => [{ id: "com.apple.Safari", name: "Safari", active: true }],
      installed: async () => [
        { id: "com.apple.Safari", name: "Safari" },
        { id: "com.apple.Notes", name: "Notes" },
      ],
      openApp: async (id) => (calls.push(`open ${id}`), true),
      quitApp: async (id) => (calls.push(`quit ${id}`), true),
      systemKey: async (action) => (calls.push(`key ${action}`), null),
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

  it("opens only an app the Mac has, and quits only one that runs", async () => {
    const t = setup();
    expect(await t.controls.apply({ open: "com.apple.Notes" })).toMatchObject({ ok: true });
    expect(await t.controls.apply({ open: "com.evil.app" })).toEqual({
      ok: false,
      reason: "That app isn't on this Mac.",
    });
    expect(await t.controls.apply({ quit: "com.apple.Notes" })).toEqual({
      ok: false,
      reason: "That app isn't running.",
    });
    expect(await t.controls.apply({ quit: "com.apple.Safari" })).toMatchObject({ ok: true });
    expect(t.calls).toEqual(["open com.apple.Notes", "quit com.apple.Safari"]);
  });

  it("answers the installed list only when asked, and keeps running apps in the state", async () => {
    const t = setup();
    const listed = await t.controls.apply({ listApps: true });
    expect(listed).toMatchObject({ ok: true, apps: [{ id: "com.apple.Safari" }, { id: "com.apple.Notes" }] });
    await t.controls.refresh();
    expect(t.controls.state.apps).toEqual([{ id: "com.apple.Safari", name: "Safari", active: true }]);
  });

  it("turns desktops, media and lock into Squeak Hands' fixed actions", async () => {
    const t = setup();
    await t.controls.apply({ space: "right" });
    await t.controls.apply({ media: "playPause" });
    await t.controls.apply({ lock: true });
    expect(t.calls).toEqual(["key space-right", "key play-pause", "key lock"]);
  });

  it("wakes the screen, and holds it on until turned off or Squeak stops", async () => {
    const t = setup();
    await t.controls.apply({ wakeScreen: true });
    expect(await t.controls.apply({ screenAwake: true })).toMatchObject({ ok: true, state: { screenAwake: true } });
    t.controls.stop();
    expect(t.controls.state.screenAwake).toBe(false);
    expect(t.calls).toEqual(["wakeScreen", "holdScreen true", "holdScreen false"]);
    expect(readControlChange({ screenAwake: "yes" })).toBeNull();
    expect(readControlChange({ wakeScreen: false })).toBeNull();
  });

  it("says whether sound is playing, only once it has been read", async () => {
    const t = setup({ playing: true });
    await t.controls.refresh();
    expect(t.controls.state.media).toEqual({ playing: true });
  });

  it("collapses a burst of slider values to the newest, one write at a time", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    const t = setup({
      slow: async () => {
        if (first) {
          first = false;
          await gate;
        }
      },
    });
    const all = [10, 20, 30, 40, 50].map((v) => t.controls.apply({ volume: v }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    const outcomes = await Promise.all(all);
    expect(t.calls).toEqual(["volume 10", "volume 50"]);
    expect(outcomes.every((o) => o.ok)).toBe(true);
  });
});

describe("audio playing and app ranking", () => {
  const sample = (resources: string) => `Listed by owning process:
   pid 428(coreaudiod): [0x1] 00:00:00 PreventUserIdleSystemSleep named: "com.apple.audio.BuiltInSpeakerDevice.context.preventuseridlesleep"
\tCreated for PID: 29571.
\tResources: ${resources}
   pid 356(powerd): [0x2] 00:24:36 PreventUserIdleSystemSleep named: "Powerd - Prevent sleep while display is on"
`;
  it("reads coreaudiod's audio-out assertion, not a microphone or another owner", () => {
    expect(parseAudioPlaying(sample("audio-out BuiltInSpeakerDevice"))).toBe(true);
    expect(parseAudioPlaying(sample("audio-in BuiltInMicrophoneDevice"))).toBe(false);
    expect(parseAudioPlaying("Assertion status system-wide:\n   PreventSystemSleep 0\n")).toBe(false);
  });

  it("ranks the front app, then the most recent, and caps the list", () => {
    const apps = Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, name: `A${i}`, active: i === 5 }));
    const ranked = rankApps(
      apps,
      new Map([
        ["a7", 200],
        ["a2", 100],
      ]),
      4,
    );
    expect(ranked.map((a) => a.id)).toEqual(["a5", "a7", "a2", "a0"]);
  });
});
