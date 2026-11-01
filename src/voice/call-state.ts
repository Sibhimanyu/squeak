import fs from "node:fs";
import path from "node:path";

import { logger } from "../utils/logger.js";

/**
 * What a phone call in progress needs from the Mac, saved in `voice-call-state.json` (0600, atomic) so a daemon restart
 * inside the call carries on. Entries carry their own times and are dropped by `MemoInbox` when they are older than
 * their rule allows; this file only reads and writes. Audio is never in it; the short texts a person has yet to
 * confirm are (a pending message or new chat, a proposal), and each still needs its own confirm after a restart.
 */
export interface CallStateFile {
  v: 1;
  savedAt: number;
  versions: Array<{
    version: string;
    targets: string[];
    spaces: Array<{ workspaceId: string; label: string }>;
    usedAt: number;
  }>;
  calls: Array<{ key: string } & Record<string, unknown>>;
  pending: Array<{ id: string } & Record<string, unknown>>;
  pendingNew: Array<{ id: string } & Record<string, unknown>>;
  handled: Array<{ id: string; at: number }>;
}

export function loadCallState(file: string): CallStateFile | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Partial<CallStateFile>;
    if (r.v !== 1) return null;
    const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
    return {
      v: 1,
      savedAt: typeof r.savedAt === "number" ? r.savedAt : 0,
      versions: list<CallStateFile["versions"][number]>(r.versions).filter(
        (e) =>
          e &&
          typeof e.version === "string" &&
          Array.isArray(e.targets) &&
          e.targets.every((t) => typeof t === "string") &&
          typeof e.usedAt === "number" &&
          Array.isArray(e.spaces) &&
          e.spaces.every((s) => s && typeof s.workspaceId === "string" && typeof s.label === "string"),
      ),
      calls: list<CallStateFile["calls"][number]>(r.calls).filter(
        (e) => e && typeof e.key === "string" && typeof e.at === "number" && typeof e.target === "string",
      ),
      pending: list<CallStateFile["pending"][number]>(r.pending).filter(
        (e) => e && typeof e.id === "string" && typeof e.at === "number" && typeof e.target === "string",
      ),
      pendingNew: list<CallStateFile["pendingNew"][number]>(r.pendingNew).filter(
        (e) => e && typeof e.id === "string" && typeof e.at === "number" && typeof e.workspaceId === "string",
      ),
      handled: list<{ id: string; at: number }>(r.handled).filter(
        (e) => e && typeof e.id === "string" && typeof e.at === "number",
      ),
    };
  } catch {
    return null;
  }
}

export function saveCallState(file: string, state: CallStateFile): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    logger.warn("voice call state could not be saved", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
