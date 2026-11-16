import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentSettings } from "./agent-settings.js";

describe("AgentSettings", () => {
  it("defaults connectors off, saves a strict boolean and rejects anything else", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-settings-"));
    const s = new AgentSettings(dir);
    expect(s.get()).toEqual({ claudeAiConnectors: false });
    expect(s.set({ claudeAiConnectors: true })).toEqual({ claudeAiConnectors: true });
    expect(new AgentSettings(dir).get().claudeAiConnectors).toBe(true);
    expect(() => s.set({ claudeAiConnectors: "yes" })).toThrow();
    expect(() => s.set({ other: true })).toThrow();
    fs.writeFileSync(path.join(dir, "agent-settings.json"), "{bad");
    expect(s.get().claudeAiConnectors).toBe(false);
  });
});
