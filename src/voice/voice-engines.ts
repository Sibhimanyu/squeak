import path from "node:path";

import { NATURAL_WORKER_PY } from "./natural-worker.js";
import { CHATTERBOX_WORKER_PY, MING_WORKER_PY, QWEN3_WORKER_PY } from "./natural-worker-mlx.js";
import { DESIGNED_VOICES_FILE, designedVoicesJson, QWEN3_DESIGNED_VOICES } from "./qwen3-designed-voices.js";

/**
 * The engines that can make the call voice (docs/voice.md, "Voice engines"): Kokoro (small, plain) and three
 * expressive ones on mlx-audio. Kokoro, Ming and Chatterbox share one voice list. Each lives in its own folder of the support directory, so removing one is deleting a
 * folder, and its weights are fetched there, never into the global Hugging Face cache.
 */

export type EngineId = "kokoro" | "qwen3" | "ming" | "chatterbox";
export const ENGINE_IDS: readonly EngineId[] = ["kokoro", "qwen3", "ming", "chatterbox"];
export const DEFAULT_ENGINE: EngineId = "kokoro";

export const DEFAULT_NATURAL_VOICE = "af_heart";
/** Kokoro voice ids are two letters, an underscore and a name (`af_heart`, `am_michael`, `bf_emma`). */
export const NATURAL_VOICE = /^[a-z]{2}_[a-z]+$/;
/** The Kokoro voices the apps offer in their picker (the daemon accepts any Kokoro name); the Mac app lists the same. */
export const NATURAL_VOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "af_heart", label: "Heart" },
  { id: "af_bella", label: "Bella" },
  { id: "af_nicole", label: "Nicole" },
  { id: "bf_emma", label: "Emma" },
  { id: "am_michael", label: "Michael" },
  { id: "am_adam", label: "Adam" },
  { id: "bm_george", label: "George" },
];

export interface EngineVoice {
  id: string;
  label: string;
}

/**
 * Which of the shared voices (`NATURAL_VOICES`) a cloning engine offers: those whose clone passed the clarity check
 * (Whisper on the 8 kHz phone copy, WER <= 5% and no garbled line). Measured 2026-11-01, docs/voice-tts-bakeoff.md,
 * "One voice list across engines"; a voice that failed is simply not listed. Rerun the check before adding one.
 */
const CLONE_PASSED: Readonly<Record<"ming" | "chatterbox", readonly string[]>> = {
  // 2026-11-01, Whisper on the phone copy over 10 lines: af_heart 3.3%, af_bella 2.9%, bf_emma 2.4%, am_michael 2.9%,
  // am_adam 2.4%, bm_george 2.9%. Left out: af_nicole, 6.7% and a dropped half of the "blocked" line.
  ming: ["af_heart", "af_bella", "bf_emma", "am_michael", "am_adam", "bm_george"],
  // Same day: af_heart 3.3%, af_bella 3.3%, af_nicole 3.3%, am_michael 3.8%, am_adam 3.3%, bm_george 2.9%. Left out:
  // bf_emma, 5.2% (over the 5% bar, by mishearing "parser" and "done", nothing dropped).
  chatterbox: ["af_heart", "af_bella", "af_nicole", "am_michael", "am_adam", "bm_george"],
};
const cloneVoices = (engine: "ming" | "chatterbox"): EngineVoice[] =>
  NATURAL_VOICES.filter((voice) => CLONE_PASSED[engine].includes(voice.id));

/** Ming's built-in voices of earlier versions, and the shared voice each one became. */
const LEGACY_MING_VOICES: Readonly<Record<string, string>> = {
  US_Emma: "af_bella",
  US_Stella: "af_nicole",
  US_James: "am_michael",
  UK_Charlotte: "bf_emma",
  UK_George: "bm_george",
};

/** One of Ming's former voice ids as the shared voice it became; anything else comes back as it was. */
export function renameLegacyVoice(engine: EngineId, voice: unknown): unknown {
  if (engine !== "ming" || typeof voice !== "string" || !Object.hasOwn(LEGACY_MING_VOICES, voice)) return voice;
  return LEGACY_MING_VOICES[voice];
}

/** A voice named in a request as this version names it: a former Ming id is migrated, anything else is left to be checked. */
export function resolveVoiceRequest(engine: EngineId, voice: unknown): unknown {
  return renameLegacyVoice(engine, voice) !== voice ? migrateVoice(engine, voice) : voice;
}

/** Whether an engine speaks by cloning reference clips (made with Kokoro), so a voice exists only once its clip does. */
export function usesReferenceClips(engine: EngineId): boolean {
  return engine === "ming" || engine === "chatterbox";
}

/** A saved voice as this version names it: Ming's old voices map to the shared list, an unknown Ming voice to Heart. */
export function migrateVoice(engine: EngineId, voice: unknown): unknown {
  const named = renameLegacyVoice(engine, voice);
  if (engine !== "ming" || typeof named !== "string") return named;
  return engineHasVoice("ming", named) ? named : DEFAULT_NATURAL_VOICE;
}

/** One Hugging Face repo an engine needs, fetched file by file into `<engine folder>/<dir>`. */
export interface EngineRepo {
  repo: string;
  dir: string;
  /** Files that must exist for the repo to count as there (the small ones come along with the listing). */
  proof: string[];
}

