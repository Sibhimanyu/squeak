import { describe, expect, it } from "vitest";

import { databaseUrl } from "./config.js";

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
