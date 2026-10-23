import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import type { NewChatAgent } from "./new-chat.js";

/**
 * The models Conductor offers for a new chat, as its own picker does: the favourites first, in the
 * order it keeps them, then every other model it has a saved setting for. Read-only against Conductor's
 * database and its picker settings file; the Mac checks a phone's choice against this list again.
 */
export interface ChatModel {
  agent: NewChatAgent;
  /** Conductor's own alias for it (`opus-5-5-1m`), which is what a chat stores. */
  id: string;
  label: string;
  /** The thinking levels it takes, lowest first; empty for a model with none (Haiku 4.5). */
  levels: string[];
  /** The level Conductor's picker starts it at. */
  defaultLevel?: string;
  favorite: boolean;
}

export const CLAUDE_LEVELS = ["low", "medium", "high", "xhigh", "max"];
export const CODEX_LEVELS = ["low", "medium", "high", "xhigh"];
const MAX_MODELS = 16;
const ALIAS = /^[A-Za-z0-9._-]{1,60}$/;

export function levelsFor(agent: NewChatAgent): string[] {
  return agent === "claude" ? CLAUDE_LEVELS : CODEX_LEVELS;
}

/** "opus-5-5-1m" is "Opus 5.5 · 1M"; "gpt-5.6-terra" is "GPT 5.6 Terra"; anything unknown stays as written. */
export function modelLabel(id: string): string {
  const parts = id.split("-");
  const context = parts[parts.length - 1]?.toLowerCase() === "1m" ? "1M" : null;
  const words = context ? parts.slice(0, -1) : parts;
  const name: string[] = [];
  const version: string[] = [];
  for (const word of words) {
    if (/^\d+(\.\d+)*$/.test(word)) version.push(word);
    else if (version.length > 0) name.push(word.charAt(0).toUpperCase() + word.slice(1));
    else name.push(word.toLowerCase() === "gpt" ? "GPT" : word.charAt(0).toUpperCase() + word.slice(1));
  }
  const head = name.filter((_, i) => i === 0);
  const tail = name.slice(1);
  const base = [...head, version.length > 0 ? version.join(".") : "", ...tail].filter(Boolean).join(" ");
  const label = context ? `${base} · ${context}` : base;
  return label || id;
}

function agentOf(id: string, hinted?: unknown): NewChatAgent | null {
  if (hinted === "claude" || hinted === "codex") return hinted;
  if (id.startsWith("gpt-")) return "codex";
  if (/^(opus|sonnet|haiku|fable)-/.test(id)) return "claude";
  return null;
}

function parse<T>(text: string | null | undefined): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function listChatModels(conductorDbPath: string): ChatModel[] {
  const settingsFile = path.join(path.dirname(conductorDbPath), "local-storage.subsystem.model-picker-configs-v1.json");
  const saved = parse<Record<string, string>>(readFile(settingsFile)) ?? {};
  const defaults = new Map<string, { effort?: string }>();
  for (const [id, raw] of Object.entries(saved)) {
    const config = parse<{ effortLevel?: unknown }>(typeof raw === "string" ? raw : null);
    defaults.set(id, typeof config?.effortLevel === "string" ? { effort: config.effortLevel } : {});
  }

  const found: Array<{ id: string; agent: NewChatAgent; favorite: boolean; level?: string }> = [];
  const db = new Database(conductorDbPath, { readonly: true });
  try {
    db.pragma("busy_timeout = 2000");
    const rows = db.prepare("SELECT configuration FROM favorite_models ORDER BY position").all() as Array<{
      configuration: string | null;
    }>;
    for (const row of rows) {
      const config = parse<{ type?: unknown; agent?: unknown; model?: unknown; thinkingLevel?: unknown }>(
        row.configuration,
      );
      if (config?.type !== "built-in" || typeof config.model !== "string" || !ALIAS.test(config.model)) continue;
      const agent = agentOf(config.model, config.agent);
      if (agent) {
        found.push({
          id: config.model,
          agent,
          favorite: true,
          ...(typeof config.thinkingLevel === "string" ? { level: config.thinkingLevel } : {}),
        });
      }
    }
  } finally {
    db.close();
  }
  for (const id of defaults.keys()) {
    const agent = agentOf(id);
    if (agent && ALIAS.test(id)) found.push({ id, agent, favorite: false });
  }

  const seen = new Set<string>();
  const models: ChatModel[] = [];
  for (const { id, agent, favorite, level } of found) {
    if (seen.has(id)) continue;
    seen.add(id);
    // A favourite starts at the level it was saved with; otherwise at the picker's own.
    const effort = level ?? defaults.get(id)?.effort;
    const levels =
      defaults.has(id) && defaults.get(id)?.effort === undefined && level === undefined ? [] : levelsFor(agent);
    models.push({
      agent,
      id,
      label: modelLabel(id),
      levels,
      ...(effort && levels.includes(effort)
        ? { defaultLevel: effort }
        : levels.includes("medium")
          ? { defaultLevel: "medium" }
          : {}),
      favorite,
    });
  }
  return models.slice(0, MAX_MODELS);
}

function readFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
