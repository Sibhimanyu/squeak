import { describe, expect, it, vi } from "vitest";

import { HandsGrantsReader, interpretGrants } from "./hands-grants.js";

const granted = {
  status: "result" as const,
  result: { ok: true, accessibility: true, location: "denied", automationTerminal: "notRunning" },
};

describe("interpretGrants", () => {
  it("reads the three grants", () => {
    expect(interpretGrants(granted)).toEqual({
      outdated: false,
      accessibility: true,
      location: "denied",
      automationTerminal: "notRunning",
    });
  });
  it("calls an unknown mode, a not-trusted answer and no answer outdated", () => {
    expect(interpretGrants({ status: "result", result: { ok: false, error: "unknown-mode" } })).toEqual({
      outdated: true,
    });
    expect(interpretGrants({ status: "result", result: { ok: false, error: "not-trusted" } })).toEqual({
      outdated: true,
    });
    expect(interpretGrants({ status: "no-result", detail: "no result" })).toEqual({ outdated: true });
  });
  it("says a missing Hands is outdated and missing", () => {
    expect(interpretGrants({ status: "missing" })).toEqual({ outdated: true, missing: true });
  });
  it("treats an unknown level as not determined", () => {
    const out = interpretGrants({ status: "result", result: { accessibility: false, location: "weird" } });
    expect(out).toMatchObject({ location: "notDetermined", automationTerminal: "notDetermined" });
  });
});

describe("HandsGrantsReader", () => {
  it("runs the grants mode and caches for 2 s", async () => {
    let t = 1000;
    const runner = vi.fn().mockResolvedValue(granted);
    const reader = new HandsGrantsReader("/x/Hands.app", runner, () => t);
    await reader.read();
    t += 1500;
    await reader.read();
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith("/x/Hands.app", "grants", {});
    t += 600;
    await reader.read();
    expect(runner).toHaveBeenCalledTimes(2);
  });
  it("shares one launch between simultaneous readers", async () => {
    const runner = vi.fn().mockResolvedValue(granted);
    const reader = new HandsGrantsReader("/x", runner);
    await Promise.all([reader.read(), reader.read()]);
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it("answers outdated when the runner throws", async () => {
    const reader = new HandsGrantsReader("/x", () => Promise.reject(new Error("boom")));
    expect(await reader.read()).toEqual({ outdated: true });
  });
});
