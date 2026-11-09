import {
  eventIdFor,
  type AgentEvent,
  type AgentPermissionRequest,
  type AgentQuestion,
  type AgentToolCategory,
} from "../core/events.js";
import type { SessionId } from "../core/types.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export function claudeToolCategory(name: string, input: Obj = {}): AgentToolCategory {
  if (name.startsWith("mcp__")) return "mcp";
  switch (name) {
    case "Bash": {
      const cmd = str(input.command) ?? "";
      return /^\s*git(\s|$)/.test(cmd) ? "git" : "shell";
    }
    case "Read":
      return "fileRead";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "fileWrite";
    case "Grep":
    case "Glob":
    case "WebSearch":
      return "search";
    case "WebFetch":
      return "browser";
    case "Task":
    case "Agent":
    case "TodoWrite":
      return "task";
    default:
      return "unknown";
  }
}

function toolTitle(name: string, input: Obj): { title: string; detail?: string } {
  const detail = str(input.command) ?? str(input.file_path) ?? str(input.path) ?? str(input.pattern) ?? str(input.url);
  return { title: name, ...(detail ? { detail: detail.slice(0, 200) } : {}) };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (isObj(c) && typeof c.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** One JSON line of `claude --output-format stream-json`; undefined for anything that is not an object. */
export function parseStreamJsonLine(line: string): Obj | undefined {
  const t = line.trim();
  if (!t.startsWith("{") || t.length > 4_000_000) return undefined;
  try {
    const v: unknown = JSON.parse(t);
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Claude Code's stream-json messages (the same objects the Agent SDK's `query` yields and ClaudeRunner hands to
 * `onMessage`) as core events. Stable ids come from the message/tool ids, so a message Claude writes twice while
 * streaming is the same event. Unknown shapes produce nothing rather than guesses.
 */
export class ClaudeEventTranslator {
  private readonly tools = new Map<string, { name: string; category: AgentToolCategory; input: Obj }>();

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

  translate(msg: unknown): AgentEvent[] {
    if (!isObj(msg)) return [];
    const type = msg.type;
    if (type === "system" && msg.subtype === "init") {
      const sid = str(msg.session_id);
      return sid ? [this.ev(`init:${sid}`, { type: "sessionStarted" })] : [];
    }
    if (type === "assistant" && isObj(msg.message)) return this.assistant(msg.message, str(msg.uuid));
    if (type === "user" && isObj(msg.message)) return this.user(msg.message);
    if (type === "result") return [this.result(msg)];
    return [];
  }

  private assistant(message: Obj, uuid?: string): AgentEvent[] {
    const mid = str(message.id) ?? uuid;
    const content = message.content;
    if (!mid || !Array.isArray(content)) return [];
    const out: AgentEvent[] = [];
    content.forEach((block, i) => {
      if (!isObj(block)) return;
      if (block.type === "text" && str(block.text)) {
        out.push(this.ev(`${mid}:${i}:text`, { type: "agentMessage", text: block.text as string }));
      } else if (block.type === "thinking") {
        const text = str(block.thinking);
        out.push(this.ev(`${mid}:${i}:thinking`, { type: "thinking", ...(text ? { text } : {}) }));
      } else if (block.type === "tool_use") {
        out.push(...this.toolUse(block));
      }
    });
    return out;
  }

  private toolUse(block: Obj): AgentEvent[] {
    const id = str(block.id);
    const name = str(block.name);
    if (!id || !name) return [];
    const input = isObj(block.input) ? block.input : {};
    const category = claudeToolCategory(name, input);
    this.tools.set(id, { name, category, input });
    const out: AgentEvent[] = [];
    if (name === "AskUserQuestion") return out; // surfaces as questionRequested, from the permission callback
    out.push(
      this.ev(`${id}:started`, {
        type: "toolStarted",
        tool: { id, name, category, ...toolTitle(name, input), state: "running" },
      }),
    );
    const path = str(input.file_path) ?? str(input.notebook_path);
    if (path) {
      if (name === "Read") out.push(this.ev(`${id}:file`, { type: "fileRead", path }));
      else if (name === "Write") out.push(this.ev(`${id}:file`, { type: "fileCreated", path }));
      else if (category === "fileWrite") out.push(this.ev(`${id}:file`, { type: "fileEdited", path }));
    }
    return out;
  }

  private user(message: Obj): AgentEvent[] {
    if (!Array.isArray(message.content)) return [];
    const out: AgentEvent[] = [];
    for (const block of message.content) {
      if (!isObj(block) || block.type !== "tool_result") continue;
      const id = str(block.tool_use_id);
      const known = id ? this.tools.get(id) : undefined;
      if (!id || !known) continue;
      const text = textOf(block.content);
      if (text) out.push(this.ev(`${id}:output`, { type: "toolOutput", toolId: id, text: text.slice(0, 8000) }));
      out.push(
        this.ev(`${id}:completed`, {
          type: "toolCompleted",
          tool: {
            id,
            name: known.name,
            category: known.category,
            ...toolTitle(known.name, known.input),
            state: block.is_error === true ? "failed" : "completed",
          },
        }),
      );
    }
    return out;
  }

  private result(msg: Obj): AgentEvent {
    const key = `result:${str(msg.uuid) ?? str(msg.session_id) ?? ""}:${str(msg.subtype) ?? ""}:${String(msg.num_turns ?? "")}:${String(msg.duration_ms ?? "")}`;
    const said = str(msg.result)?.trim();
    if (msg.subtype === "success" && msg.is_error !== true) {
      return this.ev(key, { type: "completed", ...(said ? { summary: said.slice(0, 500) } : {}) });
    }
    return this.ev(key, { type: "failed", message: said ?? str(msg.subtype) ?? "error" });
  }

  /** A `canUseTool` payload as ClaudeRunner reports it (`kind: "tool" | "plan"`). */
  permission(kind: "tool" | "plan", payload: unknown): AgentEvent | undefined {
    if (!isObj(payload)) return undefined;
    const toolName = str(payload.toolName) ?? "tool";
    const input = isObj(payload.input) ? payload.input : {};
    const id = str(payload.toolUseID) ?? `${toolName}:${JSON.stringify(input).slice(0, 80)}`;
    const category = claudeToolCategory(toolName, input);
    const files = [str(input.file_path), str(payload.blockedPath)].filter((p): p is string => !!p);
    const request: AgentPermissionRequest = {
      id,
      sessionId: this.sessionId,
      category: kind === "plan" ? "unknown" : permissionCategory(category),
      summary: str(payload.title) ?? (kind === "plan" ? "Approve the plan" : `Allow ${toolName}`),
      ...(str(input.command) ? { command: str(input.command)! } : {}),
      files: [...new Set(files)],
      availableActions: ["allowOnce", "deny", "denyWithFeedback"],
    };
    return this.ev(`${id}:permission`, { type: "permissionRequested", request });
  }

  /** An AskUserQuestion payload (`kind: "question"`): its first question becomes the request. */
  question(payload: unknown): AgentEvent | undefined {
    if (!isObj(payload) || !isObj(payload.input) || !Array.isArray(payload.input.questions)) return undefined;
    const first = payload.input.questions.find(isObj);
    const prompt = first && str(first.question);
    if (!first || !prompt) return undefined;
    const id = str(payload.toolUseID) ?? `ask:${prompt.slice(0, 60)}`;
    const options = (Array.isArray(first.options) ? first.options : [])
      .filter(isObj)
      .map((o, i) => ({ id: String(i), label: str(o.label) ?? "" }))
      .filter((o) => o.label);
    const question: AgentQuestion = { id, prompt, options, allowsFreeform: true };
    return this.ev(`${id}:question`, { type: "questionRequested", question });
  }
}

function permissionCategory(c: AgentToolCategory): AgentPermissionRequest["category"] {
  switch (c) {
    case "shell":
      return "shell";
    case "git":
      return "git";
    case "fileWrite":
      return "fileWrite";
    case "browser":
      return "network";
    case "mcp":
      return "externalTool";
    default:
      return "unknown";
  }
}
