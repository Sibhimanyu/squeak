import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { naturalInstalled, naturalPaths, writeEngineFiles, type NaturalPaths } from "./natural-voice.js";
import { REFERENCE_CLIPS_PY, REFERENCE_TEXT } from "./natural-worker-mlx.js";
import { DEFAULT_ENGINE, ENGINE_IDS, VOICE_ENGINES, referenceClip, type EngineId } from "./voice-engines.js";

const run = promisify(execFile);

const MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx";
const VOICES_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin";
/** The model is about 310 MB; anything much smaller is a failed download, not a model. */
const MODEL_MIN_BYTES = 300_000_000;
const VOICES_MIN_BYTES = 20_000_000;
/** What the two files weigh in full, for a percentage while they download (never shown as exact). */
const MODEL_APPROX_BYTES = 325_532_232;
const VOICES_APPROX_BYTES = 28_214_398;
/** Free space wanted before starting: the files, the engine and some room (about 350 MB are used). */
export const NATURAL_MIN_FREE_BYTES = 1_000_000_000;
const PYTHONS = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"];
/**
 * Pythons for the MLX engines, which need 3.10 to 3.12 built for Apple silicon (mlx has no wheel for a newer one yet,
 * and an Intel Python under Rosetta cannot run it): Homebrew's versioned ones, a user-installed 3.11, then the plain ones.
 */
const MLX_PYTHONS = [
  "/opt/homebrew/bin/python3.12",
  "/opt/homebrew/bin/python3.11",
  "/opt/homebrew/bin/python3.10",
  path.join(os.homedir(), ".local", "bin", "python3.12"),
  path.join(os.homedir(), ".local", "bin", "python3.11"),
  path.join(os.homedir(), ".local", "bin", "python3.10"),
  ...PYTHONS,
];
/** Free space kept beyond an MLX engine's own download: the venv unpacks to about 1.5 GB. */
const MLX_EXTRA_BYTES = 2_000_000_000;

export type NaturalSetupStep = "python" | "engine" | "model" | "voices" | "finishing";
export type NaturalSetupCode = "no-python" | "no-network" | "no-space" | "failed";

/** Fixed sentences: the apps show these as they are, so they carry no path, URL or command output. */
export const NATURAL_SETUP_SENTENCES: Record<NaturalSetupCode, string> = {
  "no-python":
    "Squeak needs Python 3.10 or newer to make the voice. Install it with Homebrew (brew install python), then try again.",
  "no-network":
    "Squeak couldn't download the voice. Check your internet connection and try again: it picks up where it left off.",
  "no-space": "There isn't enough free disk space. The voice needs about 1 GB free while it installs.",
  failed:
    "The voice could not be installed. Try again; if it keeps failing, run squeak voice-tts-setup in Terminal to see why.",
};

/** The sentence for a failure of `engine`'s setup: the MLX engines need a newer, Apple-silicon Python and far more room. */
export function setupSentence(code: NaturalSetupCode, engine: EngineId = DEFAULT_ENGINE): string {
  if (engine === "kokoro") return NATURAL_SETUP_SENTENCES[code];
  const label = VOICE_ENGINES[engine].label;
  if (code === "no-python") {
    return "Squeak needs Python 3.10, 3.11 or 3.12 for Apple silicon to make this voice. Install one with Homebrew (brew install python@3.12), then try again.";
  }
  if (code === "no-space") {
    return `There isn't enough free disk space. ${label} needs about ${VOICE_ENGINES[engine].size.replace("about ", "")} plus 2 GB free while it installs.`;
  }
  if (code === "failed") {
    return `${label} could not be installed. Try again; if it keeps failing, run squeak voice-tts-setup --engine ${engine} in Terminal to see why.`;
  }
  return NATURAL_SETUP_SENTENCES[code];
}

export interface NaturalSetupProgress {
  step: NaturalSetupStep;
  /** One plain line for the person, e.g. "Downloading the voice model: 120 of 310 MB". */
  text: string;
  /** 0 to 99 over the whole install while it runs; weighted by how long each step takes. */
  percent?: number;
  bytes?: number;
  totalBytes?: number;
}

export type NaturalSetupResult = { ok: true } | { ok: false; code: NaturalSetupCode };

