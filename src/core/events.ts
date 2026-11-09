import { createHash, randomUUID } from "node:crypto";
import type { AgentState } from "./state.js";
import { asEventId, type EventId, type SessionId } from "./types.js";

export interface AgentQuestion {
  id: string;
  prompt: string;
  options: { id: string; label: string }[];
  allowsFreeform: boolean;
}

export type AgentPermissionCategory =
  | "fileWrite"
  | "shell"
  | "network"
  | "git"
  | "destructive"
  | "externalTool"
  | "unknown";

export interface AgentPermissionRequest {
  id: string;
  sessionId: SessionId;
  category: AgentPermissionCategory;
  summary: string;
  command?: string;
  files: string[];
  availableActions: string[];
}

export type AgentToolCategory =
  | "shell"
  | "fileRead"
  | "fileWrite"
  | "search"
  | "git"
  | "mcp"
  | "browser"
  | "task"
  | "unknown";

export interface AgentToolActivity {
  id: string;
  name: string;
  category: AgentToolCategory;
  title: string;
  detail?: string;
  state: "running" | "completed" | "failed";
}

interface EventBase {
  id: EventId;
  sessionId: SessionId;
  /** ISO-8601 timestamp. */
  at: string;
}

export type AgentEvent =
  | (EventBase & { type: "sessionStarted"; title?: string })
  | (EventBase & { type: "userMessage"; text: string })
  | (EventBase & { type: "agentMessage"; text: string })
  | (EventBase & { type: "stateChanged"; state: AgentState })
  | (EventBase & { type: "thinking"; text?: string })
  | (EventBase & { type: "working"; text?: string })
  | (EventBase & { type: "toolStarted"; tool: AgentToolActivity })
  | (EventBase & { type: "toolOutput"; toolId: string; text: string })
  | (EventBase & { type: "toolCompleted"; tool: AgentToolActivity })
  | (EventBase & { type: "fileRead"; path: string })
  | (EventBase & { type: "fileEdited"; path: string })
  | (EventBase & { type: "fileCreated"; path: string })
  | (EventBase & { type: "questionRequested"; question: AgentQuestion })
  | (EventBase & { type: "permissionRequested"; request: AgentPermissionRequest })
  | (EventBase & { type: "completed"; summary?: string })
  | (EventBase & { type: "failed"; message: string })
  | (EventBase & { type: "sessionStopped" });

export type AgentEventType = AgentEvent["type"];

export function newEventId(): EventId {
  return asEventId(`evt_${randomUUID().replace(/-/g, "")}`);
}

/** Same inputs, same id: for adapters that replay a transcript on every read. */
export function eventIdFor(sessionId: SessionId, providerKey: string): EventId {
  const digest = createHash("sha256").update(`${sessionId}\0${providerKey}`).digest("hex").slice(0, 32);
  return asEventId(`evt_${digest}`);
}
