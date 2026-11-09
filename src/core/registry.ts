import type { SqueakAgentAdapter } from "./adapter.js";
import type { AgentProvider } from "./types.js";

export class AgentRegistry {
  private readonly adapters = new Map<AgentProvider, SqueakAgentAdapter>();

  register(adapter: SqueakAgentAdapter): void {
    if (this.adapters.has(adapter.provider)) {
      throw new Error(`Agent provider already registered: ${adapter.provider}`);
    }
    this.adapters.set(adapter.provider, adapter);
  }

  adapter(provider: AgentProvider): SqueakAgentAdapter | undefined {
    return this.adapters.get(provider);
  }

  providers(): AgentProvider[] {
    return [...this.adapters.keys()];
  }

  all(): SqueakAgentAdapter[] {
    return [...this.adapters.values()];
  }
}
