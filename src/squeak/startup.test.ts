import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { beginStartup, readDaemonVersion, shortError, startupPhase, STARTUP_FILE, StartupReporter } from "./startup.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-startup-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const read = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, "utf8"));

describe("StartupReporter", () => {
  it("writes pid, version, phase and an ISO time, and replaces it atomically", () => {
    const file = path.join(dir, "nested", STARTUP_FILE);
    const reporter = new StartupReporter(file, 42, "1.2.3+abc", () => new Date("2026-11-11T10:00:00.000Z"));
    reporter.phase("loading");
    expect(read(file)).toEqual({ pid: 42, version: "1.2.3+abc", phase: "loading", at: "2026-11-11T10:00:00.000Z" });
    reporter.phase("ready");
    expect(read(file).phase).toBe("ready");
    expect(fs.readdirSync(path.dirname(file))).toEqual([STARTUP_FILE]);
  });

  it("records a short, secret-free error when failed", () => {
    const file = path.join(dir, STARTUP_FILE);
    new StartupReporter(file, 1, "v").phase(
      "failed",
      new Error(`bad 123456789:${"A".repeat(30)} in /Users/someone/x\nstack line`),
    );
    const record = read(file);
    expect(record.phase).toBe("failed");
    expect(record.error).toBe("bad [token] in /Users/[user]/x");
  });

  it("never throws when the folder cannot be written", () => {
    const blocker = path.join(dir, "file");
    fs.writeFileSync(blocker, "x");
    expect(() => new StartupReporter(path.join(blocker, STARTUP_FILE), 1, "v").phase("config")).not.toThrow();
  });
});

describe("beginStartup", () => {
  it("logs one line first, writes loading, and later phases land in the same file", () => {
    const lines: string[] = [];
    beginStartup(dir, (line) => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^squeak \S+ starting, pid \d+, node v\d+/);
    expect(read(path.join(dir, STARTUP_FILE)).phase).toBe("loading");
    startupPhase("listening");
    expect(read(path.join(dir, STARTUP_FILE)).phase).toBe("listening");
  });
});

describe("shortError and readDaemonVersion", () => {
  it("caps length", () => {
    expect(shortError("x".repeat(500))).toHaveLength(200);
  });
  it("reads a VERSION file before package.json", () => {
    fs.mkdirSync(path.join(dir, "dist", "squeak"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
    expect(readDaemonVersion(path.join(dir, "dist", "squeak"))).toBe("9.9.9");
    fs.writeFileSync(path.join(dir, "VERSION"), "9.9.9+abc\n");
    expect(readDaemonVersion(path.join(dir, "dist", "squeak"))).toBe("9.9.9+abc");
  });
});

describe("isMainModule", () => {
  it("matches through a symlinked folder", async () => {
    const { isMainModule } = await import("./cli.js");
    const real = path.join(dir, "real");
    fs.mkdirSync(real);
    fs.writeFileSync(path.join(real, "cli.js"), "");
    fs.symlinkSync(real, path.join(dir, "link"));
    const url = new URL(`file://${fs.realpathSync(path.join(real, "cli.js"))}`).href;
    expect(isMainModule(path.join(dir, "link", "cli.js"), url)).toBe(true);
    expect(isMainModule(path.join(dir, "other.js"), url)).toBe(false);
    expect(isMainModule(undefined, url)).toBe(false);
  });
});
