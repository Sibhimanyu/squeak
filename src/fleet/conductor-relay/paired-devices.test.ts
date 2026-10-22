import { describe, expect, it } from "vitest";
import { mergePairedDevice, parsePairedDevices, type PairedDevice } from "./paired-devices.js";

const dev = (deviceId: string, name: string): PairedDevice => ({
  deviceId,
  name,
  tokenHash: "h",
  createdAt: "t",
  lastSeenAt: "t",
});

describe("paired devices", () => {
  it("reads a missing or empty item as no devices", () => {
    expect(parsePairedDevices(undefined)).toEqual([]);
    expect(parsePairedDevices("  ")).toEqual([]);
  });

  it("refuses a value that is not a list, so nothing is overwritten", () => {
    expect(() => parsePairedDevices('{"a":1}')).toThrow();
    expect(() => parsePairedDevices("[1]")).toThrow();
    expect(() => parsePairedDevices("nope")).toThrow();
  });

  it("keeps devices Conductor paired itself", () => {
    const phone = dev("p1", "iPhone");
    const merged = mergePairedDevice([phone], dev("s1", "Squeak"));
    expect(merged.map((d) => d.deviceId)).toEqual(["p1", "s1"]);
  });

  it("replaces an earlier Squeak pairing instead of piling them up", () => {
    const merged = mergePairedDevice([dev("p1", "iPhone"), dev("old", "Squeak")], dev("s1", "Squeak"));
    expect(merged.map((d) => d.deviceId)).toEqual(["p1", "s1"]);
  });
});
