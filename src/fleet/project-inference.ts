import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { normalizeRemoteUrl } from "../core/repository.js";
import type { FleetSession } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Which project (pond) a local session belongs to (Heresay Plan 12). Native chats carry a `projectId`; Conductor and
 * terminal sessions do not, so it is inferred here, after the merge, never inside an observer:
 *   1. the person's correction, 2. the native chat's own project, 3. the cwd's git remote matching a pond's remote,
 *   4. the cwd inside a pond's project folder, else none.
 * The id returned is the pond's `projectId` when it has one (what the Mac app matches ponds on), else the pond's id.
 */
export type ProjectSource = "native" | "remote" | "folder" | "corrected";

export interface ProjectGuess {
  projectId: string;
  projectSource: ProjectSource;
}

export interface KnownPond {
  id: string;
  /** The project on this Mac the pond was made from, if any. */
  projectId?: string;
  gitRemote?: string;
  /** The project's folder on this Mac, if known. */
  folder?: string;
}

/** What a pond is called in a session's `projectId`: its project when it has one. */
const pondKey = (pond: KnownPond): string => pond.projectId ?? pond.id;

export interface ProjectInferenceOptions {
  /** Where `project-corrections.json` lives. */
  supportDir: string;
  /** The ponds on this Mac. Cheap to call; the caller may cache. */
  ponds: () => KnownPond[];
  /** `git remote get-url origin` for a folder; null when there is none. Injected for tests. */
  readRemote?: (dir: string) => Promise<string | null>;
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 30_000;
const MAX_REMOTE_READS = 4;

async function defaultReadRemote(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "remote", "get-url", "origin"], {
      timeout: 5_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

const within = (dir: string, root: string): boolean => {
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export class ProjectInference {
  private readonly file: string;
  private readonly readRemote: (dir: string) => Promise<string | null>;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly remotes = new Map<string, { expiresAt: number; remote: string | null }>();
  private corrections: Record<string, string | null>;

  constructor(private readonly options: ProjectInferenceOptions) {
    this.file = path.join(options.supportDir, "project-corrections.json");
    this.readRemote = options.readRemote ?? defaultReadRemote;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.corrections = this.load();
  }

  private load(): Record<string, string | null> {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, string | null> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string" || value === null) out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * Corrects (or, with null, says "not in any project") one session. The id must be a known pond's project id or
   * pond id; it is stored as the project id the pond answers to. Returns a fixed sentence on refusal.
   */
  correct(sessionKey: string, projectId: string | null): { ok: true } | { ok: false; reason: string } {
    if (!sessionKey || sessionKey.length > 120) return { ok: false, reason: "That session isn't known." };
    let stored: string | null = null;
    if (projectId !== null) {
      const pond = this.options.ponds().find((p) => p.id === projectId || p.projectId === projectId);
      if (!pond) return { ok: false, reason: "That project isn't known." };
      stored = pondKey(pond);
    }
    this.corrections = { ...this.corrections, [sessionKey]: stored };
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, `${JSON.stringify(this.corrections, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    fs.chmodSync(this.file, 0o600);
    return { ok: true };
  }

  /** Synchronous: uses only what is already cached, so `/state` never waits on git. Call `warm` for what renders. */
  infer(
    session: Pick<FleetSession, "key" | "cwd" | "projectId"> & Partial<Pick<FleetSession, "origin" | "hostId">>,
  ): ProjectGuess | null {
    if (session.origin === "sdk" && !session.hostId) return null;
    const ponds = this.options.ponds();
    if (Object.prototype.hasOwnProperty.call(this.corrections, session.key)) {
      const corrected = this.corrections[session.key];
      // A correction to a pond that has since gone is ignored; null ("no project") always stands.
      if (corrected === null) return null;
      if (corrected && ponds.some((p) => pondKey(p) === corrected)) {
        return { projectId: corrected, projectSource: "corrected" };
      }
    }
    if (session.projectId) return { projectId: session.projectId, projectSource: "native" };
    if (!session.cwd) return null;
    const cached = this.remotes.get(session.cwd);
    if (cached?.remote) {
      const want = normalizeRemoteUrl(cached.remote);
      const hit = ponds.find((p) => p.gitRemote && normalizeRemoteUrl(p.gitRemote) === want);
      if (hit) return { projectId: pondKey(hit), projectSource: "remote" };
    }
    // The deepest folder wins, so a pond nested in another's folder is not shadowed.
    let best: KnownPond | null = null;
    for (const pond of ponds) {
      if (!pond.folder || !within(session.cwd, pond.folder)) continue;
      if (!best || pond.folder.length > best.folder!.length) best = pond;
    }
    return best ? { projectId: pondKey(best), projectSource: "folder" } : null;
  }

  /** Reads (and caches, misses too, for 30 s) the git remote of each uncached folder; only call for rendered sessions. */
  async warm(sessions: Array<Pick<FleetSession, "cwd">>): Promise<void> {
    const t = this.now();
    const todo = [
      ...new Set(
        sessions.map((s) => s.cwd).filter((d): d is string => !!d && !((this.remotes.get(d)?.expiresAt ?? 0) > t)),
      ),
    ];
    for (let i = 0; i < todo.length; i += MAX_REMOTE_READS) {
      await Promise.all(
        todo.slice(i, i + MAX_REMOTE_READS).map(async (dir) => {
          const remote = await this.readRemote(dir).catch(() => null);
          this.remotes.set(dir, { expiresAt: this.now() + this.ttlMs, remote });
        }),
      );
    }
  }
}

/** The ponds on this Mac from the flotilla service's file, with each project's folder from the native database. */
export function readKnownPonds(supportDir: string, nativeDbPath?: string): KnownPond[] {
  let ponds: unknown;
  try {
    ponds = (
      JSON.parse(fs.readFileSync(path.join(supportDir, "flotilla", "ponds.json"), "utf8")) as { ponds?: unknown }
    ).ponds;
  } catch {
    return [];
  }
  if (!ponds || typeof ponds !== "object") return [];
  const roots = new Map<string, string>();
  if (nativeDbPath) {
    try {
      const db = new Database(nativeDbPath, { readonly: true, fileMustExist: true });
      try {
        for (const row of db.prepare("SELECT id, root_path FROM projects").all() as Array<{
          id: string;
          root_path: string;
        }>) {
          roots.set(row.id, row.root_path);
        }
      } finally {
        db.close();
      }
    } catch {
      // no native database yet: remotes still match
    }
  }
  const out: KnownPond[] = [];
  for (const value of Object.values(ponds as Record<string, Record<string, unknown>>)) {
    if (!value || typeof value.id !== "string") continue;
    if (value.status !== "active" && value.status !== "pending") continue;
    const projectId = typeof value.projectId === "string" && value.projectId ? value.projectId : undefined;
    out.push({
      id: value.id,
      ...(projectId ? { projectId } : {}),
      ...(typeof value.gitRemote === "string" && value.gitRemote ? { gitRemote: value.gitRemote } : {}),
      ...(projectId && roots.get(projectId) ? { folder: roots.get(projectId)! } : {}),
    });
  }
  return out;
}

/** The route's body check: exactly `{ projectId: string | null }`, a non-empty string at most 200 characters. */
export function applyProjectCorrection(
  inference: ProjectInference,
  sessionKey: string,
  request: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return { ok: false, reason: "Say which project." };
  }
  const keys = Object.keys(request);
  const projectId = (request as { projectId?: unknown }).projectId;
  if (keys.length !== 1 || keys[0] !== "projectId") return { ok: false, reason: "Say which project." };
  if (projectId !== null && (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 200)) {
    return { ok: false, reason: "Say which project." };
  }
  return inference.correct(sessionKey, projectId);
}
