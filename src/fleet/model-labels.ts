import type { NewChatAgent } from "./chat-starter.js";

export const CLAUDE_LEVELS = ["low", "medium", "high", "xhigh", "max"];
export const CODEX_LEVELS = ["low", "medium", "high", "xhigh"];
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

/** A stored thinking level in words: "xhigh" is "Extra high", the rest are capitalised. */
export function levelLabel(level: string): string {
  const clean = level.trim().toLowerCase();
  if (!clean) return "";
  return clean === "xhigh" ? "Extra high" : clean.charAt(0).toUpperCase() + clean.slice(1);
}
