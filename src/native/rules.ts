import type { AllowRule, AllowRuleKind, RequestKind } from "./types.js";

/** Tools whose approval is the person's answer, never a standing rule. */
const NEVER_RULE_TOOLS = new Set(["ExitPlanMode", "AskUserQuestion"]);

/** Anything that can chain, background, pipe, redirect or substitute: a prefix rule never covers it. */
const SHELL_META = /[;&|`<>\n\r]|\$\(|\$\{/;

const BASH_WRAPPER = /^(?:\/\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/;

export const RULE_KINDS: readonly AllowRuleKind[] = ["tool", "bash-exact", "bash-prefix"];

/** The command a request would run, with Codex's `/bin/bash -lc '…'` wrapper taken off. */
export function commandOf(kind: RequestKind, payload: unknown): string | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  let command: string | null = null;
  if (kind === "tool" && p.toolName === "Bash") {
    const input = (p.input ?? {}) as Record<string, unknown>;
    if (typeof input.command === "string") command = input.command;
  } else if (kind === "command" && typeof p.command === "string") {
    command = p.command;
  }
  if (command === null) return null;
  command = command.trim();
  const wrapped = BASH_WRAPPER.exec(command);
  return (wrapped ? wrapped[2]! : command).trim() || null;
}

/** The tool name a rule of kind `tool` names: Claude's tool, or Codex's `command` / `fileChange`. */
export function toolNameOf(kind: RequestKind, payload: unknown): string | null {
  if (kind === "tool") {
    const name = (payload as { toolName?: unknown } | null)?.toolName;
    return typeof name === "string" && name ? name : null;
  }
  if (kind === "command") return "command";
  if (kind === "file_change") return "fileChange";
  return null;
}

/** Why a request can never be allowed for a session, or null. */
export function neverAllowReason(kind: RequestKind, payload: unknown): string | null {
  if (kind === "plan" || kind === "question") return "a plan or a question is always answered by a person";
  const name = toolNameOf(kind, payload);
  if (name && NEVER_RULE_TOOLS.has(name)) return `${name} is always answered by a person`;
  return null;
}

/** Bash → its exact command; any other tool → its name. Null when there is nothing to name. */
export function deriveRule(kind: RequestKind, payload: unknown): AllowRule | null {
  if (neverAllowReason(kind, payload)) return null;
  const command = commandOf(kind, payload);
  if (command !== null) return { kind: "bash-exact", value: command };
  if ((kind === "tool" && (payload as { toolName?: unknown } | null)?.toolName === "Bash") || kind === "command") {
    return null;
  }
  const name = toolNameOf(kind, payload);
  return name ? { kind: "tool", value: name } : null;
}

/** An error sentence when a client-supplied rule is unusable, else null. */
export function invalidRule(rule: unknown): string | null {
  if (!rule || typeof rule !== "object") return "rule must be an object";
  const { kind, value } = rule as Record<string, unknown>;
  if (typeof kind !== "string" || !RULE_KINDS.includes(kind as AllowRuleKind)) {
    return "rule.kind must be tool, bash-exact or bash-prefix";
  }
  if (typeof value !== "string" || !value.trim()) return "rule.value is required";
  if (kind === "tool" && NEVER_RULE_TOOLS.has(value.trim())) return `${value.trim()} can't be allowed for a session`;
  if (kind === "bash-prefix" && SHELL_META.test(value)) return "a prefix rule can't contain shell operators";
  return null;
}

export function normalizeRule(rule: AllowRule): AllowRule {
  return { kind: rule.kind, value: rule.value.trim() };
}

export function matchesRule(rule: AllowRule, kind: RequestKind, payload: unknown): boolean {
  if (neverAllowReason(kind, payload)) return false;
  if (rule.kind === "tool") return toolNameOf(kind, payload) === rule.value;
  const command = commandOf(kind, payload);
  if (command === null) return false;
  if (rule.kind === "bash-exact") return command === rule.value;
  // bash-prefix: whole words only, and nothing in the command that could run something else.
  if (SHELL_META.test(command)) return false;
  return command === rule.value || (command.startsWith(rule.value) && /\s/.test(command[rule.value.length]!));
}

export function describeRule(rule: AllowRule): string {
  if (rule.kind === "tool") return `${rule.value} (this tool)`;
  if (rule.kind === "bash-exact") return rule.value;
  return `${rule.value} …`;
}
