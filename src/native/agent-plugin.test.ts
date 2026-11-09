import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { squeakPluginPath } from "./agent-plugin.js";

describe("squeakPluginPath", () => {
  it("finds the repo's agent-plugin two folders up, with a skill that has a name and description", () => {
    const dir = squeakPluginPath();
    expect(dir).not.toBeNull();
    const skill = fs.readFileSync(path.join(dir!, "skills", "squeak", "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: squeak\ndescription: .+\n---/);
    expect(JSON.parse(fs.readFileSync(path.join(dir!, ".claude-plugin", "plugin.json"), "utf8")).name).toBe("squeak");
  });

  it("is null when the plugin is missing", () => {
    expect(squeakPluginPath("/nonexistent/a/b")).toBeNull();
  });
});
