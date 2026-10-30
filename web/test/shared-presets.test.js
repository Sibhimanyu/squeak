import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { availablePresets, presetOf, presetSetup, presetTitle, restoreSetup, sanitiseSetup } from "../js/presets.js";
import * as vm from "../js/view-model.js";

const models = [
  { id: "claude-opus", agent: "claude", label: "Opus 5.5 · 1M", levels: ["low", "high"], defaultLevel: "high" },
  { id: "claude-sonnet", agent: "claude", label: "Sonnet 5", levels: ["low", "high"], defaultLevel: "low" },
  { id: "gpt-5", agent: "codex", label: "GPT-5", levels: ["low", "high"], defaultLevel: "high" },
];
const workers = [
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];
const stored = { modelId: "claude-sonnet", level: "high", code: "sonnet", run: null, planFirst: true };

describe("shared presets: resolving", () => {
  it("is today's behaviour exactly without a document, and with an empty one", () => {
    for (const p of ["best", "balanced", "save"]) {
      expect(presetSetup(p, "claude", models, workers, { names: {}, setups: {} })).toEqual(
        presetSetup(p, "claude", models, workers),
      );
    }
    expect(vm.presets({})).toBeNull();
    expect(vm.presets({ presets: "x" })).toBeNull();
    expect(vm.presets({ presets: { names: {}, setups: {} } })).toEqual({ names: {}, setups: {} });
  });

  it("uses the Mac's stored setup over the built-in one, and its name", () => {
    const shared = { names: { save: "Cheap" }, setups: { claude: { save: stored } } };
    expect(presetSetup("save", "claude", models, workers, shared)).toEqual({ ...stored, run: null });
    expect(presetTitle("save", shared)).toBe("Cheap");
    expect(presetTitle("best", shared)).toBe("Best");
    expect(presetOf(stored, "claude", models, workers, shared)).toBe("save");
    expect(restoreSetup({ claude: { preset: "save", setup: null } }, "claude", models, workers, shared)).toEqual(
      stored,
    );
  });

  it("checks a stored setup against the Mac's lists: unknown model, level, worker, codex delegation", () => {
    const gone = { modelId: "claude-old", level: "low", code: null, run: null, planFirst: false };
    const shared = { names: {}, setups: { claude: { best: gone } } };
    expect(presetSetup("best", "claude", models, workers, shared)).toEqual(
      presetSetup("best", "claude", models, workers),
    );
    expect(sanitiseSetup({ ...stored, level: "xhigh" }, "claude", models, workers, null).level).toBe("low");
    expect(sanitiseSetup({ ...stored, code: "fable" }, "claude", models, workers, null)).toMatchObject({
      code: null,
      planFirst: false,
    });
    expect(
      sanitiseSetup(
        { modelId: "gpt-5", level: "low", code: "sonnet", run: "haiku", planFirst: true },
        "codex",
        models,
        workers,
        null,
      ),
    ).toEqual({ modelId: "gpt-5", level: "low", code: null, run: null, planFirst: false });
  });

  it("offers a stored preset the built-in rule cannot back, still needing more than one", () => {
    const shared = {
      names: {},
      setups: { codex: { balanced: { modelId: "gpt-5", level: "low", code: null, run: null, planFirst: false } } },
    };
    expect(availablePresets("codex", models, workers)).toEqual([]);
    expect(availablePresets("codex", models, workers, shared)).toEqual(["best", "balanced"]);
  });

  it("reads the view's document defensively", () => {
    const view = {
      presets: {
        names: { save: "Cheap", best: "", balanced: 3, custom: "x" },
        setups: { claude: { save: { ...stored, planFirst: "yes" }, best: { level: "low" } }, other: {} },
      },
    };
    expect(vm.presets(view)).toEqual({
      names: { save: "Cheap" },
      setups: { claude: { save: { ...stored, run: null, planFirst: false } } },
    });
  });
});

function fakeNode(tag) {
  return {
    tag,
    attrs: {},
    children: [],
    listeners: {},
    style: { setProperty() {} },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    addEventListener(name, fn) {
      this.listeners[name] = fn;
    },
    append(...kids) {
      this.children.push(...kids);
    },
  };
}
const text = (node) => (typeof node === "string" ? node : (node.children ?? []).map(text).join(" "));
const find = (node, pred, out = []) => {
  if (typeof node === "object" && node) {
    if (pred(node)) out.push(node);
    for (const c of node.children ?? []) find(c, pred, out);
  }
  return out;
};

