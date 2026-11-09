import type { AgentRegistry } from "../registry.js";
import { ConductorAdapter, type ConductorAdapterDeps } from "./conductor-adapter.js";
import { ClaudeCodeTerminalAdapter, CodexTerminalAdapter, type TerminalAdapterDeps } from "./terminal-adapters.js";

export * from "./state-map.js";
export * from "./fleet-ports.js";
export * from "./conductor-adapter.js";
export * from "./terminal-adapters.js";

export interface DefaultAdapterDeps {
  conductor: ConductorAdapterDeps;
  terminal: TerminalAdapterDeps;
}

export function registerDefaultAdapters(registry: AgentRegistry, deps: DefaultAdapterDeps): void {
  registry.register(new ConductorAdapter(deps.conductor));
  registry.register(new ClaudeCodeTerminalAdapter(deps.terminal));
  registry.register(new CodexTerminalAdapter(deps.terminal));
}
