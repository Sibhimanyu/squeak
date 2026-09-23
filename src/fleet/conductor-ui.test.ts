import { describe, expect, it } from "vitest";

import { mayHaveSent, SqueakHandsSender } from "./conductor-ui.js";

describe("mayHaveSent", () => {
  it("treats only an unconfirmed or interrupted send as possibly delivered", () => {
    expect(mayHaveSent({ ok: false, error: "unconfirmed" })).toBe(true);
    expect(mayHaveSent({ ok: false, error: "helper-failed" })).toBe(true);
    // Everything else fails before anything is typed, so a fallback is safe.
    for (const error of ["locked", "chat-not-open", "draft-present", "paste-failed", "not-trusted"] as const) {
      expect(mayHaveSent({ ok: false, error })).toBe(false);
    }
    expect(mayHaveSent({ ok: true })).toBe(false);
  });
});

describe("SqueakHandsSender", () => {
  it("reports a missing helper without launching anything", async () => {
    const sender = new SqueakHandsSender("/nonexistent/Squeak Hands.app");
    const result = await sender.send({ workspaceId: "w", sessionId: "s", sessionTitle: null, text: "A" });
    expect(result).toEqual({ ok: false, error: "helper-missing" });
  });
});
