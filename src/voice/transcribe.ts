import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Speech to text for a recorded memo. Injected in tests. */
export interface Transcriber {
  transcribe(audio: Buffer): Promise<string>;
}

export interface WhisperPaths {
  /** whisper.cpp's `whisper-cli`. */
  whisper: string;
  ffmpeg: string;
  /** A ggml model, e.g. `ggml-base.en.bin`. */
  model: string;
}

const CANDIDATES = {
  whisper: ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"],
  ffmpeg: ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"],
};

/** The tools and model if all three are here, else null (calling in then stays off, with the reason logged). */
export function findWhisper(model: string, exists: (file: string) => boolean = fs.existsSync): WhisperPaths | null {
  const whisper = CANDIDATES.whisper.find(exists);
  const ffmpeg = CANDIDATES.ffmpeg.find(exists);
  return whisper && ffmpeg && exists(model) ? { whisper, ffmpeg, model } : null;
}

/**
 * Whisper on this Mac: `ffmpeg` turns the Opus memo into 16 kHz PCM and `whisper-cli` reads it. Local, so the
 * audio never leaves the machine after the sealed hop from Home Assistant; about a third of a second for a
 * sentence on Apple silicon.
 */
export class WhisperTranscriber implements Transcriber {
  constructor(private readonly paths: WhisperPaths) {}

  async transcribe(audio: Buffer): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-memo-"));
    try {
      const input = path.join(dir, "memo.ogg");
      const wav = path.join(dir, "memo.wav");
      fs.writeFileSync(input, audio);
      await run(
        this.paths.ffmpeg,
        ["-y", "-loglevel", "error", "-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav],
        {
          timeout: 30_000,
        },
      );
      const { stdout } = await run(
        this.paths.whisper,
        [
          "-m",
          this.paths.model,
          "-f",
          wav,
          "-nt",
          "-np",
          "-l",
          "en",
          // Words people say to their agents that a general model mishears.
          "--prompt",
          WHISPER_VOCABULARY,
        ],
        {
          timeout: 90_000,
          maxBuffer: 1_000_000,
        },
      );
      return cleanTranscript(stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Spelling hints for whisper's decoder: product and tool names that come up in messages to coding agents. */
export const WHISPER_VOCABULARY =
  "Telegram, Squeak, Conductor, Claude, Codex, GitHub, pull request, Xcode, TypeScript, Firebase, Home Assistant.";

/** One line of plain words: no control characters, no bracketed sound notes like "[BLANK_AUDIO]". */
export function cleanTranscript(raw: string): string {
  return (
    raw
      .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1500)
  );
}
