import type { AgentCapabilities, SqueakAgentAdapter, StartSessionRequest } from "../core/adapter.js";
import { eventIdFor, type AgentEvent } from "../core/events.js";
import type { AgentState } from "../core/state.js";
import { asSessionId, LOCAL_RUNTIME_ID, type AgentSession, type SessionId } from "../core/types.js";
import type { SpawnedProcess, Spawner } from "../workspace/supervisor.js";
import { EventChannel } from "./event-channel.js";
import { CUSTOM_MATRIX } from "./providers.js";
import { toCoreCapabilities } from "./matrix.js";

export interface CustomCommandConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  requiresPTY?: boolean;
  title?: string;
}

export interface CustomCommandDeps {
  config: CustomCommandConfig;
  /** Starts the process; production passes the supervisor's spawner so nothing runs unmanaged. */
  spawner: Spawner;
  now?: () => string;
  newId?: () => string;
}

interface Live {
  session: AgentSession;
  proc: SpawnedProcess;
  channel: EventChannel;
  stopRequested: boolean;
  exited: boolean;
}

/**
 * The escape hatch: an executable with arguments and environment. Text sent goes to stdin; every complete
 * stdout line is an agentMessage; exit 0 is completed, anything else failed. No questions, permissions or tool
 * events: a wrapper that prints lines cannot honestly offer them.
 */
export class CustomCommandAdapter implements SqueakAgentAdapter {
  readonly provider = "shell" as const;
  readonly capabilities: AgentCapabilities = toCoreCapabilities(CUSTOM_MATRIX);
  private readonly live = new Map<SessionId, Live>();
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(private readonly deps: CustomCommandDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    let n = 0;
    this.newId = deps.newId ?? (() => `shell-${Date.now().toString(36)}-${++n}`);
  }

  async discoverSessions(): Promise<AgentSession[]> {
    return [...this.live.values()].map((l) => ({ ...l.session }));
  }

  async startSession(request: StartSessionRequest): Promise<AgentSession> {
    if (!request.workspacePath) throw new Error("A workspace path is required to start a session");
    const { config } = this.deps;
    const id = asSessionId(this.newId());
    const at = this.now();
    const session: AgentSession = {
      id,
      projectId: request.projectId as AgentSession["projectId"],
      runtimeId: LOCAL_RUNTIME_ID,
      provider: this.provider,
      title: config.title ?? config.command,
      state: "starting",
      createdAt: at,
      updatedAt: at,
    };
    const proc = this.deps.spawner({
      executable: config.command,
      args: config.args ?? [],
      env: { ...(config.env ?? {}) },
      cwd: request.workspacePath,
      requiresPTY: config.requiresPTY ?? false,
    });
    const channel = new EventChannel();
    const live: Live = { session, proc, channel, stopRequested: false, exited: false };
    this.live.set(id, live);
    channel.emit({ id: eventIdFor(id, "started"), sessionId: id, at, type: "sessionStarted", title: session.title });
    this.set(live, "working");
    let buffer = "";
    let line = 0;
    const emitLine = (text: string): void => {
      if (!text.trim()) return;
      channel.emit({ id: eventIdFor(id, `line:${line++}`), sessionId: id, at: this.now(), type: "agentMessage", text });
    };
    proc.onOutput((stream, chunk) => {
      if (stream !== "stdout") return;
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        emitLine(buffer.slice(0, nl).replace(/\r$/, ""));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    });
    proc.onExit((code, signal) => {
      if (live.exited) return;
      live.exited = true;
      emitLine(buffer);
      buffer = "";
      const base = { id: eventIdFor(id, "exit"), sessionId: id, at: this.now() };
      if (live.stopRequested) {
        this.set(live, "stopped");
        channel.emit({ ...base, type: "sessionStopped" });
      } else if (code === 0) {
        this.set(live, "completed");
        channel.emit({ ...base, type: "completed" });
      } else {
        this.set(live, "failed");
        channel.emit({
          ...base,
          type: "failed",
          message: signal
            ? `The command was stopped by ${signal}.`
            : `The command exited with code ${code ?? "unknown"}.`,
        });
      }
      channel.close();
    });
    proc.onError(() => {
      if (live.exited) return;
      live.exited = true;
      this.set(live, "failed");
      channel.emit({
        id: eventIdFor(id, "exit"),
        sessionId: id,
        at: this.now(),
        type: "failed",
        message: "The command could not be started.",
      });
      channel.close();
    });
    if (request.prompt) await this.send(id, request.prompt);
    return { ...live.session };
  }

  private set(live: Live, state: AgentState): void {
    live.session.state = state;
    live.session.updatedAt = this.now();
  }

  private get(id: SessionId): Live {
    const live = this.live.get(id);
    if (!live) throw new Error(`No shell session ${id}`);
    return live;
  }

  async send(sessionId: SessionId, text: string): Promise<void> {
    const live = this.get(sessionId);
    if (live.exited) throw new Error("The command has already exited");
    live.channel.emit({
      id: eventIdFor(sessionId, `user:${live.channel.events.length}`),
      sessionId,
      at: this.now(),
      type: "userMessage",
      text,
    });
    live.proc.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  async stop(sessionId: SessionId): Promise<void> {
    const live = this.get(sessionId);
    if (live.exited) return;
    live.stopRequested = true;
    live.proc.kill("SIGTERM");
  }

  eventStream(sessionId: SessionId): AsyncIterable<AgentEvent> {
    const live = this.live.get(sessionId);
    return live ? live.channel.stream() : (async function* (): AsyncGenerator<AgentEvent> {})();
  }
}
