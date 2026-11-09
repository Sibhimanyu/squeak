import type { AgentRegistry } from "../registry.js";
import { ConductorAdapter, type ConductorAdapterDeps } from "./conductor-adapter.js";
import { SqueakNativeAdapter, type SqueakNativeAdapterDeps } from "./native-adapter.js";
import { ClaudeCodeTerminalAdapter, CodexTerminalAdapter, type TerminalAdapterDeps } from "./terminal-adapters.js";

export * from "./state-map.js";
export * from "./fleet-ports.js";
export * from "./conductor-adapter.js";
export * from "./terminal-adapters.js";
export * from "./native-adapter.js";

export interface DefaultAdapterDeps {
  conductor: ConductorAdapterDeps;
  terminal: TerminalAdapterDeps;
  /** Optional: absent, Squeak's own chats have no adapter (as before). */
  native?: SqueakNativeAdapterDeps;
}

export function registerDefaultAdapters(registry: AgentRegistry, deps: DefaultAdapterDeps): void {
  registry.register(new ConductorAdapter(deps.conductor));
  registry.register(new ClaudeCodeTerminalAdapter(deps.terminal));
  registry.register(new CodexTerminalAdapter(deps.terminal));
  if (deps.native) registry.register(new SqueakNativeAdapter(deps.native));
}
