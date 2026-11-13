import type { AgentCapabilities, AgentResponse, SqueakAgentAdapter, StartSessionRequest } from "../core/adapter.js";
import type { AgentEvent } from "../core/events.js";
import { eventIdFor } from "../core/events.js";
import type { FleetObservation } from "../core/adapters/fleet-ports.js";
import { discoverFor, findOwned } from "../core/adapters/fleet-ports.js";
import { asSessionId, LOCAL_RUNTIME_ID, type AgentProvider, type AgentSession, type SessionId } from "../core/types.js";
import type { AgentState } from "../core/state.js";
import type {
  RequestKind,
  Resolution,
  Runner,
  RunnerHooks,
  SessionStatus,
  LegacySessionStatus,
} from "../native/types.js";
import { EventChannel } from "./event-channel.js";
import type { CapabilityMatrix } from "./matrix.js";
import { toCoreCapabilities } from "./matrix.js";

export interface RunnerFactoryInput {
  cwd: string;
  model?: string;
  /** The provider's own session/thread id, to continue a conversation. */
  resume?: string;
  hooks: RunnerHooks;
}

/** Builds the existing native runner for a session. Injected, so tests (and the host) decide what really runs. */
export type RunnerFactory = (input: RunnerFactoryInput) => Runner;

export interface RunnerAdapterDeps {
  createRunner: RunnerFactory;
  /** Terminal/Conductor sessions the fleet sees: what `discoverSessions` and `attach` (observe only) read. */
  observe?: FleetObservation;
  now?: () => string;
  newId?: () => string;
  /** Used when a request names no model. */
  defaultModel?: string;
}

/** What the translator side must offer; the two providers differ only here. */
export interface ProviderTranslation {
  /** onMessage / onDelta payloads to events. */
  message(kind: string, payload: unknown): AgentEvent[];
  delta(payload: unknown): AgentEvent[];
  request(kind: RequestKind, payload: unknown): AgentEvent | undefined;
}

interface Pending {
  kind: RequestKind;
  payload: unknown;
  resolve(r: Resolution): void;
}

interface Live {
  session: AgentSession;
  runner: Runner;
  channel: EventChannel;
  translation: ProviderTranslation;
  pending: Map<string, Pending>;
  stopped: boolean;
}

// Old names are read for older data (see LegacySessionStatus).
const STATUS: Record<SessionStatus | LegacySessionStatus, AgentState> = {
  idle: "idle",
  working: "working",
  awaiting_approval: "waitingForPermission",
  awaiting_plan: "waitingForInput",
  awaiting_answer: "waitingForInput",
  stopping: "working",
  needs_user_permission: "waitingForPermission",
  needs_plan_response: "waitingForInput",
  needs_user_input: "waitingForInput",
  cancelling: "working",
  error: "failed",
};

/**
 * Shared body of the Claude and Codex adapters: one existing native runner per session, its hooks turned into
 * the session's event stream, its approval requests held until `respond`. Provider protocol parsing stays in
 * the translators and the runners; nothing here reads a provider's wire format.
 */
export abstract class RunnerAdapter implements SqueakAgentAdapter {
  abstract readonly provider: AgentProvider;
  abstract readonly matrix: CapabilityMatrix;
  protected abstract translation(sessionId: SessionId, now: () => string): ProviderTranslation;
  /** The decision for a held request, from a normalized action. */
  protected abstract resolution(kind: RequestKind, payload: unknown, response: AgentResponse): Resolution;

  private readonly live = new Map<SessionId, Live>();
  protected readonly now: () => string;
  private readonly newId: () => string;

  constructor(protected readonly deps: RunnerAdapterDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    let n = 0;
    this.newId = deps.newId ?? (() => `${this.provider}-${Date.now().toString(36)}-${++n}`);
  }

  get capabilities(): AgentCapabilities {
    return toCoreCapabilities(this.matrix);
  }

  /** Native sessions of this adapter, then (read-only) the terminal sessions the fleet observes. */
  async discoverSessions(): Promise<AgentSession[]> {
    const own = [...this.live.values()].map((l) => ({ ...l.session }));
    const observed = this.deps.observe ? await discoverFor(this.deps.observe, this.provider) : [];
    return [...own, ...observed];
  }

  async startSession(request: StartSessionRequest): Promise<AgentSession> {
    return this.begin(request);
  }

  /** Provider-native continuation: the runner resumes the provider's own session id. */
  async resumeSession(externalId: string, request: StartSessionRequest): Promise<AgentSession> {
    return this.begin(request, externalId);
  }

  /**
   * Attach is observation of a session someone else runs (a terminal). The returned session has no runner: a
   * send or respond to it is refused, because Squeak must never type into a process it did not start.
   */
  async attach(sessionId: SessionId): Promise<AgentSession> {
    if (!this.deps.observe) throw new Error(`Cannot attach: no ${this.provider} sessions are observed`);
    const found = await findOwned(this.deps.observe, this.provider, sessionId);
    return (await discoverFor(async () => [found], this.provider))[0]!;
  }

