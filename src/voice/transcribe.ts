import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Speech to text for a recorded memo. Injected in tests. */
export interface Transcriber {
  transcribe(audio: Buffer): Promise<string>;
  /**
   * A recording that came up in pieces: each piece (an Ogg Opus clip) is decoded to 16 kHz mono 16-bit PCM as it
   * arrives (`decode`), and the pieces together are transcribed as one recording (`transcribePcm`). Absent: the Mac
   * does not take pieces.
   */
  decode?(opus: Buffer): Promise<Buffer>;
  transcribePcm?(pcm: Buffer): Promise<string>;
}

/** A 16 kHz mono 16-bit WAV of `pcm`. */
export function wav16k(pcm: Buffer): Buffer {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVEfmt ", 8, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24);
  head.writeUInt32LE(32000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
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
      return await this.whisper(wav);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** One Opus clip as 16 kHz mono PCM; the clips of a recording decode apart and are joined end to end. */
  async decode(opus: Buffer): Promise<Buffer> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-part-"));
    try {
      const input = path.join(dir, "part.ogg");
      fs.writeFileSync(input, opus);
      const { stdout } = await run(
        this.paths.ffmpeg,
        ["-loglevel", "error", "-i", input, "-ar", "16000", "-ac", "1", "-f", "s16le", "pipe:1"],
        { timeout: 30_000, encoding: "buffer", maxBuffer: 64_000_000 },
      );
      return stdout;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async transcribePcm(pcm: Buffer): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-memo-"));
    try {
      const wav = path.join(dir, "memo.wav");
      fs.writeFileSync(wav, wav16k(pcm));
      return await this.whisper(wav);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  private async whisper(wav: string): Promise<string> {
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
