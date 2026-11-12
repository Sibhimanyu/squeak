import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AddonUninstallStep } from "../addons.js";
import { realUninstallSystem, runUninstall, type UninstallEvent, type UninstallSystem } from "./uninstall.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-uninstall-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function system(steps: AddonUninstallStep[]): UninstallSystem {
  const sys = realUninstallSystem({}, path.join(tmp, "home"), path.join(tmp, "home", "support"));
  return {
    ...sys,
    loadedLaunchLabels: async () => [],
    handsRunning: async () => false,
    adminPaths: [],
    keychainExists: async () => false,
    addonSteps: () => steps,
  };
}

const step = (over: Partial<AddonUninstallStep> = {}): AddonUninstallStep => ({
  id: "fake-host",
  title: "Hand the host back",
  detail: "detail",
  plan: () => ["a setting"],
  run: async () => ({ status: "done", note: "back", acted: ["a setting"], restart: "Conductor" }),
  ...over,
});

describe("add-on uninstall steps", () => {
  it("runs an add-on's step first, shows its plan, and carries its restart request", async () => {
    const events: UninstallEvent[] = [];
    const result = await runUninstall(system([step()]), { dryRun: false, skipAdmin: true, orphan: true }, (e) =>
      events.push(e),
    );
    const plan = events.find((event) => event.event === "plan");
    expect(plan && plan.event === "plan" && plan.steps[0]).toMatchObject({ id: "fake-host", items: ["a setting"] });
    expect(result.statuses["fake-host"]).toBe("done");
    expect(result.acted["fake-host"]).toEqual(["a setting"]);
    expect(result.restartConductor).toBe(true);
  });

  it("skips a step with nothing to put back, and a failing one stops the run before later steps", async () => {
    const quiet = await runUninstall(
      system([step({ plan: () => [] })]),
      { dryRun: false, skipAdmin: true, orphan: true },
      () => undefined,
    );
    expect(quiet.statuses["fake-host"]).toBe("skipped");
    const events: UninstallEvent[] = [];
    const failed = await runUninstall(
      system([step({ run: async () => ({ status: "failed", note: "no" }) })]),
      { dryRun: false, skipAdmin: true, orphan: true },
      (e) => events.push(e),
    );
    expect(failed.ok).toBe(false);
    expect(events.filter((event) => event.event === "step").map((event) => (event as { id: string }).id)).toEqual([
      "fake-host",
      "fake-host",
    ]);
  });
});
