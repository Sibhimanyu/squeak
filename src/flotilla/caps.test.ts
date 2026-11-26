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

describe("roles and the Member's one switch", () => {
  it("reads canStartTasks only for a Member, and only as true", () => {
    expect(readMember(doc({ canStartTasks: true }))?.canStartTasks).toBe(true);
    expect(readMember(doc({ canStartTasks: "yes" }))?.canStartTasks).toBeUndefined();
    expect(readMember(doc({ role: "viewer", canStartTasks: true }))?.canStartTasks).toBeUndefined();
  });
  it("migration: an old document's caps and presets are ignored (Collaborator becomes a Member with the switch off)", () => {
    const collaborator = readMember(doc({ caps: { start: true, message: false, muted: true } }))!;
    expect(collaborator.role).toBe("member");
    expect(collaborator.canStartTasks).toBeUndefined();
    expect("caps" in collaborator).toBe(false);
    expect(capsOf(collaborator.role, collaborator.canStartTasks === true).message).toBe(true);
    const viewer = readMember(doc({ role: "viewer", caps: { message: true } }))!;
    expect(viewer.role).toBe("viewer");
    expect(capsOf(viewer.role).message).toBe(false);
  });
});
