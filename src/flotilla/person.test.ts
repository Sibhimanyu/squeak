import { describe, expect, it } from "vitest";

import * as person from "./person.js";
import { computerName } from "./person.js";

describe("the Mac's own names", () => {
  it("offers no person name: a name is the Squeak account's", () => {
    expect("personName" in person).toBe(false);
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
