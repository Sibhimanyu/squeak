import type { AgentProvider } from "../core/types.js";
import type { AgentLaunch, AgentStartConfiguration, LaunchPort, WorkspaceMetadata } from "../workspace/types.js";
import { claudeLaunch } from "./claude-adapter.js";
import { codexLaunch } from "./codex-adapter.js";
import type { BinaryLocator } from "./detect.js";
import type { CustomCommandConfig } from "./custom-command-adapter.js";

export interface LaunchPortDeps {
  locate: BinaryLocator;
  custom?: CustomCommandConfig;
}

/**
 * A `LaunchPort` for the Workspace engine covering the providers that can launch here. Others are refused by
 * name, never launched as something else. `config.extra.resume` is the provider's own session id.
 */
export function createLaunchPort(deps: LaunchPortDeps): LaunchPort {
  return async (
    workspace: WorkspaceMetadata,
    provider: AgentProvider,
    config: AgentStartConfiguration,
  ): Promise<AgentLaunch> => {
    const resume = config.extra?.resume;
    switch (provider) {
      case "claudeCode":
        return claudeLaunch(workspace, config, deps.locate, resume);
      case "codex":
        return codexLaunch(workspace, config, deps.locate, resume);
      case "shell": {
        if (!deps.custom) throw new Error("No custom command is configured.");
        return {
          descriptor: {
            executable: deps.custom.command,
            arguments: deps.custom.args ?? [],
            environment: { ...(deps.custom.env ?? {}) },
            requiresPTY: deps.custom.requiresPTY ?? false,
            workingDirectory: workspace.path,
          },
          ...(deps.custom.title ? { title: deps.custom.title } : {}),
        };
      }
      default:
        throw new Error(`${provider} cannot be launched by Squeak yet.`);
    }
  };
}
