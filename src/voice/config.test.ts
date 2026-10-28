import { describe, expect, it } from "vitest";

import { readQuietRange, readVoiceConfig } from "./config.js";

const base = {
  SQUEAK_VOICE_HOST: "pbx.local",
  SQUEAK_VOICE_EXTENSION: "900",
  SQUEAK_VOICE_PASSWORD: "s3cret",
  SQUEAK_VOICE_CALLEE: "101",
  SQUEAK_VOICE_BARESIP: "/opt/homebrew/bin/baresip",
};

describe("readVoiceConfig", () => {
  it("is off until the four required settings are present", () => {
    expect(readVoiceConfig({}, "/s")).toBeNull();
    expect(readVoiceConfig({ ...base, SQUEAK_VOICE_CALLEE: undefined }, "/s")).toBeNull();
  });

  it("reads a full setup", () => {
    const config = readVoiceConfig({ ...base, SQUEAK_VOICE_PIN: "4821", SQUEAK_VOICE_QUIET: "22:00-07:00" }, "/s");
    expect(config).toMatchObject({
      callee: "101",
      pin: "4821",
      quiet: { from: "22:00", to: "07:00" },
      line: { host: "pbx.local", user: "900", authUser: null, transport: "udp", dir: "/s/voice" },
    });
  });

  it("refuses values that could break out of the accounts file", () => {
    expect(() => readVoiceConfig({ ...base, SQUEAK_VOICE_PASSWORD: 'a";b' }, "/s")).toThrow(/PASSWORD/);
    expect(() => readVoiceConfig({ ...base, SQUEAK_VOICE_HOST: "pbx;x" }, "/s")).toThrow(/HOST/);
    expect(() => readVoiceConfig({ ...base, SQUEAK_VOICE_EXTENSION: "9 0" }, "/s")).toThrow(/EXTENSION/);
    expect(() => readVoiceConfig({ ...base, SQUEAK_VOICE_CALLEE: "1;2" }, "/s")).toThrow(/CALLEE/);
  });

  it("insists on a numeric PIN of a usable length", () => {
    expect(() => readVoiceConfig({ ...base, SQUEAK_VOICE_PIN: "12" }, "/s")).toThrow(/PIN/);
    expect(() => readVoiceConfig({ ...base, SQUEAK_VOICE_PIN: "abcd" }, "/s")).toThrow(/PIN/);
  });
});

describe("readQuietRange", () => {
  it("reads HH:MM-HH:MM and nothing else", () => {
    expect(readQuietRange("22:00-07:00")).toEqual({ from: "22:00", to: "07:00" });
    expect(readQuietRange("22:00-22:00")).toBeNull();
    expect(readQuietRange("night")).toBeNull();
    expect(readQuietRange(undefined)).toBeNull();
  });
});
