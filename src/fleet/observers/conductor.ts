import type { ConductorRegistryAdapter, FleetRegistrySessionRef } from "../../adapters/conductor-registry.js";
import { levelLabel, modelLabel } from "../chat-models.js";
import type { FleetState, ObservedSession } from "../types.js";

export interface ConductorObserverOptions {
  limit?: number;
  /** An idle Conductor session this recent counts as freshly finished. */
  finishedWithinMs?: number;
  now?: () => number;
}

const DEFAULT_LIMIT = 100;
const DEFAULT_FINISHED_WITHIN_MS = 24 * 60 * 60 * 1000;

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
    const state = this.toFleetState(row);
    const lastActivityAt = activityTime(row, state);

    return {
      key: `conductor:${row.id}`,
      source: this.source,
      agent,
      origin: "conductor",
      sourceId: row.id,
      agentSessionId: row.claudeSessionId,
      conductorSessionId: row.id,
      conductorWorkspaceId: row.workspaceId,
      // The worktree path is both where git must run and a better liveness
      // key than nothing, so take it from Conductor rather than waiting for a
      // transcript to supply it.
      cwd: row.workspacePath,
      repoName: row.repositoryName,
      branch: row.branch ?? row.directoryName,
      title: row.title,
      state,
      detail: state === "awaiting_input" ? (row.pendingQuestion ?? null) : null,
      lastActivityAt,
      transcriptPath: null,
      contextPercent: normalizePercent(row.contextUsedPercent),
      retired: isRetiredWorkspace(row, this.now()),
      closed: row.isHidden === true,
      workspaceRetired: isRetiredWorkspace({ ...row, isHidden: false }, this.now()),
      // Conductor does not track spend locally.
      baseRef: row.defaultBranch ? `origin/${row.defaultBranch}` : null,
      costUsd: null,
      ...modelAndEffort(row),
    };
  }

  private toFleetState(row: FleetRegistrySessionRef): FleetState {
    // Conductor keeps `working` while its question modal is open; the only
    // trace is an unanswered question-tool call in the chat's newest rows.
    if (row.pendingQuestion && !row.isHidden) {
      return "awaiting_input";
    }
    switch (row.status) {
      // `waiting`: the turn ended but background work it started —
      // subagents, a background shell — is still running, and Conductor shows
      // the chat as not done. Claude Code starts a short turn by itself each
      // time one of those finishes, and every such turn writes an ordinary
      // turn end; read as finishes, one fan-out of nine workers pushed six
      // "done" cards in ten minutes.
      case "working":
      case "cancelling":
      case "waiting":
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

    // Conductor collapses "just answered you", "failed the moment you sent
    // it" and "untouched since Tuesday" into one idle status. `updated_at`
    // cannot tell them apart: Conductor's trigger bumps it on any write to the
    // row, including touching old chats in bulk, and a turn that errors out
    // in a second is as recent as one that completed. Only the row the agent
    // writes when a turn ends says a turn finished, and how.
    const endedAt = row.lastTurnEndedAt ?? null;
    if (!endedAt || row.lastTurnOutcome === "aborted") {
      return "idle";
    }
    // You spoke after the last turn ended, and nothing ended since: that turn
    // was stopped or dropped, not finished.
    if (Date.parse(row.lastUserMessageAt) > Date.parse(endedAt)) {
      return "idle";
    }
    if (row.lastTurnOutcome === "failed") {
      return "error";
    }
    const age = this.now() - Date.parse(endedAt);
    return Number.isFinite(age) && age <= this.finishedWithinMs ? "finished" : "idle";
  }
}

/**
 * When the session last did something. A running session is moving, so its
 * row's `updated_at` is the best clock; a resting one is timed by its
 * content — the last turn end or message — so that a write that changes
 * nothing (a bulk touch, a rename) cannot make a week-old chat look fresh.
 */
function activityTime(row: FleetRegistrySessionRef, state: FleetState): string {
  if (state === "working" || state === "awaiting_input") {
    return row.updatedAt;
  }
  const candidates = [row.lastTurnEndedAt, row.lastUserMessageAt].filter(
    (value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)),
  );
  if (candidates.length === 0) {
    return row.updatedAt;
  }
  return candidates.reduce((latest, value) => (Date.parse(value) > Date.parse(latest) ? value : latest));
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
/**
 * A workspace Conductor derives as "done" (its PR merged) is still a place
 * people keep chatting: on a real machine two chats in a merged workspace ran
 * while Squeak hid them everywhere. So "done" retires only a chat nobody has
 * used for a week; a chat that is running, or that you spoke in lately, shows.
 */
const DONE_WORKSPACE_GRACE_MS = 7 * 24 * 60 * 60_000;

function isRetiredWorkspace(row: FleetRegistrySessionRef, now: number): boolean {
  // A chat you closed is done with, whatever its workspace says.
  if (row.isHidden) {
    return true;
  }
  const manual = row.manualStatus?.trim().toLowerCase();
  if (manual === "canceled" || manual === "cancelled" || manual === "done") {
    return true;
  }
  if (row.workspaceState?.trim().toLowerCase() === "archived") {
    return true;
  }
  if (row.derivedStatus?.trim().toLowerCase() !== "done") {
    return false;
  }
  if (row.status === "working" || row.status === "waiting" || row.status === "needs_user_input") {
    return false;
  }
  const lastUser = row.lastUserMessageAt ? Date.parse(row.lastUserMessageAt) : Number.NaN;
  return !(now - lastUser < DONE_WORKSPACE_GRACE_MS);
}

/** What the chat runs, for a Claude or Codex chat only: a picker alias for any other agent would read as noise. */
function modelAndEffort(row: FleetRegistrySessionRef): Pick<ObservedSession, "model" | "effort" | "fast"> {
  if (row.agentType !== "claude" && row.agentType !== "codex") {
    return {};
  }
  const model = row.model?.trim() ? modelLabel(row.model.trim()) : null;
  const effort = row.effortLevel?.trim() ? levelLabel(row.effortLevel) : null;
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(row.fastMode ? { fast: true } : {}),
  };
}
