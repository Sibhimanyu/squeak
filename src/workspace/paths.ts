import fs from "node:fs";
import path from "node:path";

import { WorkspaceEngineError } from "./types.js";

/** realpath of the deepest existing ancestor, with the not-yet-existing remainder appended. */
export function realpathLoose(p: string): string {
  const abs = path.resolve(p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(realpathLoose(root), realpathLoose(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Returns the resolved target, or throws when it is the root, outside it, or a symlink out of it. */
export function assertInside(root: string, target: string): string {
  if (!isInside(root, target)) {
    throw new WorkspaceEngineError(`${target} is not inside ${root}`, "path-escape");
  }
  return realpathLoose(target);
}

/** The only way the engine deletes a directory. */
export function safeRemove(root: string, target: string): void {
  const resolved = assertInside(root, target);
  fs.rmSync(resolved, { recursive: true, force: true });
}
