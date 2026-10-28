import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readVoiceChange, VoiceSettingsStore } from "./settings.js";

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
