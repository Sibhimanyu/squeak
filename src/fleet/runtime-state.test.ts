import { describe, expect, it } from "vitest";

import { DEFAULT_LID_ACTIONS } from "./lid-actions.js";
import { awakeRules } from "./power-monitor.js";
import { serializeState, type AwakeView } from "./runtime.js";
import type { FleetMonitor } from "./fleet-monitor.js";

const monitor = {
  snapshot: { generatedAt: "2026-10-23T00:00:00.000Z", sessions: [], active: [], attention: [], codexUsage: null },
} as unknown as FleetMonitor;

const view: AwakeView = {
  state: null,
  lidReady: true,
  lastEnd: { reason: "battery", at: "2026-10-23T00:00:00.000Z", why: "Battery at 8%" },
  lidActions: DEFAULT_LID_ACTIONS,
  lidClosedNow: false,
  sleepProblem: null,
  rules: awakeRules({ lowPowerPercent: 35, endPercent: 8 }),
  hotspot: { configured: true, ssid: "Phone", enabled: true, onHotspot: false, last: null },
};

describe("/state awake fields", () => {
  it("carries the effective safety rules and the hotspot's name and status", () => {
    const state = serializeState(monitor, null, null, view) as Record<string, unknown>;
    expect(state.awakeRules).toEqual({ lowPowerPercent: 35, endPercent: 8, heat: true });
    expect(state.hotspot).toEqual({ configured: true, ssid: "Phone", enabled: true, onHotspot: false, last: null });
    expect(state.awakeLastEnd).toMatchObject({ reason: "battery" });
    expect(JSON.stringify(state)).not.toMatch(/password/i);
  });

  it("leaves them out for a daemon without them", () => {
    const older: AwakeView = { ...view };
    delete older.rules;
    delete older.hotspot;
    const state = serializeState(monitor, null, null, older) as Record<string, unknown>;
    expect(state).not.toHaveProperty("awakeRules");
    expect(state).not.toHaveProperty("hotspot");
  });

  it("normalizes thresholds that would end a session before Low Power Mode could help", () => {
    expect(awakeRules({ lowPowerPercent: 5, endPercent: 10 })).toEqual({
      lowPowerPercent: 11,
      endPercent: 10,
      heat: true,
    });
  });
});
