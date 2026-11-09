import { asProjectId, type ProjectId, type RepositoryReference } from "../types.js";
import { normalizeRemoteUrl, projectIdFor } from "../repository.js";

export const IMPORTED_PROJECT_ID: ProjectId = asProjectId("imported-sessions");
export const IMPORTED_PROJECT_NAME = "Imported Sessions";

export type InferredFrom = "remote" | "gitRoot" | "localPath" | "imported";

export interface ProjectInference {
  projectId: ProjectId;
  name: string;
  repository?: RepositoryReference;
  inferredFrom: InferredFrom;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * Deterministic project for a session: normalized remote, else git root, else local path,
 * else the fixed "Imported Sessions" project. Never merges unrelated repos.
 */
export function inferProject(session: { path?: string; repo?: RepositoryReference }): ProjectInference {
  const repo = session.repo ?? {};
  const localPath = repo.localPath ?? session.path;
  const repository: RepositoryReference = {};
  if (repo.remoteUrl) repository.remoteUrl = repo.remoteUrl;
  if (repo.gitRoot) repository.gitRoot = repo.gitRoot;
  if (localPath) repository.localPath = localPath;

  if (repo.remoteUrl && normalizeRemoteUrl(repo.remoteUrl)) {
    return {
      projectId: projectIdFor({ remoteUrl: repo.remoteUrl }),
      name: baseName(normalizeRemoteUrl(repo.remoteUrl)),
      repository,
      inferredFrom: "remote",
    };
  }
  if (repo.gitRoot) {
    return {
      projectId: projectIdFor({ gitRoot: repo.gitRoot }),
      name: baseName(repo.gitRoot),
      repository,
      inferredFrom: "gitRoot",
    };
  }
  if (localPath) {
    return { projectId: projectIdFor({ localPath }), name: baseName(localPath), repository, inferredFrom: "localPath" };
  }
  return { projectId: IMPORTED_PROJECT_ID, name: IMPORTED_PROJECT_NAME, inferredFrom: "imported" };
}
