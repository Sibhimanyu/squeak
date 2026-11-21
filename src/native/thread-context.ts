import { execFileSync } from "node:child_process";

import { ASK_FORMAT_EXAMPLE_CHOICE, ASK_FORMAT_TEXT, NO_RETRY_LOOP_RULE } from "../fleet/ask-format.js";
import type { AgentKind, MessageAuthor } from "./types.js";

export interface ThreadContextInput {
  agent: AgentKind;
  /** The pond (project) name. */
  pond?: string | null;
  /** The stream's folder name under ~/squeak/workspaces/<pond>/ and its git branch. */
  folderName?: string | null;
  /** What the stream is called on screen, when it differs from the folder name. */
  streamTitle?: string | null;
  branch?: string | null;
  /** Absolute folder the agent works in. */
  cwd: string;
  targetBranch?: string | null;
  /** SQUEAK_PORT for the workspace's scripts, when one is reserved. */
  port?: number | null;
  /** Someone other than the owner has already written in this thread. */
  shared?: boolean;
  /** This chat's duck: its name (the person's, else the chat title) and the role the person gave it. */
  duck?: { name: string; role?: string | null; notebook?: string | null };
  /**
   * Ducks own their branch (flag `ducksOwnBranch`): where this chat is and the pond's active branches, so the duck
   * can place itself. Absent with the flag off, and in a plain-folder pond.
   */
  placement?: {
    /** `main`: the pond's own folder, read-only; `branch`: a working copy that other ducks may share. */
    mode: "main" | "branch";
    branches: { branch: string; title: string; ducks: string[]; lastActiveAt: number }[];
    now?: number;
  };
}

function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** The lines of the note that place a duck: where it is, what it may edit, the pond's branches, the tools. */
export function placementLines(p: NonNullable<ThreadContextInput["placement"]>, branch?: string | null): string[] {
  const now = p.now ?? Date.now();
  const lines =
    p.mode === "main"
      ? [
          "You are in Main, the pond's own folder, and Main is read-only for ducks: never create, edit or delete files in it (Squeak refuses the edit). Reading, searching, answering questions, planning and reviewing are fine here, and you can start at once. When you need to change files, call branch_off (optional name for the work, optional from) to get your own branch and working copy, or join_branch to share a branch another duck is already on. move_to_main brings you back here.",
        ]
      : [
          `You work on branch ${branch ?? "(unnamed)"} in a working copy of its own. Other ducks on the same branch share this folder and may edit at the same time, so re-read a file before editing it and say in the room what you are changing. branch_off starts separate work on a new branch, join_branch moves you to another duck's branch, move_to_main to Main (read-only).`,
        ];
  if (p.branches.length > 0) {
    lines.push(
      `Active branches in this pond (join the one whose task matches yours with join_branch; otherwise branch_off for new work):\n${p.branches
        .map(
          (b) =>
            `- ${b.branch}: ${b.title}${b.ducks.length ? `; ducks: ${b.ducks.join(", ")}` : "; no duck on it now"}; active ${ago(now - b.lastActiveAt)}`,
        )
        .join("\n")}`,
    );
  } else {
    lines.push("There are no active branches in this pond yet.");
  }
  return lines;
}

/** The one paragraph of the ask format the note carries: question above lettered options. Reuses the constant. */
const ASK_ESSENCE = `${ASK_FORMAT_TEXT.split("\n\n")[0]}\n${ASK_FORMAT_EXAMPLE_CHOICE}`;

/**
 * Squeak's word for a subagent (the Agent/Task tool), so the agent talks like the screens do ("2 ducklings running").
 * Kept short: it is in every thread's prompt. Exported for the test and the skill.
 */
export const DUCKLING_LINES = [
  "Start a duckling (your own helper, through the Agent tool) for short internal work; start another thread for work that is long, parallel or should be watched. Launch every duckling with `run_in_background: true` unless your very next step needs its result: a foreground duckling blocks you until it reports.",
  'In Squeak your subagents are called ducklings: say "duckling" when you start, check on or report one, with a light touch and at most one playful verb per mention (e.g. "I\'ve sent a duckling to fix the bar spacing", "The duckling on the bar changes now has five tweaks", "One duckling is still paddling on full-screen spaces"). Keep the task, status and results exact and never pad; never call the person or yourself a duck.',
];

/** A compact `squeak` skill for Codex, which has no skills: Claude gets the real SKILL.md through the plugin. */
export const CODEX_SQUEAK_GUIDE = [
  "Squeak guide (the full version is the `squeak` skill Claude chats get):",
  "- stream_changes returns everything this stream changed compared with its merge branch, edits not yet committed and new files included. Run it ahead of a PR, a review or a changelog. Use set_merge_branch to switch the merge branch, and only if asked.",
  "- list_review_notes, add_review_note and resolve_review_note work with the per-line notes in Squeak's Changes view; close every note you have dealt with.",
  "- page_person alerts the person; use it only when you are stopping because you need them, and no more than once a turn. set_progress draws a progress strip over the composer (send the full picture each call, steps: [] to remove it). show_image puts a picture in the chat (path, optional caption): use it whenever the person asks to see an image, screenshot or chart, instead of describing it. script_output returns what the run and setup scripts printed.",
  "- start_chat opens another thread in this folder: give it a self-contained brief (goal, files, constraints, how to check, what to report). send_to_chat delivers a new turn there; check back later with read_chat, never in a tight loop. Two threads editing the same files collide. Never pass secrets between threads.",
  "- post_to_room puts one short line in the pond's room: `working` when you start a distinct piece of work (what, not how), `done` when it is finished; read_room first when another thread may be in the same area; level `agents` is for coordination the person need not see.",
  "- open_jobs lists jobs asked for in the room that fit this thread; claim_job asks the owner to let you take one (it starts nothing: wait until the owner sends it to you).",
  "- Pond upkeep (pond_appearance, set_pond_icon, set_pond_colour, set_pond_labels) only when asked, for your own pond. Never hide, rename or invite.",
  "- End a turn with the outcome first, then anything the person must decide.",
].join("\n");

