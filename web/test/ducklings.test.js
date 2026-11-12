import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "../js/channel-crypto.js";
import { status } from "../js/presentation.js";
import { ducklings, ducklingsRunning, readyWithDucklings, tasks } from "../js/view-model.js";

const items = [
  {
    id: "a",
    kind: "agent",
    title: "Find callers",
    model: "Sonnet 5.5",
    status: "running",
    startedAt: "2026-11-12T00:00:00Z",
  },
  { id: "b", kind: "shell", title: "npm test", status: "failed", summary: "exit 1" },
];

describe("ducklings", () => {
  it("is named in the caps", () => expect(CAPABILITIES).toContain("ducklings"));
  it("is absent from an older Mac", () => {
    expect(ducklings({ state: "idle" })).toBeNull();
    expect(readyWithDucklings({ state: "idle" })).toBe(false);
  });
  it("lists helpers and counts the running", () => {
    const s = { state: "idle", ducklings: { running: 1, items } };
    expect(tasks(s).map((t) => t.label)).toEqual(["Find callers", "npm test"]);
    expect(tasks(s)[0].model).toBe("Sonnet 5.5");
    expect(tasks(s)[0].canOpenDetail).toBe(true);
    expect(tasks(s)[1].canOpenDetail).toBe(false);
    expect(ducklingsRunning(s)).toBe(1);
  });
  it("says Ready when idle with helpers, never when working", () => {
    expect(status({ state: "idle", ducklings: { running: 2, items: [] } }).text).toBe("Ready · 2 ducklings running");
    expect(status({ state: "working", ducklings: { running: 2, items: [] } }).text).toBe("working");
  });
});
