import { createHash } from "node:crypto";
import path from "node:path";

import { slug } from "../native/project-settings.js";
import { runGit } from "./git.js";
import { WorkspaceEngineError } from "./types.js";

export function slugify(s: string, fallback = "task"): string {
  if (!/[a-z0-9]/i.test(s)) return fallback;
  return (
    slug(s)
      .replace(/[._]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || fallback
  );
}

/** Four hex characters, derived from the workspace id so the same id always names the same paths. */
export function shortId(workspaceId: string): string {
  return createHash("sha1").update(workspaceId).digest("hex").slice(0, 4);
}

export interface WorkspaceNames {
  branch: string;
  directoryName: string;
  directory: string;
}

/** `squeak/<project>/<task-slug>-<id>` and `<workspacesRoot>/<project>/<task-slug>-<id>`. */
export function workspaceNames(
  workspacesRoot: string,
  project: string,
  task: string,
  workspaceId: string,
): WorkspaceNames {
  const p = slugify(project, "project");
  const dirName = `${slugify(task)}-${shortId(workspaceId)}`;
  return {
    branch: `squeak/${p}/${dirName}`,
    directoryName: dirName,
    directory: path.join(workspacesRoot, p, dirName),
  };
}

export async function validateBranchName(name: string): Promise<void> {
  if (!name || name.startsWith("-") || /\s/.test(name) || name.length > 200) {
    throw new WorkspaceEngineError(`Invalid branch name: ${JSON.stringify(name)}`, "bad-branch");
  }
  const r = await runGit(process.cwd(), ["check-ref-format", "--branch", name]);
  if (r.code !== 0) throw new WorkspaceEngineError(`Invalid branch name: ${JSON.stringify(name)}`, "bad-branch");
}