/**
 * Where a file of a Hugging Face repo may already be on this Mac: the Hugging Face cache (`$HF_HUB_CACHE`,
 * `$HF_HOME/hub` or `~/.cache/huggingface/hub`, `models--<org>--<name>/snapshots/<revision>/<file>`), then the
 * folders `SQUEAK_VOICE_WEIGHTS_DIR` names (plain `<name>/<file>` copies). Only a file of exactly the right size
 * counts, so a half download (its blob is `.incomplete`, never in a snapshot) is never taken.
 */
export function findCachedFile(repo: string, file: string, size: number, env = process.env): string | null {
  const [org = "", name = ""] = repo.split("/");
  const hub = env.HF_HUB_CACHE ?? path.join(env.HF_HOME ?? path.join(os.homedir(), ".cache", "huggingface"), "hub");
  const candidates: string[] = [];
  const snapshots = path.join(hub, `models--${org}--${name}`, "snapshots");
  try {
    for (const revision of fs.readdirSync(snapshots)) candidates.push(path.join(snapshots, revision, file));
  } catch {
    // No cache of this repo.
  }
  if (env.SQUEAK_VOICE_WEIGHTS_DIR) candidates.push(path.join(env.SQUEAK_VOICE_WEIGHTS_DIR, name, file));
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      if (fs.statSync(real).size === size) return real;
    } catch {
      // Not there, or a dangling link.
    }
  }
  return null;
}

/** Puts `source` at `dest` without a second copy where it can: a hard link (same volume), a clone, else a copy. */
export function placeFile(source: string, dest: string): void {
  fs.rmSync(dest, { force: true });
  try {
    fs.linkSync(source, dest);
  } catch {
    fs.copyFileSync(source, dest, fs.constants.COPYFILE_FICLONE);
  }
}

/** One file of a Hugging Face repo: its path in the repo and its full size. */
export interface RepoFile {
  path: string;
  size: number;
}

/** The effects, so a test never makes a venv, runs pip or touches the network. */
export interface NaturalSetupDeps {
  /** A Python new enough for the engine: 3.10+ for Kokoro, 3.10 to 3.12 on Apple silicon when `mlx`. */
  findPython(mlx?: boolean): Promise<string | null>;
  makeVenv(python: string, dir: string): Promise<void>;
  pipInstall(venvPython: string, packages: readonly string[]): Promise<void>;
  /** Fetches `url` into `file`, resuming a partial one; reports the bytes on disk. Rejects with a `NaturalSetupError`. */
  download(
    url: string,
    file: string,
    minBytes: number,
    onBytes: (bytes: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /** The files of a Hugging Face repo with their sizes. Rejects with a `NaturalSetupError`. */
  listRepo(repo: string): Promise<RepoFile[]>;
  /** A complete copy of a repo file already on this Mac (see `findCachedFile`), or null. */
  findCached(repo: string, file: string, size: number): string | null;
  /** Chatterbox's reference clips, made with Kokoro's Python (`<folder>/refs/<voice>.wav`). */
  makeReferenceClips(kokoro: NaturalPaths, folder: string, voices: readonly string[]): Promise<void>;
  freeBytes(dir: string): number | null;
}

export class NaturalSetupError extends Error {
  constructor(
    readonly code: NaturalSetupCode,
    detail: string,
  ) {
    super(detail);
  }
}

/** A Python new enough for the engine, or null: Kokoro 3.10+; the MLX engines 3.10 to 3.12, arm64. */
async function findPython(mlx = false): Promise<string | null> {
  const probe = "import sys, platform; print(sys.version_info[0]*100+sys.version_info[1], platform.machine())";
  for (const candidate of mlx ? MLX_PYTHONS : PYTHONS) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const { stdout } = await run(candidate, ["-I", "-c", probe]);
      const [version, machine] = stdout.trim().split(" ");
      if (Number(version) < 310) continue;
      if (mlx && (Number(version) > 312 || machine !== "arm64")) continue;
      return candidate;
    } catch {
      // Try the next.
    }
  }
  return null;
}

/** curl's exit codes that mean the network, not the file or the disk. */
const CURL_NETWORK_EXITS = new Set([5, 6, 7, 18, 22, 28, 35, 52, 55, 56, 60]);

