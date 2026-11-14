import { afterEach, describe, expect, it, vi } from "vitest";

import { logger } from "../utils/logger.js";
import { spawnClaudeProcess, STDERR_TAIL_BYTES } from "./claude-runner.js";

function run(args: string[], command = process.execPath): Promise<void> {
  const child = spawnClaudeProcess({ command, args, env: process.env });
  return new Promise((resolve) => {
    child.once("close", () => setTimeout(resolve, 5));
    child.once("error", () => setTimeout(resolve, 5));
  });
}

describe("claude process stderr", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs stderr when the CLI exits non-zero", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await run(["-e", "console.error('login required'); process.exit(3)"]);
    const call = warn.mock.calls.find(([message]) => message === "claude exited with an error");
    expect(call?.[1]).toMatchObject({ code: 3 });
    expect((call?.[1] as { stderr: string }).stderr).toContain("login required");
  });

  it("keeps only the last 64 KB of a long stderr", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await run(["-e", "process.exitCode = 1; process.stderr.write('x'.repeat(200000) + 'END')"]);
    const call = warn.mock.calls.find(([message]) => message === "claude exited with an error");
    const stderr = (call?.[1] as { stderr: string }).stderr;
    expect(stderr.length).toBeLessThanOrEqual(STDERR_TAIL_BYTES);
    expect(stderr.endsWith("END")).toBe(true);
  });

  it("says nothing on a clean exit", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await run(["-e", "console.error('noise'); process.exit(0)"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs a spawn failure", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await run([], "/nonexistent/claude-binary");
    expect(warn.mock.calls.some(([message]) => message === "claude could not be started")).toBe(true);
  });
});
