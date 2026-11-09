import { supports, type AgentCapability, type AgentResponse, type StartSessionRequest } from "./adapter.js";
import { toAgentSession } from "./adapters/state-map.js";
import type { AgentRegistry } from "./registry.js";
import type { AgentProvider, AgentSession, SessionId } from "./types.js";
import { distinctTitles } from "../fleet/radar.js";
import type { FleetSession } from "../fleet/types.js";

export interface SessionSnapshot {
  readonly active: readonly FleetSession[];
  /** The monitor's attention list; absent from a bare source, which then reports no asks. */
  readonly attention?: readonly { readonly session: { readonly key: string }; readonly kind: string }[];
}

/** Narrow view of FleetMonitor; the monitor satisfies it structurally. */
export interface SessionSource {
  readonly snapshot: SessionSnapshot;
  onSnapshot(listener: (snapshot: SessionSnapshot) => void): () => void;
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
  /** Clock for stall detection; tests set it. */
  now?: () => number;
}

function ordered(snapshot: SessionSnapshot, nowMs: number): AgentSession[] {
  const active = snapshot.active;
  const kinds = new Map<string, string[]>();
  for (const item of snapshot.attention ?? []) {
    kinds.set(item.session.key, [...(kinds.get(item.session.key) ?? []), item.kind]);
  }
  // The radar's own rule, so the title reads the same on every surface.
  const context = { distinctTitles: distinctTitles([...active]), kinds, nowMs };
  return active
    .map((s) => toAgentSession(s, context))
    .sort((a, b) => {
      const byTime = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
      return a.title.localeCompare(b.title);
    });
}

function signature(sessions: readonly AgentSession[]): string {
  return sessions
    .map(
      (s) =>
        `${s.id}|${s.state}|${s.updatedAt}|${s.title}|${s.attention?.displayTitle}|${s.attention?.stalled}|${s.attention?.asks.join(",")}|${s.attention?.contextPercent}`,
    )
    .join("\n");
}

/** The one place the app consumes core sessions from, and acts on them through adapters. */
export class SqueakSessionStore {
  private readonly registry: AgentRegistry;
  private readonly source: SessionSource;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private lastSignature: string;

  constructor(options: SqueakSessionStoreOptions) {
    this.registry = options.registry;
    this.source = options.source;
    this.now = options.now ?? Date.now;
    this.lastSignature = signature(this.sessions());
  }

  /** Active sessions (what the fleet shows), newest first by updatedAt, ties by title. */
  sessions(): AgentSession[] {
    return ordered(this.source.snapshot, this.now());
  }

  onChange(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /** Subscribes to the source; idempotent. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.source.onSnapshot((snapshot) => {
      const next = signature(ordered(snapshot, this.now()));
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
