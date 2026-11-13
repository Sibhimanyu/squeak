import { describe, expect, it } from "vitest";

import { computerName, personName } from "./person.js";

describe("who the owner is", () => {
  it("uses the full name, never the short login name", () => {
    expect(personName(() => "Sibhi Manikandan\n", "sibhi-zstch1643")).toBe("Sibhi Manikandan");
  });
  it("falls back to the login name only when the Mac has no full name", () => {
    expect(personName(() => "", "sibhi")).toBe("sibhi");
    expect(
      personName(() => {
        throw new Error("no id -F");
      }, "sibhi"),
    ).toBe("sibhi");
  });
  it("names the Nest by the computer name, else the hostname", () => {
    expect(computerName(() => "Sibhi's MacBook Pro\n", "mac.local")).toBe("Sibhi's MacBook Pro");
    expect(
      computerName(() => {
        throw new Error("unset");
      }, "mac.local"),
    ).toBe("mac");
  });
});
