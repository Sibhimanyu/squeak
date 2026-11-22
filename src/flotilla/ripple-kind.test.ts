import { describe, expect, it } from "vitest";

import { readRipple } from "./types.js";

describe("Ripple kind", () => {
  const base = { id: "r1", at: 1, actor: "d1", text: "joined" };
  it("is optional: an old Ripple reads with no kind", () => {
    expect(readRipple(base)).toEqual(base);
  });
  it("keeps a known kind and drops an unknown one", () => {
    expect(readRipple({ ...base, kind: "joined" })?.kind).toBe("joined");
    expect(readRipple({ ...base, kind: "weird" })).toEqual(base);
    expect(readRipple({ ...base, kind: 7 })).toEqual(base);
  });
});
