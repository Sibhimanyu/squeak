import fs from "node:fs";

import { defaultGit, type Git } from "./placement.js";
import type { NativeStore } from "./store.js";
import { carryTranscript } from "./stream-missing.js";

const NAME = "ducks-to-pond";

export interface StreamMigrationResult {
  /** Chats moved to the Pond's folder. */
  moved: number;
  /** Of those, the ones whose Stream folder was gone. */
  missing: number;
}

/**
 * Once (recorded in `host_migrations`, and idempotent besides: a chat already in the Pond's folder is left alone):
 * every chat of a Git Pond whose folder is one of its Streams' working copies moves to the Pond's own folder, as a
 * Duck that starts Pond-wide. Its old Stream is recorded as joined (`duck_streams`), so it still edits there. When
 * the working copy is gone, the Duck keeps the branch's name when git still has the branch, and joins it again on
 * its own. A Claude transcript (and sidecar folder) is copied to the Pond folder's project folder so resume finds
 * it; a Codex thread resumes by its id, from disk, whatever folder the new run names, so it needs no copy.
 */
export async function moveDucksToPond(o: {
  store: NativeStore;
  projectsDir?: string;
  git?: Git;
}): Promise<StreamMigrationResult> {
  const { store } = o;
  const git = o.git ?? defaultGit;
  const result: StreamMigrationResult = { moved: 0, missing: 0 };
  if (store.db.prepare("SELECT 1 FROM host_migrations WHERE name=?").get(NAME)) return result;
  // The git questions first (they are async); the moves after them are one synchronous pass.
  const lives = new Map<string, boolean>();
  const branchLives = new Map<string, boolean>();
  for (const s of store.listSessions()) {
    if (s.archivedAt || !s.workspaceId) continue;
    const ws = store.getWorkspace(s.workspaceId);
    const project = ws ? store.getProject(ws.projectId) : null;
    if (!ws || !project || project.kind !== "git" || s.cwd === project.rootPath) continue;
    if (fs.existsSync(s.cwd) || !ws.branch) continue;
    const key = `${project.id}\n${ws.branch}`;
    if (lives.has(key)) continue;
    lives.set(key, true);
    branchLives.set(
      key,
      fs.existsSync(project.rootPath) &&
        (await git(project.rootPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${ws.branch}`])) !== null,
    );
  }
  store.db.transaction(() => {
    for (const s of store.listSessions()) {
      if (s.archivedAt || !s.workspaceId) continue;
      const ws = store.getWorkspace(s.workspaceId);
      const project = ws ? store.getProject(ws.projectId) : null;
      if (!ws || !project || project.kind !== "git" || s.cwd === project.rootPath) continue;
      if (!fs.existsSync(project.rootPath)) continue;
      const gone = !fs.existsSync(s.cwd);
      const alive = gone && branchLives.get(`${project.id}\n${ws.branch}`) === true;
      const duck = store.duckBySession(s.id) ?? store.duckForSession(s.id, project.id);
      if (s.agent === "claude" && s.agentSessionId) {
        try {
          carryTranscript(s.agentSessionId, project.rootPath, o.projectsDir);
        } catch {
          // a transcript that cannot be copied leaves the chat to start its history over, never blocks the move
        }
      }
      const joins = !gone && ws.state !== "archived" && !!duck;
      if (joins) store.joinDuckStream(duck.id, ws.id);
      store.moveSessionPlace(
        s.id,
        { cwd: project.rootPath, workspaceId: null, branch: null },
        joins || alive ? ws.branch : null,
      );
      store.appendMessage(s.id, "system", "system/note", {
        text: joins
          ? `Moved to the project's folder (read-only). You are still in branch ${ws.branch}: edit it by its full path.`
          : alive
            ? `Moved to the project's folder (read-only). Branch ${ws.branch} has no working copy now; join it again with open_stream.`
            : "Moved to the project's folder (read-only). Its old branch is gone.",
      });
      result.moved += 1;
      if (gone) result.missing += 1;
    }
    store.db
      .prepare("INSERT OR IGNORE INTO host_migrations (name, at) VALUES (?,?)")
      .run(NAME, new Date().toISOString());
  })();
  return result;
}
