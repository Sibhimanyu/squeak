import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { PiperSpeaker, type Speaker } from "./tts.js";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function plain(label: string): Speaker & { spoken: string[] } {
  return {
    spoken: [],
    async speak(text) {
      this.spoken.push(`${label}:${text}`);
      return { file: "/tmp/fallback.wav", durationMs: 1 };
    },
    dispose() {},
  };
}

describe("PiperSpeaker", () => {
  it("falls back to the plain voice when piper cannot run", async () => {
    const fallback = plain("plain");
    const speaker = new PiperSpeaker({ binary: "/nonexistent/piper", model: "/nonexistent.onnx" }, fallback);
    expect(await speaker.speak("hello there")).toEqual({ file: "/tmp/fallback.wav", durationMs: 1 });
    expect(fallback.spoken).toEqual(["plain:hello there"]);
    speaker.dispose();
  });

  it.runIf(hasFfmpeg)("turns piper's output into an 8 kHz telephone WAV and keeps the text on one line", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-piper-"));
    const seen = path.join(dir, "stdin.txt");
    const binary = path.join(dir, "piper");
    // A stand-in with piper's interface: reads one line, writes a one second 22.05 kHz WAV to --output_file.
    fs.writeFileSync(
      binary,
      `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "--output_file" ] && out="$2"; shift; done\ncat > "${seen}"\nffmpeg -y -loglevel error -f lavfi -i sine=frequency=440:duration=1 -ar 22050 -ac 1 "$out"\n`,
      { mode: 0o755 },
    );
    const fallback = plain("plain");
    const speaker = new PiperSpeaker({ binary, model: "unused" }, fallback);
    const result = await speaker.speak("Which one?\n\nPress 1   for A.");
    expect(result.durationMs).toBeGreaterThan(900);
    expect(result.durationMs).toBeLessThan(1100);
    expect(fs.readFileSync(seen, "utf8")).toBe("Which one? Press 1 for A.\n");
    expect(fallback.spoken).toEqual([]);
    speaker.dispose();
    fs.rmSync(dir, { recursive: true });
  });
});
