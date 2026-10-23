import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ObservedSession } from "../types.js";
import { readClaudeTranscript } from "./claude-transcript.js";
import { asString } from "./tail.js";

export interface ClaudeCoworkObserverOptions {
  /** Claude Desktop's Cowork store: `<account>/<org>/local_<id>.json` plus a `local_<id>/` folder. */
  sessionsDir?: string;
  activeWithinMs?: number;
  idleAfterMs?: number;
  now?: () => number;
}

const DEFAULT_ACTIVE_WITHIN_MS = 24 * 60 * 60 * 1000;
const DEFAULT_IDLE_AFTER_MS = 10 * 60 * 1000;

interface CoworkMetadata {
  title: string | null;
  cliSessionId: string | null;
  isArchived: boolean;
}

/**
 * Claude Desktop's Cowork mode runs Claude Code with its own config folder per
 * session, so its transcripts never reach `~/.claude/projects` and the hooks in
 * `~/.claude/settings.json` never fire for it. Each session instead keeps
 * `local_<id>/.claude/projects/<slug>/<cli-session-id>.jsonl` beside a
 * `local_<id>.json` that holds its title and whether it was archived.
 *
 * The transcript is Claude Code's usual format, so state is read the same way
 * as any other Claude session; only discovery and naming differ. Without hooks
 * a Cowork session can never report that it is blocked on an approval.
 */
export class ClaudeCoworkObserver {
  readonly source = "claude-cowork" as const;

  private readonly sessionsDir: string;
  private readonly activeWithinMs: number;
  private readonly idleAfterMs: number;
  private readonly now: () => number;
  /** The metadata file is ~300KB of system prompt and tool schemas; parse it once per change. */
  private readonly metadataCache = new Map<string, { mtimeMs: number; metadata: CoworkMetadata | null }>();

  constructor(options: ClaudeCoworkObserverOptions = {}) {
    this.sessionsDir =
      options.sessionsDir ??
      path.join(os.homedir(), "Library", "Application Support", "Claude", "local-agent-mode-sessions");
    this.activeWithinMs = options.activeWithinMs ?? DEFAULT_ACTIVE_WITHIN_MS;
    this.idleAfterMs = options.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
    this.now = options.now ?? Date.now;
  }

  observe(): ObservedSession[] {
    const cutoff = this.now() - this.activeWithinMs;
    const sessions: ObservedSession[] = [];

    for (const metadataPath of this.listMetadataFiles()) {
      const session = this.readSession(metadataPath, cutoff);
      if (session) {
        sessions.push(session);
      }
    }

    return sessions;
  }

  private listMetadataFiles(): string[] {
    const found: string[] = [];
    for (const account of listDirectories(this.sessionsDir)) {
      for (const org of listDirectories(account)) {
        let entries: string[];
        try {
          entries = fs.readdirSync(org);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.startsWith("local_") && entry.endsWith(".json")) {
            found.push(path.join(org, entry));
          }
        }
      }
    }
    return found;
  }

  private readSession(metadataPath: string, cutoffMs: number): ObservedSession | null {
    const sessionDir = metadataPath.slice(0, -".json".length);
    const transcripts = listTranscripts(path.join(sessionDir, ".claude", "projects"));
    // Checked before the metadata is parsed, so a machine full of old Cowork
    // sessions costs a few stats per poll rather than megabytes of JSON.
    if (!transcripts.some((transcript) => transcript.mtimeMs >= cutoffMs)) {
      return null;
    }

    const metadata = this.readMetadata(metadataPath);
    // A session can hold more than one transcript (a resume starts a new
    // one); the metadata names the current one.
    const current =
      (metadata?.cliSessionId && transcripts.find((t) => t.sessionId === metadata.cliSessionId)) ||
      transcripts.reduce((newest, t) => (t.mtimeMs > newest.mtimeMs ? t : newest));
    if (current.mtimeMs < cutoffMs) {
      return null;
    }

    const observed = readClaudeTranscript(current.path, { now: this.now, idleAfterMs: this.idleAfterMs });
    if (!observed) {
      return null;
    }

    const coworkId = path.basename(sessionDir);
    return {
      ...observed,
      key: `claude-cowork:${coworkId}`,
      source: this.source,
      origin: "cowork",
      sourceId: coworkId,
      title: metadata?.title ?? observed.title,
      // The transcript's cwd is Cowork's sandbox `outputs` folder, which names
      // nothing; without it the session is labelled by its title instead.
      cwd: null,
      repoName: null,
      branch: null,
      retired: metadata?.isArchived ?? false,
    };
  }

  private readMetadata(metadataPath: string): CoworkMetadata | null {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(metadataPath).mtimeMs;
    } catch {
      return null;
    }
    const cached = this.metadataCache.get(metadataPath);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.metadata;
    }

    let metadata: CoworkMetadata | null = null;
    try {
      const raw = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
      metadata = {
        title: asString(raw.title),
        cliSessionId: asString(raw.cliSessionId),
        isArchived: raw.isArchived === true,
      };
    } catch {
      // Claude Desktop may be mid-write; the next poll will read it.
    }
    this.metadataCache.set(metadataPath, { mtimeMs, metadata });
    return metadata;
  }
}

function listDirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

interface TranscriptFile {
  path: string;
  sessionId: string;
  mtimeMs: number;
}

/** Top-level transcripts only: subagents write theirs one folder deeper. */
function listTranscripts(projectsDir: string): TranscriptFile[] {
  const found: TranscriptFile[] = [];
  for (const projectDir of listDirectories(projectsDir)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) {
        continue;
      }
      const filePath = path.join(projectDir, entry);
      try {
        found.push({
          path: filePath,
          sessionId: entry.slice(0, -".jsonl".length),
          mtimeMs: fs.statSync(filePath).mtimeMs,
        });
      } catch {
        // Vanished between readdir and stat.
      }
    }
  }
  return found;
}
