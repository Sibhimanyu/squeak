import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** 8 kHz mono 16-bit: what a phone line carries, and what baresip's `aufile` plays without resampling. */
const SAMPLE_RATE = 8000;
const WAV_HEADER_BYTES = 44;

/** Speech as a WAV file the line can play. Injected in tests. */
export interface Speaker {
  /** Writes `text` to a new WAV file and returns its path and length. */
  speak(text: string): Promise<{ file: string; durationMs: number }>;
  dispose(): void;
}

/** Length of a 16-bit mono PCM WAV with a plain 44-byte header, which is what `afconvert` writes here. */
export function wavDurationMs(bytes: number): number {
  return Math.max(0, Math.round(((bytes - WAV_HEADER_BYTES) / (SAMPLE_RATE * 2)) * 1000));
}

/** macOS `say`, then `afconvert` to a telephone WAV. The text goes in on stdin, never as an argument. */
export class MacSpeaker implements Speaker {
  private readonly dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-voice-"));
  private count = 0;

  constructor(private readonly voice: string | null = null) {}

  async speak(text: string): Promise<{ file: string; durationMs: number }> {
    const base = path.join(this.dir, `p${this.count++}`);
    const args = ["-o", `${base}.aiff`, "-f", "-", ...(this.voice ? ["-v", this.voice] : [])];
    await new Promise<void>((resolve, reject) => {
      const child = spawn("say", args, { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`say exited ${code}: ${stderr.trim()}`))));
      child.stdin.end(text);
    });
    await run("afconvert", ["-f", "WAVE", "-d", `LEI16@${SAMPLE_RATE}`, "-c", "1", `${base}.aiff`, `${base}.wav`]);
    fs.rmSync(`${base}.aiff`, { force: true });
    return { file: `${base}.wav`, durationMs: wavDurationMs(fs.statSync(`${base}.wav`).size) };
  }

  dispose(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
