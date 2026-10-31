import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { CachedSpeaker, PiperSpeaker, type Speaker } from "./tts.js";

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
  it("gives up on a piper that is too slow and speaks plainly instead", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slow-piper-"));
    const binary = path.join(dir, "piper");
    fs.writeFileSync(binary, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    const fallback = plain("plain");
    const speaker = new PiperSpeaker({ binary, model: "unused", timeoutMs: 300 }, fallback);
    const started = Date.now();
    await speaker.speak("slow one");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(fallback.spoken).toEqual(["plain:slow one"]);
    speaker.dispose();
    fs.rmSync(dir, { recursive: true });
  });

  it.runIf(hasFfmpeg)(
    "stands piper still while a call is up, without counting that time against it",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "held-piper-"));
      const ticks = path.join(dir, "ticks");
      const go = path.join(dir, "go");
      const tone = path.join(dir, "tone.wav");
      const binary = path.join(dir, "piper");
      execFileSync("ffmpeg", [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-ar",
        "22050",
        "-ac",
        "1",
        tone,
      ]);
      // Works (a mark every 50 ms) until told to finish, then writes a WAV made beforehand.
      fs.writeFileSync(
        binary,
        `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "--output_file" ] && out="$2"; shift; done\ncat > /dev/null\nwhile [ ! -f "${go}" ]; do echo x >> "${ticks}"; sleep 0.05; done\ncp "${tone}" "$out"\n`,
        { mode: 0o755 },
      );
      const fallback = plain("plain");
      const speaker = new PiperSpeaker({ binary, model: "unused", timeoutMs: 2500 }, fallback);
      // A call is up from the start: piper is stopped at the first look.
      let call = true;
      speaker.holdWhile(() => call);
      const made = speaker.speak("a prompt made ahead");
      await new Promise((resolve) => setTimeout(resolve, 2800));
      const marks = () => (fs.existsSync(ticks) ? fs.readFileSync(ticks, "utf8").length : 0);
      const during = marks();
      await new Promise((resolve) => setTimeout(resolve, 600));
      // Stood still, and held past its 2.5 s limit without being killed.
      expect(marks()).toBe(during);
      fs.writeFileSync(go, "");
      call = false;
      expect((await made).durationMs).toBeGreaterThan(900);
      expect(fallback.spoken).toEqual([]);
      speaker.dispose();
      fs.rmSync(dir, { recursive: true });
    },
    20_000,
  );

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
    // "Press star" says the same words again: piper is not run twice for them.
    fs.writeFileSync(seen, "");
    await speaker.speak("Which one?\n\nPress 1   for A.");
    expect(fs.readFileSync(seen, "utf8")).toBe("");
    speaker.dispose();
    fs.rmSync(dir, { recursive: true });
  });
});

describe("CachedSpeaker", () => {
  it("says the same words once and serves them from memory after", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cached-speaker-"));
    let made = 0;
    const inner: Speaker = {
      async speak(text) {
        made++;
        const file = path.join(dir, `${made}.wav`);
        fs.writeFileSync(file, text);
        return { file, durationMs: text.length };
      },
      dispose() {},
    };
    const speaker = new CachedSpeaker(inner, 2);
    const a = await speaker.speak("one");
    expect(await speaker.speak("one")).toEqual(a);
    expect(made).toBe(1);
    // Past the limit the stalest goes, with its file; the one just used stays.
    await speaker.speak("two");
    await speaker.speak("one");
    await speaker.speak("three");
    expect(fs.existsSync(a.file)).toBe(true);
    await speaker.speak("two");
    expect(made).toBe(4);
    fs.rmSync(dir, { recursive: true });
  });

  it("prewarms what it is given and shrugs off one that fails", async () => {
    const spoken: string[] = [];
    const speaker = new CachedSpeaker({
      async speak(text) {
        if (text === "bad") throw new Error("no voice");
        spoken.push(text);
        return { file: "/nonexistent", durationMs: 1 };
      },
      dispose() {},
    });
    await speaker.prewarm(["a", "bad", "b"]);
    expect(spoken).toEqual(["a", "b"]);
  });
});