function curlError(code: number | null): NaturalSetupError {
  if (code === 23) return new NaturalSetupError("no-space", "curl could not write the file");
  if (code !== null && CURL_NETWORK_EXITS.has(code)) return new NaturalSetupError("no-network", `curl exited ${code}`);
  return new NaturalSetupError("failed", `curl exited ${code}`);
}

/** Attempts at one file without it growing before giving up: this Mac's network stalls and drops. */
const DOWNLOAD_STALLED_TRIES = 4;

function download(
  url: string,
  file: string,
  minBytes: number,
  onBytes: (bytes: number) => void,
  signal: AbortSignal,
): Promise<void> {
  if (fs.existsSync(file) && fs.statSync(file).size >= minBytes) return Promise.resolve();
  const size = () => {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  };
  // `-C -` resumes a partial file; the model is large and the uplink is slow. `-sS`: no progress meter, errors only.
  // A transfer under 20 KB/s for 30 s is a stall: curl stops it (exit 28) and the next attempt resumes where it was.
  const attempt = (): Promise<number | null> =>
    new Promise((resolve) => {
      const child = spawn(
        "curl",
        [
          "-fLsS",
          "-C",
          "-",
          "--connect-timeout",
          "20",
          "--speed-limit",
          "20000",
          "--speed-time",
          "30",
          "-o",
          file,
          url,
        ],
        { stdio: ["ignore", "ignore", "ignore"] },
      );
      const timer = setInterval(() => onBytes(size()), 700);
      const stop = () => child.kill("SIGTERM");
      signal.addEventListener("abort", stop, { once: true });
      const finish = (code: number | null) => {
        clearInterval(timer);
        signal.removeEventListener("abort", stop);
        resolve(code);
      };
      child.on("error", () => finish(-1));
      child.on("exit", finish);
    });
  return (async () => {
    let stalled = 0;
    for (;;) {
      const before = size();
      const code = await attempt();
      if (signal.aborted) throw new NaturalSetupError("failed", "stopped");
      if (code === -1) throw new NaturalSetupError("failed", "curl could not start");
      onBytes(size());
      if (size() >= minBytes) return;
      if (code === 23) throw curlError(code);
      stalled = size() > before ? 0 : stalled + 1;
      if (stalled >= DOWNLOAD_STALLED_TRIES) {
        throw code === 0 ? new NaturalSetupError("failed", `${file} is too small`) : curlError(code);
      }
    }
  })();
}

/** The files of a Hugging Face repo, retried a few times: the API is as flaky as the downloads. */
async function listRepo(repo: string): Promise<RepoFile[]> {
  let failure = "no answer";
  for (let tryNumber = 0; tryNumber < 5; tryNumber += 1) {
    try {
      const response = await fetch(`https://huggingface.co/api/models/${repo}/tree/main?recursive=1`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) {
        const entries = (await response.json()) as Array<{ type?: string; path?: string; size?: number }>;
        const files = entries.flatMap((entry) =>
          entry.type === "file" && typeof entry.path === "string" && typeof entry.size === "number"
            ? [{ path: entry.path, size: entry.size }]
            : [],
        );
        if (files.length > 0) return files;
      }
      failure = `status ${response.status}`;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500 * (tryNumber + 1)));
  }
  throw new NaturalSetupError("no-network", `could not list ${repo}: ${failure}`);
}

const PIP_NETWORK =
  /could not find a version|connection|temporary failure|name or service|proxy|ssl|network|timed out/i;

