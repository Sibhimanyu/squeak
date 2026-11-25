import { DucklingOnlyTracker, helpersKeepWorking } from "../fleet/ducklings.js";
import {
  DucklingTracker,
  DUCKLING_STEP_ROWS,
  REBUILD_WINDOW_MS,
  type DucklingDetail,
  type Ducklings,
} from "./ducklings.js";
import { readAgentSteps, readShellOutput } from "./ducklings-output.js";
import { claudeContextStep, contextFromMessages, type ContextUsage } from "./context-usage.js";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexAppServerAdapter } from "../adapters/codex-app-server.js";
import type { McpEndpoint } from "./agent-tools.js";
import { loadAgentSdk } from "./agent-sdk.js";
import { squeakPluginPath } from "./agent-plugin.js";
import { requireAgentBinary } from "./binaries.js";
import { NO_CHECKPOINTS } from "./version-history.js";
import {
  carryTranscript,
  folderName,
  StreamMissingError,
  streamMissingText,
  type StreamMissing,
} from "./stream-missing.js";
import { Checkpointer, checkpointRef, type FileChange } from "./checkpoints.js";
import { closeWithin } from "./agent-procs.js";
import { ClaudeRunner } from "./claude-runner.js";
import { CodexRunner } from "./codex-runner.js";
import { logger } from "../utils/logger.js";
import { moveDucksToPond } from "./stream-migration.js";
import { activeBranches, ducksOwnBranch, joinedStreamDirs, mainReadOnlyRoot } from "./placement.js";
import { streamEdits } from "./stream-edits.js";
import { resolveOwnerName, threadContextFor, withSender } from "./thread-context.js";
import { projectOfSession } from "./room.js";
import {
  deriveRule,
  describeRule,
  EDIT_TOOLS,
  EDITS_RULE,
  invalidRule,
  matchesRule,
  neverAllowReason,
  normalizeRule,
} from "./rules.js";
import { AutoTitler, defaultTitleCall, type TitleModelCall } from "./auto-title.js";
import {
  autoCompactDue,
  autoCompactThreshold,
  chatSize,
  classifyConnectionFailure,
  claudeTranscriptBytes,
  cliCompactWindow,
  COMPACT_COMMAND,
  failureCardText,
  HANDOFF_SYSTEM,
  handoffFallback,
  handoffPrompt,
  type HandoffRow,
} from "./api-wait.js";
import { DEFAULT_PAGE_TURNS, TimelineLog, TimelineRecorder } from "./timeline-log.js";
import type { ReplyDelta, TimelineEvent } from "./timeline.js";
import type { NativeStore } from "./store.js";
import { PendingInput } from "./pending-input.js";
import { FileLocks, lockedMessage, type FileClash } from "./file-locks.js";
import {
  ResumeFailedError,
  type AgentKind,
  type RequestKind,
  type RequestRow,
  type Resolution,
  type ResponseDecision,
  type RuleRow,
  type Runner,
  type RunnerHooks,
  type SessionRow,
  type SessionStatus,
  type TurnRow,
  type MessageAuthor,
  type PendingItem,
} from "./types.js";

export type HostEvent =
  /** Persisted: has a `seq`, replayable. */
  | {
      type: "message";
      sessionId: string;
      seq: number;
      role: string;
      kind: string;
      payload: unknown;
      createdAt: string;
      author?: MessageAuthor;
    }
  /** Ephemeral: no seq. */
  | { type: "delta"; sessionId: string; payload: unknown }
  | {
      type: "status";
      sessionId: string;
      status: SessionStatus;
      background?: { count: number };
      ducklings?: Ducklings;
      context?: ContextUsage;
    }
  | { type: "request"; sessionId: string; request: RequestRow }
  | { type: "request-resolved"; sessionId: string; requestId: string }
  | { type: "queue"; sessionId: string }
  /** The person renamed the chat. */
  | { type: "title"; sessionId: string; title: string }
  /** The person archived or unarchived the chat. */
  | { type: "archived"; sessionId: string; archived: boolean; archivedAt: string | null }
  /** The chat's permission mode changed (a pond thread republishes whether members may message it). */
  | { type: "mode"; sessionId: string; permissionMode: string }
  /** A timeline event (stored, with a `seq`), or the ephemeral `reply.delta` (no seq). */
  | { type: "timeline"; sessionId: string; event: TimelineEvent | ReplyDelta }
  /** A pending item (queued message or steer in flight) added, changed or gone; `consumed` when the agent took it in. */
  | {
      type: "pending";
      sessionId: string;
      op: "add" | "update" | "remove";
      id: string;
      item?: PendingItem;
      consumed?: boolean;
      /** A consumed steer's transcript row: it shows there from now on. */
      seq?: number;
    };

/** A chat name: trimmed, one line, 1-200 characters. */
export function checkTitle(v: unknown): string {
  if (typeof v !== "string") throw new Error("title must be text");
  const t = v.trim();
  if (t.length === 0) throw new Error("title cannot be empty");
  if (t.length > 200) throw new Error("title is at most 200 characters");
  if (/[\r\n\u2028\u2029]/.test(t)) throw new Error("title must be one line");
  return t;
}

export type RunnerFactory = (session: SessionRow, hooks: RunnerHooks) => Runner;

export interface CreateSpec {
  cwd: string;
  agent: AgentKind;
  model: string;
  permissionMode: string;
  effort?: string | null;
  workspaceId?: string | null;
  title?: string | null;
  text?: string;
  /** Put in front of the first message for the agent only (Claude's split-the-work brief); the chat shows `text`. */
  agentPrefix?: string;
  /** A duck taking this session as its current place (made before the agent starts, so its note carries the duck). */
  duckId?: string;
  /** The first message comes from the pond's room (a job): its turn is a room turn. */
  room?: boolean;
}

/** Where in an agent's own history a fork stops. */
export interface ForkPoint {
  /** Claude: the last transcript entry to keep (absent = the whole conversation). */
  claudeMessageUuid?: string;
  /** Codex: the last turn to keep, inclusive (absent = the whole thread). */
  codexTurnId?: string;
}

/** Copies an agent conversation up to a point and returns the copy's own session / thread id. */
export type AgentForker = (session: SessionRow, point: ForkPoint) => Promise<string>;

export function defaultAgentForker(codexBin?: string): AgentForker {
  return async (session, point) => {
    const from = session.agentSessionId!;
    if (session.agent === "claude") {
      const sdk = await loadAgentSdk();
      const result = await sdk.forkSession(from, {
        dir: session.cwd,
        ...(point.claudeMessageUuid ? { upToMessageId: point.claudeMessageUuid } : {}),
      });
      return result.sessionId;
    }
    const client = new CodexAppServerAdapter(codexBin ?? requireAgentBinary("codex"));
    await client.start();
    try {
      return await client.forkThread({ threadId: from, lastTurnId: point.codexTurnId ?? null, cwd: session.cwd });
    } finally {
      await client.stop();
    }
  };
}

export interface TurnInfo {
  turn: number;
  text: string;
  startSeq: number;
  endSeq: number | null;
  startCheckpoint: { ref: string; commit: string } | null;
  endCheckpoint: { ref: string; commit: string } | null;
  /** Files that differ between the turn's start and end snapshots. */
  files: FileChange[];
  working: boolean;
}

interface ForkPlan {
  fresh: boolean;
  /** Last message seq to copy (null = all). */
  upToSeq: number | null;
  /** Last turn kept (null = no turn rows exist). */
  lastTurn: number | null;
  point: ForkPoint;
}

export interface HostOptions {
  store: NativeStore;
  /** Defaults to the real Claude Agent SDK / codex app-server runners. */
  runnerFactory?: RunnerFactory;
  idleMs?: number;
  codexBin?: string;
  /** Tests inject one; the Agent SDK's `forkSession` / Codex's `thread/fork` otherwise. */
  forkAgent?: AgentForker;
  /** Where a chat's agent reaches Squeak's tools; null = no tools (the server is not up). */
  mcpFor?: (sessionId: string) => McpEndpoint | null;
  /** Read at each Claude start: may chats use the person's claude.ai connectors (default off). */
  claudeAiConnectors?: () => boolean;
  /** The owner's pond member name, for the `[from <name> · owner]` line; the macOS full name otherwise. */
  ownerName?: () => string | null;
  /** How long a folder-Pond file lock may sit idle before it expires (default 10 min). */
  fileLockIdleMs?: number;
  /** How recent a chat must be to have its agent warmed when the host starts (default 30 min; 0 = never). */
  warmRecentMs?: number;
  /** Names untitled chats; the real one (Haiku, with a local fallback) unless a runner factory is injected, then none. */
  autoTitle?: AutoTitler | false;
  /** The model call that names chats: this Mac's own model first, Haiku after (main.ts); Haiku alone when absent. */
  titleCall?: TitleModelCall;
  /** The cheap model call that writes a handoff summary; the real one (Haiku) unless injected. */
  summaryCall?: TitleModelCall;
  /** Where the agent's own transcripts live (tests); `~/.claude/projects` otherwise. */
  projectsDir?: string;
  /**
   * Look at a chat's folder before any agent starts there (a missing folder is reported as such, never as a lost
   * resume). On unless a runner factory is injected, since tests use made-up folders; they can ask for it.
   */
  checkFolders?: boolean;
}

/** How long a warmed chat's agent process may sit idle before it is closed (a plain chat: `idleMs`, 30 min). */
export const WARM_IDLE_MS = 3 * 3600_000;
export const STALE_REQUEST = "That request is no longer waiting. Send a message to carry on.";
const NEEDS = new Set<SessionStatus>(["awaiting_approval", "awaiting_plan", "awaiting_answer"]);
const BUSY = new Set<SessionStatus>(["working", "stopping", ...NEEDS]);

export function defaultRunnerFactory(
  codexBin?: string,
  mcpFor?: (sessionId: string) => McpEndpoint | null,
  contextFor?: (session: SessionRow) => string | null,
  compactWindowFor?: (session: SessionRow) => number | null,
  claudeAiConnectors?: () => boolean,
  readOnlyRootFor?: (session: SessionRow) => string | null,
  streamDirsFor?: (session: SessionRow) => string[],
): RunnerFactory {
  const plugin = squeakPluginPath();
  return (session, hooks) =>
    session.agent === "claude"
      ? new ClaudeRunner({
          cwd: session.cwd,
          model: session.model,
          effort: session.effort,
          permissionMode: session.permissionMode,
          resume: session.agentSessionId,
          hooks,
          mcp: mcpFor?.(session.id) ?? null,
          contextNote: contextFor?.(session) ?? null,
          autoCompactWindow: compactWindowFor?.(session) ?? null,
          claudeAiConnectors: claudeAiConnectors?.() ?? false,
          readOnlyRoot: readOnlyRootFor?.(session) ?? null,
          streamDirs: () => streamDirsFor?.(session) ?? [],
          log: logHostTiming,
          ...(plugin ? { plugins: [plugin] } : {}),
        })
      : new CodexRunner({
          cwd: session.cwd,
          model: session.model,
          effort: session.effort,
          permissionMode: session.permissionMode,
          resume: session.agentSessionId,
          hooks,
          mcp: mcpFor?.(session.id) ?? null,
          contextNote: contextFor?.(session) ?? null,
          readOnlyRoot: readOnlyRootFor?.(session) ?? null,
          streamDirs: () => streamDirsFor?.(session) ?? [],
          client: new CodexAppServerAdapter(codexBin ?? requireAgentBinary("codex")) as never,
        });
}

