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
  duck?: { name: string; role?: string | null };
  /**
   * Ducks choose their Streams (flag `ducksOwnBranch`): where this chat is and the pond's active branches, so the duck
   * can open or join one. Absent with the flag off, and in a plain-folder pond.
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
          "You start in Main, the pond's own folder, and Main is read-only for ducks: never create, edit or delete files in it (Squeak refuses the edit). Squeak never picks a stream for you. To change files, call open_stream (name for the work, or an exact branch; optional from) to create or join a branch with its own working copy: it returns that folder, and you edit its files by their full path and run commands from that folder. You may be in several streams at once; each joined stream is locked per file while you edit. streams lists the pond's streams and who is in each; leave_stream leaves one when you are done with it.",
        ]
      : [
          `You work on branch ${branch ?? "(unnamed)"} in a working copy of its own. Other ducks on the same branch share this folder and may edit at the same time, so re-read a file before editing it and say in the room what you are changing. open_stream creates or joins another branch with its own working copy (edit it by full path), streams lists them, leave_stream leaves one. Main is read-only.`,
        ];
  if (p.branches.length > 0) {
    lines.push(
      `Active branches in this pond (join the one whose task matches yours with open_stream; otherwise open_stream with a name for new work):\n${p.branches
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

/** The canvas format note: short, it is in every thread's prompt. */
export const CANVAS_LINE =
  "Canvases (slides, posters, logos, social posts): use canvas_create, canvas_add_artboard, canvas_update_artboard and canvas_open, never loose HTML files. Each artboard is one self-contained HTML/CSS file (inline SVG allowed) whose body is exactly its width x height pixels (deck 1920x1080, poster 1080x1350, logo 1024x1024, social 1080x1080), with text kept as real text, images from the canvas's assets/ folder by relative path, and no external network assets except fonts (system or web-safe stacks by default).";

/** A compact `squeak` skill for Codex, which has no skills: Claude gets the real SKILL.md through the plugin. */
export const CODEX_SQUEAK_GUIDE = [
  "Squeak guide (the full version is the `squeak` skill Claude chats get):",
  "- stream_changes returns everything this stream changed compared with its merge branch, edits not yet committed and new files included. Run it ahead of a PR, a review or a changelog. Use set_merge_branch to switch the merge branch, and only if asked.",
  "- list_review_notes, add_review_note and resolve_review_note work with the per-line notes in Squeak's Changes view; close every note you have dealt with.",
  "- page_person alerts the person; use it only when you are stopping because you need them, and no more than once a turn. set_progress draws a progress strip over the composer (send the full picture each call, steps: [] to remove it). show_image puts a picture in the chat (path, optional caption): use it whenever the person asks to see an image, screenshot or chart, instead of describing it. script_output returns what the run and setup scripts printed.",
  "- start_chat opens another thread in this folder: give it a self-contained brief (goal, files, constraints, how to check, what to report). send_to_chat delivers a new turn there; check back later with read_chat, never in a tight loop. Two threads editing the same files collide. Never pass secrets between threads.",
  '- post_to_room writes a message in the pond\'s room, like a group chat: when you finish a task from the room, or someone there asked you something, post kind `message` with two or three plain sentences (what you did, what you found, what you need from the reader), starting with the substance, no preamble and no copied tool output. Use `needs` when blocked, `handoff` when you pass work on, and `plan` (a spec and plan card) only for a task that is more than small; no "took it" or "finished" lines and no message per step. read_room first when another thread may be in the same area; level `agents` is for coordination the person need not see.',
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
    'This pond has a room that the owner and the other threads read, like a group chat. When you finish a task from the room, and when someone in the room asked you something, write one message there (post_to_room, kind `message`): two or three plain sentences saying what you did, what you found and what you need from the reader, starting with the substance, with no greeting or preamble and no copied tool output; the details stay in your own thread, which the reader can open from your message. Do not post "took it" or "finished" lines or one message per step. Use kind `needs` when you are blocked, `handoff` when you pass work on, and a spec and plan card (kind `plan`) only when the task is more than small. Read_room before touching an area another thread may be in. Use level `agents` for coordination the owner doesn\'t need to see. Squeak skips status lines while nobody else is reading the room, and tells you so.',
    "To give work to another duck, call hand_off with toDuck (it goes straight to that duck as a sub-task, shown in the room as an @mention); without toDuck Squeak decides who takes it and may hatch a new duck. A plain @mention in post_to_room only nudges a duck.",
    "The room also holds jobs the owner asked for. Near the end of a turn, call open_jobs; if one fits what you just did, call claim_job with an eta, and never start it until the owner sends it to you.",
    ...(input.duck
      ? [
          `You are ${input.duck.name}, a duck in ${input.pond ?? "this pond"}${input.duck.role ? `; your role: ${input.duck.role}` : ""}. A duck belongs to the pond and moves between streams per job; you work in the stream named above, and the person may later start you in another one with a fresh chat.`,
        ]
      : []),
    input.agent === "claude"
      ? "The `squeak` skill has the details."
      : "The Squeak guide appended below has the details.",
    ...(input.placement ? placementLines(input.placement, input.branch) : []),
    ...DUCKLING_LINES,
    CANVAS_LINE,
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
  const bare = stripSenderPrefix(text);
  // A slash command (a skill) only runs at the very start of the message: the sender goes after it.
  return /^\//.test(bare) ? `${bare}\n[from ${label}]` : `[from ${label}]\n${bare}`;
}

/** The owner's name for a prefix: the pond member name (the Squeak account's), else "owner". Never the Mac's own name. */
export function resolveOwnerName(pondName?: string | null): string {
  return pondName?.trim() || "owner";
}