describe("the presets editor as drawn", () => {
  let mod;
  beforeAll(async () => {
    globalThis.document = { createElement: fakeNode, createTextNode: (t) => String(t), getElementById: () => null };
    mod = await import("../js/settings-presets.js");
  });
  afterEach(() => {
    mod.P.agent = "claude";
    mod.P.names = {};
    mod.P.setups = {};
    mod.P.sent = {};
    mod.P.problem = null;
    mod.P.open.clear();
  });
  const view = { mac: "S", chatModels: models, chatWorkers: workers, presets: { names: {}, setups: {} } };
  const ctxFor = (v, commands = {}) => ({ view: v, commands, sync: { wake() {} }, touch() {} });
  const wait = () => new Promise((r) => setTimeout(r, 0));
  const all = (nodes, pred) => nodes.flatMap((n) => find(n, pred));

  it("is hidden for an older Mac, and says what is missing without models", () => {
    expect(mod.presetsSection(ctxFor({ mac: "S" }))).toBeNull();
    const none = mod.presetsSection(ctxFor({ mac: "S", presets: { names: {}, setups: {} } }));
    expect(none.map(text).join(" ")).toContain("Connect Conductor");
  });

  it("draws the three presets with the same wording as the Mac, Codex without workers", () => {
    const claude = mod.presetsSection(ctxFor(view));
    const words = claude.map(text).join(" ");
    for (const w of [
      "Best",
      "Balanced",
      "Save usage",
      "Restore defaults",
      "Name",
      "Model",
      "Thinking",
      "Code",
      "Run commands",
      "Ask before changes",
    ]) {
      expect(words).toContain(w);
    }
    mod.P.agent = "codex";
    const codex = mod.presetsSection(ctxFor(view)).map(text).join(" ");
    expect(codex).not.toContain("Run commands");
    expect(codex).not.toContain("Ask before changes");
  });

  it("sends one whole setup per edit, which the Mac's shape accepts, and a reset", async () => {
    const sent = [];
    const commands = { presets: async (i) => (sent.push(i), { ok: true }) };
    const nodes = mod.presetsSection(ctxFor(view, commands));
    const save = nodes.flatMap((n) => find(n, (x) => x.tag === "details" && x.attrs["data-preset"] === "save"))[0];
    const code = find(save, (x) => x.tag === "select").find(
      (s) => text(s).includes("Same model") && s.listeners.change,
    );
    const selects = find(save, (x) => x.tag === "select");
    // Model, Thinking, Code, Run commands.
    expect(selects).toHaveLength(4);
    selects[3].listeners.change({ target: { value: "" } });
    await wait();
    expect(code).toBeDefined();
    expect(sent[0]).toEqual({
      agent: "claude",
      preset: "save",
      change: { setup: { modelId: "claude-sonnet", level: "low", code: "sonnet", run: null, planFirst: true } },
    });
    const reset = find(save, (x) => x.tag === "button" && text(x) === "Restore defaults")[0];
    reset.listeners.click();
    await wait();
    expect(sent[1]).toEqual({ agent: "claude", preset: "save", change: { reset: true } });
  });

  it("debounces a name and puts a refused one back with the Mac's sentence", async () => {
    const sent = [];
    const commands = {
      presets: async (i) => (sent.push(i), { ok: false, reason: "A preset's name is text." }),
    };
    const nodes = mod.presetsSection(ctxFor(view, commands));
    const input = all(nodes, (x) => x.tag === "input" && x.attrs["data-keep"] === "preset-name-best")[0];
    input.listeners.input({ target: { value: "T" } });
    input.listeners.input({ target: { value: "Top" } });
    expect(sent).toEqual([]);
    await new Promise((r) => setTimeout(r, mod.NAME_DEBOUNCE_MS + 50));
    expect(sent).toEqual([{ preset: "best", change: { name: "Top" } }]);
    expect(mod.P.problem).toBe("A preset's name is text.");
    expect(mod.P.sent.best).toBeUndefined();
  });
});