/**
 * What every Squeak thread's agent is told about where it runs and who it talks to. Built per thread when its
 * agent starts (a resumed thread gets the current note). Claude takes it as an appended system prompt, Codex as
 * the thread's developer instructions (plus `CODEX_SQUEAK_GUIDE`).
 */
export function buildThreadContext(input: ThreadContextInput): string {
  const where = [
    input.pond ? `pond ${input.pond}` : null,
    input.folderName
      ? input.streamTitle && input.streamTitle !== input.folderName
        ? `stream ${input.streamTitle} (folder name ${input.folderName})`
        : `stream ${input.folderName}`
      : null,
    input.branch ? `git branch ${input.branch}` : null,
    `folder ${input.cwd}`,
    `target branch ${input.targetBranch || "the project's default"}`,
    input.port ? `SQUEAK_PORT ${input.port} (first of ten ports for this stream's scripts)` : null,
  ].filter(Boolean);
  const lines = [
    "You are running in Squeak, a pager and workbench for coding agents on the owner's Mac; the owner reads you on the Mac app, their phone and Telegram, often away from the keyboard.",
    `This thread: ${where.join("; ")}. Keep notes and handoffs in .context/ (gitignored scratch space).`,
    "The `squeak` MCP server has tools for: the stream's diff, review comments, notifying the owner, a progress tracker, the target branch, other threads (list, read, send, start), the pond's room (post_to_room, read_room) and pond upkeep (look and labels).",
    "This pond has a room that the owner and the other threads read. Post a short `working` line (post_to_room) when you start a distinct piece of work and `done` when it is finished, and read_room before touching an area another thread may be in. Use level `agents` for coordination the owner doesn't need to see.",
    "The room also holds jobs the owner asked for. Near the end of a turn, call open_jobs; if one fits what you just did, call claim_job with an eta, and never start it until the owner sends it to you.",
    ...(input.duck
      ? [
          `You are ${input.duck.name}, a duck in ${input.pond ?? "this pond"}${input.duck.role ? `; your role: ${input.duck.role}` : ""}. A duck belongs to the pond and moves between streams per job; you work in the stream named above, and the person may later start you in another one with a fresh chat.`,
          ...(input.duck.notebook?.trim()
            ? [
                `Your notebook (what you did in earlier jobs, oldest first; trust it as your own memory, check the code before relying on details):\n${input.duck.notebook.trim()}`,
              ]
            : []),
        ]
      : []),
    input.agent === "claude"
      ? "The `squeak` skill has the details."
      : "The Squeak guide appended below has the details.",
    ...(input.placement ? placementLines(input.placement, input.branch) : []),
    ...DUCKLING_LINES,
    "Messages can come from more than one person. Each message from someone other than the owner starts with a line `[from <name> · teammate]`; the owner's messages start with `[from <name> · owner]` once anyone else has written in this thread. Address people by name, keep track of who asked for what, and if two people ask for conflicting things, say so and ask; the owner's word decides. Only the owner can approve actions or stop you.",
    ...(input.shared ? ["Other people have already written in this thread."] : []),
    ASK_ESSENCE,
    NO_RETRY_LOOP_RULE,
  ];
  return lines.join("\n");
}

/** The note as an agent receives it: Codex also gets the compact guide. */
export function threadContextFor(input: ThreadContextInput): string {
  const note = buildThreadContext(input);
  return input.agent === "codex" ? `${note}\n\n${CODEX_SQUEAK_GUIDE}` : note;
}

/** Drops leading `[from ...` lines so message text cannot pass itself off as a sender. */
export function stripSenderPrefix(text: string): string {
  let t = text;
  for (;;) {
    const m = /^\s*\[from [^\n]*(?:\n|$)/.exec(t);
    if (!m) return t;
    t = t.slice(m[0].length);
  }
}

/**
 * The text the agent receives. Unshared: unchanged. Once anyone else has written in the thread: a guest's text
 * starts with `[from <name> · teammate]`, the owner's with `[from <owner> · owner]`. The stored message stays
 * unprefixed. A name cannot break the line: brackets and newlines are removed.
 */
export function withSender(
  text: string,
  author: MessageAuthor | undefined,
  options: { shared: boolean; ownerName: string },
): string {
  if (!options.shared) return text;
  const clean = (n: string): string => n.replace(/[\][\r\n·]+/g, " ").trim() || "someone";
  const label = author ? `${clean(author.name)} · teammate` : `${clean(options.ownerName)} · owner`;
  return `[from ${label}]\n${stripSenderPrefix(text)}`;
}

let cachedFullName: string | null | undefined;

/** The owner's name for a prefix: the pond member name if given, else the macOS full name, else "owner". */
export function resolveOwnerName(pondName?: string | null, fullName: () => string | null = macFullName): string {
  const pond = pondName?.trim();
  if (pond) return pond;
  return fullName()?.trim() || "owner";
}

function macFullName(): string | null {
  if (cachedFullName !== undefined) return cachedFullName;
  try {
    cachedFullName = execFileSync("id", ["-F"], { encoding: "utf8", timeout: 2000 }).trim() || null;
  } catch {
    cachedFullName = null;
  }
  return cachedFullName;
}
