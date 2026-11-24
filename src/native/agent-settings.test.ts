import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentSettings } from "./agent-settings.js";

describe("AgentSettings", () => {
  it("defaults connectors off, saves a strict boolean and rejects anything else", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-settings-"));
    const s = new AgentSettings(dir);
    expect(s.get()).toEqual({ claudeAiConnectors: false, deciderModel: "on-device" });
    expect(s.set({ claudeAiConnectors: true })).toEqual({ claudeAiConnectors: true, deciderModel: "on-device" });
    expect(new AgentSettings(dir).get().claudeAiConnectors).toBe(true);
    expect(() => s.set({ claudeAiConnectors: "yes" })).toThrow();
    expect(() => s.set({ other: true })).toThrow();
    fs.writeFileSync(path.join(dir, "agent-settings.json"), "{bad");
    expect(s.get().claudeAiConnectors).toBe(false);
  });

  it("deciderModel defaults to on-device, saves haiku, keeps the other setting and rejects anything else", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-settings-"));
    const s = new AgentSettings(dir);
    expect(s.get().deciderModel).toBe("on-device");
    s.set({ claudeAiConnectors: true });
    expect(s.set({ deciderModel: "haiku" })).toEqual({ claudeAiConnectors: true, deciderModel: "haiku" });
    expect(new AgentSettings(dir).get().deciderModel).toBe("haiku");
    expect(s.set({ deciderModel: "on-device" }).deciderModel).toBe("on-device");
    expect(() => s.set({ deciderModel: "gpt" })).toThrow();
    expect(() => s.set({ deciderModel: true })).toThrow();
    fs.writeFileSync(path.join(dir, "agent-settings.json"), JSON.stringify({ deciderModel: "bogus" }));
    expect(s.get().deciderModel).toBe("on-device");
  });
});
