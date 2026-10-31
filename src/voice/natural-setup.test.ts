import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findCachedFile,
  installNatural,
  setupSentence,
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
    listRepo: async () => [],
    findCached: () => null,
    makeReferenceClips: async () => undefined,
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
    expect(installer.status()).toEqual({ state: "idle", engine: "kokoro" });
    expect(installer.start()).toEqual({ ok: true });
    expect(installer.start()).toEqual({ ok: true });
    expect(installer.status().state).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(downloads).toBe(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(installer.status()).toEqual({ state: "ready", engine: "kokoro" });
    expect(installer.start()).toEqual({ ok: false, reason: "The realistic voice is already installed." });
  });

  it("holds a failure with a fixed sentence until the next try", async () => {
    const installer = new NaturalInstaller(dir, { deps: fakeDeps({ findPython: async () => null }) });
    installer.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(installer.status()).toEqual({
      state: "failed",
      engine: "kokoro",
      code: "no-python",
      error: NATURAL_SETUP_SENTENCES["no-python"],
    });
    installer.start();
    expect(installer.status().state).toBe("running");
  });
});

describe("MLX engines", () => {
  const QWEN_FILES = [
    { path: ".gitattributes", size: 5 },
    { path: "README.md", size: 5 },
    { path: "config.json", size: 10 },
    { path: "model.safetensors", size: 400 },
    { path: "speech_tokenizer/model.safetensors", size: 200 },
  ];

  /** Fakes the engine's effects: the listing, a download that writes the right number of bytes, the venv. */
  function mlxDeps(overrides: Partial<NaturalSetupDeps> = {}, engine: "qwen3" | "chatterbox" = "qwen3") {
    const paths = naturalPaths(dir, engine);
    const downloaded: string[] = [];
    const deps = fakeDeps({
      findPython: async (mlx) => (mlx ? "/fake/python3.12" : "/fake/python3"),
      makeVenv: async (_python, to) => {
        fs.mkdirSync(path.join(to, "venv", "bin"), { recursive: true });
        fs.writeFileSync(path.join(to, "venv", "bin", "python3"), "");
      },
      listRepo: async (repo) =>
        repo.endsWith("S3TokenizerV2")
          ? [
              { path: "config.json", size: 4 },
              { path: "model.safetensors", size: 50 },
            ]
          : QWEN_FILES,
      download: async (url, file, min, onBytes) => {
        downloaded.push(url.replace("https://huggingface.co/", ""));
        onBytes(min / 2);
        fs.writeFileSync(file, Buffer.alloc(min));
        onBytes(min);
      },
      ...overrides,
    });
    return { deps, downloaded, paths };
  }

  it("downloads every file of the repo into the engine's folder and writes the worker last", async () => {
    const { deps, downloaded, paths } = mlxDeps();
    const seen: NaturalSetupProgress[] = [];
    const installs: Array<readonly string[]> = [];
    const result = await installNatural(dir, (p) => seen.push(p), {
      engine: "qwen3",
      deps: { ...deps, pipInstall: async (_p, packages) => void installs.push(packages) },
    });
    expect(result).toEqual({ ok: true });
    expect(naturalInstalled(paths)).toBe(true);
    expect(installs[0]?.[0]).toContain("mlx-audio");
    expect(downloaded).toEqual([
      "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit/resolve/main/config.json",
      "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit/resolve/main/model.safetensors",
      "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit/resolve/main/speech_tokenizer/model.safetensors",
    ]);
    expect(fs.statSync(path.join(paths.model, "model.safetensors")).size).toBe(400);
    expect(fs.existsSync(`${paths.model}/model.safetensors.part`)).toBe(false);
    expect(fs.readFileSync(paths.worker, "utf8")).toContain("load_model");
    // Kokoro's folder was not touched.
    expect(fs.existsSync(naturalPaths(dir).dir)).toBe(false);
    const percents = seen.map((p) => p.percent ?? 0);
    expect([...percents].sort((a, b) => a - b)).toEqual(percents);
    expect(seen.find((p) => p.step === "model" && p.bytes === 610)?.text).toContain("of 0 MB");
  });

  it("asks for a Python 3.10 to 3.12 and says so plainly when there is none", async () => {
    const { deps } = mlxDeps({ findPython: async (mlx) => (mlx ? null : "/fake/python3") });
    const result = await installNatural(dir, () => undefined, { engine: "ming", deps });
    expect(result).toEqual({ ok: false, code: "no-python" });
    expect(setupSentence("no-python", "ming")).toContain("3.12");
    expect(setupSentence("no-space", "ming")).toContain("4 GB");
    expect(setupSentence("no-network", "ming")).toBe(NATURAL_SETUP_SENTENCES["no-network"]);
  });

  it("refuses with no-space before downloading anything when the disk is too small", async () => {
    const { deps, downloaded } = mlxDeps({ freeBytes: () => 2_000_000_000 });
    expect(await installNatural(dir, () => undefined, { engine: "qwen3", deps })).toEqual({
      ok: false,
      code: "no-space",
    });
    expect(downloaded).toEqual([]);
  });

  it("resumes: a file already whole is not fetched again, and a half file is never taken as installed", async () => {
    const { deps, downloaded, paths } = mlxDeps();
    fs.mkdirSync(paths.model, { recursive: true });
    fs.writeFileSync(path.join(paths.model, "config.json"), Buffer.alloc(10));
    fs.writeFileSync(path.join(paths.model, "model.safetensors.part"), Buffer.alloc(100));
    expect(naturalInstalled(paths)).toBe(false);
    await installNatural(dir, () => undefined, { engine: "qwen3", deps });
    expect(downloaded.some((url) => url.endsWith("/config.json"))).toBe(false);
    expect(downloaded).toHaveLength(2);
  });

  it("reuses files already on this Mac instead of downloading them, and says so", async () => {
    const hub = path.join(dir, "fake-hub");
    const repo = "models--mlx-community--Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit";
    const snapshot = path.join(hub, repo, "snapshots", "abc123");
    const blobs = path.join(hub, repo, "blobs");
    fs.mkdirSync(path.join(snapshot, "speech_tokenizer"), { recursive: true });
    fs.mkdirSync(blobs, { recursive: true });
    // Snapshot entries are links to blobs, as the Hugging Face cache lays them out.
    for (const [file, size] of [
      ["config.json", 10],
      ["model.safetensors", 400],
      ["speech_tokenizer/model.safetensors", 200],
    ] as const) {
      const blob = path.join(blobs, file.replace("/", "-"));
      fs.writeFileSync(blob, Buffer.alloc(size, 7));
      fs.symlinkSync(blob, path.join(snapshot, file));
    }
    const { deps, downloaded, paths } = mlxDeps({
      findCached: (repoId, file, size) => findCachedFile(repoId, file, size, { HF_HUB_CACHE: hub }),
    });
    const seen: NaturalSetupProgress[] = [];
    expect(await installNatural(dir, (p) => seen.push(p), { engine: "qwen3", deps })).toEqual({ ok: true });
    expect(downloaded).toEqual([]);
    expect(seen.some((p) => p.text.startsWith("Using files already on this Mac"))).toBe(true);
    const mine = path.join(paths.model, "model.safetensors");
    expect(fs.statSync(mine).size).toBe(400);
    // Linked to the cached blob: no second copy on the disk.
    expect(fs.statSync(mine).ino).toBe(fs.statSync(path.join(blobs, "model.safetensors")).ino);
    expect(fs.statSync(mine).nlink).toBeGreaterThan(1);
  });

  it("takes only a complete file from a cache or a named folder", () => {
    const hub = path.join(dir, "hub2");
    const snapshot = path.join(hub, "models--org--name", "snapshots", "rev");
    fs.mkdirSync(snapshot, { recursive: true });
    fs.writeFileSync(path.join(snapshot, "a.bin"), Buffer.alloc(10));
    expect(findCachedFile("org/name", "a.bin", 10, { HF_HUB_CACHE: hub })).toBe(
      fs.realpathSync(path.join(snapshot, "a.bin")),
    );
    expect(findCachedFile("org/name", "a.bin", 11, { HF_HUB_CACHE: hub })).toBeNull();
    expect(findCachedFile("org/other", "a.bin", 10, { HF_HUB_CACHE: hub })).toBeNull();
    fs.mkdirSync(path.join(dir, "plain", "name"), { recursive: true });
    fs.writeFileSync(path.join(dir, "plain", "name", "a.bin"), Buffer.alloc(10));
    expect(
      findCachedFile("org/name", "a.bin", 10, { HF_HUB_CACHE: hub, SQUEAK_VOICE_WEIGHTS_DIR: path.join(dir, "plain") }),
    ).not.toBeNull();
  });

  it("installs Kokoro first for Chatterbox and makes its reference clips with it", async () => {
    const { deps } = mlxDeps({}, "chatterbox");
    const made: string[][] = [];
    const kokoroPaths = naturalPaths(dir);
    const result = await installNatural(dir, () => undefined, {
      engine: "chatterbox",
      deps: {
        ...deps,
        listRepo: async (repo) =>
          repo.endsWith("S3TokenizerV2")
            ? [
                { path: "config.json", size: 4 },
                { path: "model.safetensors", size: 50 },
              ]
            : [
                { path: "config.json", size: 10 },
                { path: "tokenizer.json", size: 10 },
                { path: "model.safetensors", size: 100 },
              ],
        makeVenv: async (_python, to) => {
          fs.mkdirSync(path.join(to, "venv", "bin"), { recursive: true });
          fs.writeFileSync(path.join(to, "venv", "bin", "python3"), "");
        },
        makeReferenceClips: async (kokoro, folder, voices) => {
          expect(kokoro).toEqual(kokoroPaths);
          made.push([...voices]);
          fs.mkdirSync(path.join(folder, "refs"), { recursive: true });
          for (const voice of voices) fs.writeFileSync(path.join(folder, "refs", `${voice}.wav`), "x");
        },
      },
    });
    expect(result).toEqual({ ok: true });
    expect(naturalInstalled(kokoroPaths)).toBe(true);
    expect(naturalInstalled(naturalPaths(dir, "chatterbox"))).toBe(true);
    expect(made).toEqual([["af_heart", "bf_emma", "am_michael", "bm_george"]]);
  });
});

