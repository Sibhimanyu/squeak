import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatPresetsStore, readPresetSetup } from "./chat-presets.js";
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

const models: ChatModel[] = [
  { agent: "claude", id: "opus-5-5", label: "Opus 5.5", levels: ["low", "high"], defaultLevel: "high", favorite: true },
  { agent: "codex", id: "gpt-6", label: "GPT 6", levels: [], favorite: false },
];
const setup = { modelId: "opus-5-5", level: "high", code: "sonnet", run: "haiku", planFirst: true };

describe("ChatPresetsStore", () => {
  it("starts empty: every preset is the built-in rule", () => {
    expect(new ChatPresetsStore(file()).snapshot()).toEqual({ names: {}, setups: {} });
  });

  it("saves a setup, a name and a reset, 0600, and reads them back", () => {
    const f = file();
    const store = new ChatPresetsStore(f, () => models);
    expect(store.apply({ agent: "claude", preset: "save", change: { setup } }).ok).toBe(true);
    expect(store.apply({ preset: "save", change: { name: "  Cheap  " } }).ok).toBe(true);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    const again = new ChatPresetsStore(f, () => models).snapshot();
    expect(again).toEqual({ names: { save: "Cheap" }, setups: { claude: { save: setup } } });
    // A name equal to the built-in title or empty is no name.
    store.apply({ preset: "save", change: { name: "Save usage" } });
    expect(store.snapshot().names).toEqual({});
    store.apply({ preset: "save", change: { name: "Mine" } });
    expect(store.apply({ agent: "claude", preset: "save", change: { reset: true } })).toMatchObject({
      ok: true,
      doc: { names: {}, setups: {} },
    });
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
      { agent: "claude", preset: "best", change: { name: "x", extra: 1 } },
      { agent: "gemini", preset: "best", change: { reset: true } },
      { preset: "best", change: { reset: true } },
      { agent: "claude", preset: "best", change: { reset: false } },
      { agent: "claude", preset: "best", change: { setup, reset: true } },
      { agent: "claude", preset: "best", change: { setup: { ...setup, extra: 1 } } },
      { agent: "claude", preset: "best", change: { setup: { ...setup, modelId: "" } } },
      { agent: "claude", preset: "best", change: { setup: { ...setup, modelId: "x".repeat(81) } } },
      { agent: "claude", preset: "best", change: { setup: { ...setup, code: "gpt" } } },
      { agent: "claude", preset: "best", change: { setup: { ...setup, level: "HIGH!" } } },
      { agent: "claude", preset: "best", change: { setup: { ...setup, planFirst: "yes" } } },
      { agent: "claude", preset: "best", change: { setup: { ...setup, modelId: "ghost" } } },
      { agent: "claude", preset: "best", change: { setup: { ...setup, level: "max" } } },
      { agent: "codex", preset: "best", change: { setup: { modelId: "gpt-6", code: "sonnet" } } },
      { agent: "claude", preset: "best", change: { setup }, extra: 1 },
    ];
    for (const request of bad) expect(store.apply(request)).toMatchObject({ ok: false });
    expect(fs.existsSync(f)).toBe(false);
  });

  it("accepts any well-formed model id when the Mac has no list", () => {
    const store = new ChatPresetsStore(file());
    expect(store.apply({ agent: "claude", preset: "best", change: { setup } }).ok).toBe(true);
  });

  it("ignores junk in the file but keeps what is valid", () => {
    const f = file();
    fs.writeFileSync(
      f,
      JSON.stringify({
        names: { best: "Top", save: 5, custom: "x" },
        setups: {
          claude: { best: setup, balanced: { modelId: 3 } },
          codex: { best: { modelId: "m", code: "sonnet" } },
          mars: {},
        },
      }),
    );
    expect(new ChatPresetsStore(f).snapshot()).toEqual({ names: { best: "Top" }, setups: { claude: { best: setup } } });
    fs.writeFileSync(f, "{nope");
    expect(new ChatPresetsStore(f).snapshot()).toEqual({ names: {}, setups: {} });
  });
});
