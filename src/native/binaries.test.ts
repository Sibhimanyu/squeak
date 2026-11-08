import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentNotFoundError, requireAgentBinary, resolveAgentBinary } from "./binaries.js";

const made: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-bin-"));
  made.push(d);
  return d;
}
function exe(file: string, mode = 0o755): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "#!/bin/sh\n", { mode });
  return file;
}
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("resolveAgentBinary", () => {
  it("prefers the env override, tilde-expanded", () => {
    const home = tmp();
    const mine = exe(path.join(home, "tools/my-claude"));
    exe(path.join(home, ".local/bin/claude"));
    expect(
      resolveAgentBinary("claude", {
        home,
        systemDirs: [],
        env: { CLAUDE_BIN: "~/tools/my-claude", PATH: "" },
        bundledDirs: [],
      }),
    ).toBe(mine);
  });

  it("falls through a broken override to PATH", () => {
    const home = tmp();
    const onPath = exe(path.join(tmp(), "codex"));
    const env = { CODEX_BIN: "~/missing", PATH: path.dirname(onPath) };
    expect(resolveAgentBinary("codex", { home, env, systemDirs: [] })).toBe(onPath);
  });

  it("finds the usual places with an empty PATH, in order", () => {
    const home = tmp();
    const conductor = exe(path.join(home, "Library/Application Support/com.conductor.app/bin/codex"));
    expect(resolveAgentBinary("codex", { home, systemDirs: [], env: { PATH: "" } })).toBe(conductor);
    const local = exe(path.join(home, ".local/bin/codex"));
    expect(resolveAgentBinary("codex", { home, systemDirs: [], env: {} })).toBe(local);
  });

  it("skips files that are not executable, and directories", () => {
    const home = tmp();
    const dir = path.join(home, "bin");
    exe(path.join(dir, "claude"), 0o644);
    fs.mkdirSync(path.join(home, ".local/bin/claude"), { recursive: true });
    expect(resolveAgentBinary("claude", { home, systemDirs: [], env: { PATH: dir }, bundledDirs: [] })).toBeUndefined();
  });

  it("uses the SDK's bundled claude last, and never for codex", () => {
    const home = tmp();
    const bundled = path.join(tmp(), "sdk");
    const sdkClaude = exe(path.join(bundled, "claude"));
    exe(path.join(bundled, "codex"));
    expect(resolveAgentBinary("claude", { home, systemDirs: [], env: { PATH: "" }, bundledDirs: [bundled] })).toBe(
      sdkClaude,
    );
    const onPath = exe(path.join(tmp(), "claude"));
    expect(
      resolveAgentBinary("claude", {
        home,
        systemDirs: [],
        env: { PATH: path.dirname(onPath) },
        bundledDirs: [bundled],
      }),
    ).toBe(onPath);
    expect(
      resolveAgentBinary("codex", { home, systemDirs: [], env: { PATH: "" }, bundledDirs: [bundled] }),
    ).toBeUndefined();
  });
});

describe("requireAgentBinary", () => {
  it("says it plainly when nothing is found", () => {
    const opts = { home: tmp(), systemDirs: [], env: { PATH: "" }, bundledDirs: [] };
    expect(() => requireAgentBinary("claude", opts)).toThrow(
      "Squeak can't find Claude Code. Install it, or set CLAUDE_BIN.",
    );
    expect(() => requireAgentBinary("codex", opts)).toThrow(AgentNotFoundError);
    expect(() => requireAgentBinary("codex", opts)).toThrow("Squeak can't find Codex. Install it, or set CODEX_BIN.");
  });
});
