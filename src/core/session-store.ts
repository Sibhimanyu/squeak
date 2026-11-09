import { supports, type AgentCapability, type AgentResponse, type StartSessionRequest } from "./adapter.js";
import { toAgentSession } from "./adapters/state-map.js";
import type { AgentRegistry } from "./registry.js";
import type { AgentProvider, AgentSession, SessionId } from "./types.js";
import type { FleetSession } from "../fleet/types.js";

/** Narrow view of FleetMonitor; the monitor satisfies it structurally. */
export interface SessionSource {
  readonly snapshot: { readonly active: readonly FleetSession[] };
  onSnapshot(listener: (snapshot: { readonly active: readonly FleetSession[] }) => void): () => void;
  refresh(): Promise<unknown>;
}

export class CoreCapabilityError extends Error {
  constructor(
    readonly provider: AgentProvider,
    readonly capability: AgentCapability,
    readonly reason: "no-adapter" | "unsupported" = "unsupported",
  ) {
    super(
      reason === "no-adapter" ? `No adapter registered for ${provider}` : `${provider} does not support ${capability}`,
    );
    this.name = "CoreCapabilityError";
  }
}

export class CoreSessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Unknown session: ${sessionId}`);
    this.name = "CoreSessionNotFoundError";
  }
}

export interface SqueakSessionStoreOptions {
  registry: AgentRegistry;
  source: SessionSource;
}

function ordered(sessions: readonly FleetSession[]): AgentSession[] {
  return sessions.map(toAgentSession).sort((a, b) => {
    const byTime = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
    return a.title.localeCompare(b.title);
  });
}

function signature(sessions: readonly AgentSession[]): string {
  return sessions.map((s) => `${s.id}|${s.state}|${s.updatedAt}|${s.title}`).join("\n");
}

/** The one place the app consumes core sessions from, and acts on them through adapters. */
export class SqueakSessionStore {
  private readonly registry: AgentRegistry;
  private readonly source: SessionSource;
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private lastSignature: string;

  constructor(options: SqueakSessionStoreOptions) {
    this.registry = options.registry;
    this.source = options.source;
    this.lastSignature = signature(this.sessions());
  }

  /** Active sessions (what the fleet shows), newest first by updatedAt, ties by title. */
  sessions(): AgentSession[] {
    return ordered(this.source.snapshot.active);
  }

  onChange(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /** Subscribes to the source; idempotent. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.source.onSnapshot((snapshot) => {
      const next = signature(ordered(snapshot.active));
      if (next === this.lastSignature) return;
      this.lastSignature = next;
      for (const listener of [...this.listeners]) listener();
    });
  }

  /** Unsubscribes; idempotent. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async refresh(): Promise<void> {
    await this.source.refresh();
  }

  async send(sessionId: SessionId, text: string): Promise<void> {
    const adapter = this.adapterFor(sessionId, "messaging");
    await adapter.send!(sessionId, text);
  }

  async respond(sessionId: SessionId, response: AgentResponse): Promise<void> {
    const session = this.find(sessionId);
    const adapter = this.registry.adapter(session.provider);
    if (!adapter) throw new CoreCapabilityError(session.provider, "questions", "no-adapter");
    const cap: AgentCapability = supports(adapter, "questions") ? "questions" : "approvals";
    if (!supports(adapter, cap)) throw new CoreCapabilityError(session.provider, "questions");
    await adapter.respond!(sessionId, response);
  }

  async startSession(provider: AgentProvider, request: StartSessionRequest): Promise<AgentSession> {
    const adapter = this.registry.adapter(provider);
    if (!adapter) throw new CoreCapabilityError(provider, "startSession", "no-adapter");
    if (!supports(adapter, "startSession")) throw new CoreCapabilityError(provider, "startSession");
    return adapter.startSession!(request);
  }

  async stopSession(sessionId: SessionId): Promise<void> {
    const adapter = this.adapterFor(sessionId, "stopSession");
    await adapter.stop!(sessionId);
  }

  private find(sessionId: SessionId): AgentSession {
    const session = this.sessions().find((s) => s.id === sessionId);
    if (!session) throw new CoreSessionNotFoundError(sessionId);
    return session;
  }

  private adapterFor(sessionId: SessionId, capability: AgentCapability) {
    const session = this.find(sessionId);
    const adapter = this.registry.adapter(session.provider);
    if (!adapter) throw new CoreCapabilityError(session.provider, capability, "no-adapter");
    if (!supports(adapter, capability)) throw new CoreCapabilityError(session.provider, capability);
    return adapter;
  }
}
