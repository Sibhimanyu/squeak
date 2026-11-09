import { describe, expect, it } from "vitest";

import { lastOccurrence, nextOccurrence, Planner, readSchedule } from "./planner.js";
import { NativeStore } from "./store.js";
import type { SessionRow } from "./types.js";

const at = (s: string) => new Date(s);

function setup(start: string) {
  const store = new NativeStore(":memory:");
  const project = store.createProject({ name: "p", rootPath: "/p", defaultBranch: "main" });
  let now = at(start);
  const started: { text: string; newWorkspace: boolean; permissionMode: string }[] = [];
  const planner = new Planner(
    store,
    async (spec) => {
      started.push({ text: spec.text, newWorkspace: spec.newWorkspace, permissionMode: spec.permissionMode });
      return store.createSession({
        cwd: "/p",
        agent: spec.agent,
        model: spec.model,
        permissionMode: spec.permissionMode,
      });
    },
    { now: () => now },
  );
  return { store, project, planner, started, setNow: (s: string) => (now = at(s)) };
}

describe("schedules", () => {
  it("finds the latest and next occurrence in local time", () => {
    const now = at("2026-11-11T10:30:00"); // a Wednesday
    const daily = readSchedule({ kind: "daily", at: "09:00" });
    expect(lastOccurrence(daily, now, now)).toEqual(at("2026-11-11T09:00:00"));
    expect(nextOccurrence(daily, now, now)).toEqual(at("2026-11-12T09:00:00"));
    const weekly = readSchedule({ kind: "weekly", day: 1, at: "08:00" }); // Mondays
    expect(lastOccurrence(weekly, now, now)).toEqual(at("2026-11-09T08:00:00"));
    expect(nextOccurrence(weekly, now, now)).toEqual(at("2026-11-16T08:00:00"));
    const hourly = readSchedule({ kind: "hourly", every: 6 });
    expect(lastOccurrence(hourly, now, at("2026-11-11T05:00:00"))).toBeNull();
    expect(lastOccurrence(hourly, now, at("2026-11-11T04:00:00"))).toEqual(at("2026-11-11T10:00:00"));
    for (const bad of [
      { kind: "daily", at: "25:00" },
      { kind: "hourly", every: 0 },
      { kind: "weekly", day: 7, at: "08:00" },
      null,
    ]) {
      expect(() => readSchedule(bad)).toThrow();
    }
  });
});

describe("routines", () => {
  it("run once when due, never again for the same occurrence, and once after a long sleep", async () => {
    const { project, planner, started, setNow } = setup("2026-11-11T08:00:00");
    const r = planner.addRoutine(project.id, {
      prompt: "Triage new issues",
      schedule: { kind: "daily", at: "09:00" },
      agent: "claude",
      model: "m",
    });
    expect(r.nextRunAt).toBe(at("2026-11-11T09:00:00").toISOString());
    expect(planner.due()).toEqual([]);
    setNow("2026-11-11T09:00:30");
    await planner.tick();
    await planner.tick();
    expect(started).toHaveLength(1);
    expect(started[0]!.text).toContain("Triage new issues");
    expect(started[0]!.newWorkspace).toBe(true);
    // Asleep for three days: one run, not three.
    setNow("2026-11-14T12:00:00");
    await planner.tick();
    expect(started).toHaveLength(2);
    expect(planner.routines(project.id)[0]!.lastSessionId).not.toBeNull();
  });

  it("refuses modes that skip approvals, and a disabled routine never runs", async () => {
    const { project, planner, started, setNow } = setup("2026-11-11T08:00:00");
    const base = { prompt: "x", schedule: { kind: "daily", at: "09:00" }, agent: "codex", model: "m" };
    expect(() => planner.addRoutine(project.id, { ...base, permissionMode: "bypassPermissions" })).toThrow(
      /never one that skips/,
    );
    const r = planner.addRoutine(project.id, { ...base, enabled: false });
    setNow("2026-11-11T10:00:00");
    await planner.tick();
    expect(started).toHaveLength(0);
    expect(planner.updateRoutine(r.id, { enabled: true }).enabled).toBe(true);
    await planner.tick();
    expect(started).toHaveLength(1);
    planner.removeRoutine(r.id);
    expect(planner.routines(project.id)).toEqual([]);
  });
});

describe("backlog", () => {
  it("keeps ideas newest first and starts one as a chat, which takes it off the list", async () => {
    const { project, planner, started } = setup("2026-11-11T08:00:00");
    const a = planner.addBacklog(project.id, { prompt: "Add dark mode\nfor settings" });
    expect(a.title).toBe("Add dark mode");
    planner.addBacklog(project.id, { title: "Later", prompt: "Refactor" });
    expect(planner.backlog(project.id)).toHaveLength(2);
    const s: SessionRow = await planner.startBacklog(a.id, { agent: "claude", model: "m" });
    expect(s.id).toBeTruthy();
    expect(started[0]).toMatchObject({ text: "Add dark mode\nfor settings", newWorkspace: true });
    expect(planner.backlog(project.id).map((x) => x.title)).toEqual(["Later"]);
    await expect(planner.startBacklog(a.id, { agent: "claude", model: "m" })).rejects.toThrow(/no such/);
  });
});
