import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { engineTag, naturalPaths } from "./natural-voice.js";
import {
  engineHasVoice,
  migrateVoice,
  NATURAL_VOICES,
  referenceClip,
  renameLegacyVoice,
  VOICE_ENGINES,
} from "./voice-engines.js";

const ids = (engine: keyof typeof VOICE_ENGINES) => VOICE_ENGINES[engine].voices.map((voice) => voice.id);
const shared = NATURAL_VOICES.map((voice) => voice.id);

describe("the shared voice list", () => {
  it("is all seven names on Kokoro, and only shared names on Ming and Chatterbox, in the shared order", () => {
    expect(ids("kokoro")).toEqual(shared);
    expect(shared).toEqual(["af_heart", "af_bella", "af_nicole", "bf_emma", "am_michael", "am_adam", "bm_george"]);
    for (const engine of ["ming", "chatterbox"] as const) {
      expect(ids(engine).length).toBeGreaterThan(0);
      expect(shared.filter((id) => ids(engine).includes(id))).toEqual(ids(engine));
      expect(VOICE_ENGINES[engine].voices).toEqual(NATURAL_VOICES.filter((v) => ids(engine).includes(v.id)));
      expect(ids(engine)).toContain(VOICE_ENGINES[engine].defaultVoice);
    }
  });

  it("offers each cloning engine exactly the voices that passed the clarity check", () => {
    expect(ids("ming")).toEqual(["af_heart", "af_bella", "bf_emma", "am_michael", "am_adam", "bm_george"]);
    expect(ids("chatterbox")).toEqual(["af_heart", "af_bella", "af_nicole", "am_michael", "am_adam", "bm_george"]);
  });

  it("leaves Qwen3's own list alone", () => {
    expect(ids("qwen3").slice(0, 5)).toEqual(["aiden", "ryan", "eric", "sohee", "ono_anna"]);
    expect(engineHasVoice("qwen3", "af_heart")).toBe(false);
  });

  it("no longer offers Ming's built-in voices", () => {
    for (const old of ["US_Emma", "US_Stella", "US_James", "UK_Charlotte", "UK_George"]) {
      expect(engineHasVoice("ming", old)).toBe(false);
    }
  });
});

describe("Ming's former voices", () => {
  it("map onto the shared list, and anything unknown onto Heart", () => {
    expect(renameLegacyVoice("ming", "US_Emma")).toBe("af_bella");
    expect(renameLegacyVoice("ming", "UK_Charlotte")).toBe("bf_emma");
    expect(renameLegacyVoice("chatterbox", "US_Emma")).toBe("US_Emma");
    expect(migrateVoice("ming", "US_James")).toBe("am_michael");
    expect(migrateVoice("ming", "UK_George")).toBe("bm_george");
    expect(migrateVoice("ming", "US_Stella")).toBe("af_heart"); // Nicole did not pass on Ming
    expect(migrateVoice("ming", "nobody")).toBe("af_heart");
    expect(migrateVoice("ming", "bm_george")).toBe("bm_george");
    expect(migrateVoice("ming", undefined)).toBeUndefined();
  });
});

describe("clone engines on disk", () => {
  it("need a reference clip per offered voice, and key Ming's cache apart from its old one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-engines-"));
    try {
      const ming = naturalPaths(dir, "ming");
      for (const voice of ids("ming")) expect(ming.required).toContain(referenceClip(ming.dir, voice));
      expect(naturalPaths(dir, "qwen3").required?.some((file) => file.includes("refs"))).toBe(false);
      fs.mkdirSync(path.dirname(ming.required![0]!), { recursive: true });
      fs.writeFileSync(ming.required![0]!, "x");
      const tag = engineTag({ ...ming, required: [ming.required![0]!] }, "ming");
      expect(tag).toContain("ming-Ming-3.0-tts-0.5B-bf16-clone-");
      expect(engineTag({ ...ming, required: [ming.required![0]!] }, "chatterbox")).not.toContain("clone");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
