import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatPresetsStore, builtinPresets, readPresetSetup } from "./chat-presets.js";
import type { ChatModel } from "./chat-models.js";

const dirs: string[] = [];
const file = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-presets-"));
  dirs.push(dir);
  return path.join(dir, "chat-presets.json");
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const levels = ["low", "medium", "high"];
const models: ChatModel[] = [
  { agent: "claude", id: "opus-5-5", label: "Opus 5.5", levels: ["low", "high"], defaultLevel: "high", favorite: true },
  { agent: "codex", id: "gpt-6", label: "GPT 6", levels: [], favorite: false },
];
const full: ChatModel[] = [
  { agent: "claude", id: "opus-5-5", label: "Opus 5.5", levels, defaultLevel: "medium", favorite: true },
  { agent: "claude", id: "opus-5-5-1m", label: "Opus 5.5 · 1M", levels, defaultLevel: "medium", favorite: true },
  { agent: "claude", id: "sonnet-5-5", label: "Sonnet 5.5", levels, defaultLevel: "medium", favorite: true },
  { agent: "claude", id: "haiku-4-5", label: "Haiku 4.5", levels: [], favorite: false },
  { agent: "codex", id: "gpt-6", label: "GPT 6", levels: ["low", "high"], favorite: false },
];
const setup = { modelId: "opus-5-5", level: "high", code: "sonnet", run: "haiku", planFirst: true };

describe("builtinPresets", () => {
  it("mixes Claude models by role from what the Mac lists", () => {
    expect(builtinPresets(full)).toEqual({
      best: { modelId: "opus-5-5-1m", level: "high", code: "opus", run: "sonnet", planFirst: false },
      balanced: { modelId: "opus-5-5", level: "medium", code: "sonnet", run: "haiku", planFirst: false },
      save: { modelId: "sonnet-5-5", level: "low", code: "haiku", run: "haiku", planFirst: false },
    });
  });

  it("falls back to the nearest listed model, and makes none without a Claude model", () => {
    expect(builtinPresets([models[0]!]).save?.modelId).toBe("opus-5-5");
    expect(builtinPresets([models[1]!])).toEqual({});
    expect(builtinPresets([])).toEqual({});
  });
});

describe("ChatPresetsStore", () => {
  it("starts with the three built-in presets (Claude's), or none with no model list", () => {
    expect(new ChatPresetsStore(file()).snapshot()).toEqual({ names: {}, presets: {}, setups: {} });
    const snap = new ChatPresetsStore(file(), () => full).snapshot();
    expect(Object.keys(snap.presets)).toEqual(["best", "balanced", "save"]);
    expect(snap.setups).toEqual({ claude: snap.presets });
  });

  it("saves a setup, a name and a reset, 0600, and reads them back", () => {
    const f = file();
    const store = new ChatPresetsStore(f, () => models);
    expect(store.apply({ preset: "save", change: { setup } }).ok).toBe(true);
    expect(store.apply({ preset: "save", change: { name: "  Cheap  " } }).ok).toBe(true);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    const again = new ChatPresetsStore(f, () => models).snapshot();
    expect(again.names).toEqual({ save: "Cheap" });
    expect(again.presets.save).toEqual(setup);
    expect(again.setups.claude?.save).toEqual(setup);
    // A name equal to the built-in title or empty is no name.
    store.apply({ preset: "save", change: { name: "Save usage" } });
    expect(store.snapshot().names).toEqual({});
    store.apply({ preset: "save", change: { name: "Mine" } });
    // An older client still names the agent.
    const reset = store.apply({ agent: "claude", preset: "save", change: { reset: true } });
    expect(reset).toMatchObject({ ok: true, doc: { names: {} } });
    expect(store.snapshot().presets.save).toMatchObject({ modelId: "opus-5-5" });
    expect(JSON.parse(fs.readFileSync(f, "utf8"))).toEqual({ version: 2, names: {}, presets: {} });
  });

  it("falls back to the built-in preset when the stored model is no longer listed", () => {
    const f = file();
    new ChatPresetsStore(f).apply({ preset: "best", change: { setup: { ...setup, modelId: "gone" } } });
    expect(new ChatPresetsStore(f, () => full).snapshot().presets.best?.modelId).toBe("opus-5-5-1m");
  });

  it("normalises: omitted keys are null and plan first needs delegated work", () => {
    expect(readPresetSetup("claude", { modelId: "m", planFirst: true })).toEqual({
      modelId: "m",
      level: null,
      code: null,
      run: null,
      planFirst: false,
    });
  });

  it("has no presets for Codex", () => {
    const store = new ChatPresetsStore(file(), () => models);
    expect(readPresetSetup("codex", { modelId: "gpt-6" })).toBeUndefined();
    expect(store.apply({ agent: "codex", preset: "best", change: { setup: { modelId: "gpt-6" } } })).toMatchObject({
      ok: false,
    });
  });

  it("refuses everything that is not exactly a preset change, and saves nothing", () => {
    const f = file();
    const store = new ChatPresetsStore(f, () => models);
    const bad: unknown[] = [
      null,
      [],
      {},
      { preset: "custom", change: { name: "x" } },
      { preset: "best", change: { name: 3 } },
      { preset: "best", change: { name: "x" }, agent: "claude" },
      { preset: "best", change: { name: "x", extra: 1 } },
      { agent: "gemini", preset: "best", change: { reset: true } },
      { preset: "best", change: { reset: false } },
      { preset: "best", change: { setup, reset: true } },
      { preset: "best", change: { setup: { ...setup, extra: 1 } } },
      { preset: "best", change: { setup: { ...setup, modelId: "" } } },
      { preset: "best", change: { setup: { ...setup, modelId: "x".repeat(81) } } },
      { preset: "best", change: { setup: { ...setup, code: "gpt" } } },
      { preset: "best", change: { setup: { ...setup, level: "HIGH!" } } },
      { preset: "best", change: { setup: { ...setup, planFirst: "yes" } } },
      { preset: "best", change: { setup: { ...setup, modelId: "ghost" } } },
      { preset: "best", change: { setup: { ...setup, level: "max" } } },
      { preset: "best", change: { setup }, extra: 1 },
    ];
    for (const request of bad) expect(store.apply(request)).toMatchObject({ ok: false });
    expect(fs.existsSync(f)).toBe(false);
  });

  it("accepts any well-formed model id when the Mac has no list", () => {
    const store = new ChatPresetsStore(file());
    expect(store.apply({ preset: "best", change: { setup } }).ok).toBe(true);
  });

  it("migrates the old per-agent file once: Claude setups and names kept, Codex dropped", () => {
    const f = file();
    fs.writeFileSync(
      f,
      JSON.stringify({
        names: { best: "Top", save: 5, custom: "x" },
        setups: {
          claude: { best: setup, balanced: { modelId: 3 } },
          codex: { best: { modelId: "m" }, save: { modelId: "n" } },
          mars: {},
        },
      }),
    );
    const snap = new ChatPresetsStore(f).snapshot();
    expect(snap).toEqual({ names: { best: "Top" }, presets: { best: setup }, setups: { claude: { best: setup } } });
    expect(JSON.parse(fs.readFileSync(f, "utf8"))).toEqual({
      version: 2,
      names: { best: "Top" },
      presets: { best: setup },
    });
    fs.writeFileSync(f, "{nope");
    expect(new ChatPresetsStore(f).snapshot()).toEqual({ names: {}, presets: {}, setups: {} });
  });
});
