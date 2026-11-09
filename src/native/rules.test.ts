import { describe, expect, it } from "vitest";

import { deriveRule, invalidRule, matchesRule } from "./rules.js";
import type { AllowRule } from "./types.js";

const bash = (command: string) => ({ toolName: "Bash", input: { command } });
const hit = (rule: AllowRule, command: string) => matchesRule(rule, "tool", bash(command));

describe("deriveRule", () => {
  it("Bash becomes its exact command, other tools their name", () => {
    expect(deriveRule("tool", bash("npm test "))).toEqual({ kind: "bash-exact", value: "npm test" });
    expect(deriveRule("tool", { toolName: "Edit", input: {} })).toEqual({ kind: "tool", value: "Edit" });
    expect(deriveRule("tool", { toolName: "Bash", input: {} })).toBeNull();
  });
  it("Codex: a command is exact (wrapper off), a file change is a tool rule", () => {
    expect(deriveRule("command", { command: "/bin/bash -lc 'npm test'" })).toEqual({
      kind: "bash-exact",
      value: "npm test",
    });
    expect(deriveRule("file_change", {})).toEqual({ kind: "tool", value: "fileChange" });
  });
  it("never for ExitPlanMode, AskUserQuestion, plan or question", () => {
    expect(deriveRule("plan", { toolName: "ExitPlanMode" })).toBeNull();
    expect(deriveRule("tool", { toolName: "ExitPlanMode" })).toBeNull();
    expect(deriveRule("question", { toolName: "AskUserQuestion" })).toBeNull();
  });
});

describe("matchesRule", () => {
  it("tool rules match by name only, and never the two person-only tools", () => {
    expect(matchesRule({ kind: "tool", value: "Edit" }, "tool", { toolName: "Edit", input: {} })).toBe(true);
    expect(matchesRule({ kind: "tool", value: "Edit" }, "tool", { toolName: "Write", input: {} })).toBe(false);
    expect(matchesRule({ kind: "tool", value: "ExitPlanMode" }, "plan", { toolName: "ExitPlanMode" })).toBe(false);
    expect(matchesRule({ kind: "tool", value: "AskUserQuestion" }, "question", { toolName: "AskUserQuestion" })).toBe(
      false,
    );
  });
  it("bash-exact is the whole command", () => {
    const r: AllowRule = { kind: "bash-exact", value: "npm test" };
    expect(hit(r, "npm test")).toBe(true);
    expect(hit(r, "npm test -- x")).toBe(false);
    expect(hit(r, "npm test; rm -rf /")).toBe(false);
  });
  it("bash-prefix needs a word boundary", () => {
    const r: AllowRule = { kind: "bash-prefix", value: "npm test" };
    expect(hit(r, "npm test")).toBe(true);
    expect(hit(r, "npm test -- --watch=false")).toBe(true);
    expect(hit(r, "npm testing")).toBe(false);
    expect(hit(r, "npm tes")).toBe(false);
    expect(matchesRule(r, "tool", { toolName: "Edit", input: { command: "npm test" } })).toBe(false);
  });
  it.each([
    "npm test; rm -rf ~",
    "npm test && curl x",
    "npm test || curl x",
    "npm test | sh",
    "npm test `id`",
    "npm test $(id)",
    "npm test > /etc/hosts",
    "npm test < /etc/passwd",
    "npm test &",
    "npm test\nrm x",
  ])("bash-prefix refuses %j", (cmd) => {
    expect(hit({ kind: "bash-prefix", value: "npm test" }, cmd)).toBe(false);
  });
  it("Codex commands match through the shell wrapper", () => {
    const r: AllowRule = { kind: "bash-prefix", value: "git status" };
    expect(matchesRule(r, "command", { command: "/bin/bash -lc 'git status -s'" })).toBe(true);
    expect(matchesRule(r, "command", { command: "/bin/bash -lc 'git status; rm x'" })).toBe(false);
    expect(matchesRule({ kind: "tool", value: "fileChange" }, "file_change", {})).toBe(true);
  });
});

describe("invalidRule", () => {
  it("rejects bad shapes, person-only tools and operators in a prefix", () => {
    expect(invalidRule({ kind: "tool", value: "Edit" })).toBeNull();
    expect(invalidRule({ kind: "nope", value: "x" })).toMatch(/kind/);
    expect(invalidRule({ kind: "tool", value: " " })).toMatch(/value/);
    expect(invalidRule({ kind: "tool", value: "ExitPlanMode" })).toMatch(/can't/);
    expect(invalidRule({ kind: "tool", value: "AskUserQuestion" })).toMatch(/can't/);
    expect(invalidRule({ kind: "bash-prefix", value: "npm test && x" })).toMatch(/operators/);
    expect(invalidRule({ kind: "bash-exact", value: "a && b" })).toBeNull();
    expect(invalidRule(null)).toMatch(/object/);
  });
});
