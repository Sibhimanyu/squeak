import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Claude Code plugin Squeak gives its chats (`agent-plugin/`: the `squeak` skill). Two folders above this
 * module's folder, the same relative place in the checkout (`src/native`, `dist/native`) and in the app-bundled
 * daemon (copied by macos/scripts/embed-daemon.sh). Null when it is missing: a chat without it still runs.
 */
export function squeakPluginPath(here = path.dirname(fileURLToPath(import.meta.url))): string | null {
  const dir = path.resolve(here, "..", "..", "agent-plugin");
  return fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json")) ? dir : null;
}
