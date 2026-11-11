import { describe, expect, it } from "vitest";

import { readThread } from "./types.js";

const base = {
  id: "t1",
  title: "Fix login",
  starter: "m1",
  starterName: "Sibhi",
  nest: "mac",
  agent: "claude",
  model: "m",
  state: "idle",
  private: false,
  mode: "shared",
  updatedAt: 1,
};

describe("a thread document's workspace, branch and participants", () => {
  it("decodes a thread written before they existed", () => {
    const t = readThread(base)!;
    expect(t).not.toBeNull();
    expect(t.workspace).toBeUndefined();
    expect(t.branch).toBeUndefined();
    expect(t.participants).toBeUndefined();
  });

  it("reads them when present, newest first, dropping malformed entries", () => {
    const t = readThread({
      ...base,
      workspace: "ushuaia",
      branch: "feat/x",
      participants: [
        { memberId: "m1", name: "Sibhi", lastAt: "2026-11-01T10:00:00.000Z" },
        { memberId: "m2", name: "Aarav", lastAt: "2026-11-02T10:00:00.000Z" },
        { memberId: 5, name: "bad", lastAt: "x" },
      ],
    })!;
    expect(t).toMatchObject({ workspace: "ushuaia", branch: "feat/x" });
    expect(t.participants!.map((p) => p.name)).toEqual(["Aarav", "Sibhi"]);
  });

  it("ignores wrongly typed values rather than refusing the thread", () => {
    const t = readThread({ ...base, workspace: 3, branch: {}, participants: "no" })!;
    expect(t.workspace).toBeUndefined();
    expect(t.participants).toBeUndefined();
  });
});