export class SessionHost extends EventEmitter {
  private readonly store: NativeStore;
  private readonly factory: RunnerFactory;
  private readonly idleMs: number;
  private readonly checkpoints = new Checkpointer();
  /** Per-file locks for Ducks editing a folder Pond directly (no Streams there). */
  private readonly fileLocks: FileLocks;
  /** Clashes already announced this turn (blocked chat|file|holder), so a retrying Duck posts one line. */
  private readonly clashed = new Set<string>();
  /** Words to start the next turn with, set while a steer's interrupt is still ending the running one. */
  private readonly steerNext = new Map<string, string>();
  private readonly steerAuthor = new Map<string, MessageAuthor | null>();
  private readonly forkAgent: AgentForker;
  /** Chats whose turn ended and whose closing snapshot is still being taken: they stay busy until it is. */
  private readonly finishing = new Set<string>();
  private readonly runners = new Map<string, Runner>();
  /** Live background tasks per chat (async subagents, background shells), as the runner reports them. */
  private readonly background = new Map<string, number>();
  /** Each chat's background helpers, kept from its stored rows; the turn does not wait on them. */
  private readonly ducklings = new Map<string, DucklingTracker>();
  private readonly ducklingsSent = new Map<string, string>();
  /** Per chat: whether its open turn has only ducklings running, folded from the timeline's own events. */
  private readonly onlyDucklings = new Map<string, DucklingOnlyTracker>();
  /** Foreground helpers (blocking Agent calls) running per chat: steers wait on them. */
  private readonly foregroundHelpers = new Map<string, number>();
  /** The label of each chat's oldest running foreground helper. */
  private readonly helperLabels = new Map<string, string>();
  /** Each chat's context usage; null = known empty (after a compaction), absent = not read yet. */
  private readonly contexts = new Map<string, ContextUsage | null>();
  /** A turn's start snapshot, still being taken: the turn's end waits for it, the send does not. */
  private readonly snapshots = new Map<string, Promise<void>>();
  /** Chats whose lost `--resume` was already retried once. */
  private readonly resumeRetried = new Set<string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Chats the Mac asked to keep warm: they get the long idle clock until their runner is closed. */
  private readonly warmed = new Set<string>();
  private readonly pending = new Map<string, (r: Resolution) => void>();
  /** Chats whose running work a pond member asked for: nothing is auto-allowed there. Empty unless Flotilla is on. */
  private readonly guestTurns = new Set<string>();
  private readonly ownerNameOf: () => string | null;
  /** Chats where someone other than the owner has written: every message the agent gets then names its sender. */
  private readonly guestChats = new Set<string>();
  /** The words of each steer waiting on an interrupt, kept apart so each keeps its own sender line. */
  private readonly steerBlocks = new Map<string, { text: string; author?: MessageAuthor }[]>();
  /** Called when a user message starts a turn (the first one renames a new workspace's branch). Never throws out. */
  beforeTurn: ((session: SessionRow, text: string) => void) | null = null;

  private readonly warmRecentMs: number;
  /** The chat timeline: each chat's ordered event log, the one source an open chat's feed reads (timeline.ts). */
  readonly timeline: TimelineRecorder;
  /** Everything waiting beside a chat's running turn: queued messages and steers in flight (pending-input.ts). */
  private readonly pendingInput: PendingInput;

  constructor(options: HostOptions) {
    super();
    this.store = options.store;
    this.timeline = new TimelineRecorder(new TimelineLog(this.store.db), (sessionId, event) => {
      this.emit("event", { type: "timeline", sessionId, event } satisfies HostEvent);
      if (event.type === "reply.delta") return;
      let tracker = this.onlyDucklings.get(sessionId);
      if (!tracker) this.onlyDucklings.set(sessionId, (tracker = new DucklingOnlyTracker()));
      tracker.apply(event);
      // While helpers run, a step starting or ending can turn "only a duckling works" on or off: tell watchers.
      if (event.type.startsWith("step.") && (this.ducklings.get(sessionId)?.list(Date.now()).running ?? 0) > 0) {
        this.noteDucklings(sessionId);
      }
    });
    this.pendingInput = new PendingInput({
      store: this.store,
      timeline: this.timeline,
      emit: (event) => this.emit("event", event satisfies HostEvent),
      busy: (id) => BUSY.has(this.store.getSession(id)?.status ?? "idle"),
      helper: (id) =>
        (this.foregroundHelpers.get(id) ?? 0) > 0 ? { label: this.helperLabels.get(id) ?? "helper" } : null,
    });
    this.ownerNameOf = options.ownerName ?? (() => null);
    this.fileLocks = new FileLocks(options.fileLockIdleMs);
    this.factory =
      options.runnerFactory ??
      defaultRunnerFactory(
        options.codexBin,
        options.mcpFor,
        (s) => this.contextNote(s),
        (s) => cliCompactWindow(this.compactThreshold(s), s.model),
        options.claudeAiConnectors,
        (s) => mainReadOnlyRoot(this.store, s),
        (s) => joinedStreamDirs(this.store, s),
      );
    this.summaryCall = options.summaryCall ?? defaultTitleCall();
    this.projectsDir = options.projectsDir;
    this.checkFolders = options.checkFolders ?? !options.runnerFactory;
    this.idleMs = options.idleMs ?? 30 * 60_000;
    // An injected factory (tests) is not warmed at start unless asked.
    this.warmRecentMs = options.warmRecentMs ?? (options.runnerFactory ? 0 : 30 * 60_000);
    this.forkAgent = options.forkAgent ?? defaultAgentForker(options.codexBin);
    this.titler =
      options.autoTitle === false || (options.autoTitle === undefined && options.runnerFactory)
        ? null
        : (options.autoTitle ??
          new AutoTitler({
            store: this.store,
            ...(options.titleCall ? { call: options.titleCall } : {}),
            onTitle: (sessionId, title) => this.emit("event", { type: "title", sessionId, title } satisfies HostEvent),
          }));
  }

  private readonly titler: AutoTitler | null;
  private readonly summaryCall: TitleModelCall;
  private readonly projectsDir: string | undefined;
  private readonly checkFolders: boolean;
  /** When each running turn began: a failure card says how long it ran. */
  private readonly turnStarts = new Map<string, number>();
  private readonly lastAutoCompact = new Map<string, number>();
  /** Chats whose last turn failed by a lost connection and not since sent again. */
  private readonly retryable = new Set<string>();
  /** The words of each chat's newest failure row, which its failed turn ends with in the timeline. */
  private readonly lastFailure = new Map<string, string>();
  private readonly sizeCache = new Map<string, { at: number; bytes: number | null }>();

  /** The context size at which this chat compacts itself (its project's setting; 90% of the model's window by default; null = off). */
  compactThreshold(s: SessionRow): number | null {
    if (s.agent !== "claude") return null;
    const ws = s.workspaceId ? this.store.getWorkspace(s.workspaceId) : null;
    const project = ws ? this.store.getProject(ws.projectId) : this.store.getProjectByRoot(s.cwd);
    return autoCompactThreshold(project ? this.store.getProjectSettings(project.id).autoCompactTokens : null, s.model);
  }

  private transcriptBytesOf(s: SessionRow): number | null {
    if (s.agent !== "claude" || !s.agentSessionId) return null;
    const hit = this.sizeCache.get(s.id);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.bytes;
    const bytes = claudeTranscriptBytes(s.agentSessionId, this.projectsDir);
    this.sizeCache.set(s.id, { at: Date.now(), bytes });
    return bytes;
  }

  /** How large the chat is: very large ones get a notice and a way to continue in a new thread. */
  sizeOf(s: SessionRow): ReturnType<typeof chatSize> {
    return chatSize(this.contextOf(s), this.transcriptBytesOf(s), this.compactThreshold(s));
  }

  /** What this thread's agent is told about Squeak and about who may write (built when its agent starts). */
  private contextNote(s: SessionRow): string {
    const ws = s.workspaceId ? this.store.getWorkspace(s.workspaceId) : null;
    // A chat in a plain-folder pond runs in the folder itself, with no stream.
    const folderPond = ws ? null : this.store.getProjectByRoot(s.cwd);
    // Ducks own their branch: Main of a git pond is a place too, and the duck is told where it is and what is active.
    const own = ducksOwnBranch();
    const gitMain = own && !ws && folderPond?.kind === "git" && folderPond.rootPath === s.cwd ? folderPond : null;
    const project = ws
      ? this.store.getProject(ws.projectId)
      : gitMain
        ? gitMain
        : folderPond?.kind === "folder"
          ? folderPond
          : null;
    const placement =
      own && project?.kind === "git" && (ws || gitMain)
        ? {
            mode: ws ? ("branch" as const) : ("main" as const),
            branches: activeBranches(this.store, project.id).map((b) => ({
              branch: b.branch,
              title: b.title,
              ducks: b.ducks.map((d) => d.name),
              lastActiveAt: b.lastActiveAt,
            })),
          }
        : null;
    return threadContextFor({
      ...(placement ? { placement } : {}),
      agent: s.agent,
      pond: project?.name ?? null,
      folderName: ws?.name ?? null,
      streamTitle: ws?.title ?? null,
      branch: ws?.branch ?? null,
      cwd: s.cwd,
      targetBranch: ws ? (this.store.getTargetBranch(ws.id) ?? project?.defaultBranch ?? null) : null,
      port: ws?.port ?? null,
      shared: this.isShared(s.id),
      duck: {
        name: this.store.duckOf(s.id).name ?? (s.title?.trim() || (s.agent === "codex" ? "Codex" : "Claude")),
        role: this.store.duckOf(s.id).role,
      },
    });
  }

  private isShared(id: string): boolean {
    if (this.guestChats.has(id)) return true;
    if (!this.store.hasGuestAuthor(id)) return false;
    this.guestChats.add(id);
    return true;
  }

  /** The text the agent gets for a message: with a sender line once anyone else has written in the thread. */
  private agentText(id: string, text: string, author?: MessageAuthor): string {
    if (author) this.guestChats.add(id);
    return withSender(text, author, {
      shared: this.isShared(id),
      ownerName: resolveOwnerName(this.ownerNameOf()),
    });
  }

