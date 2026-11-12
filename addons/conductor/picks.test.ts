import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseLinkRequest, parseWorkspaceRequest, WorkspacePicks } from "./picks.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-picks-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("WorkspacePicks", () => {
  it("starts empty and ignores the old conductor-link.json", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "conductor-link.json"), JSON.stringify({ linked: true, workspaces: ["w1"] }));
    const picks = WorkspacePicks.in(dir);
    expect(picks.workspaces).toEqual([]);
    expect(picks.isPicked("w1")).toBe(false);
    // the old file is left alone
    expect(fs.existsSync(path.join(dir, "conductor-link.json"))).toBe(true);
  });

  it("persists picks, tells listeners only when the set changed", () => {
    const dir = tmp();
    const picks = WorkspacePicks.in(dir);
    const listener = vi.fn();
    picks.onChange(listener);
    picks.setPicked("w1", true);
    picks.setPicked("w1", true);
    picks.setPicked("w2", true);
    picks.setPicked("w1", false);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(WorkspacePicks.in(dir).workspaces).toEqual(["w2"]);
    expect(picks.isPicked(null)).toBe(false);
  });
});

describe("request parsing", () => {
  it("reads exactly { linked } and { id, picked }", () => {
    expect(parseLinkRequest({ linked: true })).toEqual({ ok: true, linked: true });
    expect(parseLinkRequest({ linked: true, extra: 1 }).ok).toBe(false);
    expect(parseLinkRequest(null).ok).toBe(false);
    expect(parseWorkspaceRequest({ id: "w", picked: false })).toEqual({ ok: true, id: "w", picked: false });
    expect(parseWorkspaceRequest({ id: "w" }).ok).toBe(false);
    expect(parseWorkspaceRequest({ id: "", picked: true }).ok).toBe(false);
  });
});
