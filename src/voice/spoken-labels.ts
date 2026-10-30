import path from "node:path";

import { chatTitle } from "../fleet/radar.js";
import type { FleetSession } from "../fleet/types.js";

/**
 * Names for being read aloud on a call. Unlike the radar's `cardLabel` (which clips from the start with "…" for
 * a screen), a spoken label is short, recognisable, never contains an ellipsis and never starts mid-word.
 */
export const MAX_SPOKEN_CHAT = 40;
const MAX_SPOKEN_WORKSPACE = 50;

type Named = Pick<FleetSession, "agent" | "cwd" | "repoName" | "branch" | "title">;

/** Plain words: no emoji, markdown, links, paths or ellipses; dashes and underscores become spaces. */
export function speakable(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/(?:^|\s)~?\/?(?:[\w.@-]+\/)+[\w.@-]*/g, " ")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/\u200d|\ufe0f|\u20e3/g, "")
    .replace(/[-_]+/g, " ")
    .replace(/[`*#>[\]()~|\\{}<]/g, " ")
    .replace(/…|\.{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** At most `max` characters, cut at a word boundary (never mid-word unless the first word alone is longer). */
export function cutAtWord(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  const head = clean.slice(0, max);
  if (clean[max] === " ") return head.trimEnd();
  const space = head.lastIndexOf(" ");
  const cut = space > 0 ? head.slice(0, space) : head;
  return cut.replace(/[\s,;:.!?-]+$/, "");
}

/** "squeak, ushuaia": the repository, then the workspace folder. */
export function spokenWorkspace(session: Named): string {
  const repo = speakable(session.repoName ?? "");
  const folder = session.cwd ? speakable(path.basename(session.cwd.replace(/\/+$/, ""))) : "";
  if (repo && folder && repo.toLowerCase() !== folder.toLowerCase()) {
    return cutAtWord(`${repo}, ${folder}`, MAX_SPOKEN_WORKSPACE);
  }
  if (repo || folder) return cutAtWord(repo || folder, MAX_SPOKEN_WORKSPACE);
  const branch = session.branch && session.branch !== "HEAD" ? speakable(session.branch) : "";
  return branch ? cutAtWord(branch, MAX_SPOKEN_CHAT) : "a workspace";
}

/** The chat's own title, else "<agent> chat". `taken` (see `spokenChats`) numbers a repeat: "two", "three". */
export function spokenChat(session: Named, taken?: Map<string, number>): string {
  const own = chatTitle(session);
  const title = own ? cutAtWord(speakable(own), MAX_SPOKEN_CHAT) : "";
  const base = title || `${session.agent === "codex" ? "codex" : "claude"} chat`;
  if (!taken) return base;
  const count = (taken.get(base.toLowerCase()) ?? 0) + 1;
  taken.set(base.toLowerCase(), count);
  return count === 1 ? base : `${base} ${NUMBER_WORDS[count] ?? String(count)}`;
}

const NUMBER_WORDS = [
  "",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

/**
 * Spoken chat labels for sessions in the given order, keyed by session key. Chats of one workspace that would
 * speak alike get "two", "three" … after the first; `workspaceOf` says which workspace a session is in.
 */
export function spokenChats(
  sessions: Array<Named & { key: string }>,
  workspaceOf: (session: Named & { key: string }) => string | null,
): Map<string, string> {
  const perWorkspace = new Map<string, Map<string, number>>();
  const out = new Map<string, string>();
  for (const session of sessions) {
    const ws = workspaceOf(session) ?? "";
    let taken = perWorkspace.get(ws);
    if (!taken) perWorkspace.set(ws, (taken = new Map()));
    out.set(session.key, spokenChat(session, taken));
  }
  return out;
}