export interface VoiceEngine {
  id: EngineId;
  label: string;
  summary: string;
  /** For the apps to show, never exact. */
  size: string;
  /** What setup downloads and unpacks, for the free-space check and the percentage. */
  approxBytes: number;
  emotion: boolean;
  licence: string;
  voices: ReadonlyArray<EngineVoice>;
  defaultVoice: string;
  /** Folder name under the support directory. */
  folder: string;
  /** Python workers kept: MLX engines run one (a second copy would double GPU memory), Kokoro two. */
  workers: 1 | 2;
  /** Names the weights for the sentence cache: a different model never reuses another's clips. */
  model: string;
  repos: readonly EngineRepo[];
  /** Small files Squeak writes beside the worker, at setup and whenever they changed (name: contents). */
  files?: Readonly<Record<string, string>>;
  /** pip packages of the venv (MLX engines). */
  packages: readonly string[];
  worker: string;
}

const MLX_PACKAGES = ["mlx-audio>=0.6.3,<0.7", "numpy", "scipy"];

export const VOICE_ENGINES: Readonly<Record<EngineId, VoiceEngine>> = {
  kokoro: {
    id: "kokoro",
    label: "Kokoro (fast, plain)",
    summary: "Small and quick, an even voice with no emotion.",
    size: "about 350 MB",
    approxBytes: 350_000_000,
    emotion: false,
    licence: "Apache-2.0",
    voices: NATURAL_VOICES,
    defaultVoice: DEFAULT_NATURAL_VOICE,
    folder: "voice-tts",
    workers: 2,
    model: "kokoro-82m",
    repos: [],
    packages: ["kokoro-onnx", "numpy"],
    worker: NATURAL_WORKER_PY,
  },
  qwen3: {
    id: "qwen3",
    label: "Qwen3-TTS (expressive)",
    summary: "Expressive speech with preset speakers; the mood is spoken as an instruction.",
    size: "about 4 GB",
    approxBytes: 4_000_000_000,
    emotion: true,
    licence: "Apache-2.0",
    voices: [
      { id: "aiden", label: "Aiden" },
      { id: "ryan", label: "Ryan" },
      { id: "eric", label: "Eric" },
      { id: "sohee", label: "Sohee" },
      { id: "ono_anna", label: "Anna" },
      ...QWEN3_DESIGNED_VOICES.map(({ id, label }) => ({ id, label })),
    ],
    defaultVoice: "aiden",
    folder: "voice-tts-qwen3",
    workers: 1,
    model: "Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit",
    repos: [
      {
        repo: "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit",
        dir: "model",
        proof: ["model.safetensors", "speech_tokenizer/model.safetensors", "config.json"],
      },
    ],
    packages: MLX_PACKAGES,
    worker: QWEN3_WORKER_PY,
    files: { [DESIGNED_VOICES_FILE]: designedVoicesJson() },
  },
  ming: {
    id: "ming",
    label: "Ming (fast, expressive)",
    summary: "Quick and expressive; speaks in the shared voices, with emotion, pace and pitch.",
    size: "about 4 GB",
    approxBytes: 4_000_000_000,
    emotion: true,
    licence: "MIT",
    voices: cloneVoices("ming"),
    defaultVoice: DEFAULT_NATURAL_VOICE,
    folder: "voice-tts-ming",
    workers: 1,
    model: "Ming-3.0-tts-0.5B-bf16",
    repos: [
      {
        repo: "mlx-community/Ming-3.0-tts-0.5B-bf16",
        dir: "model",
        proof: ["model.safetensors", "config.json"],
      },
    ],
    packages: MLX_PACKAGES,
    worker: MING_WORKER_PY,
  },
  chatterbox: {
    id: "chatterbox",
    label: "Chatterbox (expressive)",
    summary: "Natural, lively speech that clones a short reference clip; the mood is its exaggeration.",
    size: "about 4 GB",
    approxBytes: 4_000_000_000,
    emotion: true,
    licence: "MIT",
    voices: cloneVoices("chatterbox"),
    defaultVoice: DEFAULT_NATURAL_VOICE,
    folder: "voice-tts-chatterbox",
    workers: 1,
    model: "Chatterbox-TTS-fp16",
    repos: [
      {
        repo: "mlx-community/Chatterbox-TTS-fp16",
        dir: "model",
        proof: ["model.safetensors", "tokenizer.json", "config.json"],
      },
      { repo: "mlx-community/S3TokenizerV2", dir: "s3tokenizer", proof: ["model.safetensors", "config.json"] },
    ],
    packages: MLX_PACKAGES,
    worker: CHATTERBOX_WORKER_PY,
  },
};

export function isEngineId(value: unknown): value is EngineId {
  return typeof value === "string" && (ENGINE_IDS as readonly string[]).includes(value);
}

/** Whether `voice` is one this engine can speak (Kokoro takes any of its names). */
export function engineHasVoice(engine: EngineId, voice: unknown): voice is string {
  if (typeof voice !== "string") return false;
  if (engine === "kokoro") return NATURAL_VOICE.test(voice);
  return VOICE_ENGINES[engine].voices.some((entry) => entry.id === voice);
}

/** The folder an engine lives in. */
export function engineDir(supportDir: string, engine: EngineId): string {
  return path.join(supportDir, VOICE_ENGINES[engine].folder);
}

/** The reference clip Ming and Chatterbox clone for a voice, made with Kokoro at setup. */
export function referenceClip(dir: string, voice: string): string {
  return path.join(dir, "refs", `${voice}.wav`);
}
