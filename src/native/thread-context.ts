import { execFileSync } from "node:child_process";

import { ASK_FORMAT_EXAMPLE_CHOICE, ASK_FORMAT_TEXT } from "../fleet/ask-format.js";
import type { AgentKind, MessageAuthor } from "./types.js";

export interface ThreadContextInput {
  agent: AgentKind;
  /** The pond (project) name. */
  pond?: string | null;
  /** The branch's folder name under ~/squeak/workspaces/<pond>/ and its git branch. */
  folderName?: string | null;
  branch?: string | null;
  /** Absolute folder the agent works in. */
  cwd: string;
  targetBranch?: string | null;
  /** SQUEAK_PORT for the workspace's scripts, when one is reserved. */
  port?: number | null;
  /** Someone other than the owner has already written in this thread. */
  shared?: boolean;
}

/** The one paragraph of the ask format the note carries: question above lettered options. Reuses the constant. */
const ASK_ESSENCE = `${ASK_FORMAT_TEXT.split("\n\n")[0]}\n${ASK_FORMAT_EXAMPLE_CHOICE}`;

/** A compact `squeak` skill for Codex, which has no skills: Claude gets the real SKILL.md through the plugin. */
export const CODEX_SQUEAK_GUIDE = [
  "Squeak guide (the full version is the `squeak` skill Claude chats get):",
  "- workspace_diff is the whole change against the target branch, uncommitted and untracked files included: use it before a PR, a review or a changelog. Change the target with set_target_branch only when asked.",
  "- review_comments, add_review_comment, resolve_review_comment: line comments in Squeak's Changes view; resolve each one you addressed.",
  "- notify_user pages the person: only when you stop and need them, at most once per turn. update_progress shows a tracker above the composer (send the full state; steps: [] when done). terminal_output is what the run/setup scripts printed.",
  "- start_chat opens another thread in this folder: give it a self-contained brief (goal, files, constraints, how to check, what to report). send_to_chat delivers a new turn there; check back later with read_chat, never in a tight loop. Two threads editing the same files collide. Never pass secrets between threads.",
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
    input.folderName ? `branch folder ${input.folderName}` : null,
    input.branch ? `git branch ${input.branch}` : null,
    `folder ${input.cwd}`,
    `target branch ${input.targetBranch || "the project's default"}`,
    input.port ? `SQUEAK_PORT ${input.port} (first of ten ports for this workspace's scripts)` : null,
  ].filter(Boolean);
  const lines = [
    "You are running in Squeak, a pager and workbench for coding agents on the owner's Mac; the owner reads you on the Mac app, their phone and Telegram, often away from the keyboard.",
    `This thread: ${where.join("; ")}. Keep notes and handoffs in .context/ (gitignored scratch space).`,
    "The `squeak` MCP server has tools for: the workspace diff, review comments, notifying the owner, a progress tracker, the target branch, other threads (list, read, send, start) and pond upkeep (look and labels).",
    input.agent === "claude"
      ? "The `squeak` skill has the details."
      : "The Squeak guide appended below has the details.",
    "Use your own subagents for short internal work; start another thread for work that is long, parallel or should be watched.",
    "Messages can come from more than one person. Each message from someone other than the owner starts with a line `[from <name> · teammate]`; the owner's messages start with `[from <name> · owner]` once anyone else has written in this thread. Address people by name, keep track of who asked for what, and if two people ask for conflicting things, say so and ask; the owner's word decides. Only the owner can approve actions or stop you.",
    ...(input.shared ? ["Other people have already written in this thread."] : []),
    ASK_ESSENCE,
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
