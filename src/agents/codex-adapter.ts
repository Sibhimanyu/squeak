import type { AgentResponse } from "../core/adapter.js";
import type { SessionId } from "../core/types.js";
import { CodexRunner, type CodexClient } from "../native/codex-runner.js";
import type { RequestKind, Resolution } from "../native/types.js";
import { CodexEventTranslator } from "./codex-translate.js";
import { CODEX_MATRIX } from "./providers.js";
import { RunnerAdapter, type ProviderTranslation, type RunnerFactory } from "./runner-adapter.js";
import type { AgentLaunch, AgentStartConfiguration, WorkspaceMetadata } from "../workspace/types.js";
import type { BinaryLocator } from "./detect.js";

type Obj = Record<string, unknown>;

export class CodexAdapter extends RunnerAdapter {
  readonly provider = "codex" as const;
  readonly matrix = CODEX_MATRIX;

  protected translation(sessionId: SessionId, now: () => string): ProviderTranslation {
    const t = new CodexEventTranslator(sessionId, now);
    return {
      // CodexRunner reports a completed item as `item/<type>` with the item, and a turn as `turn/completed`.
      message: (kind, payload) =>
        kind === "turn/completed"
          ? t.translate({ method: "turn/completed", params: { turn: payload as Obj } })
          : kind.startsWith("item/")
            ? t.translate({ method: "item/completed", params: { item: payload as Obj } })
            : [],
      delta: (payload) => {
        const { method, ...params } = (payload ?? {}) as Obj;
        return typeof method === "string" ? t.translate({ method, params }) : [];
      },
      request: (_kind, payload) => {
        const { method, item, ...params } = (payload ?? {}) as Obj;
        return typeof method === "string" ? t.approval(method, params, item) : undefined;
      },
    };
  }

  protected resolution(_kind: RequestKind, _payload: unknown, response: AgentResponse): Resolution {
    if (response.actionId === "allowOnce") return { decision: "allow" };
    if (response.actionId === "allowSession") return { decision: "allow", scope: "session" };
    return { decision: "deny", ...(response.text?.trim() ? { message: response.text.trim() } : {}) };
  }
}

/** Builds the real CodexRunner over a client the caller made (a `CodexAppServerAdapter` in production). */
export function createCodexRunnerFactory(options: {
  client: () => CodexClient;
  permissionMode?: string;
}): RunnerFactory {
  return (input) =>
    new CodexRunner({
      cwd: input.cwd,
      model: input.model ?? "",
      permissionMode: options.permissionMode ?? "default",
      resume: input.resume ?? null,
      hooks: input.hooks,
      client: options.client(),
    });
}

/**
 * The process the supervisor would own for Codex: the app-server over stdio, the same command
 * `CodexAppServerAdapter` spawns. Speaking its JSON-RPC needs a client; `CodexAdapter` uses the runner for that.
 */
export function codexLaunch(
  workspace: WorkspaceMetadata,
  config: AgentStartConfiguration,
  locate: BinaryLocator,
  resumeId?: string,
): AgentLaunch {
  const executable = locate("codex");
  if (!executable) throw new Error("Codex is not installed.");
  return {
    descriptor: {
      executable,
      arguments: ["app-server", "--listen", "stdio://"],
      environment: {},
      requiresPTY: false,
      workingDirectory: workspace.path,
    },
    ...(resumeId ? { externalId: resumeId } : {}),
    ...(config.title ? { title: config.title } : {}),
  };
}