describe("one install at a time, and removing an engine", () => {
  const installFake = (engine: "kokoro" | "qwen3") => {
    const paths = naturalPaths(dir, engine);
    fs.mkdirSync(paths.dir, { recursive: true });
    for (const file of [paths.python, paths.worker, ...(paths.required ?? [paths.model, paths.voices])]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "x");
    }
    return paths;
  };

  it("does not start a second install while one runs, whichever engine", async () => {
    let release: () => void = () => undefined;
    const installer = new NaturalInstaller(dir, {
      deps: fakeDeps({
        findPython: () => new Promise<string | null>((resolve) => (release = () => resolve(null))),
      }),
    });
    expect(installer.start("qwen3")).toEqual({ ok: true });
    expect(installer.start("ming")).toEqual({ ok: true }); // joins the one that runs
    expect(installer.status("kokoro")).toMatchObject({ state: "running", engine: "qwen3" });
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(installer.status("qwen3")).toMatchObject({ state: "failed", engine: "qwen3", code: "no-python" });
    expect((installer.status("qwen3") as { error: string }).error).toBe(setupSentence("no-python", "qwen3"));
    expect(installer.status("ming")).toEqual({ state: "idle", engine: "ming" });
  });

  it("removes an engine's folder, but never the one in use or the only Kokoro", () => {
    const installer = new NaturalInstaller(dir, { deps: fakeDeps() });
    installFake("kokoro");
    const qwen = installFake("qwen3");
    expect(installer.installedEngines()).toEqual(["kokoro", "qwen3"]);
    expect(installer.remove("qwen3", "qwen3")).toMatchObject({ ok: false });
    expect(fs.existsSync(qwen.dir)).toBe(true);
    expect(installer.remove("qwen3", "kokoro")).toEqual({ ok: true });
    expect(fs.existsSync(qwen.dir)).toBe(false);
    expect(installer.remove("kokoro", "qwen3")).toEqual({
      ok: false,
      reason: "Kokoro is the only voice engine installed.",
    });
    expect(naturalInstalled(naturalPaths(dir))).toBe(true);
  });
});
