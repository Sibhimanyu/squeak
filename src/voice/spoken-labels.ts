import path from "node:path";

import { chatTitle } from "../fleet/radar.js";
import type { FleetSession } from "../fleet/types.js";
import { workFolder } from "../fleet/session-folder.js";

/**
 * Names for being read aloud on a call. Unlike the radar's `cardLabel` (which clips from the start with "…" for
 * a screen), a spoken label is short, recognisable, never contains an ellipsis and never starts mid-word.
 */
export const MAX_SPOKEN_CHAT = 40;
const MAX_SPOKEN_WORKSPACE = 50;

type Named = Pick<FleetSession, "agent" | "cwd" | "repoName" | "branch" | "title"> &
  Partial<Pick<FleetSession, "workspaceRoot">>;

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

const PLAIN_BRANCHES = new Set(["head", "main", "master"]);

/**
 * "squeak, fix parser": the repository, then the branch's last segment. Conductor's folder is a random city
 * ("ushuaia") that means nothing aloud, so it is never spoken. The branch is left out when it says nothing: missing,
 * HEAD, main, master, the repo's default branch (`baseRef`, "origin/<branch>"), or the folder's own name (Conductor
 * names a fresh branch after the city). No repo: the branch alone; nothing: "a workspace". Two workspaces of one repo
 * can speak alike; `numberRepeats` tells them apart in a menu.
 */
/**
 * A workspace as said on a call: its repo, plus the branch when `withBranch` (the caller passes it only when two
 * workspaces in the same list share a repo: a branch said for no reason, "motion graphics skill, release notes", was
 * heard as the agent reading release notes).
 */
export function spokenWorkspace(session: Named & { baseRef?: string | null }, withBranch = true): string {
  const repo = speakable(session.repoName ?? "");
  // The workspace's folder, not the subfolder the agent cd'd into ("caracas", not "source").
  const root = workFolder(session);
  const folder = root ? speakable(path.basename(root.replace(/\/+$/, ""))).toLowerCase() : "";
  const raw = (session.branch ?? "").trim();
  const base = (session.baseRef ?? "")
    .replace(/^origin\//, "")
    .trim()
    .toLowerCase();
  const tail = raw.slice(raw.lastIndexOf("/") + 1);
  let branch = speakable(tail);
  const plain =
    !raw ||
    PLAIN_BRANCHES.has(raw.toLowerCase()) ||
    PLAIN_BRANCHES.has(tail.toLowerCase()) ||
    (base !== "" && (raw.toLowerCase() === base || tail.toLowerCase() === base)) ||
    branch.toLowerCase() === folder;
  if (plain || (!withBranch && repo)) branch = "";
  if (repo && branch) return cutAtWord(`${repo}, ${branch}`, MAX_SPOKEN_WORKSPACE);
  if (repo) return cutAtWord(repo, MAX_SPOKEN_WORKSPACE);
  return branch ? cutAtWord(branch, MAX_SPOKEN_WORKSPACE) : "a workspace";
}

/** Labels in menu order with repeats numbered ("squeak", "squeak two", "squeak three"), case-insensitively. */
export function numberRepeats(labels: string[]): string[] {
  const seen = new Map<string, number>();
  const used = new Set(labels.map((l) => l.toLowerCase()));
  return labels.map((label) => {
    const count = (seen.get(label.toLowerCase()) ?? 0) + 1;
    seen.set(label.toLowerCase(), count);
    if (count === 1) return label;
    let n = count;
    let next = `${label} ${NUMBER_WORDS[n] ?? String(n)}`;
    while (used.has(next.toLowerCase())) next = `${label} ${NUMBER_WORDS[++n] ?? String(n)}`;
    return next;
  });
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
