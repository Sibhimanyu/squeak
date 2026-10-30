import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { pauseUntil, readPauseChange, readVoiceChange, VoiceSettingsStore } from "./settings.js";

describe("readVoiceChange", () => {
  it("takes an internal extension or null, nothing else", () => {
    expect(readVoiceChange({ callee: "101" })).toEqual({ callee: "101" });
    expect(readVoiceChange({ callee: null })).toEqual({ callee: null });
    for (const bad of [
      { callee: "1" },
      { callee: "1234567" },
      { callee: "+919876543210" },
      { callee: "10 1" },
      { callee: 101 },
      { callee: "101", x: 1 },
      {},
      [],
      null,
      "101",
    ]) {
      expect(readVoiceChange(bad)).toBeNull();
    }
  });
});

describe("VoiceSettingsStore", () => {
  it("saves privately, reloads, and keeps the old value on a refused change", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-settings-"));
    const file = path.join(dir, "voice-settings.json");
    const store = new VoiceSettingsStore(file);
    expect(store.settings.callee).toBeNull();
    expect(store.apply({ callee: "202" })).toEqual({ ok: true, settings: { callee: "202" } });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(new VoiceSettingsStore(file).settings.callee).toBe("202");
    expect(store.apply({ callee: "9" }).ok).toBe(false);
    expect(store.settings.callee).toBe("202");
    fs.rmSync(dir, { recursive: true });
  });

  it("ignores a hand-edited file with a bad value", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-settings-"));
    const file = path.join(dir, "voice-settings.json");
    fs.writeFileSync(file, '{"callee":"+1555"}');
    expect(new VoiceSettingsStore(file).settings.callee).toBeNull();
    fs.rmSync(dir, { recursive: true });
  });
});

describe("pause calls", () => {
  const at = new Date(2026, 9, 30, 15, 40).getTime();
  const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "voice-pause-")), "voice-settings.json");

  it("accepts exactly one pause key with a known choice", () => {
    for (const c of ["1h", "4h", "tomorrow", "forever", "resume"]) expect(readPauseChange({ pause: c })).toBe(c);
    for (const bad of [{ pause: "2h" }, { pause: 1 }, { pause: "1h", callee: "101" }, {}, [], null])
      expect(readPauseChange(bad)).toBeNull();
  });

  it("computes until in the daemon: 1h, 4h, next 08:00 local, forever", () => {
    expect(pauseUntil("1h", at)).toBe(at + 3_600_000);
    expect(pauseUntil("4h", at)).toBe(at + 4 * 3_600_000);
    expect(pauseUntil("forever", at)).toBeNull();
    expect(pauseUntil("tomorrow", at)).toBe(new Date(2026, 9, 31, 8, 0).getTime());
    const early = new Date(2026, 9, 30, 3, 0).getTime();
    expect(pauseUntil("tomorrow", early)).toBe(new Date(2026, 9, 30, 8, 0).getTime());
  });

  it("persists a pause beside the callee, resumes, and refuses a bad choice", () => {
    const f = file();
    const store = new VoiceSettingsStore(f, () => at);
    store.apply({ callee: "202" });
    expect(store.apply({ pause: "4h" })).toEqual({
      ok: true,
      settings: { callee: "202", pause: { until: at + 4 * 3_600_000 } },
    });
    expect(new VoiceSettingsStore(f, () => at).pause()).toEqual({ until: at + 4 * 3_600_000 });
    expect(store.apply({ callee: "303" })).toMatchObject({
      ok: true,
      settings: { pause: { until: at + 4 * 3_600_000 } },
    });
    expect(store.apply({ pause: "forever" })).toMatchObject({ ok: true });
    expect(store.pause()).toEqual({ until: null });
    expect(store.apply({ pause: "bogus" }).ok).toBe(false);
    expect(store.pause()).toEqual({ until: null });
    expect(store.apply({ pause: "resume" })).toEqual({ ok: true, settings: { callee: "303" } });
    expect(store.pause()).toBeNull();
    expect(JSON.parse(fs.readFileSync(f, "utf8"))).toEqual({ callee: "303" });
  });

  it("clears an elapsed pause lazily", () => {
    const f = file();
    let now = at;
    const store = new VoiceSettingsStore(f, () => now);
    store.apply({ pause: "1h" });
    now = at + 3_599_000;
    expect(store.pause()).not.toBeNull();
    now = at + 3_600_000;
    expect(store.pause()).toBeNull();
    expect(JSON.parse(fs.readFileSync(f, "utf8")).pause).toBeUndefined();
  });
});
