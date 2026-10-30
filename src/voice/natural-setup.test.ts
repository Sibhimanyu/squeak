import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  installNatural,
  NATURAL_SETUP_SENTENCES,
  NaturalInstaller,
  NaturalSetupError,
  type NaturalSetupDeps,
  type NaturalSetupProgress,
} from "./natural-setup.js";
import { naturalInstalled, naturalPaths } from "./natural-voice.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "natural-setup-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Fakes every effect: nothing here makes a venv, runs pip or downloads the model. */
function fakeDeps(overrides: Partial<NaturalSetupDeps> = {}): NaturalSetupDeps {
  const paths = naturalPaths(dir);
  return {
    findPython: async () => "/fake/python3",
    makeVenv: async () => {
      fs.mkdirSync(path.dirname(paths.python), { recursive: true });
      fs.writeFileSync(paths.python, "");
    },
    pipInstall: async () => undefined,
    download: async (_url, file, _min, onBytes) => {
      onBytes(100_000_000);
      onBytes(200_000_000);
      fs.writeFileSync(file, "x");
    },
    freeBytes: () => 50_000_000_000,
    ...overrides,
  };
}

describe("installNatural", () => {
  it("installs step by step and reports rising progress", async () => {
    const seen: NaturalSetupProgress[] = [];
    const result = await installNatural(dir, (p) => seen.push(p), { deps: fakeDeps() });
    expect(result).toEqual({ ok: true });
    expect(naturalInstalled(naturalPaths(dir))).toBe(true);
    expect(seen.map((p) => p.step)).toContain("model");
    expect(seen.map((p) => p.step)).toContain("voices");
    const percents = seen.map((p) => p.percent ?? 0);
    expect([...percents].sort((a, b) => a - b)).toEqual(percents);
    expect(Math.max(...percents)).toBeLessThanOrEqual(99);
    const model = seen.find((p) => p.step === "model" && p.bytes === 100_000_000);
    expect(model?.text).toBe("Downloading the voice model: 100 of 326 MB");
    expect(model?.totalBytes).toBeGreaterThan(300_000_000);
  });

  it("says plainly when no Python 3.10+ is found", async () => {
    const result = await installNatural(dir, () => undefined, { deps: fakeDeps({ findPython: async () => null }) });
    expect(result).toEqual({ ok: false, code: "no-python" });
    expect(NATURAL_SETUP_SENTENCES["no-python"]).toContain("brew install python");
  });

  it("maps a network failure and a full disk to their own codes", async () => {
    const net = await installNatural(dir, () => undefined, {
      deps: fakeDeps({
        download: async () => {
          throw new NaturalSetupError("no-network", "curl exited 6");
        },
      }),
    });
    expect(net).toEqual({ ok: false, code: "no-network" });
    const disk = await installNatural(dir, () => undefined, { deps: fakeDeps({ freeBytes: () => 100_000_000 }) });
    expect(disk).toEqual({ ok: false, code: "no-space" });
  });

  it("turns an unexpected error into a fixed failure and logs the detail only to the log", async () => {
    const logged: string[] = [];
    const result = await installNatural(dir, () => undefined, {
      deps: fakeDeps({
        pipInstall: async () => {
          throw new Error("/Users/secret/path boom");
        },
      }),
      log: (d) => logged.push(d),
    });
    expect(result).toEqual({ ok: false, code: "failed" });
    expect(logged[0]).toContain("boom");
    for (const sentence of Object.values(NATURAL_SETUP_SENTENCES)) expect(sentence).not.toContain("/Users");
  });
});

describe("NaturalInstaller", () => {
  it("runs one install at a time, ends ready, and refuses once installed", async () => {
    let release: () => void = () => undefined;
    let downloads = 0;
    const installer = new NaturalInstaller(dir, {
      deps: fakeDeps({
        download: async (_u, file) => {
          downloads += 1;
          await new Promise<void>((resolve) => (release = resolve));
          fs.writeFileSync(file, "x");
        },
      }),
    });
    expect(installer.status()).toEqual({ state: "idle" });
    expect(installer.start()).toEqual({ ok: true });
    expect(installer.start()).toEqual({ ok: true });
    expect(installer.status().state).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(downloads).toBe(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(installer.status()).toEqual({ state: "ready" });
    expect(installer.start()).toEqual({ ok: false, reason: "The realistic voice is already installed." });
  });

  it("holds a failure with a fixed sentence until the next try", async () => {
    const installer = new NaturalInstaller(dir, { deps: fakeDeps({ findPython: async () => null }) });
    installer.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(installer.status()).toEqual({
      state: "failed",
      code: "no-python",
      error: NATURAL_SETUP_SENTENCES["no-python"],
    });
    installer.start();
    expect(installer.status().state).toBe("running");
  });
});
