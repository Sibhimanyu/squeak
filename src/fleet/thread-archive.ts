import { ArchivedSessions } from "./archived-sessions.js";
import type { FleetSession } from "./types.js";

export const ARCHIVE_BUSY_SENTENCE = "Stop the chat before archiving it.";

export type ThreadArchiveResult = { ok: true } | { ok: false; reason: string };

export interface ThreadArchiveDeps {
  archived: ArchivedSessions;
  /** Every session the fleet tracks now (archived ones included, so an unarchive finds its thread). */
  sessions: () => FleetSession[];
  /** Re-reads the fleet so every surface sees the change at once. */
  refresh: () => void;
  /** Squeak's session host: archives a Squeak chat (`POST /native/sessions/<id>/archive|unarchive`). Absent: refused. */
  nativeArchive?: ((nativeSessionId: string, archived: boolean) => Promise<void>) | null;
}

/**
 * The one archive path for the Mac's route and the phone's command. A Squeak chat is archived by the session host
 * (its own `archived_at`); every other thread (Conductor, terminal, Codex, desktop, headless) is hidden in Squeak only,
 * in `archived-sessions.json`: Conductor's database and the agent's files are never touched. A working or waiting
 * thread is refused, as the host refuses its own.
 */
export async function setThreadArchived(
  deps: ThreadArchiveDeps,
  key: string,
  archived: boolean,
): Promise<ThreadArchiveResult> {
  if (!ArchivedSessions.validKey(key)) return { ok: false, reason: "That isn't a thread this Mac knows." };
  const session = deps.sessions().find((candidate) => candidate.key === key);
  if (session?.origin === "squeak") {
    if (!deps.nativeArchive) return { ok: false, reason: "Squeak's session host isn't available." };
    try {
      await deps.nativeArchive(session.sourceId, archived);
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error && error.message ? error.message : "The host didn't take that.",
      };
    }
    deps.refresh();
    return { ok: true };
  }
  if (archived) {
    if (!session) return { ok: false, reason: "That thread isn't on this Mac any more." };
    if (session.state === "working" || session.state === "awaiting_approval" || session.state === "awaiting_input") {
      return { ok: false, reason: ARCHIVE_BUSY_SENTENCE };
    }
    deps.archived.archive(key);
  } else {
    // Unarchiving is allowed for a key whose thread has gone: it just forgets the record.
    deps.archived.unarchive(key);
  }
  deps.refresh();
  return { ok: true };
}

/** The route's body: exactly `{ archived: boolean }`. */
export function readArchiveRequest(request: unknown): { archived: boolean } | null {
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  const keys = Object.keys(request);
  const archived = (request as { archived?: unknown }).archived;
  if (keys.length !== 1 || keys[0] !== "archived" || typeof archived !== "boolean") return null;
  return { archived };
}