  /** Sessions a restart left mid-turn are stopped and their open requests denied. */
  start(): void {
    this.titler?.backfill();
    // One-time, capped, in the background: "New chat" and copied-prompt titles get a real one.
    this.titler?.backfillWeak();
    // Chats made before a workspace was derived from their folder get it now, so they show under their stream.
    this.store.adoptWorkspaces();
    // Ducks have no archive: chats archived before become Off-duty Ducks, once.
    try {
      this.store.migrateArchivedToOffDuty((s) => projectOfSession(this.store, s));
    } catch (error) {
      logHostError("archived to off duty", error);
    }
    // Notes the Ducks-to-Pond move wrote counted as activity: hide them and restore the chats' last activity (once).
    try {
      this.store.repairHousekeepingNotes();
    } catch (error) {
      logHostError("hide move notes", error);
    }
    // Chats that run in a Stream's working copy move to the Pond's folder and join that Stream (once).
    if (ducksOwnBranch()) {
      void moveDucksToPond({ store: this.store, ...(this.projectsDir ? { projectsDir: this.projectsDir } : {}) }).catch(
        (error) => logHostError("ducks to pond", error),
      );
    }
    for (const s of this.store.listSessions()) {
      if (!BUSY.has(s.status)) continue;
      this.store.setStatus(s.id, "idle", true);
      this.store.appendMessage(s.id, "system", "system/restart", { text: "Squeak restarted; the turn was stopped" });
    }
    for (const r of this.store.openRequests()) {
      this.store.resolveRequest(r.id, { decision: "deny", message: "Squeak restarted" });
    }
    // A turn the restart cut off ends as stopped in the timeline, so no chat opens onto a turn that never finishes.
    this.timeline.recover();
    for (const s of this.store.listSessions()) {
      const open = this.store.openTurn(s.id);
      if (open) this.store.endTurn(s.id, open.n, this.store.lastSeq(s.id), null);
    }
    // A message queued behind the stopped turn is still in the database: nothing else would ever start it.
    for (const s of this.store.listSessions()) {
      if (this.pendingInput.queued(s.id).every((q) => q.held)) continue;
      if (s.workspaceId && this.store.getWorkspace(s.workspaceId)?.state === "setting_up") continue;
      void this.afterTurn(s.id).catch((error) => logHostError(`resume queue ${s.id}`, error));
    }
    void this.sweepArchivedCheckpoints();
    this.warmRecent();
  }

