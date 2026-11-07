import type { FleetSession } from "./types.js";

/**
 * The folder a session's work lives in: Conductor's workspace for a Conductor chat, else the agent's own folder.
 *
 * `cwd` follows the agent: Claude Code records every `cd` its shell makes, so a chat that went into `brand/source`
 * reports that folder, while its git tree, its `.context/` and what Conductor calls the workspace stay at the top.
 * Anything that reads the work (git, diffs, images) or writes into it (phone photos) uses this; only matching the
 * agent's own process, or resolving a relative path the agent wrote, wants `cwd`.
 */
export function workFolder(session: Pick<FleetSession, "cwd" | "workspaceRoot">): string | null {
  return session.workspaceRoot ?? session.cwd ?? null;
}
