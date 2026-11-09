import { eventIdFor, type AgentEvent, type AgentPermissionRequest } from "../core/events.js";
import type { SessionId } from "../core/types.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export interface CodexNote {
  method: string;
  params: Obj;
}

/**
 * Codex app-server notifications (`item/started`, `item/completed`, `turn/completed`, output deltas) as core
 * events. Patches become generic file activity; commands become shell tool activity. Unknown items produce
 * nothing. Ids come from the item/turn ids, so replays are the same events.
 */
export class CodexEventTranslator {
  private readonly deltas = new Map<string, number>();

  constructor(
    private readonly sessionId: SessionId,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private ev<T extends AgentEvent["type"]>(
    key: string,
    e: { type: T } & Omit<Extract<AgentEvent, { type: T }>, "id" | "sessionId" | "at">,
  ): AgentEvent {
    return { ...e, id: eventIdFor(this.sessionId, key), sessionId: this.sessionId, at: this.now() } as AgentEvent;
  }

  translate(n: CodexNote): AgentEvent[] {
    const p = n.params;
    const item = isObj(p.item) ? p.item : undefined;
    switch (n.method) {
      case "item/started":
        return item ? this.started(item) : [];
      case "item/completed":
        return item ? this.completed(item) : [];
      case "item/commandExecution/outputDelta": {
        const id = str(p.itemId);
        const text = str(p.delta);
        if (!id || !text) return [];
        // A delta has no id of its own: number them per item, so equal chunks stay separate events.
        const n = (this.deltas.get(id) ?? 0) + 1;
        this.deltas.set(id, n);
        return [this.ev(`${id}:delta:${n}`, { type: "toolOutput", toolId: id, text })];
      }
      case "turn/completed": {
        const turn = isObj(p.turn) ? p.turn : {};
        const key = `turn:${str(turn.id) ?? ""}:${str(turn.status) ?? ""}`;
        const status = str(turn.status);
        if (status === "completed") return [this.ev(key, { type: "completed" })];
        if (status === "interrupted") return [this.ev(key, { type: "sessionStopped" })];
        return [this.ev(key, { type: "failed", message: status ?? "failed" })];
      }
      default:
        return [];
    }
  }

  private started(item: Obj): AgentEvent[] {
    const id = str(item.id);
    if (!id) return [];
    if (item.type === "commandExecution") {
      return [this.ev(`${id}:started`, { type: "toolStarted", tool: this.command(id, item, "running") })];
    }
    if (item.type === "fileChange") {
      return [this.ev(`${id}:started`, { type: "toolStarted", tool: this.patch(id, item, "running") })];
    }
    return [];
  }

  private completed(item: Obj): AgentEvent[] {
    const id = str(item.id);
    switch (item.type) {
      case "agentMessage": {
        const text = str(item.text);
        return id && text ? [this.ev(`${id}:text`, { type: "agentMessage", text })] : [];
      }
      case "reasoning":
        return id ? [this.ev(`${id}:thinking`, { type: "thinking" })] : [];
      case "commandExecution": {
        if (!id) return [];
        const failed = typeof item.exitCode === "number" && item.exitCode !== 0;
        const out: AgentEvent[] = [
          this.ev(`${id}:started`, { type: "toolStarted", tool: this.command(id, item, "running") }),
        ];
        const output = str(item.aggregatedOutput);
        if (output) out.push(this.ev(`${id}:output`, { type: "toolOutput", toolId: id, text: output.slice(0, 8000) }));
        out.push(
          this.ev(`${id}:completed`, {
            type: "toolCompleted",
            tool: this.command(id, item, failed ? "failed" : "completed"),
          }),
        );
        return out;
      }
      case "fileChange": {
        if (!id) return [];
        const failed = item.status === "failed" || item.status === "declined";
        const out: AgentEvent[] = [
          this.ev(`${id}:started`, { type: "toolStarted", tool: this.patch(id, item, "running") }),
        ];
        for (const c of Array.isArray(item.changes) ? item.changes : []) {
          if (!isObj(c)) continue;
          const path = str(c.path);
          if (!path) continue;
          const kind = isObj(c.kind) ? str(c.kind.type) : str(c.kind);
          out.push(this.ev(`${id}:file:${path}`, { type: kind === "add" ? "fileCreated" : "fileEdited", path }));
        }
        out.push(
          this.ev(`${id}:completed`, {
            type: "toolCompleted",
            tool: this.patch(id, item, failed ? "failed" : "completed"),
          }),
        );
        return out;
      }
      default:
        return [];
    }
  }

  private command(id: string, item: Obj, state: "running" | "completed" | "failed") {
    const command = str(item.command) ?? "command";
    return {
      id,
      name: "commandExecution",
      category: "shell" as const,
      title: command.slice(0, 120),
      detail: command.slice(0, 200),
      state,
    };
  }

  private patch(id: string, item: Obj, state: "running" | "completed" | "failed") {
    const n = Array.isArray(item.changes) ? item.changes.length : 0;
    return {
      id,
      name: "fileChange",
      category: "fileWrite" as const,
      title: n === 1 ? "Edit 1 file" : `Edit ${n} files`,
      state,
    };
  }

  /** An approval server-request (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`). */
  approval(method: string, params: Obj, item?: unknown): AgentEvent | undefined {
    const isCommand = method === "item/commandExecution/requestApproval";
    if (!isCommand && method !== "item/fileChange/requestApproval") return undefined;
    const id = str(params.itemId) ?? `${method}:${str(params.command) ?? ""}`;
    const changes = isObj(item) && Array.isArray(item.changes) ? item.changes : [];
    const files = changes.map((c) => (isObj(c) ? str(c.path) : undefined)).filter((p): p is string => !!p);
    const offered = Array.isArray(params.availableDecisions) ? params.availableDecisions : [];
    const request: AgentPermissionRequest = {
      id,
      sessionId: this.sessionId,
      category: isCommand ? "shell" : "fileWrite",
      summary: isCommand ? `Run ${str(params.command) ?? "a command"}` : "Apply a patch",
      ...(isCommand && str(params.command) ? { command: str(params.command)! } : {}),
      files,
      availableActions: ["allowOnce", ...(offered.includes("acceptForSession") ? ["allowSession"] : []), "deny"],
    };
    return this.ev(`${id}:permission`, { type: "permissionRequested", request });
  }
}