  private async begin(request: StartSessionRequest, resume?: string): Promise<AgentSession> {
    if (!request.workspacePath) throw new Error("A workspace path is required to start a session");
    const id = asSessionId(this.newId());
    const at = this.now();
    const session: AgentSession = {
      id,
      projectId: request.projectId as AgentSession["projectId"],
      runtimeId: LOCAL_RUNTIME_ID,
      provider: this.provider,
      ...(resume ? { providerRef: { provider: this.provider, externalId: resume } } : {}),
      title: request.prompt?.split("\n")[0]?.slice(0, 80) || "New session",
      state: "starting",
      createdAt: at,
      updatedAt: at,
    };
    const channel = new EventChannel();
    const translation = this.translation(id, this.now);
    const pending = new Map<string, Pending>();
    const live: Live = {
      session,
      runner: undefined as unknown as Runner,
      channel,
      translation,
      pending,
      stopped: false,
    };
    live.runner = this.deps.createRunner({
      cwd: request.workspacePath,
      ...((request.model ?? this.deps.defaultModel) ? { model: (request.model ?? this.deps.defaultModel)! } : {}),
      ...(resume ? { resume } : {}),
      hooks: this.hooks(live),
    });
    this.live.set(id, live);
    channel.emit({ id: eventIdFor(id, "started"), sessionId: id, at, type: "sessionStarted", title: session.title });
    if (request.prompt) {
      channel.emit({ id: eventIdFor(id, "prompt:0"), sessionId: id, at, type: "userMessage", text: request.prompt });
      try {
        await live.runner.send(request.prompt);
      } catch (error) {
        this.fail(live, error);
        throw error;
      }
    }
    return { ...live.session };
  }

  private set(live: Live, state: AgentState): void {
    live.session.state = state;
    live.session.updatedAt = this.now();
  }

  private fail(live: Live, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.set(live, "failed");
    live.channel.emit({
      id: eventIdFor(live.session.id, `fail:${live.channel.events.length}`),
      sessionId: live.session.id,
      at: this.now(),
      type: "failed",
      message,
    });
  }

  private hooks(live: Live): RunnerHooks {
    const emit = (events: AgentEvent[]): void => {
      for (const e of events) {
        live.channel.emit(e);
        if (e.type === "completed") this.set(live, "completed");
        else if (e.type === "failed") this.set(live, "failed");
      }
    };
    return {
      onAgentSessionId: (externalId) => {
        live.session.providerRef = { provider: this.provider, externalId };
      },
      onMessage: (_role, kind, payload) => emit(live.translation.message(kind, payload)),
      onDelta: (payload) => emit(live.translation.delta(payload)),
      onStatus: (status) => {
        const state = STATUS[status];
        if (status === "error" || live.session.state === state) return;
        this.set(live, state);
        live.channel.emit({
          id: eventIdFor(live.session.id, `state:${live.channel.events.length}`),
          sessionId: live.session.id,
          at: this.now(),
          type: "stateChanged",
          state,
        });
      },
      onRequest: (kind, payload) =>
        new Promise<Resolution>((resolve) => {
          const refuse = (): void => resolve({ decision: "deny", message: "Squeak could not read this request." });
          const event = live.translation.request(kind, payload);
          const requestId =
            event?.type === "permissionRequested"
              ? event.request.id
              : event?.type === "questionRequested"
                ? event.question.id
                : undefined;
          if (!event || !requestId) return refuse();
          live.pending.set(requestId, { kind, payload, resolve });
          live.channel.emit(event);
        }),
      onTurnEnd: (outcome) => {
        if (outcome === "idle" && live.session.state !== "completed") this.set(live, "idle");
      },
      onExit: (error) => {
        if (live.stopped) return;
        if (error) this.fail(live, error);
        else {
          this.set(live, "stopped");
          live.channel.emit({
            id: eventIdFor(live.session.id, "exit"),
            sessionId: live.session.id,
            at: this.now(),
            type: "sessionStopped",
          });
        }
        live.channel.close();
      },
    };
  }

  private owned(sessionId: SessionId): Live {
    const live = this.live.get(sessionId);
    if (!live) {
      throw new Error(`No ${this.provider} session ${sessionId} started by Squeak (attached sessions are read-only)`);
    }
    return live;
  }

  async send(sessionId: SessionId, text: string): Promise<void> {
    const live = this.owned(sessionId);
    live.channel.emit({
      id: eventIdFor(sessionId, `user:${live.channel.events.length}`),
      sessionId,
      at: this.now(),
      type: "userMessage",
      text,
    });
    await live.runner.send(text);
  }

  async stop(sessionId: SessionId): Promise<void> {
    const live = this.owned(sessionId);
    if (live.stopped) return;
    live.stopped = true;
    for (const p of live.pending.values()) p.resolve({ decision: "deny", message: "Session stopped." });
    live.pending.clear();
    try {
      await live.runner.interrupt();
    } finally {
      await live.runner.close();
    }
    this.set(live, "stopped");
    live.channel.emit({ id: eventIdFor(sessionId, "stopped"), sessionId, at: this.now(), type: "sessionStopped" });
    live.channel.close();
  }

  async respond(sessionId: SessionId, response: AgentResponse): Promise<void> {
    const live = this.owned(sessionId);
    const pending = live.pending.get(response.requestId);
    if (!pending) throw new Error(`No pending request ${response.requestId}`);
    live.pending.delete(response.requestId);
    pending.resolve(this.resolution(pending.kind, pending.payload, response));
  }

  eventStream(sessionId: SessionId): AsyncIterable<AgentEvent> {
    const live = this.live.get(sessionId);
    if (!live) {
      return (async function* (): AsyncGenerator<AgentEvent> {})();
    }
    return live.channel.stream();
  }
}
