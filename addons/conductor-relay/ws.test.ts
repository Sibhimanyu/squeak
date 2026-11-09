import { describe, expect, it } from "vitest";
import { offeredSubprotocol } from "./ws.js";

describe("offeredSubprotocol", () => {
  it("takes the first token", () => {
    expect(offeredSubprotocol("a, b")).toBe("a");
    expect(offeredSubprotocol(["x.y", "z"])).toBe("x.y");
  });
  it("ignores nothing-offered and header-injection attempts", () => {
    expect(offeredSubprotocol(undefined)).toBeUndefined();
    expect(offeredSubprotocol("")).toBeUndefined();
    expect(offeredSubprotocol("bad value")).toBeUndefined();
    expect(offeredSubprotocol("a\r\nX: y")).toBeUndefined();
  });
});
