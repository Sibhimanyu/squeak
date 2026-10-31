import { describe, expect, it } from "vitest";

import { parseIdleSeconds } from "./user-idle.js";

describe("parseIdleSeconds", () => {
  it("reads HIDIdleTime as seconds", () => {
    expect(parseIdleSeconds('    | |   "HIDIdleTime" = 4500000000\n')).toBe(4.5);
    expect(parseIdleSeconds('"HIDIdleTime"=0')).toBe(0);
  });
  it("is null when there is no such line", () => {
    expect(parseIdleSeconds("nothing here")).toBeNull();
  });
});
