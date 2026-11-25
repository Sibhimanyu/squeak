import path from "node:path";

import { isInside } from "./placement.js";
import type { NativeStore } from "./store.js";
import type { ProjectRow } from "./types.js";

/**
 * A Duck in a Git Pond runs in the Pond's main folder (read-only) and edits Streams by path. This is the rule for those
 * edits: a file inside a Stream's working copy may be edited only by a Duck that is in that Stream, and such a file is
 * what the per-file locks guard (one lock per file, so per Stream). A file outside every Stream is not this module's
 * business (Main is refused by the runner; anything else is the person's own folders).
 */
export function streamEdits(
  store: NativeStore,
  pond: ProjectRow,
  sessionId: string,
  cwd: string,
  files: string[],
): { denied: string | null; locked: string[] } {
  const live = store.listWorkspaces(pond.id).filter((w) => w.state !== "archived");
  const duck = store.duckBySession(sessionId);
  const mine = new Set((duck ? store.duckStreams(duck.id) : []).map((w) => w.id));
  const locked: string[] = [];
  for (const file of files) {
    const absolute = path.resolve(cwd, file);
    const stream = live.find((w) => isInside(w.path, absolute));
    if (!stream) continue;
    if (!mine.has(stream.id)) {
      return {
        denied: `${file} is in branch ${stream.branch}, which you have not joined. Call open_stream (branch: "${stream.branch}") to join it, then edit again.`,
        locked: [],
      };
    }
    locked.push(absolute);
  }
  return { denied: null, locked };
}
