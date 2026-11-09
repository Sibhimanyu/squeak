import type { NewChatAgent } from "../fleet/new-chat.js";

/**
 * Squeak's own model catalog: what a new chat may use when Conductor's picker data is not there
 * (Conductor uninstalled, or its database unreadable). Ids are Conductor-style aliases because that is
 * what a chat stores; `toClaudeCliModel` turns a Claude alias into the CLI's catalog id
 * (`opus-5-5-1m` -> `claude-opus-5-5[1m]`). Update with `claude-pricing.ts` when a model ships.
 */
export interface BuiltinModel {
  agent: NewChatAgent;
  id: string;
  label: string;
  levels: string[];
  defaultLevel?: string;
  favorite: boolean;
}

const CLAUDE = ["low", "medium", "high", "xhigh", "max"];
const CODEX = ["low", "medium", "high", "xhigh"];

export function builtinChatModels(): BuiltinModel[] {
  const claude = (id: string, label: string, favorite: boolean, levels = CLAUDE): BuiltinModel => ({
    agent: "claude",
    id,
    label,
    levels,
    ...(levels.includes("medium") ? { defaultLevel: "medium" } : {}),
    favorite,
  });
  const codex = (id: string, label: string, favorite: boolean, defaultLevel: string): BuiltinModel => ({
    agent: "codex",
    id,
    label,
    levels: CODEX,
    defaultLevel,
    favorite,
  });
  return [
    claude("opus-5-5-1m", "Opus 5.5 · 1M", true),
    claude("sonnet-5-5-1m", "Sonnet 5.5 · 1M", true),
    codex("gpt-6.1-sol", "GPT 6.1 Sol", true, "high"),
    claude("fable-5-1", "Fable 5.1", false),
    claude("haiku-4-5", "Haiku 4.5", false, []),
    codex("gpt-5.6-terra", "GPT 5.6 Terra", false, "medium"),
    codex("gpt-5.4", "GPT 5.4", false, "medium"),
  ];
}
