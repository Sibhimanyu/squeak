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

describe("a finished duckling leaves the list once reported", () => {
  const T0 = Date.parse("2026-11-12T10:00:00Z");
  const done = { id: "d", kind: "agent", title: "d", status: "done", endedAt: "2026-11-12T10:00:00Z" };
  const reported = { ...done, id: "p", reportedAt: "2026-11-12T10:00:05Z" };
  const failed = { id: "f", kind: "shell", title: "f", status: "failed", endedAt: "2026-11-12T10:00:00Z" };
  const running = { id: "r", kind: "agent", title: "r", status: "running" };
  const session = { ducklings: { running: 1, items: [running, done, reported, failed] } };
  const ids = (ms) => ducklings(session, T0 + ms).items.map((t) => t.id);
  it("keeps an unreported one 20 s, a reported one until its report, a failed one until reported", () => {
    expect(ids(4000)).toEqual(["r", "d", "p", "f"]);
    expect(ids(5000)).toEqual(["r", "d", "f"]);
    expect(ids(20000)).toEqual(["r", "f"]);
  });
});
