import type { NewChatAgent } from "./new-chat.js";

/**
 * Splitting a new chat's work across models, to save usage: the chat's own model plans and reviews,
 * cheaper Claude subagents write the code and run the commands, and "plan first" holds every change
 * until the person says go. It reaches the agent as text in front of its first message only (Conductor's
 * `agentMessage`); the chat shows what the person wrote. Conductor's relay cannot set plan mode itself
 * (its `/config` route refuses it), so plan first is an instruction too.
 */
export interface WorkSplit {
  /** A worker model alias (`SPLIT_WORKERS`) for writing code; absent: the chat's own model does it. */
  code?: string;
  /** A worker model alias for builds, tests and other commands; absent: the chat's own model does it. */
  run?: string;
  /** Plan, show it, and change nothing until told to go. */
  planFirst?: boolean;
}

export interface SplitWorker {
  /** What Claude Code's Agent tool takes as `model`: a family, which it resolves to its current version. */
  id: string;
  label: string;
}

/** The models a Claude chat can hand work to, cheapest-first after Sonnet, the usual coder. */
export const SPLIT_WORKERS: SplitWorker[] = [
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
  { id: "opus", label: "Opus" },
  { id: "fable", label: "Fable" },
];

/** A phone's or the Mac app's split, checked; the error is for the person. Nothing chosen is `split: undefined`. */
export function checkWorkSplit(
  agent: NewChatAgent,
  raw: unknown,
): { ok: true; split?: WorkSplit } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, reason: "Not a request this Mac understands." };
  const { code, run, planFirst, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return { ok: false, reason: "Not a request this Mac understands." };
  if (planFirst !== undefined && typeof planFirst !== "boolean") {
    return { ok: false, reason: "Not a request this Mac understands." };
  }
  for (const worker of [code, run]) {
    if (worker === undefined) continue;
    if (typeof worker !== "string" || !SPLIT_WORKERS.some((offered) => offered.id === worker)) {
      return { ok: false, reason: "That worker model isn't one this Mac offers. Pick another." };
    }
    if (agent !== "claude") {
      return { ok: false, reason: "Only a Claude chat can hand work to other models." };
    }
  }
  const split: WorkSplit = {
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof run === "string" ? { run } : {}),
    ...(planFirst === true ? { planFirst: true } : {}),
  };
  return Object.keys(split).length > 0 ? { ok: true, split } : { ok: true };
}

/** The instructions put in front of the first message, or null when nothing is split. Kept short: it is paid for on every turn. */
export function splitBrief(split: WorkSplit | undefined): string | null {
  if (!split) return null;
  const lines: string[] = [];
  if (split.code || split.run) {
    lines.push(
      "- You are the planner: plan, decide and review. Keep your own reading and editing small; workers do the bulk.",
    );
  }
  if (split.code) {
    lines.push(
      `- Code: hand each change to a subagent (Agent tool, model "${split.code}") with a self-contained brief: the files, the change, how to check it. Ask for a report of 10 lines or fewer, not the diff.`,
    );
  }
  if (split.run) {
    lines.push(
      `- Run: builds, tests and long commands go to a subagent (Agent tool, model "${split.run}"). It reports the command, the exit code and only the failures.`,
    );
  }
  if (split.code || split.run) {
    lines.push(
      "- An edit of a line or two, or one quick command, do yourself: handing it off costs more than it saves.",
    );
  }
  if (split.planFirst) {
    lines.push(
      "- Plan first: look around without changing anything, then reply with the plan and stop. Change nothing until I say go.",
    );
  }
  if (lines.length === 0) return null;
  return ["[How to work on this, set in Squeak to save usage]", ...lines].join("\n");
}

/** What the agent receives in place of `text`, or undefined when it receives `text` as it is. */
export function agentMessageFor(text: string, split: WorkSplit | undefined): string | undefined {
  const brief = splitBrief(split);
  return brief ? `${brief}\n\n${text}` : undefined;
}

/** "Sonnet codes · Haiku runs · plan first", for a log line. */
export function describeSplit(split: WorkSplit | undefined): string {
  if (!split) return "";
  const label = (id: string) => SPLIT_WORKERS.find((worker) => worker.id === id)?.label ?? id;
  return [
    split.code ? `${label(split.code)} codes` : "",
    split.run ? `${label(split.run)} runs` : "",
    split.planFirst ? "plan first" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
