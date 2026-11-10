// The open chat's inspector decisions (js/chat-inspector-logic.js): which sections show, the context meter, the change bars.

import { describe, expect, it } from "vitest";

import {
  changeBars,
  contextMeter,
  inspectorSections,
  pondOf,
  splitPath,
  workspaceFacts,
} from "../js/chat-inspector-logic.js";

const ids = (sections) => sections.map((s) => s.id);
const task = (status) => ({ id: status, kind: "agent", label: "x", status });

describe("inspector sections", () => {
  it("always has Status and Workspace, and nothing else for a bare chat", () => {
    expect(ids(inspectorSections({ session: { state: "idle" } }))).toEqual(["status", "workspace"]);
  });

  it("shows what it's doing only while working with steps", () => {
    const steps = [{ kind: "tool", text: "Read a" }];
    expect(ids(inspectorSections({ session: { state: "working" }, steps }))).toContain("doing");
    expect(ids(inspectorSections({ session: { state: "finished" }, steps }))).not.toContain("doing");
    expect(ids(inspectorSections({ session: { state: "working" }, steps: [] }))).not.toContain("doing");
  });

  it("shows Changes for a git line or a listed file, with the file count", () => {
    const withGit = inspectorSections({ session: { state: "finished", git: "+1 −0 · 1 file" } });
    expect(withGit.find((s) => s.id === "changes").count).toBeNull();
    const listed = inspectorSections({ session: { state: "finished" }, files: [{ path: "a" }, { path: "b" }] });
    expect(listed.find((s) => s.id === "changes").count).toBe(2);
  });

  it("orders sections as drawn and counts subagents; a long ended list starts folded", () => {
    const session = { state: "working", git: "+1 −0", pond: { members: [{ name: "Asha", online: true }] } };
    const out = inspectorSections({ session, steps: [{ kind: "tool", text: "t" }], tasks: [task("running")] });
    expect(ids(out)).toEqual(["status", "doing", "changes", "background", "pond", "workspace"]);
    const many = inspectorSections({ session: {}, tasks: Array.from({ length: 6 }, () => task("done")) });
    expect(many.find((s) => s.id === "background").open).toBe(false);
    const running = inspectorSections({
      session: {},
      tasks: [...Array.from({ length: 5 }, () => task("done")), task("running")],
    });
    expect(running.find((s) => s.id === "background").open).toBe(true);
  });

  it("lets a person's choice override the default", () => {
    const out = inspectorSections({ session: {}, chosen: new Map([["status", false]]) });
    expect(out[0].open).toBe(false);
    expect(out[1].open).toBe(true);
  });
});

describe("context meter", () => {
  it("clamps, rounds and picks a tone", () => {
    expect(contextMeter(28)).toEqual({ percent: 28, tone: "ok" });
    expect(contextMeter(70.4)).toEqual({ percent: 70, tone: "warn" });
    expect(contextMeter(95)).toEqual({ percent: 95, tone: "high" });
    expect(contextMeter(140).percent).toBe(100);
    expect(contextMeter(-3).percent).toBe(0);
  });
  it("is null without a number", () => {
    expect(contextMeter(null)).toBeNull();
    expect(contextMeter("40")).toBeNull();
    expect(contextMeter(Number.NaN)).toBeNull();
  });
});

describe("change bars", () => {
  const f = (insertions, deletions, binary = false) => ({ path: "p", insertions, deletions, binary });
  it("fills the track for the biggest file and scales the rest", () => {
    const [a, b] = changeBars([f(80, 20), f(40, 10)]);
    expect(a.add + a.del).toBe(100);
    expect(a.add).toBe(80);
    expect(b.add + b.del).toBe(50);
  });
  it("keeps a sliver for a tiny change and none for binary or empty", () => {
    const [big, tiny, bin, empty] = changeBars([f(1000, 0), f(1, 0), f(5, 5, true), f(0, 0)]);
    expect(big.add).toBe(100);
    expect(tiny.add).toBeGreaterThan(0);
    expect(bin).toEqual({ add: 0, del: 0 });
    expect(empty).toEqual({ add: 0, del: 0 });
  });
  it("handles an empty list", () => {
    expect(changeBars([])).toEqual([]);
  });
});

describe("path, pond and workspace", () => {
  it("splits a path at its last slash", () => {
    expect(splitPath("src/a/b.ts")).toEqual({ dir: "src/a/", name: "b.ts" });
    expect(splitPath("package.json")).toEqual({ dir: "", name: "package.json" });
  });
  it("reads a pond thread, never an empty one", () => {
    expect(pondOf({ pond: { name: "Crew", members: [{ name: "A", online: true }, { name: "" }] } })).toEqual({
      name: "Crew",
      members: [{ name: "A", online: true }],
    });
    expect(pondOf({ pond: { members: [] } })).toBeNull();
    expect(pondOf({})).toBeNull();
  });
  it("copies the path when there is one, else the label", () => {
    expect(workspaceFacts({ label: "ledger · csv", workspacePath: "/w/ledger" })).toMatchObject({
      repo: "ledger",
      branch: "csv",
      copy: "/w/ledger",
    });
    expect(workspaceFacts({ label: "ledger · csv" }).copy).toBe("ledger · csv");
    expect(workspaceFacts({}).copy).toBeNull();
  });
});
