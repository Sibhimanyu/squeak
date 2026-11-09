/**
 * Provider-neutral core model: projects, workspaces, runtimes and agent
 * sessions, independent of Conductor, Claude Code, Codex or any other source.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ProjectId = Brand<string, "ProjectId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type RuntimeId = Brand<string, "RuntimeId">;
export type SessionId = Brand<string, "SessionId">;
export type EventId = Brand<string, "EventId">;

export const asProjectId = (value: string): ProjectId => value as ProjectId;
export const asWorkspaceId = (value: string): WorkspaceId => value as WorkspaceId;
export const asRuntimeId = (value: string): RuntimeId => value as RuntimeId;
export const asSessionId = (value: string): SessionId => value as SessionId;
export const asEventId = (value: string): EventId => value as EventId;

export interface RepositoryReference {
  localPath?: string;
  remoteUrl?: string;
  gitRoot?: string;
}

export interface Project {
  id: ProjectId;
  name: string;
  repository?: RepositoryReference;
  createdAt: string;
}

export interface Workspace {
  id: WorkspaceId;
  projectId: ProjectId;
  name: string;
  path: string;
  branch?: string;
  worktreePath?: string;
}

export interface Runtime {
  id: RuntimeId;
  name: string;
  kind: "local" | "remote";
  capabilities: readonly string[];
}

export type AgentProvider = "conductor" | "claudeCode" | "codex" | "openCode" | "gemini" | "acp" | "shell";

export type { AgentState } from "./state.js";
import type { AgentState } from "./state.js";

export interface AgentSession {
  id: SessionId;
  projectId: ProjectId;
  workspaceId?: WorkspaceId;
  runtimeId: RuntimeId;
  provider: AgentProvider;
  providerRef?: { provider: AgentProvider; externalId: string };
  title: string;
  state: AgentState;
  createdAt: string;
  updatedAt: string;
}

export const LOCAL_RUNTIME_ID = asRuntimeId("local");

export function localRuntime(name = "This Mac"): Runtime {
  return { id: LOCAL_RUNTIME_ID, name, kind: "local", capabilities: [] };
}