  /** After a start, the agents of chats used in the last 30 minutes are warmed (newest four), so the first send is not cold. */
  private warmRecent(): void {
    if (this.warmRecentMs <= 0) return;
    const since = Date.now() - this.warmRecentMs;
    const recent = this.store
      .listSessions()
      .filter((s) => s.agent === "claude" && Date.parse(s.updatedAt) >= since)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 4);
    for (const s of recent) {
      void this.warm(s.id).catch(() => undefined);
    }
  }

  /** Checkpoint refs of chats in archived workspaces are dropped (their worktree is gone). */
  private async sweepArchivedCheckpoints(): Promise<void> {
    for (const ws of this.store.workspacesInState("archived")) await this.pruneCheckpoints(ws.id).catch(() => 0);
  }

  /** Deletes the checkpoint refs of every chat of a workspace (archived) and forgets their commit ids. */
  async pruneCheckpoints(workspaceId: string): Promise<number> {
    const ws = this.store.getWorkspace(workspaceId);
    const project = ws ? this.store.getProject(ws.projectId) : null;
    let pruned = 0;
    for (const s of this.store.listSessions().filter((x) => x.workspaceId === workspaceId)) {
      if (project) pruned += await this.checkpoints.prune(project.rootPath, s.id);
      this.store.clearTurnCommits(s.id);
    }
    return pruned;
  }

  /** Closes a chat's agent process, bounded and logged: a failed close is a leaked `claude`/`codex`. */
  private closeRunner(id: string, runner: Runner): Promise<boolean> {
    return closeWithin(`agent of chat ${id}`, () => runner.close());
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    const closing: Promise<boolean>[] = [];
    for (const [id, runner] of this.runners) {
      this.runners.delete(id);
      closing.push(this.closeRunner(id, runner));
    }
    await Promise.all(closing);
  }

  /** Cold context replays (300 message rows each, payloads can be megabytes) one list call may do before it answers. */
  static readonly COLD_CONTEXTS_PER_LIST = 6;
  private lastAdopt = 0;

  list(): SessionRow[] {
    // A write on every poll is a lock and a table scan for nothing: chats get their stream within 5 s of the row appearing.
    const now = Date.now();
    if (now - this.lastAdopt > 5_000) {
      this.lastAdopt = now;
      this.store.adoptWorkspaces();
    }
    const closed = this.store.closedImportedIds();
    const budget = { cold: SessionHost.COLD_CONTEXTS_PER_LIST };
    return this.store
      .listSessions()
      .filter((s) => !closed.has(s.id))
      .map((s) => this.withBackground(this.reconcile(s), budget));
  }

  /** The chat's context usage: live from the runner, else replayed once from the stored messages. */
  contextOf(s: SessionRow): ContextUsage | null {
    if (!this.contexts.has(s.id)) {
      const tail = s.agent === "claude" ? this.store.messagesBefore(s.id, null, 300) : [];
      this.contexts.set(s.id, contextFromMessages(s.agent, s.model, tail));
    }
    return this.contexts.get(s.id) ?? null;
  }

  private setContext(id: string, c: ContextUsage | null): void {
    const prev = this.contexts.get(id);
    this.contexts.set(id, c);
    if (prev?.used === c?.used && prev?.limit === c?.limit) return;
    const now = this.store.getSession(id);
    if (!now) return;
    this.emit("event", {
      type: "status",
      sessionId: id,
      status: now.status,
      ...(c ? { context: c } : {}),
    } satisfies HostEvent);
  }

  /**
   * A chat's helper tracker. After a host restart nothing is in memory: it is rebuilt once from the stored rows, so a
   * helper that was started is still listed (running ones as unknown, with no live process to ask), whatever
   * the surface loaded and however far back its launch row is.
   */
  private trackerOf(id: string): DucklingTracker | undefined {
    const known = this.ducklings.get(id);
    if (known) return known;
    if (!this.store.getSession(id)) return undefined;
    const tracker = new DucklingTracker();
    for (const row of this.store.helperRows(id, new Date(Date.now() - REBUILD_WINDOW_MS).toISOString())) {
      tracker.feed(row);
    }
    this.ducklings.set(id, tracker);
    return tracker;
  }

  /** The chat's helpers now; with no live agent process nothing runs (a restart or a closed runner). */
  private ducklingsOf(id: string): Ducklings | null {
    const tracker = this.trackerOf(id);
    if (!tracker) return null;
    tracker.settle(this.runners.has(id));
    const list = tracker.list(Date.now());
    // Claude waits on a foreground duckling and does nothing itself: surfaces show the ducklings, not "Working".
    const status = this.store.getSession(id)?.status;
    if (list.running > 0 && status === "working") {
      const agents = new Set(list.items.filter((d) => d.kind === "agent" && d.status === "running").map((d) => d.id));
      if (this.onlyDucklings.get(id)?.isOnlyDucklings(agents)) return { ...list, onlyDucklings: true };
    }
    return list;
  }

  /** A chat's Ducklings for the Pond roster: how many run, whether they keep it working, and what the first is on. */
  helpersOf(id: string): { running: number; keepWorking: boolean; task?: string } | null {
    const list = this.ducklingsOf(id);
    if (!list) return null;
    const session = this.store.getSession(id);
    const task = list.items.find((d) => d.status === "running")?.title;
    return {
      running: list.running,
      keepWorking: !!session && !BUSY.has(session.status) && helpersKeepWorking(list, Date.now()),
      ...(task ? { task } : {}),
    };
  }

  /** One helper's panel: its brief, its own steps from the stored rows, its report. Null when the chat has no such helper. */
  ducklingDetail(id: string, taskId: string): DucklingDetail | null {
    const tracker = this.trackerOf(id);
    const seq = tracker?.launchSeq(taskId);
    if (!tracker || seq === null || seq === undefined) return null;
    tracker.settle(this.runners.has(id));
    const detail = tracker.detail(taskId, Date.now(), this.store.messagesAfter(id, seq - 1, DUCKLING_STEP_ROWS));
    if (!detail) return null;
    const file = tracker.outputFileOf(taskId);
    // A shell produces output, never steps; a subagent whose rows we hold none of is read from its own transcript.
    if (detail.kind === "shell") return { ...detail, output: readShellOutput(file) };
    if (detail.steps.length === 0) {
      const steps = readAgentSteps(file);
      if (steps.length > 0) return { ...detail, steps };
    }
    return detail;
  }

  /** Tells watchers when what the helpers list says changed (a start, an end, a report). */
  private noteDucklings(id: string, force = false): void {
    const list = this.ducklingsOf(id);
    const key = JSON.stringify(list);
    if (!force && (this.ducklingsSent.get(id) ?? "null") === key) return;
    this.ducklingsSent.set(id, key);
    const now = this.store.getSession(id);
    if (!now) return;
    this.emit("event", {
      type: "status",
      sessionId: id,
      status: now.status,
      ...(this.background.get(id) ? { background: { count: this.background.get(id)! } } : {}),
      ...(list && list.items.length > 0 ? { ducklings: list } : {}),
      ...(this.contexts.get(id) ? { context: this.contexts.get(id)! } : {}),
    } satisfies HostEvent);
  }

  /**
   * Set when the chat's folder is gone from disk (a Stream's working copy removed). Decided here, from the disk, so
   * every surface says the same thing; null when the folder is there, the chat is archived, or folders are not checked.
   */
  streamMissingOf(s: SessionRow): StreamMissing | null {
    if (!this.checkFolders || !s.cwd || s.archivedAt || fs.existsSync(s.cwd)) return null;
    const ws = s.workspaceId ? this.store.getWorkspace(s.workspaceId) : null;
    const branch = ws?.branch ?? this.store.duckBySession(s.id)?.branch ?? s.branch ?? null;
    return { path: s.cwd, branch, folder: folderName(s.cwd) };
  }

  private streamMissingWords(s: SessionRow, gone: StreamMissing): string {
    const name = this.store.duckOf(s.id).name?.trim() || s.title?.trim() || (s.agent === "codex" ? "Codex" : "Claude");
    return streamMissingText(name, gone.folder);
  }

  private withBackground(s: SessionRow, budget?: { cold: number }): SessionRow {
    const count = this.background.get(s.id) ?? 0;
    // After a restart every Claude chat's context is replayed from its stored rows: spread that over several lists
    // (the first one measured 1.4 s on the event loop with 300 chats) rather than stall every request behind it.
    let ctx: ContextUsage | null = null;
    if (!budget || this.contexts.has(s.id) || s.agent !== "claude") ctx = this.contextOf(s);
    else if (budget.cold > 0) {
      budget.cold -= 1;
      ctx = this.contextOf(s);
    }
    const ducklings = this.ducklingsOf(s.id);
    const size = s.agent === "claude" && ctx ? this.sizeOf(s) : null;
    const gone = BUSY.has(s.status) ? null : this.streamMissingOf(s);
    const row: SessionRow = {
      ...(s.status === "error" && this.retryable.has(s.id) ? { retryable: true } : {}),
      ...(gone ? { streamMissing: gone } : {}),
      ...(size?.large && size.reason
        ? { large: { reason: size.reason, transcriptBytes: size.transcriptBytes, compacting: size.compacting } }
        : {}),
      ...(s.agent === "claude" ? { autoCompactAt: this.compactThreshold(s) } : {}),
      ...(count > 0 && BUSY.has(s.status) ? { ...s, background: { count } } : s),
      ...(ducklings && ducklings.items.length > 0 ? { ducklings } : {}),
      ...(ctx ? { context: ctx } : {}),
      ...(!BUSY.has(s.status) && helpersKeepWorking(ducklings, Date.now()) ? { helpersWorking: true } : {}),
    };
    const busy = BUSY.has(s.status) || this.runners.get(s.id)?.activity?.().busy === true;
    return busy ? { ...row, busy: true } : row;
  }

  /**
   * A chat that says it waits on the person while no request is pending in this host's memory (the turn that
   * asked is gone: a restart, a crashed agent) would stay stuck for good. Its orphan requests are denied and its
   * status follows what is really there: working with a live agent, idle otherwise.
   */
  reconcile(s: SessionRow): SessionRow {
    if (!NEEDS.has(s.status)) return s;
    const open = this.store.openRequests(s.id);
    if (open.some((r) => this.pending.has(r.id))) return s;
    for (const r of open) {
      this.store.resolveRequest(r.id, { decision: "deny", message: "No longer waiting" });
      this.emit("event", { type: "request-resolved", sessionId: s.id, requestId: r.id } satisfies HostEvent);
    }
    const live = this.runners.has(s.id);
    this.setStatus(s.id, live ? "working" : "idle", !live);
    if (!live) this.timeline.end(s.id, "stopped");
    return this.store.getSession(s.id) ?? s;
  }

  get(
    id: string,
  ):
    | (SessionRow & { requests: RequestRow[]; queue: ReturnType<NativeStore["queued"]>; pending: PendingItem[] })
    | null {
    const found = this.store.getSession(id);
    const s = found ? this.withBackground(this.reconcile(found)) : null;
    return s
      ? {
          ...s,
          requests: this.store.openRequests(id),
          queue: this.pendingInput.queued(id),
          pending: this.pendingInput.list(id),
        }
      : null;
  }

  /**
   * The chat's timeline log for a reader: `since` (events after a seq, for a reconnect or a gap), or whole turns
   * (the newest `turns`, or the `turns` before `before`). A chat with no log yet has one built from its rows first.
   */
  timelinePage(
    id: string,
    q: { since?: number; turns?: number; before?: number; limit?: number },
  ): { events: TimelineEvent[]; lastSeq: number; hasEarlier: boolean } {
    const s = this.require(id);
    this.timeline.ensure(id, () => this.store.messagesBefore(id, null, 2000), BUSY.has(s.status));
    const log = this.timeline.log;
    if (q.since !== undefined) {
      const events = log.after(id, q.since, q.limit ?? 1000);
      return { events, lastSeq: log.lastSeq(id), hasEarlier: false };
    }
    return log.turnsPage(id, q.turns ?? DEFAULT_PAGE_TURNS, q.before);
  }

  /** `GET /sessions/:id/pending`. */
  pendingItems(id: string): PendingItem[] {
    this.require(id);
    return this.pendingInput.list(id);
  }

  async create(spec: CreateSpec): Promise<SessionRow> {
    const created = this.store.createSession(spec);
    if (spec.duckId) this.store.attachSessionToDuck(spec.duckId, created.id);
    if (spec.agentPrefix && spec.text) this.firstBrief.set(created.id, spec.agentPrefix);
    if (spec.text) await this.send(created.id, spec.text, spec.room ? { room: true } : {});
    return this.store.getSession(created.id)!;
  }

  async send(
    id: string,
    text: string,
    options: {
      mode?: "queue" | "steer";
      author?: MessageAuthor;
      clientNonce?: string;
      room?: boolean;
      /** Told when the message went into the running turn as a steer (its step's seq, and whether the agent has yet to read it). */
      onSteered?: (steer: { seq: number; waiting: boolean }) => void;
    } = {},
  ): Promise<{ queued: boolean }> {
    const s = this.require(id);
    // A new workspace's setup script is still running: the first message waits for it, in the queue.
    const settingUp = s.workspaceId ? this.store.getWorkspace(s.workspaceId)?.state === "setting_up" : false;
    if (settingUp && !BUSY.has(s.status)) {
      this.pendingInput.enqueue(id, text, options.author, options.clientNonce, options.room);
      return { queued: true };
    }
    if (BUSY.has(s.status)) {
      const runner = this.runners.get(id);
      if (options.mode === "steer") {
        if (runner?.canSteer) {
          if (await runner.steer(this.agentText(id, text, options.author))) {
            const row = this.store.appendMessage(id, "user", "user/text", { text, steered: true }, options.author);
            this.emitMessage(row);
            this.timeline.steer(id, {
              seq: row.seq,
              text,
              author: options.author,
              clientNonce: options.clientNonce,
              waiting: Boolean(runner.lastSteerUuid),
              at: row.createdAt,
            });
            this.noteSteered(id, text, options.author, row.seq, runner);
            options.onSteered?.({ seq: row.seq, waiting: Boolean(runner.lastSteerUuid) });
            return { queued: false };
          }
        } else if (runner) {
          await this.steerByInterrupt(id, text, options.author);
          return { queued: false };
        }
      }
      this.pendingInput.enqueue(id, text, options.author, options.clientNonce, options.room);
      return { queued: true };
    }
    await this.startTurn(s, text, false, options.author, undefined, {
      clientNonce: options.clientNonce,
      room: options.room,
    });
    return { queued: false };
  }

  /**
   * A workspace's setup ended: tell its chats if it failed, then start what waited. A failed setup still lets
   * the chat go, since the person can read the log and the agent can finish the setup itself.
   */
  async workspaceSettled(workspaceId: string, failure: string | null): Promise<void> {
    for (const s of this.store.listSessions().filter((x) => x.workspaceId === workspaceId)) {
      if (failure) {
        this.emitMessage(
          this.store.appendMessage(s.id, "system", "system/setup-failed", {
            text: `${failure} The stream's log has the output.`,
          }),
        );
      }
      if (s.status === "idle" && this.pendingInput.queued(s.id).length > 0) await this.afterTurn(s.id);
    }
  }

  /** Closes the idle agent processes of a workspace's chats (it is being archived). */
  async closeWorkspaceRunners(workspaceId: string): Promise<void> {
    for (const s of this.store.listSessions().filter((x) => x.workspaceId === workspaceId)) {
      const runner = this.runners.get(s.id);
      if (!runner || BUSY.has(s.status)) continue;
      this.runners.delete(s.id);
      this.clearTimer(s.id);
      await this.closeRunner(s.id, runner);
    }
  }

  /**
   * Starts (or keeps) the chat's agent process before the first message, so the send does not pay the spawn.
   * While warmed it is closed only after WARM_IDLE_MS of nothing (a chat open on screen re-warms it).
   * Codex and chats that are busy are left as they are.
   */
  async warm(id: string): Promise<{ warm: boolean; idleMs: number }> {
    const s = this.require(id);
    this.warmed.add(id);
    if (s.agent === "claude" && !BUSY.has(s.status) && !this.runners.has(id)) {
      let runner: Runner;
      try {
        runner = this.openRunner(s);
      } catch (error) {
        logHostError(`warm ${id}`, error);
        this.warmed.delete(id);
        throw new HostError(error instanceof Error ? error.message : "the agent could not start", 503);
      }
      try {
        await runner.warm?.();
      } catch (error) {
        logHostError(`warm ${id}`, error);
        this.runners.delete(id);
        this.warmed.delete(id);
        void this.closeRunner(id, runner);
        throw new HostError(error instanceof Error ? error.message : "the agent could not start", 503);
      }
    }
    if (!BUSY.has(this.store.getSession(id)?.status ?? "idle")) this.armTimer(id);
    return { warm: this.runners.has(id), idleMs: WARM_IDLE_MS };
  }

  /**
   * Compacts the chat's context with the agent's own command, only while it is idle. Claude gets `/compact` as a
   * message (it is a slash command there, and shows in the chat like any message); Codex has a thread RPC.
   */
  async compact(id: string): Promise<{ ok: true }> {
    const s = this.require(id);
    if (BUSY.has(s.status) || this.runners.get(id)?.activity?.().busy === true)
      throw new HostError("The chat is working. Compact it when it finishes.", 409);
    if (s.agent === "claude") {
      await this.send(id, COMPACT_COMMAND);
      return { ok: true };
    }
    let runner: Runner;
    try {
      runner = this.runners.get(id) ?? this.openRunner(s);
    } catch (error) {
      throw new HostError(error instanceof Error ? error.message : "the agent could not start", 503);
    }
    if (!runner.compact) throw new HostError("This agent cannot compact.", 409);
    try {
      await runner.compact();
    } catch (error) {
      throw new HostError(error instanceof Error ? error.message : "compaction failed", 502);
    }
    return { ok: true };
  }

  /**
   * The opening message for a new thread that continues this one: a cheap model (Haiku) summarises the title and the
   * last messages; when it cannot, the person's own recent words stand in. The person edits it before it is sent.
   */
  async handoffDraft(id: string): Promise<{ summary: string; auto: boolean; size: ReturnType<typeof chatSize> }> {
    const s = this.require(id);
    const rows: HandoffRow[] = this.store
      .messagesBefore(id, null, 200)
      .map((r) => ({ role: r.role, text: rowText(r) }))
      .filter((r) => r.text.trim())
      .slice(-24);
    const size = this.sizeOf(s);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 45_000);
    try {
      const text = (
        await this.summaryCall({
          prompt: handoffPrompt(s.title, rows),
          system: HANDOFF_SYSTEM,
          signal: abort.signal,
        })
      ).trim();
      if (text) return { summary: text.slice(0, 8000), auto: true, size };
    } catch (error) {
      logger.warn("handoff summary failed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(timer);
    }
    return { summary: handoffFallback(s.title, rows), auto: false, size };
  }

  /**
   * "Continue in a new thread": a new chat in the same workspace and folder, same model, whose first message is the
   * (edited) summary. Both chats get a note naming the other, so each leads to the other.
   */
  async handoff(id: string, summary: string): Promise<SessionRow> {
    const s = this.require(id);
    const text = summary.trim();
    if (!text) throw new HostError("The first message cannot be empty.", 400);
    if (text.length > 20_000) throw new HostError("The first message is too long.", 400);
    if (BUSY.has(s.status))
      throw new HostError("The chat is working. Continue it in a new thread when it finishes.", 409);
    const base = (s.title ?? "Chat").replace(/ \(continued\)$/, "");
    const next = this.store.createSession({
      workspaceId: s.workspaceId,
      cwd: s.cwd,
      agent: s.agent,
      model: s.model,
      effort: s.effort,
      permissionMode: s.permissionMode,
      title: `${base} (continued)`,
    });
    this.emitMessage(
      this.store.appendMessage(next.id, "system", "system/note", {
        text: `Continued from "${s.title ?? "an earlier chat"}"`,
        linkedSessionId: s.id,
        link: "from",
      }),
    );
    this.emitMessage(
      this.store.appendMessage(
        id,
        "system",
        "system/note",
        {
          text: `Continued in "${next.title ?? "a new thread"}"`,
          linkedSessionId: next.id,
          link: "to",
        },
        undefined,
        { quiet: true },
      ),
    );
    await this.send(next.id, text);
    return this.store.getSession(next.id)!;
  }

  async interrupt(id: string): Promise<void> {
    this.require(id);
    for (const r of this.store.openRequests(id)) this.settle(r.id, { decision: "deny", message: "Interrupted" });
    try {
      await this.runners.get(id)?.interrupt();
    } catch (error) {
      // the agent is already gone; the chat is settled below
      console.error(`[squeak host] interrupt ${id}:`, error);
      this.runners.delete(id);
    }
    const now = this.store.getSession(id);
    if (now && BUSY.has(now.status) && !this.runners.has(id)) {
      // the agent is gone: Stop still ends in idle, with the same stop row as any interrupt
      this.emitMessage(this.store.appendMessage(id, "agent", "error", { type: "error", content: "aborted by user" }));
      this.setStatus(id, "idle", true);
      this.timeline.end(id, "stopped");
    }
  }

  respond(requestId: string, input: Omit<Resolution, "decision"> & { decision: ResponseDecision }): RuleRow | null {
    let resolution: Resolution = input as Resolution;
    let editsRule: RuleRow | null = null;
    if (input.decision === "allowEditsForChat") {
      const r = this.store.getRequest(requestId);
      if (!r || r.resolvedAt) throw new HostError(STALE_REQUEST, r ? 409 : 404);
      const tool = (r.payload as { toolName?: unknown } | null)?.toolName;
      if (r.kind !== "tool" || typeof tool !== "string" || !EDIT_TOOLS.has(tool)) {
        throw new HostError("allowEditsForChat answers a file edit (Edit, Write, MultiEdit, NotebookEdit)", 400);
      }
      if (!this.pending.has(requestId)) return this.respond(requestId, { decision: "allow" });
      editsRule = this.store.addRule(r.sessionId, EDITS_RULE);
      resolution = { decision: "allow" };
    }
    const saved = this.respondResolved(requestId, resolution);
    return editsRule ?? saved;
  }

  private respondResolved(requestId: string, resolution: Resolution): RuleRow | null {
    const r = this.store.getRequest(requestId);
    if (!r || r.resolvedAt) throw new HostError(STALE_REQUEST, r ? 409 : 404);
    if (!this.pending.has(requestId)) {
      const s = this.store.getSession(r.sessionId);
      if (s) this.reconcile(s);
      throw new HostError(STALE_REQUEST, 409);
    }
    let saved: RuleRow | null = null;
    let { rule, ...rest } = resolution;
    if (resolution.scope === "session") {
      if (resolution.decision !== "allow") throw new HostError("only an allow can be kept for the session", 400);
      const never = neverAllowReason(r.kind, r.payload);
      if (never) throw new HostError(`can't allow for the session: ${never}`, 400);
      if (rule) {
        const bad = invalidRule(rule);
        if (bad) throw new HostError(bad, 400);
      }
      rule = rule ? normalizeRule(rule) : (deriveRule(r.kind, r.payload) ?? undefined);
      if (!rule) throw new HostError("nothing in this request can be named as a rule", 400);
      saved = this.store.addRule(r.sessionId, rule);
    } else {
      rest = {
        decision: resolution.decision,
        ...(resolution.message !== undefined ? { message: resolution.message } : {}),
        ...(resolution.answers !== undefined ? { answers: resolution.answers } : {}),
      };
    }
    this.settle(requestId, rule ? { ...rest, rule } : rest);
    return saved;
  }

  /** A Squeak note in a chat (from its agent's tools): stored and streamed like any message. */
  post(id: string, kind: string, payload: unknown): void {
    this.require(id);
    this.emitMessage(this.store.appendMessage(id, "system", kind, payload));
  }

  setGuestTurn(id: string, on: boolean): void {
    if (on) this.guestTurns.add(id);
    else this.guestTurns.delete(id);
  }

  rules(id: string): RuleRow[] {
    this.require(id);
    return this.store.listRules(id);
  }

  removeRule(id: string, ruleId: string): void {
    this.require(id);
    if (!this.store.removeRule(id, ruleId)) throw new HostError("no such rule", 404);
  }

  /** The first of the chat's rules that covers this request, logged as a system message. */
  private autoAllow(id: string, kind: RequestKind, payload: unknown): boolean {
    // A pond member's message is running: a rule the starter kept for their own turns does not cover it (docs/ponds.md).
    if (this.guestTurns.has(id)) return false;
    const cwd = this.store.getSession(id)?.cwd;
    const rule = this.store.listRules(id).find((x) => matchesRule(x, kind, payload, cwd));
    if (!rule) return false;
    this.emitMessage(
      this.store.appendMessage(id, "system", "system/rule-allow", {
        text: `Allowed by this chat's rule: ${describeRule(rule)}`,
        rule: { id: rule.id, kind: rule.kind, value: rule.value },
      }),
    );
    return true;
  }

  /** A Task finished in this chat: its title is looked at once more and changes only if the scope shifted. */
  titleTaskDone(id: string): void {
    this.titler?.taskDone(id);
  }

  /** The person's own name for a chat: stored, and it replaces any earlier title. Throws on text that is not 1-200 chars on one line. */
  rename(id: string, title: unknown): string {
    this.require(id);
    const clean = checkTitle(title);
    this.store.setTitle(id, clean);
    this.emit("event", { type: "title", sessionId: id, title: clean } satisfies HostEvent);
    return clean;
  }

  /**
   * Takes a chat off duty (Ducks have no archive). A chat waiting on the person (approval, plan, question) is stood down
   * at once: what it waits on is denied, as a Stop does. A working chat is refused unless `stop` is true, which stops the
   * turn (waiting for it to settle, up to `timeoutMs`; the agent is closed if it will not) and drops the queued
   * messages. Its idle agent process is closed. The caller sets the Duck's duty.
   */
  async standDown(id: string, options: { stop?: boolean; timeoutMs?: number } = {}): Promise<void> {
    const s = this.require(id);
    const waiting = NEEDS.has(s.status);
    const working = BUSY.has(s.status) && !waiting;
    if (!waiting && (working || this.runners.get(id)?.activity?.().busy === true) && options.stop !== true)
      throw new HostError("Stop the chat before taking it off duty.", 409);
    if (waiting || working || options.stop === true) await this.stopForArchive(id, options.timeoutMs ?? 8000);
    const runner = this.runners.get(id);
    if (runner) {
      this.runners.delete(id);
      this.clearTimer(id);
      await this.closeRunner(id, runner);
    }
    this.warmed.delete(id);
  }

  /** Drops the chat's queued messages and steers, stops its turn (denying what it waits on) and waits for it to settle. */
  private async stopForArchive(id: string, timeoutMs: number): Promise<void> {
    this.pendingInput.dropQueued(id);
    this.steerNext.delete(id);
    this.steerAuthor.delete(id);
    this.steerBlocks.delete(id);
    await this.interrupt(id);
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const now = this.store.getSession(id);
      if (!now || !BUSY.has(now.status)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    // It will not settle: the chat is being stood down, so the agent is closed and the turn ends as a stop.
    const runner = this.runners.get(id);
    this.runners.delete(id);
    if (runner) await this.closeRunner(id, runner);
    const now = this.store.getSession(id);
    if (now && BUSY.has(now.status)) {
      this.emitMessage(this.store.appendMessage(id, "agent", "error", { type: "error", content: "aborted by user" }));
      this.setStatus(id, "idle", true);
      this.timeline.end(id, "stopped");
    }
  }

  async setMode(id: string, permissionMode: string): Promise<void> {
    this.require(id);
    this.store.setPermissionMode(id, permissionMode);
    this.emit("event", { type: "mode", sessionId: id, permissionMode } satisfies HostEvent);
    try {
      await this.runners.get(id)?.setPermissionMode(permissionMode);
    } catch (error) {
      // The mode is saved and the runner follows it live; a refusal from the agent must never fail the switch.
      logHostError(`setMode ${id} ${permissionMode}`, error);
    }
    // "Skip approvals" allows what is already waiting, and it holds for the next call too.
    if (permissionMode === "bypassPermissions") {
      for (const r of this.store.openRequests(id)) {
        if (r.kind === "tool" && this.pending.has(r.id)) this.settle(r.id, { decision: "allow" });
      }
    }
  }

  /**
   * `brief` (a preset picked in an existing Claude chat): the split-the-work brief for the NEXT message, in front of
   * it for the agent only, like a new chat's first one. null clears one still waiting; undefined leaves it alone.
   */
  async setModel(id: string, model: string, effort?: string | null, brief?: string | null): Promise<void> {
    const s = this.require(id);
    const nextEffort = effort === undefined ? s.effort : effort;
    this.store.setModel(id, model, nextEffort);
    if (brief) this.firstBrief.set(id, brief);
    else if (brief === null) this.firstBrief.delete(id);
    await this.runners.get(id)?.setModel?.(model, nextEffort);
  }

  queue(id: string): ReturnType<NativeStore["queued"]> {
    this.require(id);
    return this.pendingInput.queued(id);
  }

  removeQueued(id: string, queueId: string): void {
    this.require(id);
    const result = this.pendingInput.remove(id, queueId);
    if (result === "steering") throw new HostError("already steering", 409);
    if (result === "missing") throw new HostError("no such queued message", 404);
  }

  /** Changes a queued message's words and/or holds it (being edited: not sent) or releases it. */
  editQueued(id: string, queueId: string, patch: string | { text?: string; held?: boolean }): void {
    const s = this.require(id);
    const { text, held } = typeof patch === "string" ? { text: patch, held: undefined } : patch;
    if (!this.pendingInput.edit(id, queueId, { text, held })) throw new HostError("no such queued message", 404);
    // Released while the chat is idle: nothing else would start it.
    if (held === false && s.status === "idle") void this.afterTurn(id);
  }

  /** A steer that went in at once: Claude's stays a card until the CLI names it; one with no uuid (Codex) is taken in already. */
  private noteSteered(id: string, text: string, author: MessageAuthor | undefined, seq: number, runner: Runner): void {
    const uuid = runner.lastSteerUuid;
    if (!uuid) return;
    this.pendingInput.steer(id, text, author, { seq, uuid });
  }

  /**
   * Turns a queued message into a steer. Codex adds it to the running turn; an agent that cannot (Claude: a
   * message pushed mid-turn becomes its own turn) is interrupted and the message starts the next turn at once,
   * ahead of the rest of the queue. Idle: it simply starts.
   */
  async steerQueued(id: string, queueId: string): Promise<void> {
    const s = this.require(id);
    const item = this.store.getQueued(id, queueId);
    if (!item) throw new HostError("no such queued message", 404);
    if (!BUSY.has(s.status)) {
      this.pendingInput.startNow(id, queueId);
      await this.startTurn(s, item.text, false, item.author, undefined, {
        queuedId: queueId,
        clientNonce: item.clientNonce,
        room: item.room,
      });
      return;
    }
    const runner = this.runners.get(id);
    if (!runner) throw new HostError("can't steer", 409);
    if (runner.canSteer) {
      if (!(await runner.steer(this.agentText(id, item.text, item.author)))) throw new HostError("can't steer", 409);
    } else {
      this.pendingInput.promote(id, queueId);
      await this.steerByInterrupt(id, item.text, item.author);
      return;
    }
    this.pendingInput.promote(id, queueId);
    const row = this.store.appendMessage(id, "user", "user/text", { text: item.text, steered: true }, item.author);
    this.emitMessage(row);
    this.timeline.steer(id, {
      seq: row.seq,
      text: item.text,
      author: item.author,
      clientNonce: item.clientNonce,
      waiting: Boolean(runner.lastSteerUuid),
      at: row.createdAt,
    });
    this.noteSteered(id, item.text, item.author, row.seq, runner);
  }

  /**
   * "Send now" on a steer that waits on a foreground helper: the turn is interrupted, which stops the helper. The
   * steer is already with the agent, and a real run showed Claude's CLI keeps such a message through an interrupt and
   * runs it as the next turn, so it is not sent again; its card goes when the agent takes it in. A steer the agent
   * already took in (or one no longer waiting) is left alone and says so.
   */
  async sendSteerNow(id: string, itemId: string): Promise<{ status: "sent" | "consumed" | "not-waiting" }> {
    this.require(id);
    const status = this.pendingInput.sendNow(id, itemId);
    if (status === "sent") await this.interrupt(id);
    return { status };
  }

  // internals

  /**
   * Steering a runner that cannot take a message mid-turn: remember the words, interrupt, and let the turn's
   * end (closing checkpoint first, then idle) start them before anything queued. Requests are denied by the
   * interrupt; a second steer before the turn ends joins the first.
   */
  private async steerByInterrupt(id: string, text: string, author?: MessageAuthor): Promise<void> {
    const waiting = this.steerNext.get(id);
    this.steerBlocks.set(id, [...(this.steerBlocks.get(id) ?? []), { text, ...(author ? { author } : {}) }]);
    this.steerNext.set(id, waiting === undefined ? text : `${waiting}\n\n${text}`);
    this.pendingInput.steer(id, text, author, { viaInterrupt: true });
    // Several steers become one message: it has an author only when they all share one.
    const prior = this.steerAuthor.get(id);
    this.steerAuthor.set(
      id,
      waiting === undefined ? (author ?? null) : prior && author && prior.id === author.id ? prior : null,
    );
    await this.interrupt(id);
  }

  private require(id: string): SessionRow {
    const s = this.store.getSession(id);
    if (!s) throw new HostError("no such session", 404);
    return s;
  }

  private emitMessage(m: {
    seq: number;
    sessionId: string;
    role: string;
    kind: string;
    payload: unknown;
    createdAt: string;
    author?: MessageAuthor;
  }): void {
    this.emit("event", { type: "message", ...m } satisfies HostEvent);
    // The agent began a turn by itself (a background command or helper reported in): the chat is working, so every
    // screen shows it working and offers Stop, until that turn ends like any other.
    if (this.timeline.message(m.sessionId, m) && !BUSY.has(this.store.getSession(m.sessionId)?.status ?? "idle")) {
      this.setStatus(m.sessionId, "working");
    }
  }

  private setStatus(id: string, status: SessionStatus, endedTurn = false): void {
    this.store.setStatus(id, status, endedTurn);
    if (!BUSY.has(status)) {
      this.fileLocks.releaseSession(id);
      for (const k of this.clashed) if (k.startsWith(`${id}|`)) this.clashed.delete(k);
    }
    const context = this.contexts.get(id);
    this.emit("event", {
      type: "status",
      sessionId: id,
      status,
      ...(context ? { context } : {}),
    } satisfies HostEvent);
  }

  private settle(requestId: string, resolution: Resolution): void {
    const resolve = this.pending.get(requestId);
    this.pending.delete(requestId);
    if (this.store.resolveRequest(requestId, resolution)) {
      const r = this.store.getRequest(requestId)!;
      this.emit("event", { type: "request-resolved", sessionId: r.sessionId, requestId } satisfies HostEvent);
    }
    resolve?.(resolution);
  }

  /** A brief for a chat's next message (its first, or the one after a preset pick), kept until that turn starts (it may wait for a setup script). Memory only. */
  private readonly firstBrief = new Map<string, string>();

  /**
   * Folder Ponds have no Streams: Ducks edit the folder itself; in a Git Pond they edit the Streams they joined. A Duck's edit takes a per-file lock (until its turn
   * ends, or ten idle minutes); another Duck's edit to a locked file is refused with the holder named, and the clash
   * is announced as `file-clash` for the Room. Null: go ahead.
   */
  private guardEdit(sessionId: string, files: string[]): string | null {
    const s = this.store.getSession(sessionId);
    if (!s || s.workspaceId) return null;
    const pond = this.store.getProjectByRoot(s.cwd);
    if (!pond) return null;
    // A Duck in a Git Pond runs in Main (read-only) and edits the Streams it joined by path: those are what it locks.
    if (pond.kind === "git") {
      if (!ducksOwnBranch()) return null;
      const checked = streamEdits(this.store, pond, sessionId, s.cwd, files);
      if (checked.denied) return checked.denied;
      files = checked.locked;
    } else if (pond.kind !== "folder") return null;
    const absolute = [...new Set(files.map((f) => path.resolve(s.cwd, f)))];
    const name =
      this.store.duckBySession(sessionId)?.name?.trim() ||
      s.title?.trim() ||
      (s.agent === "codex" ? "Codex" : "Claude");
    for (const file of absolute) {
      const holder = this.fileLocks.heldByOther(pond.id, file, sessionId);
      if (!holder) continue;
      const shown = path.relative(s.cwd, file) || file;
      const once = `${sessionId}|${file}|${holder.sessionId}`;
      if (!this.clashed.has(once)) {
        this.clashed.add(once);
        this.emit("file-clash", { projectId: pond.id, sessionId, name, file: shown, holder } satisfies FileClash);
      }
      return lockedMessage(shown, holder.name);
    }
    for (const file of absolute) this.fileLocks.take(pond.id, file, { sessionId, name });
    return null;
  }

  private async startTurn(
    s: SessionRow,
    text: string,
    steered = false,
    author?: MessageAuthor,
    agentBody?: string,
    extra: { clientNonce?: string | undefined; queuedId?: string | undefined; room?: boolean | undefined } = {},
  ): Promise<void> {
    this.clearTimer(s.id);
    // A chat that has no log yet (made before it existed) gets one from its rows first, so the new turn lands after them.
    this.timeline.ensure(s.id, () => this.store.messagesBefore(s.id, null, 2000), false);
    const userRow = this.store.appendMessage(
      s.id,
      "user",
      "user/text",
      steered ? { text, steered: true } : { text },
      author,
    );
    this.emitMessage(userRow);
    // The turn opens here, synchronously, before the agent has been started: whoever reads the timeline sees the
    // new prompt and its (still empty) turn before anything the agent does.
    this.timeline.begin(s.id, {
      promptSeq: userRow.seq,
      text,
      author,
      clientNonce: extra.clientNonce,
      queuedId: extra.queuedId,
      room: extra.room,
      at: userRow.createdAt,
    });
    const turn = this.store.addTurn(s.id, text, userRow.seq);
    if (!steered) {
      this.turnStarts.set(s.id, Date.now());
      this.retryable.delete(s.id);
    }
    // A chat's first message names it, in the background; the send never waits.
    if (turn.n === 1 && !s.title) this.titler?.request(s.id);
    try {
      this.beforeTurn?.(s, text);
    } catch {
      // a side effect of a message must never stop the message
    }
    // Working at once: surfaces show progress before the agent (or git) has said anything.
    this.setStatus(s.id, "working");
    // The folder is gone: no agent can start there and nothing is snapshotted. The turn ends with the plain reason.
    const gone = this.streamMissingOf(s);
    if (gone) {
      this.failTurn(s.id, this.streamMissingWords(s, gone));
      return;
    }
    // The start snapshot runs beside the agent; the turn's end waits for it, the send does not.
    // A plain-folder pond keeps no checkpoints: its folder may sit inside some larger repository, which must not be
    // snapshotted in its place.
    const snap = (
      this.keepsNoCheckpoints(s.cwd)
        ? Promise.resolve(null)
        : this.checkpoints.snapshot(s.cwd, checkpointRef(s.id, turn.n, "start"))
    )
      .then((commit) => {
        if (commit) this.store.setTurnStartCommit(s.id, turn.n, commit);
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.snapshots.get(s.id) === snap) this.snapshots.delete(s.id);
      });
    this.snapshots.set(s.id, snap);
    const brief = this.firstBrief.get(s.id);
    this.firstBrief.delete(s.id);
    const body = agentBody ?? this.agentText(s.id, text, author);
    const full = brief ? `${brief}\n\n${body}` : body;
    this.sentText.set(s.id, full);
    let runner: Runner;
    try {
      runner = this.runners.get(s.id) ?? this.openRunner(s);
    } catch (error) {
      logHostError(`open runner ${s.id}`, error);
      this.failTurn(s.id, error instanceof Error ? error.message : String(error));
      return;
    }
    // Not awaited: the request returns now. The agent starts once the start snapshot is taken, so it cannot
    // have changed a file before it; a failure settles the chat through failTurn.
    void this.dispatch(s.id, runner, full, snap);
  }

  private async dispatch(id: string, runner: Runner, full: string, after?: Promise<void>): Promise<void> {
    try {
      await runner.send(full, after ? { after } : undefined);
    } catch (error) {
      logHostError(`send ${id}`, error);
      this.failTurn(id, error instanceof Error ? error.message : String(error));
    }
  }

  /** The agent text of each chat's running turn, kept to resend it once if the agent's resume is lost. */
  private readonly sentText = new Map<string, string>();

  /**
   * The agent process died before it started while resuming a conversation. Only when that conversation's
   * transcript is really gone is it safe to start fresh (once, with a note); otherwise the chat says what happened.
   */
  private async lostResume(id: string): Promise<void> {
    const s = this.store.getSession(id);
    const text = this.sentText.get(id);
    // Node reports a missing working folder as ENOENT on the command: that is not a lost resume.
    const gone = s ? this.streamMissingOf(s) : null;
    if (s && gone) {
      this.failTurn(id, this.streamMissingWords(s, gone));
      return;
    }
    if (s?.agentSessionId && text && !this.resumeRetried.has(id) && !transcriptExists(s.agentSessionId)) {
      this.resumeRetried.add(id);
      this.store.clearAgentSessionId(id);
      this.emitMessage(
        this.store.appendMessage(id, "system", "system/resume-lost", {
          text: "This chat's earlier conversation could not be loaded, so the agent started fresh.",
        }),
      );
      const fresh = { ...s, agentSessionId: null };
      await this.dispatch(id, this.openRunner(fresh), text);
      return;
    }
    this.failTurn(
      id,
      "Squeak couldn't load this chat's earlier conversation, so the agent didn't start. Send the message again, or start a new chat.",
    );
  }

  /**
   * A chat whose folder is gone carries on in `place` (the Pond's folder; `joined` stays the Duck's Stream): the same chat, history kept.
   * Claude finds a transcript by the folder the agent ran in, so the transcript (and its sidecar folder) is copied to the
   * new folder's project folder before the next resume. Refused while the chat works or when its folder is there.
   */
  async recoverStream(
    id: string,
    place: { cwd: string; workspaceId: string | null; branch: string | null },
    note: string,
    joined: string | null = place.branch,
  ): Promise<SessionRow> {
    const s = this.require(id);
    if (BUSY.has(s.status)) throw new HostError("The chat is working. Move it when it finishes.", 409);
    if (!this.streamMissingOf(s)) throw new HostError("This chat's folder is there, so there is nothing to move.", 409);
    if (!fs.existsSync(place.cwd)) throw new HostError("The new folder is not there.", 409);
    if (s.agent === "claude" && s.agentSessionId) carryTranscript(s.agentSessionId, place.cwd, this.projectsDir);
    const stale = this.runners.get(id);
    if (stale) {
      this.runners.delete(id);
      void this.closeRunner(id, stale);
    }
    this.store.moveSessionPlace(id, place, joined);
    this.setStatus(id, "idle");
    this.emitMessage(this.store.appendMessage(id, "system", "system/note", { text: note }, undefined, { quiet: true }));
    return this.store.getSession(id)!;
  }

  private openRunner(s: SessionRow): Runner {
    const id = s.id;
    const gone = this.streamMissingOf(s);
    if (gone) throw new StreamMissingError(this.streamMissingWords(s, gone), gone);
    const hooks: RunnerHooks = {
      onAgentSessionId: (agentId) => this.store.setAgentSessionId(id, agentId),
      onMessage: (role, kind, payload) => {
        const stored = this.store.appendMessage(id, role, kind, payload);
        this.emitMessage(stored);
        if (role === "agent") {
          // a tracker rebuilt just now already read this row from the store
          const fresh = !this.ducklings.has(id);
          const tracker = this.trackerOf(id);
          if (tracker && !fresh) tracker.feed(stored);
          this.noteDucklings(id);
        }
        const cur = this.store.getSession(id);
        if (cur?.agent === "claude" && role === "agent") {
          const step = claudeContextStep(kind, payload, cur.model);
          if (step !== undefined) this.setContext(id, step);
        }
      },
      onContext: (c) => this.setContext(id, c),
      onDelta: (payload) => {
        this.timeline.delta(id, payload);
        this.emit("event", { type: "delta", sessionId: id, payload } satisfies HostEvent);
      },
      onStatus: (status) => {
        // A request waiting on a person keeps its needs_* status until it is answered.
        if (status === "working" && this.store.openRequests(id).length > 0) return;
        this.setStatus(id, status);
      },
      tryAutoAllow: (kind, payload) => this.autoAllow(id, kind, payload),
      onRequest: (kind, payload) =>
        new Promise<Resolution>((resolve) => {
          const row = this.store.createRequest(id, kind, payload);
          this.pending.set(row.id, resolve);
          this.emit("event", { type: "request", sessionId: id, request: row } satisfies HostEvent);
        }),
      onConsumed: (uuids) => this.pendingInput.consumedUuids(id, uuids),
      guardEdit: (files) => this.guardEdit(id, files),
      onForegroundHelpers: (count, oldest) => {
        if (count > 0) {
          this.foregroundHelpers.set(id, count);
          if (oldest) this.helperLabels.set(id, oldest);
        } else {
          this.foregroundHelpers.delete(id);
          this.helperLabels.delete(id);
        }
        // the cards of steers in flight change what they say
        this.pendingInput.helpersChanged(id);
      },
      onBackground: (count) => {
        if (count > 0) this.background.set(id, count);
        else {
          this.background.delete(id);
          // nothing is left alive: whatever the rows still call running was stopped (a Stop, a closed process)
          this.ducklings.get(id)?.stopRunning(new Date().toISOString());
        }
        this.noteDucklings(id, true);
      },
      onTurnEnd: (outcome, detail) => {
        // helpers still running (`background`) do not hold the turn: the runner reports them, and they stay
        this.foregroundHelpers.delete(id);
        this.helperLabels.delete(id);
        this.sentText.delete(id);
        this.resumeRetried.delete(id);
        // A steer still a card when the turn ends was taken in (or is moot): it is in the transcript.
        this.pendingInput.turnEnded(id);
        this.closeTurn(id, () => {
          for (const r of this.store.openRequests(id)) this.settle(r.id, { decision: "deny", message: "Turn ended" });
          this.setStatus(id, outcome, true);
          if (outcome === "error") this.failureRow(id, detail ?? "error");
          this.timeline.end(
            id,
            outcome === "error" ? "failed" : "done",
            outcome === "error" ? this.lastFailure.get(id) : undefined,
          );
          this.turnStarts.delete(id);
        }).then(() => {
          // The first finished turn with real tool work gives the chat its meaningful title, in the background.
          if (outcome === "idle") this.titler?.turnFinished(id);
          return this.afterTurn(id);
        });
      },
      onExit: (error) => {
        this.runners.delete(id);
        this.fileLocks.releaseSession(id);
        this.background.delete(id);
        this.foregroundHelpers.delete(id);
        this.helperLabels.delete(id);
        this.noteDucklings(id);
        const current = this.store.getSession(id);
        if (current && BUSY.has(current.status) && !this.finishing.has(id)) {
          if (error instanceof ResumeFailedError) {
            void this.lostResume(id);
            return;
          }
          logHostError(`agent exited ${id}`, error ?? new Error("The agent process exited"));
          this.failTurn(id, error?.message ?? "The agent process exited");
        }
      },
    };
    const runner = this.factory(this.store.getSession(id)!, hooks);
    this.runners.set(id, runner);
    return runner;
  }

  /**
   * The chat's failure row. A connection failure (dropped, timed out, overloaded, a stall) says so plainly and is
   * `retryable`, which is what draws "Try again"; the agent's own words stay in `detail`. Anything else keeps its text.
   */
  private failureRow(id: string, detail: string): void {
    const kind = classifyConnectionFailure(detail);
    const started = this.turnStarts.get(id);
    const payload = kind
      ? {
          text: failureCardText(kind, started === undefined ? null : Date.now() - started),
          detail,
          failure: kind,
          retryable: true,
        }
      : { text: detail };
    if (kind) this.retryable.add(id);
    this.lastFailure.set(id, payload.text);
    this.emitMessage(this.store.appendMessage(id, "system", "system/error", payload));
  }

  /**
   * Try again after a failed turn: sends the person's last message once more, unless the agent already got somewhere
   * with it (a reply or a tool call is in the chat), in which case nothing is sent and `resent` is false.
   */
  async retry(id: string): Promise<{ resent: boolean; reason?: string }> {
    const s = this.require(id);
    if (BUSY.has(s.status) || this.runners.get(id)?.activity?.().busy === true)
      throw new HostError("The chat is working.", 409);
    const rows = this.store.messagesBefore(id, null, 400);
    let newest = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]!.role === "user" && rows[i]!.kind === "user/text") {
        newest = i;
        break;
      }
    }
    if (newest < 0) throw new HostError("There is no message to send again.", 409);
    const msg = rows[newest]!;
    const after = rows.slice(newest + 1);
    if (after.some((r) => r.role === "agent" && agentProgressed(r)))
      return { resent: false, reason: "The agent already replied to that message." };
    const text = (msg.payload as { text?: unknown } | null)?.text;
    if (typeof text !== "string" || !text.trim()) throw new HostError("There is no message to send again.", 409);
    await this.send(id, text, msg.author ? { author: msg.author } : {});
    return { resent: true };
  }

  private failTurn(id: string, text: string): void {
    const runner = this.runners.get(id);
    this.runners.delete(id);
    if (runner) void this.closeRunner(id, runner);
    const steer = this.steerNext.get(id);
    if (steer !== undefined) {
      // the words meant for the next turn are not lost: they join the queue
      this.steerNext.delete(id);
      this.pendingInput.enqueue(id, steer, this.steerAuthor.get(id) ?? undefined);
      this.steerAuthor.delete(id);
      this.steerBlocks.delete(id);
      this.pendingInput.interruptDone(id);
    }
    void this.closeTurn(id, () => {
      for (const r of this.store.openRequests(id)) this.settle(r.id, { decision: "deny", message: "Turn failed" });
      this.failureRow(id, text);
      this.turnStarts.delete(id);
      this.setStatus(id, "error", true);
      this.timeline.end(id, "failed", this.lastFailure.get(id));
    });
  }

  /**
   * Ends a turn: the closing snapshot first (the chat stays busy until it is taken, so a revert cannot
   * race it), then `finish` changes the status in one synchronous step and the turn row gets its end.
   * Without a start checkpoint (not a git repo) there is nothing to wait for and it all runs at once.
   */
  private closeTurn(id: string, finish: () => void): Promise<void> {
    const starting = this.snapshots.get(id);
    if (starting) return starting.then(() => this.closeTurnNow(id, finish));
    return this.closeTurnNow(id, finish);
  }

  private closeTurnNow(id: string, finish: () => void): Promise<void> {
    const open = this.store.openTurn(id);
    const done = (commit: string | null): void => {
      this.finishing.delete(id);
      finish();
      if (open) this.store.endTurn(id, open.n, this.store.lastSeq(id), commit);
    };
    if (!open?.startCommit) {
      done(null);
      return Promise.resolve();
    }
    this.finishing.add(id);
    const cwd = this.store.getSession(id)?.cwd ?? "";
    return this.checkpoints
      .snapshot(cwd, checkpointRef(id, open.n, "end"))
      .catch(() => null)
      .then(done);
  }

  // checkpoints, fork, edit

  private keepsNoCheckpoints(cwd: string): boolean {
    return this.store.getProjectByRoot(cwd)?.kind === "folder";
  }

  async turns(id: string): Promise<TurnInfo[]> {
    const s = this.require(id);
    const out: TurnInfo[] = [];
    for (const t of this.store.listTurns(id)) {
      out.push({
        turn: t.n,
        text: t.text,
        startSeq: t.startSeq,
        endSeq: t.endSeq,
        startCheckpoint: t.startCommit ? { ref: checkpointRef(id, t.n, "start"), commit: t.startCommit } : null,
        endCheckpoint: t.endCommit ? { ref: checkpointRef(id, t.n, "end"), commit: t.endCommit } : null,
        files: t.startCommit && t.endCommit ? await this.checkpoints.changes(s.cwd, t.startCommit, t.endCommit) : [],
        working: t.endSeq === null && BUSY.has(s.status),
      });
    }
    return out;
  }

  /** Puts the worktree's files back to a turn's start or end. The conversation is not rewound. */
  async revertFiles(
    id: string,
    turn: number,
    to: "start" | "end",
    confirm: boolean,
  ): Promise<{ safety: string; written: number; removed: number }> {
    const s = this.require(id);
    if (confirm !== true) throw new HostError("Restoring files needs confirm: true.", 400);
    this.requireQuiet(s, "restore files");
    const t = this.store.getTurn(id, turn);
    if (!t) throw new HostError("no such turn", 404);
    const commit = to === "start" ? t.startCommit : t.endCommit;
    if (!commit) {
      throw new HostError(
        this.keepsNoCheckpoints(s.cwd)
          ? NO_CHECKPOINTS
          : "That turn has no checkpoint (not a git repository, or it was cleaned up).",
        409,
      );
    }
    let result;
    try {
      result = await this.checkpoints.restore(s.cwd, id, commit);
    } catch (error) {
      throw new HostError(`Couldn't restore files: ${error instanceof Error ? error.message : String(error)}`, 409);
    }
    this.emitMessage(
      this.store.appendMessage(id, "system", "system/files-restored", {
        text: to === "start" ? `Files restored to before turn ${turn}` : `Files restored to after turn ${turn}`,
        turn,
        to,
        safety: result.safety,
        written: result.written,
        removed: result.removed,
      }),
    );
    return result;
  }

  /** A chat, and any other chat in its folder, must be quiet before files or history move. */
  private requireQuiet(s: SessionRow, what: string): void {
    if (BUSY.has(s.status) || this.finishing.has(s.id)) {
      throw new HostError(`Can't ${what} while this chat is working or waiting.`, 409);
    }
    const other = this.store.listSessions().find((x) => x.id !== s.id && x.cwd === s.cwd && BUSY.has(x.status));
    if (other) throw new HostError(`Can't ${what} while another chat in this folder is working or waiting.`, 409);
  }

  /** What a fork at `atTurn` (absent = the latest) would copy; throws when it cannot be done. No side effects. */
  private planFork(s: SessionRow, atTurn: number | undefined): ForkPlan {
    if (BUSY.has(s.status) || this.finishing.has(s.id)) {
      throw new HostError("Can't fork a chat while it is working or waiting.", 409);
    }
    const turns = this.store.listTurns(s.id);
    const latest = turns.length > 0 ? turns[turns.length - 1]!.n : null;
    if (atTurn !== undefined && (!Number.isInteger(atTurn) || atTurn < 0)) {
      throw new HostError("atTurn must be a whole number from 0", 400);
    }
    if (atTurn === 0) return { fresh: true, upToSeq: 0, lastTurn: 0, point: {} };
    if (atTurn !== undefined && !this.store.getTurn(s.id, atTurn)) throw new HostError("no such turn", 404);
    if (!s.agentSessionId) throw new HostError("This chat hasn't run yet: there is nothing to fork.", 409);
    const n = atTurn ?? latest;
    if (n === null || n === latest) return { fresh: false, upToSeq: null, lastTurn: n, point: {} };
    const next = this.store.getTurn(s.id, n + 1)!;
    const from = this.store.getTurn(s.id, n)!.startSeq;
    const upToSeq = next.startSeq - 1;
    const range: { kind: string; payload: unknown }[] = [];
    for (let after = from - 1; ; ) {
      const page = this.store.messagesAfter(s.id, after, 500).filter((m) => m.seq <= upToSeq);
      range.push(...page);
      if (page.length < 500) break;
      after = page[page.length - 1]!.seq;
    }
    const point: ForkPoint = {};
    if (s.agent === "claude") {
      const last = range.filter(
        (m) => m.kind === "assistant" && typeof (m.payload as { uuid?: unknown } | null)?.uuid === "string",
      );
      const uuid = (last[last.length - 1]?.payload as { uuid?: string } | undefined)?.uuid;
      if (!uuid) throw new HostError("Can't fork at that turn: it left nothing the agent can resume from.", 409);
      point.claudeMessageUuid = uuid;
    } else {
      const ends = range.filter((m) => m.kind === "turn/completed");
      const turnId = (ends[ends.length - 1]?.payload as { id?: string } | undefined)?.id;
      if (!turnId) throw new HostError("Can't fork at that turn: Codex didn't report its end.", 409);
      point.codexTurnId = turnId;
    }
    return { fresh: false, upToSeq, lastTurn: n, point };
  }

  private async forkFrom(s: SessionRow, plan: ForkPlan): Promise<SessionRow> {
    let agentId: string | null = null;
    if (!plan.fresh) {
      try {
        agentId = await this.forkAgent(s, plan.point);
      } catch (error) {
        throw new HostError(`Couldn't fork: ${error instanceof Error ? error.message : String(error)}`, 502);
      }
    }
    const fork = this.store.createSession({
      workspaceId: s.workspaceId,
      cwd: s.cwd,
      agent: s.agent,
      model: s.model,
      effort: s.effort,
      permissionMode: s.permissionMode,
      title: `${s.title ?? "Chat"} (fork)`,
    });
    if (agentId) this.store.setAgentSessionId(fork.id, agentId);
    // History: the original's messages through the kept turn, and its turn rows (no checkpoints to revert to).
    const olds: number[] = [];
    const news: number[] = [];
    if (!plan.fresh) {
      for (let after = 0; ; ) {
        const page = this.store.messagesAfter(s.id, after, 500);
        for (const m of page) {
          if (plan.upToSeq !== null && m.seq > plan.upToSeq) continue;
          olds.push(m.seq);
          news.push(this.store.appendMessage(fork.id, m.role, m.kind, m.payload, m.author).seq);
        }
        if (page.length < 500) break;
        after = page[page.length - 1]!.seq;
      }
      const mapLE = (seq: number): number => {
        let found = news[0] ?? 0;
        for (let i = 0; i < olds.length && olds[i]! <= seq; i++) found = news[i]!;
        return found;
      };
      const keep: TurnRow[] = this.store.listTurns(s.id).filter((t) => plan.lastTurn !== null && t.n <= plan.lastTurn);
      for (const t of keep) {
        this.store.copyTurn(fork.id, {
          n: t.n,
          text: t.text,
          startSeq: mapLE(t.startSeq),
          endSeq: t.endSeq === null ? null : mapLE(t.endSeq),
        });
      }
    }
    return this.store.getSession(fork.id)!;
  }

  /** A new chat in the same folder whose agent history is this one's through `atTurn` (default: all of it). */
  async fork(id: string, atTurn?: number): Promise<SessionRow> {
    const s = this.require(id);
    return this.forkFrom(s, this.planFork(s, atTurn));
  }

  /**
   * Edits an earlier message: a fork from the turn before it, with the new text sent
   * there. `revertFiles` first puts the folder back to how that turn found it (same refusals as a revert).
   */
  async edit(
    id: string,
    input: { turn: number; text: string; revertFiles?: boolean },
  ): Promise<{ session: SessionRow; restored: { safety: string; written: number; removed: number } | null }> {
    const s = this.require(id);
    if (!Number.isInteger(input.turn) || input.turn < 1) throw new HostError("turn must be a whole number from 1", 400);
    if (!input.text.trim()) throw new HostError("text is required", 400);
    if (!this.store.getTurn(id, input.turn)) throw new HostError("no such turn", 404);
    const plan = this.planFork(s, input.turn - 1);
    const restored = input.revertFiles ? await this.revertFiles(id, input.turn, "start", true) : null;
    const fork = await this.forkFrom(s, plan);
    await this.send(fork.id, input.text);
    return { session: this.store.getSession(fork.id)!, restored };
  }

  /** The next queued message starts when a turn ends; otherwise the idle clock runs. */
  private async afterTurn(id: string): Promise<void> {
    const s = this.store.getSession(id);
    const steer = this.steerNext.get(id);
    if (steer !== undefined && s && (s.status === "idle" || s.status === "error")) {
      this.steerNext.delete(id);
      const author = this.steerAuthor.get(id) ?? undefined;
      this.steerAuthor.delete(id);
      const blocks = this.steerBlocks.get(id) ?? [];
      this.steerBlocks.delete(id);
      const body = blocks.length ? blocks.map((b) => this.agentText(id, b.text, b.author)).join("\n\n") : undefined;
      this.pendingInput.interruptDone(id);
      await this.startTurn(s, steer, true, author, body);
      return;
    }
    if (!s || s.status !== "idle") {
      this.armTimer(id);
      return;
    }
    if (this.autoCompactIfDue(s)) return;
    const next = this.pendingInput.next(id);
    if (next) {
      await this.startTurn(s, next.text, false, next.author, undefined, {
        queuedId: next.id,
        clientNonce: next.clientNonce,
        room: next.room,
      });
    } else {
      this.armTimer(id);
    }
  }

  /**
   * A Claude chat whose last request was at or past its compaction point compacts now, between turns (the queued
   * message goes after). The CLI is told the same window, which covers a long turn; this covers the turn that ended.
   */
  private autoCompactIfDue(s: SessionRow): boolean {
    if (s.agent !== "claude") return false;
    const now = Date.now();
    if (!autoCompactDue(this.contexts.get(s.id) ?? null, this.compactThreshold(s), this.lastAutoCompact.get(s.id), now))
      return false;
    this.lastAutoCompact.set(s.id, now);
    this.emitMessage(
      this.store.appendMessage(s.id, "system", "system/note", {
        text: "This chat is getting long. Compacting it so replies stay fast.",
        autoCompact: true,
      }),
    );
    void this.send(s.id, COMPACT_COMMAND).catch((error) => logHostError(`auto compact ${s.id}`, error));
    return true;
  }

  private clearTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

  private armTimer(id: string): void {
    this.clearTimer(id);
    const t = setTimeout(
      () => {
        this.timers.delete(id);
        const s = this.store.getSession(id);
        const runner = this.runners.get(id);
        if (s && runner && !BUSY.has(s.status)) {
          this.runners.delete(id);
          this.warmed.delete(id);
          void this.closeRunner(id, runner);
        }
      },
      this.warmed.has(id) ? Math.max(this.idleMs, WARM_IDLE_MS) : this.idleMs,
    );
    t.unref();
    this.timers.set(id, t);
  }
}