export const realNaturalSetupDeps: NaturalSetupDeps = {
  findPython,
  makeVenv: async (python, dir) => {
    await run(python, ["-m", "venv", `${dir}/venv`]);
  },
  pipInstall: async (venvPython, packages) => {
    let failure: unknown;
    // pip resumes nothing, but a second try finds what the first downloaded in its cache.
    for (let tryNumber = 0; tryNumber < 3; tryNumber += 1) {
      try {
        await run(venvPython, ["-m", "pip", "install", "-q", "--disable-pip-version-check", ...packages], {
          timeout: 1_800_000,
        });
        return;
      } catch (error) {
        failure = error;
        const text = `${(error as { stderr?: string }).stderr ?? ""} ${error instanceof Error ? error.message : ""}`;
        if (!PIP_NETWORK.test(text)) break;
      }
    }
    const text = `${(failure as { stderr?: string }).stderr ?? ""} ${failure instanceof Error ? failure.message : ""}`;
    throw new NaturalSetupError(PIP_NETWORK.test(text) ? "no-network" : "failed", text.slice(0, 300));
  },
  download,
  listRepo,
  findCached: (repo, file, size) => findCachedFile(repo, file, size),
  makeReferenceClips: async (kokoro, folder, voices) => {
    await run(
      kokoro.python,
      [
        "-I",
        "-c",
        REFERENCE_CLIPS_PY,
        kokoro.model,
        kokoro.voices,
        path.join(folder, "refs"),
        REFERENCE_TEXT,
        ...voices,
      ],
      { timeout: 300_000 },
    );
  },
  freeBytes: (dir) => {
    try {
      const stat = fs.statfsSync(dir);
      return stat.bavail * stat.bsize;
    } catch {
      return null;
    }
  },
};

const mb = (bytes: number) => Math.round(bytes / 1_000_000);

/** Where each step sits in the whole install, by how long it takes: the model is nearly all of it. */
const SHARE = {
  python: [0, 3],
  engine: [3, 12],
  model: [12, 92],
  voices: [92, 99],
} as const;
/** The same for an MLX engine: a bigger venv, much bigger weights, and (Chatterbox) the reference clips. */
const MLX_SHARE = {
  python: [0, 2],
  engine: [2, 14],
  model: [14, 95],
  voices: [95, 99],
} as const;

function overall(step: keyof typeof SHARE, fraction: number, share: typeof SHARE | typeof MLX_SHARE = SHARE): number {
  const [from, to] = share[step];
  return Math.min(99, Math.round(from + (to - from) * Math.max(0, Math.min(1, fraction))));
}

const sizeOf = (file: string): number => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

/**
 * Installs an engine of the realistic voice (Kokoro unless `options.engine` says otherwise): a Python venv with its
 * packages and the model in the engine's own folder of the support directory (about 350 MB for Kokoro, 4 GB for the
 * others, nothing sent anywhere after). Safe to run again; it only fills what is missing, and a partial download
 * resumes. Chatterbox clones reference clips that Kokoro makes, so it installs Kokoro first when that is missing.
 * Progress goes through `report`; it never throws.
 */
export async function installNatural(
  supportDir: string,
  report: (progress: NaturalSetupProgress) => void,
  options: {
    engine?: EngineId;
    deps?: NaturalSetupDeps;
    signal?: AbortSignal;
    log?: (detail: string) => void;
  } = {},
): Promise<NaturalSetupResult> {
  const engineId = options.engine ?? DEFAULT_ENGINE;
  if (engineId !== "kokoro") return installMlxEngine(supportDir, engineId, report, options);
  const deps = options.deps ?? realNaturalSetupDeps;
  const signal = options.signal ?? new AbortController().signal;
  const paths = naturalPaths(supportDir);
  try {
    fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const free = deps.freeBytes(paths.dir);
    // Only what is still missing needs room: a resumed install with the model on disk needs little.
    if (!naturalInstalled(paths) && free !== null && free < NATURAL_MIN_FREE_BYTES) {
      const stillNeeded =
        MODEL_APPROX_BYTES - sizeOf(paths.model) + (VOICES_APPROX_BYTES - sizeOf(paths.voices)) + 200_000_000;
      if (free < stillNeeded) return { ok: false, code: "no-space" };
    }
    if (!fs.existsSync(paths.python)) {
      report({ step: "python", text: "Looking for Python…", percent: overall("python", 0) });
      const python = await deps.findPython();
      if (!python) return { ok: false, code: "no-python" };
      report({ step: "python", text: "Making the voice's Python environment…", percent: overall("python", 0.5) });
      await deps.makeVenv(python, paths.dir);
    }
    report({ step: "engine", text: "Installing the speech engine…", percent: overall("engine", 0) });
    await deps.pipInstall(paths.python, VOICE_ENGINES.kokoro.packages);
    const fetch = async (
      step: "model" | "voices",
      label: string,
      url: string,
      file: string,
      min: number,
      approx: number,
    ) => {
      const say = (bytes: number) => {
        const shown = Math.min(bytes, approx);
        report({
          step,
          text: `Downloading ${label}: ${mb(shown)} of ${mb(approx)} MB`,
          percent: overall(step, shown / approx),
          bytes: shown,
          totalBytes: approx,
        });
      };
      say(sizeOf(file));
      await deps.download(url, file, min, say, signal);
    };
    await fetch("model", "the voice model", MODEL_URL, paths.model, MODEL_MIN_BYTES, MODEL_APPROX_BYTES);
    await fetch("voices", "the voice list", VOICES_URL, paths.voices, VOICES_MIN_BYTES, VOICES_APPROX_BYTES);
    report({ step: "finishing", text: "Finishing up…", percent: 99 });
    fs.writeFileSync(paths.worker, VOICE_ENGINES.kokoro.worker, { mode: 0o600 });
    if (!naturalInstalled(paths)) {
      options.log?.("setup finished but a file is still missing");
      return { ok: false, code: "failed" };
    }
    return { ok: true };
  } catch (error) {
    options.log?.(error instanceof Error ? error.message : String(error));
    return { ok: false, code: error instanceof NaturalSetupError ? error.code : "failed" };
  }
}

