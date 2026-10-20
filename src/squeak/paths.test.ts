import { describe, expect, it } from "vitest";

import { defaultSqueakDbPath, defaultSqueakEnvPath, expandHome, resolveSqueakEnvPath } from "./paths.js";

describe("squeak paths", () => {
  it("keeps everything under Application Support/squeak", () => {
    expect(defaultSqueakEnvPath("/Users/t")).toBe("/Users/t/Library/Application Support/squeak/.env");
    expect(defaultSqueakDbPath("/Users/t")).toBe("/Users/t/Library/Application Support/squeak/squeak.db");
  });

  it("expands ~ and leaves other paths alone", () => {
    expect(expandHome("~/x/y", "/Users/t")).toBe("/Users/t/x/y");
    expect(expandHome("/abs", "/Users/t")).toBe("/abs");
  });

  it("honours SQUEAK_ENV_PATH", () => {
    expect(resolveSqueakEnvPath({ SQUEAK_ENV_PATH: "~/custom/.env" }, "/Users/t")).toBe("/Users/t/custom/.env");
  });
});
