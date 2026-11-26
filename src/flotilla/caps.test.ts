import { describe, expect, it } from "vitest";

import { capsOf } from "./permissions.js";
import { readMember } from "./types.js";

const doc = (over: Record<string, unknown>) => ({
  id: "m1",
  name: "Aarav",
  publicKey: "k",
  role: "member",
  nest: null,
  addedAt: 1,
  ...over,
});

describe("roles", () => {
  it("regression: a leftover canStartTasks in an old document is ignored; there is no per-Member switch", () => {
    for (const v of [true, false, "yes"]) {
      const member = readMember(doc({ canStartTasks: v }))!;
      expect(member.role).toBe("member");
      expect("canStartTasks" in member).toBe(false);
    }
  });
  it("migration: an old document's caps and presets are ignored (Collaborator becomes a Member)", () => {
    const collaborator = readMember(doc({ caps: { start: true, message: false, muted: true } }))!;
    expect(collaborator.role).toBe("member");
    expect("caps" in collaborator).toBe(false);
    expect(capsOf(collaborator.role).message).toBe(true);
    const viewer = readMember(doc({ role: "viewer", caps: { message: true } }))!;
    expect(viewer.role).toBe("viewer");
    expect(capsOf(viewer.role).message).toBe(false);
  });
});
