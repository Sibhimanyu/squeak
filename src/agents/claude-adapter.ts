import type { AgentResponse } from "../core/adapter.js";
import type { SessionId } from "../core/types.js";
import { ClaudeRunner } from "../native/claude-runner.js";
import type { RequestKind, Resolution } from "../native/types.js";
import { ClaudeEventTranslator } from "./claude-translate.js";
import { CLAUDE_MATRIX } from "./providers.js";
import { RunnerAdapter, type ProviderTranslation, type RunnerFactory } from "./runner-adapter.js";
import type { AgentLaunch, AgentStartConfiguration, WorkspaceMetadata } from "../workspace/types.js";
import type { BinaryLocator } from "./detect.js";

export class ClaudeCodeAdapter extends RunnerAdapter {
  readonly provider = "claudeCode" as const;
  readonly matrix = CLAUDE_MATRIX;

  protected translation(sessionId: SessionId, now: () => string): ProviderTranslation {
    const t = new ClaudeEventTranslator(sessionId, now);
    return {
      message: (_kind, payload) => t.translate(payload),
      delta: () => [],
      request: (kind, payload) => {
        if (kind === "question") return t.question(payload);
        if (kind === "plan" || kind === "tool") return t.permission(kind, payload);
        return undefined;
      },
    };
  }

  protected resolution(kind: RequestKind, payload: unknown, response: AgentResponse): Resolution {
    const message = response.text?.trim() || undefined;
    if (kind === "question") {
      const input = (payload as { input?: { questions?: { question?: string; options?: { label?: string }[] }[] } })
        .input;
      const q = input?.questions?.[0];
      const picked = response.actionId !== undefined ? q?.options?.[Number(response.actionId)]?.label : undefined;
      const answer = picked ?? message;
      if (!q?.question || !answer) return { decision: "deny", message: "No answer was given." };
      return { decision: "allow", answers: { [q.question]: answer } };
    }
    // Claude's runner has no session-scoped allow of its own, so only once / deny / deny-with-feedback exist.
    if (response.actionId === "allowOnce") return { decision: "allow" };
    return { decision: "deny", ...(message ? { message } : {}) };
  }
}

/** Builds the real ClaudeRunner for a session (the SDK is imported by the runner on first send, not here). */
export function createClaudeRunnerFactory(
  options: { executable?: string; permissionMode?: string } = {},
): RunnerFactory {
  return (input) =>
    new ClaudeRunner({
      cwd: input.cwd,
      model: input.model ?? "",
      permissionMode: options.permissionMode ?? "default",
      resume: input.resume ?? null,
      hooks: input.hooks,
      ...(options.executable ? { executable: options.executable } : {}),
    });
}

/**
 * What the Workspace engine's launch port needs for a Claude process the supervisor owns: the CLI's own
 * stream-json mode, so stdout is exactly what `ClaudeEventTranslator` reads (`parseStreamJsonLine`).
 */
export function claudeLaunch(
  workspace: WorkspaceMetadata,
  config: AgentStartConfiguration,
  locate: BinaryLocator,
  resumeId?: string,
): AgentLaunch {
  const executable = locate("claude");
  if (!executable) throw new Error("Claude Code is not installed.");
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  if (config.model) args.push("--model", config.model);
  if (resumeId) args.push("--resume", resumeId);
  return {
    descriptor: {
      executable,
      arguments: args,
      environment: { CLAUDE_CODE_ENTRYPOINT: "squeak" },
      requiresPTY: false,
      workingDirectory: workspace.path,
    },
    ...(resumeId ? { externalId: resumeId } : {}),
    ...(config.title ? { title: config.title } : {}),
  };
}
