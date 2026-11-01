import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureReferenceClips, type NaturalSetupDeps } from "./natural-setup.js";
import {
  availableVoices,
  engineTag,
  naturalInstalled,
  naturalPaths,
  NaturalSettingsStore,
  NaturalVoice,
} from "./natural-voice.js";
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
  const withEngine = async (run: (dir: string, ming: ReturnType<typeof naturalPaths>) => void | Promise<void>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-engines-"));
    try {
      const ming = naturalPaths(dir, "ming");
      for (const file of [ming.python, ming.worker, ...(ming.required ?? [])]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "x");
      }
      await run(dir, ming);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const clip = (ming: { dir: string }, voice: string) => {
    fs.mkdirSync(path.join(ming.dir, "refs"), { recursive: true });
    fs.writeFileSync(referenceClip(ming.dir, voice), "x");
  };

  it("counts as installed without reference clips, but lists only the voices whose clip exists", async () => {
    await withEngine((_dir, ming) => {
      expect(naturalInstalled(ming)).toBe(true);
      expect(availableVoices(ming, "ming")).toEqual([]);
      clip(ming, "am_michael");
      clip(ming, "af_nicole"); // not a Ming voice at all
      expect(availableVoices(ming, "ming").map((voice) => voice.id)).toEqual(["am_michael"]);
      expect(availableVoices(ming, "qwen3").length).toBe(VOICE_ENGINES.qwen3.voices.length);
      expect(availableVoices(ming, "kokoro").length).toBe(7);
    });
  });

  it("falls back to Heart for a voice with no clip, without touching the saved pick", async () => {
    await withEngine((_dir, ming) => {
      const file = path.join(path.dirname(ming.dir), "natural.json");
      const store = new NaturalSettingsStore(
        file,
        () => true,
        (engine, voice) => availableVoices(ming, engine).some((entry) => entry.id === voice),
      );
      expect(store.apply({ engine: "ming", voice: "bm_george" })).toEqual({ ok: true });
      clip(ming, "af_heart");
      expect(store.settings).toMatchObject({ voice: "af_heart", voices: { ming: "bm_george" } });
      expect(store.spoken("ming")).toBe("af_heart");
      expect(JSON.parse(fs.readFileSync(file, "utf8")).voices.ming).toBe("bm_george");
      clip(ming, "bm_george");
      expect(store.settings.voice).toBe("bm_george");
    });
  });

  it("cannot speak, so calls use the add-on, until some clip exists; a voice without one is not rendered", async () => {
    await withEngine(async (_dir, ming) => {
      const settings = { enabled: true, voice: "af_heart", engine: "ming" as const };
      const natural = new NaturalVoice(ming, () => settings);
      expect(natural.usable).toBe(false);
      expect(await natural.preview("af_heart", "ming")).toBeNull();
      clip(ming, "af_heart");
      expect(natural.usable).toBe(true);
      expect(await natural.preview("bm_george", "ming")).toBeNull(); // no clip for George yet
    });
  });

  it("keys Ming's cache apart from its old one", async () => {
    await withEngine((_dir, ming) => {
      const tag = engineTag(ming, "ming");
      expect(tag).toContain("ming-Ming-3.0-tts-0.5B-bf16-clone-");
      expect(engineTag(ming, "chatterbox")).not.toContain("clone");
    });
  });
});

describe("ensureReferenceClips", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-refs-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const touch = (file: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x");
  };
  const install = (engine: "kokoro" | "ming" | "chatterbox") => {
    const paths = naturalPaths(dir, engine);
    for (const file of [paths.python, paths.worker, ...(paths.required ?? [paths.model, paths.voices])]) touch(file);
    return paths;
  };
  const deps = (made: Array<[string, string[]]>, extra: Partial<NaturalSetupDeps> = {}): NaturalSetupDeps => ({
    findPython: async () => "/fake/python3",
    makeVenv: async (_python, to) => touch(path.join(to, "venv", "bin", "python3")),
    pipInstall: async () => undefined,
    download: async (_url, file) => touch(file),
    listRepo: async () => [],
    findCached: () => null,
    makeReferenceClips: async (_kokoro, folder, voices) => {
      made.push([path.basename(folder), [...voices]]);
      for (const voice of voices) touch(referenceClip(folder, voice));
    },
    freeBytes: () => 50_000_000_000,
    ...extra,
  });

  it("makes only the missing clips of installed cloning engines, with Kokoro already there", async () => {
    install("kokoro");
    const ming = install("ming");
    const chatterbox = install("chatterbox");
    for (const voice of VOICE_ENGINES.chatterbox.voices) touch(referenceClip(chatterbox.dir, voice.id));
    touch(referenceClip(ming.dir, "af_heart"));
    const made: Array<[string, string[]]> = [];
    expect(await ensureReferenceClips(dir, { deps: deps(made) })).toEqual(["ming"]);
    expect(made).toEqual([["voice-tts-ming", ids("ming").filter((id) => id !== "af_heart")]]);
    expect(availableVoices(ming, "ming").map((voice) => voice.id)).toEqual(ids("ming"));
    expect(await ensureReferenceClips(dir, { deps: deps(made) })).toEqual([]); // nothing left: nothing made
    expect(made).toHaveLength(1);
  });

  it("does nothing, and installs nothing, when no cloning engine is installed", async () => {
    const made: Array<[string, string[]]> = [];
    expect(await ensureReferenceClips(dir, { deps: deps(made) })).toEqual([]);
    expect(naturalInstalled(naturalPaths(dir))).toBe(false);
    expect(made).toEqual([]);
  });

  it("installs Kokoro first when it is missing, then makes the clips", async () => {
    install("ming");
    const made: Array<[string, string[]]> = [];
    expect(await ensureReferenceClips(dir, { deps: deps(made) })).toEqual(["ming"]);
    expect(naturalInstalled(naturalPaths(dir))).toBe(true);
    expect(made[0]?.[1]).toEqual(ids("ming"));
  });

  it("logs and gives up, never throwing, when Kokoro cannot be installed or a clip fails", async () => {
    install("ming");
    const logged: string[] = [];
    const none = await ensureReferenceClips(dir, {
      deps: deps([], { findPython: async () => null }),
      log: (detail) => logged.push(detail),
    });
    expect(none).toEqual([]);
    expect(logged[0]).toContain("Kokoro could not be installed");
    install("kokoro");
    const failed = await ensureReferenceClips(dir, {
      deps: deps([], {
        makeReferenceClips: async () => {
          throw new Error("kokoro crashed");
        },
      }),
      log: (detail) => logged.push(detail),
    });
    expect(failed).toEqual([]);
    expect(logged.at(-1)).toContain("kokoro crashed");
  });
});
