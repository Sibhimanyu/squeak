import { describe, expect, it } from "vitest";

import { databaseUrl, localPort, sharedFlag } from "./config.js";

describe("databaseUrl", () => {
  it("accepts a Realtime Database instance root, normalized", () => {
    expect(databaseUrl("https://squeak-5c9gvo-default-rtdb.asia-southeast1.firebasedatabase.app/")).toBe(
      "https://squeak-5c9gvo-default-rtdb.asia-southeast1.firebasedatabase.app",
    );
    expect(databaseUrl(" https://squeak-5c9gvo-default-rtdb.firebaseio.com ")).toBe(
      "https://squeak-5c9gvo-default-rtdb.firebaseio.com",
    );
  });

  it("is off when unset", () => {
    expect(databaseUrl(undefined)).toBeNull();
    expect(databaseUrl("  ")).toBeNull();
  });

  it("refuses anything the phone would refuse, rather than pairing phones to it", () => {
    for (const bad of [
      "http://x-default-rtdb.firebasedatabase.app",
      "https://evil.example.com",
      "https://firebasedatabase.app.evil.com",
      "https://x.firebasedatabase.app/channels",
      "https://x.firebasedatabase.app?ns=y",
      "not a url",
    ]) {
      expect(() => databaseUrl(bad), bad).toThrow(/SQUEAK_REMOTE_DATABASE_URL/);
    }
  });
});

describe("localPort", () => {
  it("pins a valid unprivileged port and otherwise leaves the choice to the system", () => {
    expect(localPort("48500")).toBe(48500);
    expect(localPort(" 8479 ")).toBe(8479);
    for (const bad of [undefined, "", "0", "80", "70000", "abc", "1.5"]) {
      expect(localPort(bad)).toBe(0);
    }
  });
});

describe("sharedFlag", () => {
  const url = "https://squeak-shared-default-rtdb.firebaseio.com";
  it("reads 1/on/true in any case", () => {
    for (const on of ["1", "on", "TRUE", " On "]) {
      expect(sharedFlag(on, url), on).toBe(true);
    }
    for (const off of [undefined, "", "0", "off", "no"]) {
      expect(sharedFlag(off, url), String(off)).toBe(false);
    }
  });

  it("needs the database URL", () => {
    expect(() => sharedFlag("1", undefined)).toThrow(/SQUEAK_REMOTE_DATABASE_URL/);
    expect(sharedFlag("off", undefined)).toBe(false);
  });
});
