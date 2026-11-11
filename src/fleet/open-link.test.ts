import { describe, expect, it } from "vitest";
import { OPEN_IN_SQUEAK_URL, openInSqueakLink } from "./open-link.js";

describe("openInSqueakLink", () => {
  it("points at the GitHub Pages hand-off page, never a Firebase site", () => {
    expect(OPEN_IN_SQUEAK_URL).toBe("https://sibhimanyu.github.io/squeak/open/");
    expect(openInSqueakLink("289014c4-b06d-4bae-92c6-7ed94912e6bd")).toBe(
      "https://sibhimanyu.github.io/squeak/open/#s=289014c4-b06d-4bae-92c6-7ed94912e6bd",
    );
  });
  it("encodes the id", () => {
    expect(openInSqueakLink("a b")).toBe("https://sibhimanyu.github.io/squeak/open/#s=a%20b");
  });
});
