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
const PYTHONS = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"];

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

function download(url: string, file: string, minBytes: number, say: (text: string) => void): Promise<void> {
  if (fs.existsSync(file) && fs.statSync(file).size >= minBytes) return Promise.resolve();
  say(`Downloading ${file.split("/").pop()} (resumes if interrupted)…`);
  return new Promise((resolve, reject) => {
    // `-C -` resumes a partial file; the model is large and the uplink is slow.
    const child = spawn("curl", ["-fL", "-C", "-", "--retry", "5", "-o", file, url], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`curl exited ${code}`));
      if (fs.statSync(file).size < minBytes) return reject(new Error(`${file} is too small: the download failed`));
      resolve();
    });
  });
}

/**
 * `squeak voice-tts-setup`: a Python venv with kokoro-onnx and the model files in `<support>/voice-tts/` (about 350 MB
 * once, nothing sent anywhere after). Safe to run again; it only fills what is missing. Returns the exit code.
 */
export async function runNaturalSetup(supportDir: string, say: (text: string) => void = console.log): Promise<number> {
  const paths = naturalPaths(supportDir);
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  try {
    if (!fs.existsSync(paths.python)) {
      const python = await findPython();
      if (!python) {
        say("Squeak's natural voice needs Python 3.10 or newer (brew install python).");
        return 1;
      }
      say("Making the voice's Python environment…");
      await run(python, ["-m", "venv", `${paths.dir}/venv`]);
    }
    say("Installing the speech engine…");
    await run(paths.python, ["-m", "pip", "install", "-q", "--disable-pip-version-check", "kokoro-onnx", "numpy"], {
      timeout: 600_000,
    });
    await download(MODEL_URL, paths.model, MODEL_MIN_BYTES, say);
    await download(VOICES_URL, paths.voices, VOICES_MIN_BYTES, say);
    fs.writeFileSync(paths.worker, NATURAL_WORKER_PY, { mode: 0o600 });
    if (!naturalInstalled(paths)) {
      say("Setup finished but something is still missing.");
      return 1;
    }
    say("The natural voice is ready. Squeak uses it for phone calls from now on.");
    return 0;
  } catch (error) {
    say(`Natural voice setup failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
