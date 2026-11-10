// The dashboard's grouping, filters and stat numbers (js/dashboard-logic.js).

import { describe, expect, it } from "vitest";

import {
  agentChoices,
  boardColumns,
  boardStats,
  columnOf,
  filterBoard,
  IDLE_LIMIT,
  parseGit,
  projectChips,
  toggleProject,
  weekUsage,
} from "../js/dashboard-logic.js";
import { homeViewPref } from "../js/prefs.js";

const NOW = Date.parse("2026-11-10T15:00:00");
const ago = (m) => new Date(NOW - m * 60_000).toISOString();
const s = (key, state, o = {}) => ({
  key,
  label: `${o.repo ?? "ledger"} · b-${key}`,
  title: key,
  agent: o.agent ?? "claude",
  state,
  lastActivityAt: ago(o.ago ?? 5),
  ...o,
});

describe("columns", () => {
  it("places each state", () => {
    expect(columnOf(s("a", "awaiting_approval"))).toBe("needs");
    expect(columnOf(s("a", "awaiting_input"))).toBe("needs");
    expect(columnOf(s("a", "finished", { asks: "Which one?" }))).toBe("needs");
    expect(columnOf(s("a", "working"))).toBe("progress");
    expect(columnOf(s("a", "finished"))).toBe("done");
    expect(columnOf(s("a", "error"))).toBe("done");
    expect(columnOf(s("a", "idle"))).toBe("idle");
  });

  it("is newest first inside every column, not ranked by urgency", () => {
    const cols = boardColumns({
      active: [s("old", "awaiting_approval", { ago: 30 }), s("new", "awaiting_input", { ago: 1 }), s("w", "working")],
      recent: [s("r1", "finished", { ago: 900 }), s("r2", "idle", { ago: 700 })],
    });
    expect(cols.needs.map((x) => x.key)).toEqual(["new", "old"]);
    expect(cols.progress.map((x) => x.key)).toEqual(["w"]);
    expect(cols.done).toEqual([]);
    expect(cols.idle.map((x) => x.key)).toEqual(["r2", "r1"]);
  });

  it("caps the idle column", () => {
    const recent = Array.from({ length: IDLE_LIMIT + 5 }, (_, i) => s(`r${i}`, "finished", { ago: 600 + i }));
    expect(boardColumns({ active: [], recent }).idle).toHaveLength(IDLE_LIMIT);
  });
});

describe("filters", () => {
  const cols = boardColumns({
    active: [s("a", "working", { repo: "ledger" }), s("b", "working", { repo: "lantern", agent: "codex" })],
  });
  it("filters by project and agent", () => {
    const some = filterBoard(cols, { projects: new Set(["lantern"]), agent: "all" });
    expect(some.progress.map((x) => x.key)).toEqual(["b"]);
    expect(filterBoard(cols, { projects: new Set(), agent: "claude" }).progress.map((x) => x.key)).toEqual(["a"]);
    expect(filterBoard(cols, { projects: new Set(), agent: "all" }).progress).toHaveLength(2);
  });
  it("lists chips and toggles", () => {
    const all = [
      s("a", "working", { repo: "ledger" }),
      s("b", "idle", { repo: "ledger" }),
      s("c", "idle", { repo: "x" }),
    ];
    expect(projectChips(all).find((p) => p.name === "ledger").count).toBe(2);
    expect(agentChoices(all)).toEqual(["claude"]);
    const on = toggleProject({ projects: new Set(), agent: "all" }, "x");
    expect([...on.projects]).toEqual(["x"]);
    expect(toggleProject(on, "x").projects.size).toBe(0);
  });
});

describe("stats", () => {
  it("counts needs, working, done today and reads usage", () => {
    const active = [
      s("a", "awaiting_approval"),
      s("b", "working"),
      s("c", "finished", { ago: 10 }),
      s("d", "finished", { ago: 60 * 40 }),
    ];
    const view = { usage: { claude: { sevenDay: { usedPercent: 22, resetsAt: ago(-3000) } } } };
    const stats = boardStats({ active, recent: [], view, now: NOW });
    expect(stats.needs).toBe(1);
    expect(stats.working).toBe(1);
    expect(stats.doneToday).toBe(1);
    expect(stats.usage).toEqual([{ agent: "Claude", label: "22% used", fraction: 0.22 }]);
  });
  it("shows a reset window as empty and says nothing without a reading", () => {
    expect(weekUsage({ usage: { codex: { weekly: { usedPercent: 80, resetsAt: ago(1) } } } }, NOW)[0].fraction).toBe(0);
    expect(weekUsage({}, NOW)).toEqual([]);
  });
});

describe("what changed", () => {
  it("reads the Mac's git line", () => {
    expect(parseGit("+86 −12 · 4 files")).toEqual({ add: 86, del: 12, files: 4 });
    expect(parseGit("1 file")).toEqual({ add: 0, del: 0, files: 1 });
    expect(parseGit(null)).toBeNull();
    expect(parseGit("clean")).toBeNull();
  });
  it("remembers the home view", () => {
    expect(homeViewPref({})).toBe("board");
    expect(homeViewPref({ homeView: "projects" })).toBe("projects");
  });
});
