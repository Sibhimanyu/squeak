import { describe, expect, it } from "vitest";

import { chooseSpeaker, envFromAddonOptions } from "./gateway-main.js";
import { EspeakSpeaker } from "./tts.js";
import { wavDurationMs } from "./tts.js";

describe("envFromAddonOptions", () => {
  it("maps add-on options to the settings the Mac reads, skipping blanks and non-strings", () => {
    expect(
      envFromAddonOptions({
        sip_host: "1348.3cx.cloud",
        sip_proxy: " 192.168.68.114:5060 ",
        pin: "",
        extension: 35217,
        password: "pw",
        other: "x",
      }),
    ).toEqual({
      SQUEAK_VOICE_HOST: "1348.3cx.cloud",
      SQUEAK_VOICE_PROXY: "192.168.68.114:5060",
      SQUEAK_VOICE_PASSWORD: "pw",
    });
    expect(envFromAddonOptions(null)).toEqual({});
  });

  it("ignores a leftover pin or callee option: both are set from the app", () => {
    expect(envFromAddonOptions({ pin: "2008", callee: "101", sip_host: "h" })).toEqual({ SQUEAK_VOICE_HOST: "h" });
  });
});

describe("wavDurationMs", () => {
  function wav(extraChunk: boolean, samples: number): Buffer {
    const data = Buffer.alloc(samples * 2);
    const chunks = [Buffer.from("fmt ").subarray(0), Buffer.alloc(0)];
    void chunks;
    const fmt = Buffer.alloc(24);
    fmt.write("fmt ", 0);
    fmt.writeUInt32LE(16, 4);
    const list = extraChunk
      ? Buffer.concat([Buffer.from("LIST"), Buffer.from([4, 0, 0, 0]), Buffer.from("INFO")])
      : Buffer.alloc(0);
    const head = Buffer.alloc(8);
    head.write("data", 0);
    head.writeUInt32LE(data.length, 4);
    return Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVE"), fmt, list, head, data]);
  }

  it("reads the data chunk whether or not a LIST chunk comes first", () => {
    expect(wavDurationMs(wav(false, 8000))).toBe(1000);
    expect(wavDurationMs(wav(true, 4000))).toBe(500);
    expect(wavDurationMs(Buffer.from("junk"))).toBe(0);
  });
});

describe("chooseSpeaker", () => {
  it("is plain when asked, even if piper is installed", () => {
    const speaker = chooseSpeaker({
      SQUEAK_VOICE_SPEECH: "plain",
      SQUEAK_PIPER_BIN: process.execPath,
      SQUEAK_PIPER_MODEL: process.execPath,
    });
    expect(speaker).toBeInstanceOf(EspeakSpeaker);
    speaker.dispose();
  });

  it("is plain when piper is not in the image", () => {
    const speaker = chooseSpeaker({ SQUEAK_PIPER_BIN: "/nonexistent/piper", SQUEAK_PIPER_MODEL: "/nonexistent.onnx" });
    expect(speaker).toBeInstanceOf(EspeakSpeaker);
    speaker.dispose();
  });
});