async function installMlxEngine(
  supportDir: string,
  engineId: Exclude<EngineId, "kokoro">,
  report: (progress: NaturalSetupProgress) => void,
  options: { deps?: NaturalSetupDeps; signal?: AbortSignal; log?: (detail: string) => void },
): Promise<NaturalSetupResult> {
  const deps = options.deps ?? realNaturalSetupDeps;
  const signal = options.signal ?? new AbortController().signal;
  const engine = VOICE_ENGINES[engineId];
  const paths = naturalPaths(supportDir, engineId);
  const needsKokoro = engineId === "chatterbox";
  try {
    // Chatterbox's reference clips come from Kokoro; the first tenth of the bar is that install, when it is missing.
    const lift = needsKokoro && !naturalInstalled(naturalPaths(supportDir)) ? 10 : 0;
    const say = (progress: NaturalSetupProgress) =>
      report(
        progress.percent === undefined
          ? progress
          : { ...progress, percent: Math.min(99, Math.round(lift + (progress.percent * (99 - lift)) / 99)) },
      );
    if (lift > 0) {
      const kokoro = await installNatural(
        supportDir,
        (progress) =>
          report({ ...progress, percent: Math.round(((progress.percent ?? 0) * lift) / 99), text: progress.text }),
        { deps, signal, ...(options.log ? { log: options.log } : {}) },
      );
      if (!kokoro.ok) return kokoro;
    }
    fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const free = deps.freeBytes(paths.dir);
    if (!naturalInstalled(paths) && free !== null) {
      const have = engine.repos.reduce((sum, repo) => sum + dirBytes(path.join(paths.dir, repo.dir)), 0);
      if (free < Math.max(0, engine.approxBytes - have) + MLX_EXTRA_BYTES) return { ok: false, code: "no-space" };
    }
    if (!fs.existsSync(paths.python)) {
      say({ step: "python", text: "Looking for Python…", percent: overall("python", 0, MLX_SHARE) });
      const python = await deps.findPython(true);
      if (!python) return { ok: false, code: "no-python" };
      say({
        step: "python",
        text: "Making the voice's Python environment…",
        percent: overall("python", 0.5, MLX_SHARE),
      });
      await deps.makeVenv(python, paths.dir);
    }
    say({ step: "engine", text: "Installing the speech engine…", percent: overall("engine", 0, MLX_SHARE) });
    await deps.pipInstall(paths.python, engine.packages);

    const listing = await Promise.all(
      engine.repos.map(async (repo) => ({ repo, files: await deps.listRepo(repo.repo) })),
    );
    const wanted = listing.flatMap(({ repo, files }) =>
      files
        .filter((file) => !file.path.startsWith(".") && !file.path.endsWith("README.md"))
        .map((file) => ({ url: `https://huggingface.co/${repo.repo}/resolve/main/${file.path}`, repo, ...file })),
    );
    const total = wanted.reduce((sum, file) => sum + file.size, 0);
    let done = wanted.reduce((sum, file) => {
      const final = path.join(paths.dir, file.repo.dir, file.path);
      return sum + (sizeOf(final) === file.size ? file.size : 0);
    }, 0);
    let reusing = false;
    const tell = (bytes: number) => {
      const shown = Math.min(bytes, total);
      say({
        step: "model",
        text: `${reusing ? "Using files already on this Mac" : "Downloading the voice model"}: ${mb(shown)} of ${mb(total)} MB`,
        percent: overall("model", shown / total, MLX_SHARE),
        bytes: shown,
        totalBytes: total,
      });
    };
    tell(done);
    for (const file of wanted) {
      const final = path.join(paths.dir, file.repo.dir, file.path);
      if (sizeOf(final) === file.size) continue;
      fs.mkdirSync(path.dirname(final), { recursive: true, mode: 0o700 });
      const have = deps.findCached(file.repo.repo, file.path, file.size);
      if (have) {
        reusing = true;
        const part = `${final}.part`;
        placeFile(have, part);
        fs.renameSync(part, final);
        done += file.size;
        tell(done);
        continue;
      }
      reusing = false;
      // Downloaded under a temporary name and renamed when whole, so a half file never looks installed.
      const part = `${final}.part`;
      const before = done;
      await deps.download(file.url, part, file.size, (bytes) => tell(before + bytes), signal);
      fs.renameSync(part, final);
      done += file.size;
      tell(done);
    }
    if (needsKokoro) {
      say({ step: "voices", text: "Making the reference voices…", percent: overall("voices", 0, MLX_SHARE) });
      const missing = engine.voices
        .map((voice) => voice.id)
        .filter((id) => !fs.existsSync(referenceClip(paths.dir, id)));
      if (missing.length > 0) await deps.makeReferenceClips(naturalPaths(supportDir), paths.dir, missing);
    }
    say({ step: "finishing", text: "Finishing up…", percent: 99 });
    fs.writeFileSync(paths.worker, engine.worker, { mode: 0o600 });
    writeEngineFiles(paths.dir, engine.files);
    const refsThere = !needsKokoro || engine.voices.every((voice) => fs.existsSync(referenceClip(paths.dir, voice.id)));
    if (!naturalInstalled(paths) || !refsThere) {
      options.log?.("setup finished but a file is still missing");
      return { ok: false, code: "failed" };
    }
    return { ok: true };
  } catch (error) {
    options.log?.(error instanceof Error ? error.message : String(error));
    return { ok: false, code: error instanceof NaturalSetupError ? error.code : "failed" };
  }
}

