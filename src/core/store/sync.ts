import type { AgentSession, Project, Workspace } from "../types.js";
import type { CoreDb } from "./core-db.js";
import type { ProjectInference } from "./project-inference.js";

export interface SyncInference {
  project: ProjectInference;
  workspace?: Workspace;
}

export interface SyncResult {
  added: number;
  updated: number;
}

/**
 * Upserts a batch: each session's inferred project and workspace, the session and its
 * provider ref. Idempotent; a manual project assignment is kept. The session's `projectId`
 * is replaced by the inferred one (the store keeps the manual one when present).
 */
export function syncSessions(
  db: CoreDb,
  sessions: AgentSession[],
  inferFor: (session: AgentSession) => SyncInference,
): SyncResult {
  const result: SyncResult = { added: 0, updated: 0 };
  db.ensureLocalRuntime();
  for (const session of sessions) {
    const { project, workspace } = inferFor(session);
    const existing = db.getProject(project.projectId);
    const row: Project = {
      id: project.projectId,
      name: project.name,
      createdAt: existing?.createdAt ?? session.createdAt,
    };
    if (project.repository) row.repository = project.repository;
    db.upsertProject(row);
    if (workspace) db.upsertWorkspace({ ...workspace, projectId: project.projectId });
    const outcome = db.upsertSession({
      ...session,
      projectId: project.projectId,
      ...(workspace ? { workspaceId: workspace.id } : {}),
    });
    result[outcome] += 1;
  }
  return result;
}
