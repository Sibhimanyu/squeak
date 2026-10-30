import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

import { naturalInstalled, naturalPaths } from "./natural-voice.js";
import { NATURAL_WORKER_PY } from "./natural-worker.js";

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

/** The effects, so a test never makes a venv, runs pip or touches the network. */
export interface NaturalSetupDeps {
  findPython(): Promise<string | null>;
  makeVenv(python: string, dir: string): Promise<void>;
  pipInstall(venvPython: string): Promise<void>;
  /** Fetches `url` into `file`, resuming a partial one; reports the bytes on disk. Rejects with a `NaturalSetupError`. */
  download(
    url: string,
    file: string,
    minBytes: number,
    onBytes: (bytes: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
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

/** A Python new enough for Kokoro's runtime (3.10+), or null. */
async function findPython(): Promise<string | null> {
  for (const candidate of PYTHONS) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const { stdout } = await run(candidate, ["-c", "import sys; print(sys.version_info[0]*100+sys.version_info[1])"]);
      if (Number(stdout.trim()) >= 310) return candidate;
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

function download(
  url: string,
  file: string,
  minBytes: number,
  onBytes: (bytes: number) => void,
  signal: AbortSignal,
): Promise<void> {
  if (fs.existsSync(file) && fs.statSync(file).size >= minBytes) return Promise.resolve();
  return new Promise((resolve, reject) => {
    // `-C -` resumes a partial file; the model is large and the uplink is slow. `-sS`: no progress meter, errors only.
    const child = spawn("curl", ["-fLsS", "-C", "-", "--retry", "5", "-o", file, url], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const size = () => {
      try {
        return fs.statSync(file).size;
      } catch {
        return 0;
      }
    };
    const timer = setInterval(() => onBytes(size()), 700);
    const stop = () => child.kill("SIGTERM");
    signal.addEventListener("abort", stop, { once: true });
    const finish = (done: () => void) => {
      clearInterval(timer);
      signal.removeEventListener("abort", stop);
      done();
    };
    child.on("error", () => finish(() => reject(new NaturalSetupError("failed", "curl could not start"))));
    child.on("exit", (code) =>
      finish(() => {
        if (signal.aborted) return reject(new NaturalSetupError("failed", "stopped"));
        if (code !== 0) return reject(curlError(code));
        if (size() < minBytes) return reject(new NaturalSetupError("failed", `${file} is too small`));
        onBytes(size());
        resolve();
      }),
    );
  });
}

const PIP_NETWORK =
  /could not find a version|connection|temporary failure|name or service|proxy|ssl|network|timed out/i;

export const realNaturalSetupDeps: NaturalSetupDeps = {
  findPython,
  makeVenv: async (python, dir) => {
    await run(python, ["-m", "venv", `${dir}/venv`]);
  },
  pipInstall: async (venvPython) => {
    try {
      await run(venvPython, ["-m", "pip", "install", "-q", "--disable-pip-version-check", "kokoro-onnx", "numpy"], {
        timeout: 600_000,
      });
    } catch (error) {
      const text = `${(error as { stderr?: string }).stderr ?? ""} ${error instanceof Error ? error.message : ""}`;
      throw new NaturalSetupError(PIP_NETWORK.test(text) ? "no-network" : "failed", text.slice(0, 300));
    }
  },
  download,
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

function overall(step: keyof typeof SHARE, fraction: number): number {
  const [from, to] = SHARE[step];
  return Math.min(99, Math.round(from + (to - from) * Math.max(0, Math.min(1, fraction))));
}

/**
 * Installs the realistic voice: a Python venv with kokoro-onnx and the model files in `<support>/voice-tts/` (about
 * 350 MB once, nothing sent anywhere after). Safe to run again; it only fills what is missing, and a partial
 * download resumes. Progress goes through `report`; it never throws.
 */
export async function installNatural(
  supportDir: string,
  report: (progress: NaturalSetupProgress) => void,
  options: { deps?: NaturalSetupDeps; signal?: AbortSignal; log?: (detail: string) => void } = {},
): Promise<NaturalSetupResult> {
  const deps = options.deps ?? realNaturalSetupDeps;
  const signal = options.signal ?? new AbortController().signal;
  const paths = naturalPaths(supportDir);
  try {
    fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const free = deps.freeBytes(paths.dir);
    // Only what is still missing needs room: a resumed install with the model on disk needs little.
    if (!naturalInstalled(paths) && free !== null && free < NATURAL_MIN_FREE_BYTES) {
      const have = (file: string) => {
        try {
          return fs.statSync(file).size;
        } catch {
          return 0;
        }
      };
      const stillNeeded =
        MODEL_APPROX_BYTES - have(paths.model) + (VOICES_APPROX_BYTES - have(paths.voices)) + 200_000_000;
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
    await deps.pipInstall(paths.python);
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
      say(fs.existsSync(file) ? fs.statSync(file).size : 0);
      await deps.download(url, file, min, say, signal);
    };
    await fetch("model", "the voice model", MODEL_URL, paths.model, MODEL_MIN_BYTES, MODEL_APPROX_BYTES);
    await fetch("voices", "the voice list", VOICES_URL, paths.voices, VOICES_MIN_BYTES, VOICES_APPROX_BYTES);
    report({ step: "finishing", text: "Finishing up…", percent: 99 });
    fs.writeFileSync(paths.worker, NATURAL_WORKER_PY, { mode: 0o600 });
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

/**
 * `squeak voice-tts-setup`: the same install in a terminal. Returns the exit code. Progress prints at each step and
 * every 10% of a download; the detail of a failure is printed here (it is the person's own terminal).
 */
export async function runNaturalSetup(supportDir: string, say: (text: string) => void = console.log): Promise<number> {
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
    { log: (detail) => say(`Detail: ${detail}`) },
  );
  if (result.ok) {
    say("The natural voice is ready. Squeak uses it for phone calls from now on.");
    return 0;
  }
  say(`Natural voice setup failed: ${NATURAL_SETUP_SENTENCES[result.code]}`);
  return 1;
}

export type NaturalInstallStatus =
  | { state: "idle" }
  | { state: "running"; step: NaturalSetupStep; text: string; percent?: number; bytes?: number; totalBytes?: number }
  | { state: "ready" }
  | { state: "failed"; code: NaturalSetupCode; error: string };

/** The one install the daemon runs at a time, in the background; the Mac app polls `status()`. */
export class NaturalInstaller {
  private running: { progress: NaturalSetupProgress } | null = null;
  private failure: { code: NaturalSetupCode } | null = null;
  private abort: AbortController | null = null;

  constructor(
    private readonly supportDir: string,
    private readonly options: { deps?: NaturalSetupDeps; log?: (detail: string) => void } = {},
  ) {}

  status(): NaturalInstallStatus {
    if (this.running) return { state: "running", ...this.running.progress };
    if (naturalInstalled(naturalPaths(this.supportDir))) return { state: "ready" };
    if (this.failure)
      return { state: "failed", code: this.failure.code, error: NATURAL_SETUP_SENTENCES[this.failure.code] };
    return { state: "idle" };
  }

  /** Starts the install; while one runs this joins it. A refusal is a fixed sentence. */
  start(): { ok: true } | { ok: false; reason: string } {
    if (this.running) return { ok: true };
    if (naturalInstalled(naturalPaths(this.supportDir))) {
      return { ok: false, reason: "The realistic voice is already installed." };
    }
    this.failure = null;
    this.running = { progress: { step: "python", text: "Starting…", percent: 0 } };
    this.abort = new AbortController();
    void installNatural(
      this.supportDir,
      (progress) => {
        if (this.running) this.running.progress = progress;
      },
      {
        ...(this.options.deps ? { deps: this.options.deps } : {}),
        signal: this.abort.signal,
        ...(this.options.log ? { log: this.options.log } : {}),
      },
    ).then((result) => {
      this.running = null;
      this.abort = null;
      this.failure = result.ok ? null : { code: result.code };
    });
    return { ok: true };
  }

  /** Daemon shutdown: stops the download; what is on disk resumes next time. */
  stop(): void {
    this.abort?.abort();
  }
}
