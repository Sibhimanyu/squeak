import { describe, expect, it } from "vitest";

import { parseCursor } from "./transcript.js";

describe("parseCursor", () => {
  it("validates a cursor strictly", () => {
    expect(parseCursor(null)).toBeNull();
    expect(parseCursor("")).toBeNull();
    expect(parseCursor("42")).toBe(42);
    for (const bad of ["0", "-1", "1.5", "12a", " 1", "1e3", "0x10", "99999999999999999"]) {
      expect(parseCursor(bad)).toBe("invalid");
    }
  });
});
