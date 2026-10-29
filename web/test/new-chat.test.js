import { describe, expect, it } from "vitest";

import { shape } from "../js/command-shapes.js";
import { composeMessage } from "../js/images.js";
import {
  availablePresets,
  buildStart,
  canStart,
  choiceToSave,
  failureNote,
  presetOf,
  presetSetup,
  restoreSetup,
  splitFor,
  startProblem,
  summary,
  workspaceGroups,
} from "../js/presets.js";

const models = [
  {
    id: "claude-opus",
    agent: "claude",
    label: "Opus 5.5 · 1M",
    levels: ["low", "high", "xhigh"],
    defaultLevel: "high",
  },
  { id: "claude-sonnet", agent: "claude", label: "Sonnet 5", levels: ["low", "high"], defaultLevel: "low" },
  { id: "gpt-5", agent: "codex", label: "GPT-5", levels: [], defaultLevel: null },
];
const workers = [
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
  { id: "opus", label: "Opus" },
];
const ws = { id: "w1", label: "squeak · ushuaia" };

describe("presets", () => {
  it("backs Best, Balanced and Save from the Mac's lists", () => {
    expect(presetSetup("best", "claude", models, workers)).toMatchObject({ modelId: "claude-opus", level: "high" });
    expect(presetSetup("balanced", "claude", models, workers)).toMatchObject({
      modelId: "claude-opus",
      code: "sonnet",
      run: null,
    });
    expect(presetSetup("save", "claude", models, workers)).toEqual({
      modelId: "claude-sonnet",
      level: "low",
      code: "sonnet",
      run: "haiku",
      planFirst: true,
    });
    expect(availablePresets("claude", models, workers)).toEqual(["best", "balanced", "save"]);
  });
  it("offers only what can be backed, and nothing when there is no choice", () => {
    expect(availablePresets("claude", models, [])).toEqual([]);
    expect(availablePresets("codex", models, workers)).toEqual([]);
    expect(presetSetup("save", "claude", models, [{ id: "sonnet", label: "Sonnet" }])).toBeNull();
  });
  it("derives Custom when a detail is edited away", () => {
    const best = presetSetup("best", "claude", models, workers);
    expect(presetOf(best, "claude", models, workers)).toBe("best");
    expect(presetOf({ ...best, planFirst: true }, "claude", models, workers)).toBe("custom");
  });
  it("says the setup in one line", () => {
    const save = presetSetup("save", "claude", models, workers);
    expect(summary(save, "claude", models, workers)).toBe(
      "Sonnet 5 plans · Sonnet codes · Haiku runs tests · asks before changes",
    );
    expect(summary(presetSetup("best", "claude", models, workers), "claude", models, workers)).toBe(
      "Opus 5.5 · high thinking",
    );
  });
  it("restores the last choice, kept on what the Mac offers now", () => {
    const saved = choiceToSave(
      {},
      "claude",
      { modelId: "claude-sonnet", level: "xhigh", code: "gone", run: "haiku", planFirst: true },
      "custom",
    );
    expect(restoreSetup(saved, "claude", models, workers)).toEqual({
      modelId: "claude-sonnet",
      level: "low",
      code: null,
      run: "haiku",
      planFirst: true,
    });
    expect(restoreSetup(saved, "claude", models, [])).toMatchObject({ code: null, run: null });
    expect(restoreSetup({ claude: { preset: "save" } }, "claude", models, workers).run).toBe("haiku");
    expect(restoreSetup({}, "claude", models, workers)).toEqual(presetSetup("best", "claude", models, workers));
  });
});

describe("the request", () => {
  const setup = presetSetup("save", "claude", models, workers);
  it("carries what is on screen and omits unset keys", () => {
    const request = buildStart({ workspaceId: "w1", agent: "claude", text: "hi", setup, models, workers });
    expect(request).toEqual({
      workspaceId: "w1",
      agent: "claude",
      text: "hi",
      model: "claude-sonnet",
      thinking: "low",
      split: { code: "sonnet", run: "haiku", planFirst: true },
    });
    expect(shape("start", request)).toEqual(request);
    const bare = buildStart({ workspaceId: "w1", agent: "codex", text: "hi", setup: {}, models, workers });
    expect(bare).toEqual({ workspaceId: "w1", agent: "codex", text: "hi", model: "gpt-5" });
    expect(
      Object.keys(
        buildStart({
          workspaceId: "w",
          agent: "claude",
          text: "x",
          setup: { planFirst: false },
          models: [],
          workers: [],
        }),
      ),
    ).toEqual(["workspaceId", "agent", "text"]);
  });
  it("sends no split to an older Mac, and none of the workers to Codex", () => {
    expect(splitFor(setup, "claude", [])).toBeNull();
    expect(splitFor({ ...setup, planFirst: true }, "codex", workers)).toEqual({ planFirst: true });
    expect(buildStart({ workspaceId: "w", agent: "claude", text: "x", setup, models, workers: [] })).not.toHaveProperty(
      "split",
    );
  });
});

describe("messages and limits", () => {
  it("names the saved photos after the words", () => {
    const refs = [".context/attachments/ab12cd34/image-1.jpg"];
    expect(composeMessage("  Fix this ", refs)).toBe(
      "Fix this\n\n@⟦image-1.jpg⟧(.context%2Fattachments%2Fab12cd34%2Fimage-1.jpg)",
    );
    expect(composeMessage("", refs)).toMatch(/^See the attached image\./);
  });
  it("validates what may be sent", () => {
    const ok = { workspace: ws, text: "hi", photos: 0, sending: false };
    expect(canStart(ok)).toBe(true);
    expect(canStart({ ...ok, text: "  ", photos: 1 })).toBe(true);
    expect(startProblem({ ...ok, text: "" })).toBe("empty");
    expect(startProblem({ ...ok, workspace: null })).toBe("workspace");
    expect(startProblem({ ...ok, text: "x".repeat(20_001) })).toBe("long");
    expect(startProblem({ ...ok, text: "x".repeat(20_000) })).toBeNull();
    expect(startProblem({ ...ok, photos: 5 })).toBe("photos");
    expect(startProblem({ ...ok, sending: true })).toBe("sending");
  });
  it("says the Mac's reason, points at Conductor's settings, and never invites a resend of an unconfirmed start", () => {
    expect(failureNote({ reason: "You just started a chat. Wait a few seconds and try again." })).toBe(
      "You just started a chat. Wait a few seconds and try again.",
    );
    expect(failureNote({ reason: "Conductor's relay isn't connected." })).toBe(
      "Conductor's relay isn't connected. On your Mac: Settings › Conductor",
    );
    expect(failureNote({ unconfirmed: true, reason: "x" })).toMatch(/Check Home before sending again/);
  });
  it("groups workspaces by repo and searches repo or branch", () => {
    const list = [
      { id: "1", label: "squeak · a", defaultAgent: "claude" },
      { id: "2", label: "blume · b", defaultAgent: "codex" },
      { id: "3", label: "squeak · c", defaultAgent: "claude" },
    ];
    expect(workspaceGroups(list).map((g) => [g.name, g.items.map((i) => i.branch)])).toEqual([
      ["squeak", ["a", "c"]],
      ["blume", ["b"]],
    ]);
    expect(workspaceGroups(list, "BLU").map((g) => g.name)).toEqual(["blume"]);
    expect(workspaceGroups(list, "zzz")).toEqual([]);
  });
});
