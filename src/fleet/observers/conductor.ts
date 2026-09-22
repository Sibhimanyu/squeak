import type { ConductorRegistryAdapter, FleetRegistrySessionRef } from "../../adapters/conductor-registry.js";
import type { FleetState, ObservedSession } from "../types.js";

export interface ConductorObserverOptions {
  limit?: number;
  /** An idle Conductor session this recent counts as freshly finished. */
  finishedWithinMs?: number;
  now?: () => number;
}

const DEFAULT_LIMIT = 100;
const DEFAULT_FINISHED_WITHIN_MS = 6 * 60 * 60 * 1000;

/**
 * Conductor already tracks status for the sessions it spawned, so this
 * observer is a straight translation rather than an inference. Its real job is
 * to contribute the identity — repo, branch, session id — that lets the
 * monitor recognise a transcript-discovered session as the same session and
 * therefore offer actions on it.
 */
export class ConductorObserver {
  readonly source = "conductor" as const;

  private readonly registry: ConductorRegistryAdapter;
  private readonly limit: number;
  private readonly finishedWithinMs: number;
  private readonly now: () => number;

  constructor(registry: ConductorRegistryAdapter, options: ConductorObserverOptions = {}) {
    this.registry = registry;
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.finishedWithinMs = options.finishedWithinMs ?? DEFAULT_FINISHED_WITHIN_MS;
    this.now = options.now ?? Date.now;
  }

  observe(): ObservedSession[] {
    let rows: FleetRegistrySessionRef[];
    try {
      rows = this.registry.listFleetSessions(this.limit);
    } catch {
      return [];
    }

    return rows.map((row) => this.toObserved(row));
  }

  private toObserved(row: FleetRegistrySessionRef): ObservedSession {
    const agent = row.agentType === "codex" ? "codex" : "claude";
    const lastActivityAt = row.updatedAt;

    return {
      key: `conductor:${row.id}`,
      source: this.source,
      agent,
      origin: "conductor",
      sourceId: row.id,
      agentSessionId: row.claudeSessionId,
      conductorSessionId: row.id,
      // The worktree path is both where git must run and a better liveness
      // key than nothing, so take it from Conductor rather than waiting for a
      // transcript to supply it.
      cwd: row.workspacePath,
      repoName: row.repositoryName,
      branch: row.branch ?? row.directoryName,
      title: row.title,
      state: this.toFleetState(row, row.updatedAt),
      detail: null,
      lastActivityAt,
      transcriptPath: null,
      contextPercent: normalizePercent(row.contextUsedPercent),
      retired: isRetiredWorkspace(row),
      // Conductor does not track spend locally.
      baseRef: row.defaultBranch ? `origin/${row.defaultBranch}` : null,
      costUsd: null,
    };
  }

  private toFleetState(row: FleetRegistrySessionRef, lastActivityAt: string): FleetState {
    switch (row.status) {
      case "working":
      case "cancelling":
        return "working";
      case "needs_user_input":
      case "needs_plan_response":
        return "awaiting_input";
      case "error":
        return "error";
      default:
        break;
    }

    // A chat the user never spoke in never ran, so its "recent idle" is a
    // creation, not a finish — without this every new chat pushes "done".
    if (!row.lastUserMessageAt) {
      return "idle";
    }

    // Conductor collapses "just answered you" and "untouched since Tuesday"
    // into a single idle status. Recency is the only thing separating them.
    const age = this.now() - Date.parse(lastActivityAt);
    return Number.isFinite(age) && age <= this.finishedWithinMs ? "finished" : "idle";
  }
}

/** Conductor stores this as a float that is sometimes absent and sometimes 0. */
function normalizePercent(value: number | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, value));
}

/**
 * A workspace the user already finished with. Conductor tracks this itself, so
 * honour it rather than nagging about work that has been signed off.
 */
function isRetiredWorkspace(row: FleetRegistrySessionRef): boolean {
  const manual = row.manualStatus?.trim().toLowerCase();
  if (manual === "canceled" || manual === "cancelled" || manual === "done") {
    return true;
  }
  if (row.workspaceState?.trim().toLowerCase() === "archived") {
    return true;
  }
  return row.derivedStatus?.trim().toLowerCase() === "done";
}
