import type { ConductorUiCloser } from "./conductor-ui.js";
import { logger } from "../utils/logger.js";

/**
 * Closing a Conductor chat from a phone. Conductor does not reload what is written behind its back, so
 * setting `is_hidden` alone left the tab open in its window (seen on a real Mac: two chats closed from
 * the phone, hidden in the database, both still open as tabs). So the tab is closed the way a person
 * closes it, its own "Close tab", through Squeak Hands, and Conductor hides the chat itself. Only when
 * the window cannot be driven (locked, Conductor closed, no Hands) is the database written instead.
 */

const BUSY = ["working", "cancelling", "needs_user_input", "needs_plan_response"];

export type CloseOutcome = "closed" | "busy" | "missing";

export interface ChatCloserDeps {
  lookup(sessionId: string): { status: string | null; workspaceId: string; title: string | null } | null;
  /** The database write: `is_hidden = 1`. */
  hide(sessionId: string): CloseOutcome;
  ui: ConductorUiCloser | null;
}

export async function closeChat(deps: ChatCloserDeps, sessionId: string): Promise<CloseOutcome> {
  const row = deps.lookup(sessionId);
  if (!row) return "missing";
  // Conductor's own process holds a running chat; closing it would stop the agent.
  if (BUSY.includes(row.status ?? "")) return "busy";
  if (deps.ui) {
    const result = await deps.ui.close({ workspaceId: row.workspaceId, sessionId, sessionTitle: row.title });
    if (result.ok) {
      // Conductor writes it itself; this makes sure, and is a no-op when it has.
      deps.hide(sessionId);
      return "closed";
    }
    if (result.error !== "chat-not-open") {
      logger.info("closing a chat in Conductor's window failed; hiding it in the database", {
        sessionId: sessionId.slice(0, 8),
        error: result.error,
        ...(result.detail ? { detail: result.detail } : {}),
      });
    }
  }
  // No tab to close (it is not open), or the window could not be driven: the database alone.
  return deps.hide(sessionId);
}
