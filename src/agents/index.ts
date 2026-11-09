import type { AgentRegistry } from "../core/registry.js";
import { ClaudeCodeAdapter } from "./claude-adapter.js";
import { CodexAdapter } from "./codex-adapter.js";
import { CustomCommandAdapter, type CustomCommandDeps } from "./custom-command-adapter.js";
import type { RunnerAdapterDeps } from "./runner-adapter.js";

export * from "./matrix.js";
export * from "./providers.js";
export * from "./detect.js";
export * from "./diagnostics.js";
export * from "./event-channel.js";
export * from "./claude-translate.js";
export * from "./codex-translate.js";
export * from "./runner-adapter.js";
export * from "./claude-adapter.js";
export * from "./codex-adapter.js";
export * from "./custom-command-adapter.js";
export * from "./launch-port.js";

export interface AgentAdapterDeps {
  claude?: RunnerAdapterDeps;
  codex?: RunnerAdapterDeps;
  custom?: CustomCommandDeps;
}

/**
 * Registers the adapters whose dependencies are given. Nothing calls this at daemon start. Note the registry
 * allows one adapter per provider: `claudeCode` / `codex` collide with the terminal adapters of
 * `registerDefaultAdapters`, so a caller picks one set (or a registry of its own).
 */
export function registerAgentAdapters(registry: AgentRegistry, deps: AgentAdapterDeps): void {
  if (deps.claude) registry.register(new ClaudeCodeAdapter(deps.claude));
  if (deps.codex) registry.register(new CodexAdapter(deps.codex));
  if (deps.custom) registry.register(new CustomCommandAdapter(deps.custom));
}
