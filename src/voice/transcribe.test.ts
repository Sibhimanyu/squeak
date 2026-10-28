import { describe, expect, it } from "vitest";

import { cleanTranscript, findWhisper } from "./transcribe.js";

describe("cleanTranscript", () => {
  it("keeps the words and drops sound notes and control characters", () => {
    expect(cleanTranscript("\n [BLANK_AUDIO]  Tell it to go (laughs) with B.\u0007\n")).toBe("Tell it to go with B.");
    expect(cleanTranscript("[MUSIC]")).toBe("");
  });
});

describe("findWhisper", () => {
  it("needs the tool, ffmpeg and the model", () => {
    const have = (files: string[]) => (f: string) => files.includes(f);
    expect(
      findWhisper("/m.bin", have(["/opt/homebrew/bin/whisper-cli", "/opt/homebrew/bin/ffmpeg", "/m.bin"])),
    ).toEqual({
      whisper: "/opt/homebrew/bin/whisper-cli",
      ffmpeg: "/opt/homebrew/bin/ffmpeg",
      model: "/m.bin",
    });
    expect(findWhisper("/m.bin", have(["/opt/homebrew/bin/whisper-cli", "/opt/homebrew/bin/ffmpeg"]))).toBeNull();
    expect(findWhisper("/m.bin", have(["/m.bin"]))).toBeNull();
  });
});
