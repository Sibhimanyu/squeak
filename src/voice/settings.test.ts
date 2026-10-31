import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_HOLD,
  isTerse,
  MAX_PERSONA_CHARS,
  pauseUntil,
  personaInstruction,
  readHoldChange,
  readPauseChange,
  readPersonaChange,
  readVoiceChange,
  VoiceSettingsStore,
} from "./settings.js";

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

describe("the call's persona", () => {
  const store = (): { file: string; store: VoiceSettingsStore } => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "squeak-persona-")), "voice-settings.json");
    return { file, store: new VoiceSettingsStore(file) };
  };

  it("reads exactly a style, and a custom one needs its text", () => {
    expect(readPersonaChange({ persona: { style: "terse" } })).toEqual({ style: "terse" });
    expect(readPersonaChange({ persona: { style: "friendly", custom: "ignored" } })).toEqual({ style: "friendly" });
    expect(readPersonaChange({ persona: { style: "custom", custom: "  dry\u0000 and\nblunt " } })).toEqual({
      style: "custom",
      custom: "dry and blunt",
    });
    expect(readPersonaChange({ persona: { style: "custom", custom: "x".repeat(900) } })?.custom).toHaveLength(
      MAX_PERSONA_CHARS,
    );
    for (const bad of [
      { persona: { style: "custom" } },
      { persona: { style: "custom", custom: "   " } },
      { persona: { style: "rude" } },
      { persona: { style: "terse", extra: 1 } },
      { persona: "terse" },
      { persona: { style: "terse" }, callee: "101" },
      {},
      null,
    ]) {
      expect(readPersonaChange(bad)).toBeNull();
    }
  });

  it("is terse by default, and only friendly keeps the pleasantries", () => {
    expect(isTerse(undefined)).toBe(true);
    expect(isTerse({ style: "terse" })).toBe(true);
    expect(isTerse({ style: "custom", custom: "dry" })).toBe(true);
    expect(isTerse({ style: "friendly" })).toBe(false);
    expect(personaInstruction(undefined)).toContain("No greetings");
    expect(personaInstruction({ style: "friendly" })).toContain("Warm");
    expect(personaInstruction({ style: "custom", custom: "like a pirate" })).toContain("like a pirate");
  });

  it("is saved, survives a reload, and is not lost when the extension or a pause changes", () => {
    const { file, store: settings } = store();
    expect(settings.apply({ persona: { style: "custom", custom: "dry and blunt" } })).toMatchObject({ ok: true });
    expect(settings.apply({ callee: "101" })).toMatchObject({ ok: true });
    expect(settings.apply({ pause: "1h" })).toMatchObject({ ok: true });
    expect(settings.settings).toMatchObject({ callee: "101", persona: { style: "custom", custom: "dry and blunt" } });
    expect(new VoiceSettingsStore(file).settings.persona).toEqual({ style: "custom", custom: "dry and blunt" });
    expect(settings.apply({ pause: "resume" })).toMatchObject({ ok: true });
    expect(settings.settings.persona).toEqual({ style: "custom", custom: "dry and blunt" });
  });

  it("says what is wrong with a persona it cannot take, and changes nothing", () => {
    const { store: settings } = store();
    const outcome = settings.apply({ persona: { style: "custom" } });
    expect(outcome).toMatchObject({ ok: false });
    expect(settings.settings.persona).toBeUndefined();
  });
});

describe("hold settings", () => {
  it("reads whole integers in range, some keys at a time, and refuses the rest", () => {
    expect(readHoldChange({ hold: { graceSeconds: 15, maxHoldMinutes: 120, holdAtMac: false } })).toEqual({
      graceSeconds: 15,
      maxHoldMinutes: 120,
      holdAtMac: false,
    });
    for (const bad of [
      { hold: {} },
      { hold: { graceSeconds: 14 } },
      { hold: { graceSeconds: 601 } },
      { hold: { awayAfterSeconds: 29 } },
      { hold: { awayAfterSeconds: 901 } },
      { hold: { sawItAwayAfterSeconds: 29 } },
      { hold: { sawItAwayAfterSeconds: 1801 } },
      { hold: { maxHoldMinutes: 0 } },
      { hold: { maxHoldMinutes: 121 } },
      { hold: { graceSeconds: 45.5 } },
      { hold: { graceSeconds: "45" } },
      { hold: { holdAtMac: "yes" } },
      { hold: { other: 1 } },
      { hold: [] },
      { hold: { graceSeconds: 45 }, callee: "101" },
      { hold: null },
    ]) {
      expect(readHoldChange(bad)).toBeNull();
    }
  });

  it("defaults for an old file, saves a change, merges the next and keeps it across other changes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-settings-"));
    const file = path.join(dir, "voice-settings.json");
    fs.writeFileSync(file, JSON.stringify({ callee: "101" }));
    const store = new VoiceSettingsStore(file);
    expect(store.hold()).toEqual(DEFAULT_HOLD);
    expect(store.apply({ hold: { graceSeconds: 60 } }).ok).toBe(true);
    expect(store.apply({ hold: { sawItAwayAfterSeconds: 300 } }).ok).toBe(true);
    expect(store.apply({ persona: { style: "friendly" } }).ok).toBe(true);
    expect(store.apply({ pause: "1h" }).ok).toBe(true);
    expect(store.apply({ callee: "102" }).ok).toBe(true);
    const wanted = { ...DEFAULT_HOLD, graceSeconds: 60, sawItAwayAfterSeconds: 300 };
    expect(store.hold()).toEqual(wanted);
    expect(new VoiceSettingsStore(file).hold()).toEqual(wanted);
    expect(new VoiceSettingsStore(file).settings.persona).toEqual({ style: "friendly" });
    expect(new VoiceSettingsStore(file).pause()).not.toBeNull();
    const refused = store.apply({ hold: { graceSeconds: 5 } });
    expect(refused.ok).toBe(false);
    expect(store.hold()).toEqual(wanted);
  });

  it("keeps the valid keys of a damaged file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-settings-"));
    const file = path.join(dir, "voice-settings.json");
    fs.writeFileSync(file, JSON.stringify({ callee: null, hold: { graceSeconds: 5, awayAfterSeconds: 120, x: 1 } }));
    expect(new VoiceSettingsStore(file).hold()).toEqual({ ...DEFAULT_HOLD, awayAfterSeconds: 120 });
  });
});
