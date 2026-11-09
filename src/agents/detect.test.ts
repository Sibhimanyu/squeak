import { describe, expect, it } from "vitest";
import { compareVersions, detectProvider, parseVersion, type CommandRunner } from "./detect.js";
import { diagnoseProviders } from "./diagnostics.js";
import { PROVIDER_SPECS, specFor } from "./providers.js";

const claude = specFor("claudeCode")!;
const ok =
  (stdout: string): CommandRunner =>
  async () => ({ exitCode: 0, stdout, stderr: "" });

describe("versions", () => {
  it("parses and compares", () => {
    expect(parseVersion("2.1.4 (Claude Code)")).toBe("2.1.4");
    expect(parseVersion("codex-cli 0.149.0")).toBe("0.149.0");
    expect(parseVersion("nothing")).toBeUndefined();
    expect(compareVersions("2.0.0", "10.0.0")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });
});

describe("detectProvider", () => {
  it("is available at or above the floor, and runs only the version flag", async () => {
    const calls: [string, string[]][] = [];
    const r = await detectProvider(
      claude,
      async (f, a) => {
        calls.push([f, a]);
        return { exitCode: 0, stdout: "2.3.1 (Claude Code)", stderr: "" };
      },
      () => "/bin/claude",
    );
    expect(r).toEqual({ status: "available", executable: "/bin/claude", version: "2.3.1" });
    expect(calls).toEqual([["/bin/claude", ["--version"]]]);
  });

  it("reports missing when not located or ENOENT", async () => {
    expect((await detectProvider(claude, ok("2.0.0"), () => undefined)).status).toBe("missing");
    const enoent: CommandRunner = async () => {
      throw Object.assign(new Error("spawn"), { code: "ENOENT" });
    };
    expect((await detectProvider(claude, enoent)).status).toBe("missing");
  });

  it("reports unsupported-version below the floor", async () => {
    const r = await detectProvider(claude, ok("1.0.9"));
    expect(r.status).toBe("unsupported-version");
    expect(r.problem).toBe("Claude Code 1.0.9 is older than 2.0.0, the oldest Squeak supports.");
  });

  it("reports error with fixed sentences and never leaks output", async () => {
    const bad = await detectProvider(claude, async () => ({ exitCode: 1, stdout: "", stderr: "secret-token-xyz" }));
    expect(bad).toMatchObject({ status: "error", problem: "Claude Code did not answer its version check." });
    expect(JSON.stringify(bad)).not.toContain("secret");
    expect((await detectProvider(claude, ok("hello"))).problem).toMatch(/cannot read/);
    const boom: CommandRunner = async () => {
      throw new Error("EACCES secret");
    };
    const r = await detectProvider(claude, boom);
    expect(r.status).toBe("error");
    expect(r.problem).not.toContain("secret");
  });

  it("does not probe a provider with no command", async () => {
    const acp = specFor("acp")!;
    let ran = false;
    const r = await detectProvider(acp, async () => {
      ran = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    expect(ran).toBe(false);
    expect(r.status).toBe("error");
  });
});

describe("diagnoseProviders", () => {
  it("returns one truthful row per provider", async () => {
    const run: CommandRunner = async (file) => ({
      exitCode: 0,
      stdout: file.endsWith("claude") ? "2.0.5" : file.endsWith("opencode") ? "0.3.1" : "9.9.9",
      stderr: "",
    });
    const rows = await diagnoseProviders({ run, locate: (c) => (c === "gemini" ? undefined : `/bin/${c}`) });
    expect(rows.map((r) => r.provider)).toEqual(PROVIDER_SPECS.map((s) => s.provider));
    const by = Object.fromEntries(rows.map((r) => [r.provider, r]));
    expect(by.claudeCode).toMatchObject({ availability: "available", version: "2.0.5", implementation: "implemented" });
    expect(by.claudeCode!.problem).toBeUndefined();
    expect(by.codex).toMatchObject({ availability: "available", version: "9.9.9" });
    // installed but not implemented: reported as installed AND unsupported
    expect(by.openCode).toMatchObject({
      availability: "available",
      version: "0.3.1",
      problem: "OpenCode is not supported yet.",
    });
    expect(by.openCode!.capabilities.launch).toBe(false);
    expect(by.gemini).toMatchObject({ availability: "missing", problem: "Gemini CLI is not installed." });
    expect(by.acp).toMatchObject({ availability: "not-applicable", implementation: "not-implemented" });
    expect(by.shell).toMatchObject({ availability: "not-applicable", implementation: "implemented" });
    expect(by.shell!.problem).toBeUndefined();
  });
});
