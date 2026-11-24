/**
 * Per-file locks for folder Ponds: a folder Pond has no Streams, so Ducks edit the folder itself, and two of them
 * must not edit one file at once. A Duck's first edit to a file takes its lock; the lock is released when that Duck's
 * turn ends and expires after it has sat idle for ten minutes. Host-local memory only: a host restart ends every turn.
 */

export const FILE_LOCK_IDLE_MS = 10 * 60_000;

export interface LockHolder {
  sessionId: string;
  name: string;
}

interface Lock extends LockHolder {
  touchedAt: number;
}

export class FileLocks {
  private readonly locks = new Map<string, Lock>();

  constructor(
    private readonly idleMs = FILE_LOCK_IDLE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private key(projectId: string, file: string): string {
    return `${projectId}\u0000${file}`;
  }

  /** Who holds the file for someone else, or null (free, expired, or held by `sessionId` itself). */
  heldByOther(projectId: string, file: string, sessionId: string): LockHolder | null {
    const k = this.key(projectId, file);
    const lock = this.locks.get(k);
    if (!lock) return null;
    if (this.now() - lock.touchedAt >= this.idleMs) {
      this.locks.delete(k);
      return null;
    }
    return lock.sessionId === sessionId ? null : { sessionId: lock.sessionId, name: lock.name };
  }

  /** Takes (or refreshes) the lock. Call only after `heldByOther` said null. */
  take(projectId: string, file: string, holder: LockHolder): void {
    this.locks.set(this.key(projectId, file), { ...holder, touchedAt: this.now() });
  }

  /** The turn ended (or the chat's agent exited): everything this chat held is free. */
  releaseSession(sessionId: string): void {
    for (const [k, lock] of this.locks) if (lock.sessionId === sessionId) this.locks.delete(k);
  }

  heldBy(sessionId: string): number {
    let n = 0;
    for (const lock of this.locks.values()) if (lock.sessionId === sessionId) n++;
    return n;
  }
}

/** The tool message a blocked Duck reads. */
export function lockedMessage(file: string, holder: string): string {
  return `${file} is locked: ${holder} is editing it right now. Do not edit it yet. @mention ${holder} in the Room (post_to_room with "@${holder} ...", or hand_off) to agree who goes first, then try again when they are done.`;
}

/** What the host announces when a Duck is refused a locked file (the Room turns it into a line). */
export interface FileClash {
  projectId: string;
  /** The blocked chat. */
  sessionId: string;
  name: string;
  /** Relative to the Pond's folder. */
  file: string;
  holder: LockHolder;
}
