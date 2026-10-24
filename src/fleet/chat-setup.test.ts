import { describe, expect, it } from "vitest";

import { resolveSetup } from "./chat-setup.js";

const models = [
  {
    agent: "claude" as const,
    id: "opus-5-5",
    label: "Opus 5.5",
    levels: ["low", "high"],
    defaultLevel: "high",
    favorite: true,
  },
  { agent: "claude" as const, id: "haiku-4-5", label: "Haiku 4.5", levels: [], favorite: false },
  { agent: "codex" as const, id: "gpt-5.5", label: "GPT 5.5", levels: ["low", "high"], favorite: true },
];

describe("resolveSetup", () => {
  it("keeps the chat's level and fast mode when the new model takes them", () => {
    expect(resolveSetup(models, { agent: "claude", effortId: "low", fast: true }, { model: "opus-5-5" })).toEqual({
      ok: true,
      model: "opus-5-5",
      label: "Opus 5.5",
      thinkingLevel: "low",
      fastMode: true,
    });
  });

  it("falls back to the model's default level, and none for a model without levels", () => {
    expect(resolveSetup(models, { agent: "claude", effortId: "max" }, { model: "opus-5-5" })).toMatchObject({
      thinkingLevel: "high",
      fastMode: false,
    });
    const haiku = resolveSetup(models, { agent: "claude", effortId: "high" }, { model: "haiku-4-5" });
    expect(haiku).toMatchObject({ ok: true, model: "haiku-4-5" });
    expect(haiku).not.toHaveProperty("thinkingLevel");
  });

  it("refuses another provider's model, an unknown level, a non-agent chat and a malformed ask", () => {
    expect(resolveSetup(models, { agent: "claude" }, { model: "gpt-5.5" })).toMatchObject({ ok: false });
    expect(resolveSetup(models, { agent: "claude" }, { model: "opus-5-5", thinking: "max" })).toMatchObject({
      ok: false,
    });
    expect(resolveSetup(models, { agent: "cursor" }, { model: "opus-5-5" })).toMatchObject({ ok: false });
    expect(resolveSetup(models, { agent: "claude" }, { model: "opus-5-5", fast: "yes" })).toMatchObject({ ok: false });
  });
});