/** The bytes under a folder (what is already downloaded), 0 when it is not there. */
function dirBytes(dir: string): number {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
      const file = path.join(dir, entry.name);
      return sum + (entry.isDirectory() ? dirBytes(file) : sizeOf(file));
    }, 0);
  } catch {
    return 0;
  }
}

/**
 * `squeak voice-tts-setup [--engine <id>]`: the same install in a terminal. Returns the exit code. Progress prints at
 * each step and every 10% of a download; the detail of a failure is printed here (it is the person's own terminal).
 */
export async function runNaturalSetup(
  supportDir: string,
  say: (text: string) => void = console.log,
  engine: EngineId = DEFAULT_ENGINE,
): Promise<number> {
  let lastLine = "";
  let lastBucket = -1;
  const result = await installNatural(
    supportDir,
    (progress) => {
      const bucket =
        progress.bytes !== undefined && progress.totalBytes
          ? Math.floor((progress.bytes / progress.totalBytes) * 10)
          : -1;
      const line = (bucket >= 0 ? progress.text.split(":")[0] : progress.text) ?? progress.text;
      if (bucket >= 0 ? bucket === lastBucket && line === lastLine : line === lastLine) return;
      lastLine = line;
      lastBucket = bucket;
      say(progress.text);
    },
    { engine, log: (detail) => say(`Detail: ${detail}`) },
  );
  if (result.ok) {
    say(
      engine === "kokoro"
        ? "The natural voice is ready. Squeak uses it for phone calls from now on."
        : `${VOICE_ENGINES[engine].label} is ready. Choose it in Squeak's voice settings to use it for calls.`,
    );
    return 0;
  }
  say(`Natural voice setup failed: ${setupSentence(result.code, engine)}`);
  return 1;
}

