import { describe, expect, it } from "vitest";
import { plainFileMentions } from "./file-mention.js";

describe("plainFileMentions", () => {
  it("replaces Conductor's token with the decoded path", () => {
    expect(plainFileMentions("look @⟦image.png⟧(.context%2Fattachments%2Fab%2Fimage.png) now")).toBe(
      "look .context/attachments/ab/image.png now",
    );
  });
  it("leaves other text and bad escapes alone", () => {
    expect(plainFileMentions("no token")).toBe("no token");
    expect(plainFileMentions("@⟦a⟧(%E0%A4%A)")).toBe("%E0%A4%A");
  });
});