export class HostError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** One timing line in the host log (no message content). */
export function logHostTiming(line: string): void {
  logger.info(`[squeak host] ${line}`);
}

/** Writes the real error (message and stack, secrets scrubbed by the logger) to the host log. */
export function logHostError(what: string, error: unknown): void {
  const e = error instanceof Error ? error : new Error(String(error));
  logger.error(`[squeak host] ${what}: ${e.message}`, { stack: e.stack });
}

/** Whether Claude Code still has a transcript for this session id, in any project folder. */
/** An agent row that shows the model got somewhere with the request: a real reply or a tool call (not an API error). */
export function agentProgressed(r: { kind: string; payload: unknown }): boolean {
  if (r.kind !== "assistant") return false;
  const p = r.payload as { error?: unknown; isApiErrorMessage?: unknown; message?: { content?: unknown } } | null;
  if (!p || p.error || p.isApiErrorMessage) return false;
  const c = p.message?.content;
  return Array.isArray(c) ? c.length > 0 : typeof c === "string" && c.trim().length > 0;
}

/** The words of a stored message row, for a summary: the person's text, or the agent's text blocks. */
export function rowText(r: { role: string; kind: string; payload: unknown }): string {
  if (r.kind === "user/text") return String((r.payload as { text?: unknown } | null)?.text ?? "");
  if (r.role !== "agent" || r.kind !== "assistant") return "";
  const p = r.payload as { parent_tool_use_id?: unknown; message?: { content?: unknown } } | null;
  if (typeof p?.parent_tool_use_id === "string") return "";
  const c = p?.message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return (c as { type?: string; text?: string }[])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function transcriptExists(agentSessionId: string): boolean {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(agentSessionId)) return false;
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  try {
    for (const dir of fs.readdirSync(root)) {
      if (fs.existsSync(path.join(root, dir, `${agentSessionId}.jsonl`))) return true;
    }
  } catch {
    // no projects folder: nothing to resume from
  }
  return false;
}
