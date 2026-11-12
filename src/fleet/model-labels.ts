import type { NewChatAgent } from "./chat-starter.js";

export const CLAUDE_LEVELS = ["low", "medium", "high", "xhigh", "max"];
export const CODEX_LEVELS = ["low", "medium", "high", "xhigh"];
export function levelsFor(agent: NewChatAgent): string[] {
  return agent === "claude" ? CLAUDE_LEVELS : CODEX_LEVELS;
}

/**
 * The one place a model id becomes a name a person reads: Conductor aliases (`opus-5-5-1m`), the claude
 * CLI's catalog ids (`claude-opus-5-5[1m]`, `claude-haiku-4-5-20251001`) and Codex ids (`gpt-6.1-sol`) give
 * "Opus 5.5 · 1M", "Haiku 4.5", "GPT 6.1 Sol". An unknown id has its dashes turned into spaces and is
 * capitalised; brackets never show. The Swift and web formatters follow this one.
 */
export function modelLabel(id: string): string {
  let text = id.trim().toLowerCase();
  let bracketContext: string | null = null;
  const bracket = /\[(\d+m)\]$/.exec(text);
  if (bracket) {
    bracketContext = bracket[1]!.toUpperCase();
    text = text.slice(0, bracket.index);
  }
  text = text
    .replace(/[[\]]/g, " ")
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "");
  const parts = text.split(/[-_\s]+/).filter(Boolean);
  const context = bracketContext ?? (parts[parts.length - 1] === "1m" ? "1M" : null);
  const words = !bracketContext && context ? parts.slice(0, -1) : parts;
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

/** A stored thinking level in words: "xhigh" is "Extra high", the rest are capitalised. */
export function levelLabel(level: string): string {
  const clean = level.trim().toLowerCase();
  if (!clean) return "";
  return clean === "xhigh" ? "Extra high" : clean.charAt(0).toUpperCase() + clean.slice(1);
}
