import { describe, expect, it } from "vitest";

globalThis.__squeakNoEntry = true;
const { framed } = await import("../js/entry.js");

describe("framed", () => {
  it("is false for a top-level window", () => {
    const w = {};
    w.top = w;
    w.self = w;
    expect(framed(w)).toBe(false);
  });
  it("is true inside a frame, or when the parent cannot be read", () => {
    expect(framed({ top: {}, self: {} })).toBe(true);
    expect(
      framed({
        get top() {
          throw new Error("cross-origin");
        },
        self: {},
      }),
    ).toBe(true);
  });
});