export type NaturalInstallStatus =
  | { state: "idle"; engine: EngineId }
  | {
      state: "running";
      engine: EngineId;
      step: NaturalSetupStep;
      text: string;
      percent?: number;
      bytes?: number;
      totalBytes?: number;
    }
  | { state: "ready"; engine: EngineId }
  | { state: "failed"; engine: EngineId; code: NaturalSetupCode; error: string };

/** The one install the daemon runs at a time (across engines), in the background; the Mac app polls `status()`. */
export class NaturalInstaller {
  private running: { engine: EngineId; progress: NaturalSetupProgress } | null = null;
  private failure: { engine: EngineId; code: NaturalSetupCode } | null = null;
  private abort: AbortController | null = null;

  constructor(
    private readonly supportDir: string,
    private readonly options: { deps?: NaturalSetupDeps; log?: (detail: string) => void } = {},
  ) {}

  private installed(engine: EngineId): boolean {
    return naturalInstalled(naturalPaths(this.supportDir, engine));
  }

  /** The engines on disk. */
  installedEngines(): EngineId[] {
    return ENGINE_IDS.filter((engine) => this.installed(engine));
  }

  /** The running install's status when one runs (whichever engine), else `engine`'s (Kokoro's when absent). */
  status(engine: EngineId = DEFAULT_ENGINE): NaturalInstallStatus {
    if (this.running) return { state: "running", ...this.running.progress, engine: this.running.engine };
    if (this.installed(engine)) return { state: "ready", engine };
    if (this.failure?.engine === engine) {
      return {
        state: "failed",
        engine,
        code: this.failure.code,
        error: setupSentence(this.failure.code, engine),
      };
    }
    return { state: "idle", engine };
  }

  /** Starts the install; while one runs this joins it. A refusal is a fixed sentence. */
  start(engine: EngineId = DEFAULT_ENGINE): { ok: true } | { ok: false; reason: string } {
    if (this.running) return { ok: true };
    if (this.installed(engine)) {
      return {
        ok: false,
        reason:
          engine === "kokoro"
            ? "The realistic voice is already installed."
            : `${VOICE_ENGINES[engine].label} is already installed.`,
      };
    }
    this.failure = null;
    this.running = { engine, progress: { step: "python", text: "Starting…", percent: 0 } };
    this.abort = new AbortController();
    void installNatural(
      this.supportDir,
      (progress) => {
        if (this.running) this.running.progress = progress;
      },
      {
        engine,
        ...(this.options.deps ? { deps: this.options.deps } : {}),
        signal: this.abort.signal,
        ...(this.options.log ? { log: this.options.log } : {}),
      },
    ).then((result) => {
      this.running = null;
      this.abort = null;
      this.failure = result.ok ? null : { engine, code: result.code };
    });
    return { ok: true };
  }

  /**
   * Deletes an engine's folder (its venv, weights and cached sentences). Not while an install runs, not the engine
   * in use (`current`), and not Kokoro while it is the only one installed: calls always keep a voice to fall back on.
   */
  remove(engine: EngineId, current: EngineId): { ok: true } | { ok: false; reason: string } {
    if (this.running) return { ok: false, reason: "Wait for the install that is running to finish." };
    if (engine === current) return { ok: false, reason: "That voice engine is in use. Choose another first." };
    if (engine === "kokoro" && this.installedEngines().filter((id) => id !== "kokoro").length === 0) {
      return { ok: false, reason: "Kokoro is the only voice engine installed." };
    }
    try {
      fs.rmSync(naturalPaths(this.supportDir, engine).dir, { recursive: true, force: true });
    } catch {
      return { ok: false, reason: "This Mac could not remove that voice engine." };
    }
    if (this.failure?.engine === engine) this.failure = null;
    return { ok: true };
  }

  /** Daemon shutdown: stops the download; what is on disk resumes next time. */
  stop(): void {
    this.abort?.abort();
  }
}
