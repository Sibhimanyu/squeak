import type { AwakeState } from "../fleet/awake-session.js";
import type { HotspotState } from "../fleet/hotspot.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { logger } from "../utils/logger.js";
import type { ParsedChoices } from "../fleet/choices.js";
import { parseChoices } from "../fleet/choices.js";
import type { FleetSnapshot } from "../fleet/fleet-monitor.js";
import { describeGitState } from "../fleet/git-state.js";
import {
  NEW_CHAT_MAX_TEXT,
  type NewChatAgent,
  type NewChatWorkspace,
  type StartChatOutcome,
} from "../fleet/new-chat.js";
import { chatTitle, distinctTitles, sessionLabel } from "../fleet/radar.js";
import type { QueueAction, QueueItem, ReplyMode, ReplyOptions, ReplyOutcome } from "../fleet/session-reply.js";
import type { ClaudeLimits } from "../fleet/claude-limits.js";
import type { Activity } from "../fleet/activity.js";
import type { DiffFile, WorkspaceDiff } from "../fleet/diff-view.js";
import type { PhoneImageResult } from "./phone-image.js";
import type { TranscriptMessage } from "../fleet/transcript.js";
import type { CodexUsage } from "../fleet/codex-usage.js";
import type { FleetSession } from "../fleet/types.js";
import type { QuestionPrompt } from "../fleet/pending-question.js";
import { AnswerRateLimit, runAnswerCommand } from "../fleet/answer-command.js";
import type { AnswerCommand, Answerer } from "../fleet/answer-command.js";
import type { ChannelDoc } from "./firestore-rest.js";
import { condenseHistory, LIVE_STEP_CHARS, LIVE_STEPS, liveHistoryHandle, LiveTurnPublisher } from "./live-turn.js";
import { generateChannel, open, pairingCode, seal, verifyDeviceSignature } from "./remote-crypto.js";

/**
 * Squeak's side of the remote channel (docs/remote-channel.md): publish an
 * encrypted snapshot for paired phones, take pairing requests, and run the
 * commands those phones send — after checking every one of them.
 *
 * The one rule everything here serves: **the Mac trusts a key, not a
 * server.** Firestore can drop, delay or invent documents; none of that can
 * make this code send a reply that a paired phone did not sign, for a turn
 * that is still current, within the last few minutes, exactly once.
 */

/** What is kept on the Mac, never in the cloud. Mode 0600. */
export interface RemoteConfig {
  projectId: string;
  channelId: string;
  key: string;
  devices: PairedDevice[];
}

export interface PairedDevice {
  id: string;
  name: string;
  publicKey: string;
  pairedAt: string;
  revokedAt?: string | null;
}

export interface PendingPairing {
  id: string;
  name: string;
  publicKey: string;
  code: string;
  requestedAt: string;
}

/** What a phone sends. Signed as the exact box string it arrives in. */
export interface RemoteCommand {
  v: 1;
  sessionId: string;
  /** The turn the phone was looking at; refused if the chat has moved on. */
  answersTurn: string | null;
  text: string;
  /**
   * Optional, signed with the rest. Absent means queue. Steer is still a plain
   * reply: it only changes where Conductor puts it when the agent is mid-turn.
   */
  mode?: ReplyMode;
  /**
   * Optional, signed with the rest: the phone's id for the message (a
   * lowercase UUID), passed to Conductor so the phone can find it in the
   * chat's queue (the live doc's `queue`) and steer or delete it later.
   */
  messageId?: string;
  nonce: string;
  /** Epoch ms. */
  expiresAt: number;
}

/**
 * A signed change to a message waiting in a Conductor chat's queue: steer it
 * into the running turn now (`promote`) or delete it (`cancel`). Same envelope
 * as a reply. There is no turn to match: the queued message's id is the
 * anchor, and it must still be in the queue when the Mac reads it.
 */
/**
 * A signed Stop for a working Conductor chat: the same as Conductor's own Stop
 * button. Same envelope as a reply; it names the turn the phone saw working,
 * so a Stop sent while one turn ran cannot stop the next.
 */
export interface StopCommand {
  v: 1;
  kind: "stop";
  sessionId: string;
  /** The chat's last finished turn as the phone saw it; absent when it had none. */
  answersTurn?: string | null;
  nonce: string;
  /** Epoch ms. */
  expiresAt: number;
}

/**
 * A signed request to see what a chat changed: its file list against the
 * base branch, and one file's patch when `file` names its index in that list.
 * Read-only, but it reveals code, so it is signed like everything else and
 * answered only for a chat the phone is shown.
 */
export interface DiffCommand {
  v: 1;
  kind: "diff";
  sessionId: string;
  file?: number;
  nonce: string;
  /** Epoch ms. */
  expiresAt: number;
}

/**
 * A signed request for an image the chat's agent put in its answer
 * (`![alt](source)`), which the phone cannot open itself. Read-only; answered
 * only for a source the chat's own messages name, inside its workspace
 * (phone-image.ts).
 */
export interface ImageCommand {
  v: 1;
  kind: "image";
  sessionId: string;
  source: string;
  nonce: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** What reads a workspace's diff (fleet/diff-view.ts). */
export interface RemoteDiffReader {
  readSummary(dir: string, baseRef: string | null): Promise<WorkspaceDiff | null>;
  readFilePatch(dir: string, baseRef: string | null, file: DiffFile): Promise<string | null>;
}

export interface QueueCommand {
  v: 1;
  kind: "queue";
  sessionId: string;
  messageId: string;
  action: QueueAction;
  nonce: string;
  /** Epoch ms. */
  expiresAt: number;
}

/**
 * A signed request to start a new chat in an existing workspace. Same
 * envelope as a reply (nonce, expiry, device signature over the sealed box);
 * the `kind` is what tells them apart. A reply carries no `kind` at all, so
 * replies stay byte-identical to before.
 */
export interface StartCommand {
  v: 1;
  kind: "start";
  workspaceId: string;
  agent: NewChatAgent;
  text: string;
  nonce: string;
  /** Epoch ms. */
  expiresAt: number;
}

/**
 * A signed request to take a fresh Claude usage reading (the Mac's Refresh,
 * from the phone). It carries nothing but the envelope: no text, no target.
 * The reading costs one small real call, so the Mac's refresher runs it at
 * most once a minute whoever asks, and the phone gets the cached one inside
 * that minute.
 */
export interface UsageCommand {
  v: 1;
  kind: "usage";
  nonce: string;
  /** Epoch ms. */
  expiresAt: number;
}

/**
 * A signed change to the Mac's awake session (fleet/awake-session.ts): `on`
 * false ends it; true starts one for `minutes` (absent: until ended), or with
 * `extend` adds that many minutes to the running one. It reaches no agent and
 * carries no text. The first phones sent only `on`.
 */
export interface AwakeCommand {
  v: 1;
  kind: "awake";
  on: boolean;
  minutes?: number;
  extend?: number;
  /** Stay awake with the lid closed too; needs `minutes` and the Mac's sudoers rule. */
  lid?: boolean;
  nonce: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface RemoteActivity {
  at: string;
  device: string;
  outcome: "sent" | "refused" | "rejected";
  detail: string;
}

export interface ChannelStore {
  get(path: string): Promise<ChannelDoc | null>;
  set(path: string, doc: ChannelDoc): Promise<void>;
  list(collection: string): Promise<Array<{ id: string; doc: ChannelDoc }>>;
  delete(path: string): Promise<void>;
  /**
   * Present when the store can stream changes (the Realtime Database). The
   * bridge then runs a pass as soon as a phone writes, and polls only as a
   * fallback. A change only wakes the pass; every check still runs on what
   * the pass reads.
   */
  watch?(
    path: string,
    onChange: () => void,
    options?: { onOpen?: () => void; onError?: (error: Error) => void },
  ): () => void;
}

export interface RemoteReplier {
  lastTurnText(sessionId: string): string | null;
  lastTurnId(sessionId: string): string | null;
  send(
    sessionId: string,
    text: string,
    onFailed: (message: string) => void,
    options?: ReplyOptions,
  ): Promise<ReplyOutcome>;
  /** The chat's Conductor queue; null when it can't be read (relay down, not a Conductor chat). */
  queue?(sessionId: string): Promise<QueueItem[] | null>;
  queueAction?(
    sessionId: string,
    messageId: string,
    action: QueueAction,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** The chat's readable messages, oldest first, for the phone's history above the turn. */
  transcript?(sessionId: string, limit: number): { messages: TranscriptMessage[] };
  /** Conductor's Stop for a working chat. Absent: a phone's Stop is refused. */
  stopTurn?(sessionId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/** Starting chats from a phone. Absent means this Mac does not offer it. */
export interface RemoteChatStarter {
  /** Re-read from the registry on every call: the phone's copy is never trusted. */
  workspaces(): NewChatWorkspace[];
  start(args: { workspaceId: string; agent: NewChatAgent; text: string }): Promise<StartChatOutcome>;
}

export interface RemoteBridgeDependencies {
  configPath: string;
  projectId: string;
  /** Built per config, since a reset changes nothing but the channel path. */
  store: ChannelStore;
  replier: RemoteReplier;
  snapshot: () => FleetSnapshot;
  /**
   * A working session's current turn (fleet/activity.ts). Without it the
   * phone shows only the last message, as before.
   */
  activity?: ((session: FleetSession) => Activity | null) | null;
  /** Workspaces a phone may start a chat in, and the way to start one. */
  newChat?: RemoteChatStarter | null;
  /** Answers a chat's pending question or plan (src/fleet/answer.ts). */
  answerer?: Answerer | null;
  /**
   * Take a fresh Claude usage reading (`ClaudeLimitsRefresher.refresh`,
   * throttled to once a minute). Absent: a phone's Refresh is refused.
   */
  refreshUsage?: (() => Promise<{ refreshed: boolean; throttled: boolean; error?: string }>) | null;
  /**
   * Hotspot failover (fleet/hotspot.ts): its state for the phone, and the
   * way to set it up, switch now, or switch back. Absent: phones hide it.
   */
  hotspot?: {
    state(): HotspotState;
    apply(request: unknown): Promise<{ ok: true; state: HotspotState } | { ok: false; reason: string }>;
  } | null;
  /** The awake session. Absent: phones hide it, and a change is refused. */
  awake?: {
    state(): AwakeState | null;
    /** Whether a lid-closed session can start (the sudoers rule is installed). */
    lidReady?(): boolean;
    /** The Mac's battery, power draw and lid, as last read. */
    power?(): {
      percent: number | null;
      onBattery: boolean | null;
      watts: number | null;
      lidClosed: boolean | null;
    } | null;
    apply(
      request: unknown,
    ):
      | Promise<{ ok: true; state: AwakeState | null } | { ok: false; reason: string }>
      | { ok: true; state: AwakeState | null }
      | { ok: false; reason: string };
  } | null;
  /** Claude's last plan-limit reading, for the read-only usage view on the phone. */
  claudeLimits?: (() => ClaudeLimits | null) | null;
  /**
   * The question a session waiting on you asked, whole (fleet/question.ts),
   * so the phone can show every option instead of a one-line summary.
   */
  question?:
    | ((session: FleetSession) => { toolUseId: string; questions: QuestionPrompt[]; plan?: string | null } | null)
    | null;
  /**
   * Subscribe to fresh snapshots. When one differs in what the phone shows
   * (state, title, detail — not just a newer timestamp) the bridge publishes
   * at once instead of waiting for its next pass. Optional; without it the
   * cadence alone applies.
   */
  onSnapshot?: ((listener: (snapshot: FleetSnapshot) => void) => () => void) | null;
  /**
   * The Realtime Database URL when `store` is one. It goes into the pairing
   * code, and is announced, sealed with the channel key, in Firestore's
   * `state/transport` through `announce`, so a phone paired before the move
   * follows without pairing again.
   */
  databaseUrl?: string | null;
  announce?: ChannelStore | null;
  /**
   * A session's current turn with whole steps (`readActivity` with
   * `stepChars`), for the phone's verbose view (live-turn.ts). Used only
   * with a streaming store (the Realtime Database). Without it, on
   * Firestore, or with `verbose: false` (SQUEAK_REMOTE_VERBOSE=off), a phone
   * asking for verbose gets nothing beyond the snapshot.
   */
  liveActivity?: ((session: FleetSession, limit: number, stepChars: number) => Activity | null) | null;
  verbose?: boolean;
  /** Reads a chat's diff for the phone's "what changed". Absent: refused. */
  diff?: RemoteDiffReader | null;
  /** Reads an image a chat's agent named, for the phone (phone-image.ts). Absent: refused. */
  image?: ((source: string, cwd: string) => Promise<PhoneImageResult>) | null;
  now?: () => number;
  macName?: string;
}

/** A pending question as the phone gets it: its prompts, or (for ExitPlanMode) the plan's text. */
type PhoneQuestion = { toolUseId: string; questions: QuestionPrompt[]; plan?: string };

/** A command older than this is refused even if nothing else is wrong. */
export const MAX_COMMAND_LIFETIME_MS = 10 * 60_000;
/** How long a phone counts as "open" after its last presence ping. */
const PRESENCE_WINDOW_MS = 60_000;
/**
 * The Mac answers a phone's presence with `state/alive`, at most this often,
 * so the phone can tell a quiet Mac from one that is asleep or off: the view
 * itself is only rewritten when something changes.
 */
const ALIVE_MIN_GAP_MS = 10_000;
const ACTIVE_POLL_MS = 2_000;
const IDLE_POLL_MS = 15_000;
const ACTIVE_PUBLISH_MS = 3_000;
const IDLE_PUBLISH_MS = 60_000;
/** A change publishes after this long, so a burst of snapshots becomes one write. */
const CHANGE_PUBLISH_DELAY_MS = 300;
/** Even change-driven publishes keep this gap, to bound Firestore writes. */
const CHANGE_PUBLISH_MIN_GAP_MS = 1_000;
/** With a streaming store a pass runs on every change; this is only the safety net. */
const STREAM_FALLBACK_MS = 60_000;
/** A burst of changes (a command, then its deletion) becomes one pass. */
const WATCH_DEBOUNCE_MS = 50;
/**
 * Results are read by the phone within seconds; older ones are swept. Without
 * this they piled up forever, and every phone that connected a stream to
 * `results` downloaded all of them (an image result is up to 700 KB).
 */
export const RESULT_RETENTION_MS = 15 * 60_000;
const RESULT_SWEEP_EVERY_MS = 5 * 60_000;
/** Pairing is only listened for while the Mac app's pairing sheet is open. */
const PAIRING_WINDOW_MS = 10 * 60_000;
const MESSAGE_MAX_CHARS = 8_000;
/**
 * Recent chats: Conductor chats that are no longer active, so a phone can
 * pick one up again. A short list, each with a shorter message: they change
 * rarely, but every published view carries them.
 */
export const PHONE_RECENT_LIMIT = 10;
/** "Show more" on the phone asks for up to this many, and reaches back further. */
export const PHONE_RECENT_MAX = 50;
const PHONE_RECENT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const PHONE_RECENT_MORE_AGE_MS = 30 * 24 * 60 * 60_000;
const RECENT_MESSAGE_MAX_CHARS = 2_000;
/** Past the first PHONE_RECENT_LIMIT, a preview: enough to recognise the chat, small enough to send 50. */
const RECENT_MORE_MESSAGE_MAX_CHARS = 300;
/** How many workspaces the snapshot offers a phone for a new chat. */
export const PHONE_WORKSPACE_LIMIT = 20;
/** One start per device in this window: a stolen phone cannot fan out agents. */
export const START_MIN_GAP_MS = 15_000;
/**
 * The phone gets less of a turn than the Mac window does: what leaves the Mac
 * is only what the phone must render (docs/remote-channel.md), so the newest
 * few steps, each clipped, and only while the session works.
 */
const PHONE_ACTIVITY_STEPS = 6;
const PHONE_ACTIVITY_STEP_CHARS = 200;
const ACTIVITY_LIMIT = 50;
/** A phone-chosen message id: what Conductor accepts, in the one spelling the phone sends. */
const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class RemoteBridge {
  private readonly deps: RemoteBridgeDependencies;
  private readonly now: () => number;
  private config: RemoteConfig | null;
  private readonly pending = new Map<string, PendingPairing>();
  private readonly seenNonces = new Map<string, number>();
  private readonly lastStartAt = new Map<string, number>();
  private readonly activity: RemoteActivity[] = [];
  private readonly messageCache = new Map<string, { text: string | null; choices: ParsedChoices | null }>();
  private readonly activityCache = new Map<string, PhoneActivity | null>();
  private readonly questionCache = new Map<string, PhoneQuestion | null>();
  private readonly answerLimit = new AnswerRateLimit();
  private pairingOpenUntil = 0;
  private phoneSeenAt = 0;
  /** The phone's own stamp on the last presence read, so a new ping is told apart from a re-read. */
  private lastPresenceStamp: number | null = null;
  private resultsSweptAt = 0;
  /** The last presence answered with `state/alive`, by the phone's own stamp, and when. */
  private answeredPresence = 0;
  private aliveWrittenAt = 0;
  private lastPublishedAt = 0;
  private lastPublished = "";
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private publishing = false;
  private stopped = false;
  private unsubscribe: (() => void) | null = null;
  private watching: { channelId: string; stops: Array<() => void> } | null = null;
  /** A change arrived during a pass; run another as soon as it ends. */
  private dirty = false;
  private announcedFor = "";
  /** The session the phone's last presence said it is watching in verbose mode. */
  private presenceWatching: string | null = null;
  /** How many recent chats the phone asked for ("Show more"); a view preference, not a command. */
  private recentWanted = PHONE_RECENT_LIMIT;
  private readonly live: LiveTurnPublisher | null;
  private lastSignature: string | null = null;
  private lastStepsSignature: string | null = null;
  /** What the phone in front of this Mac said it can read (its presence `caps`). */
  private phoneCaps: string[] = [];
  /** The counter every published document carries as `seq`, so a phone keeps only the newest. */
  private seq = 0;
  private lastRecentPublished = "";
  /** A history document may exist, so clearing the live turn deletes it too. */
  private historyWritten = false;
  private changeTimer: NodeJS.Timeout | null = null;
  private changeDueAt = 0;

  constructor(deps: RemoteBridgeDependencies) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.config = readConfig(deps.configPath);
    // Verbose needs the Realtime Database: a write a second is what it is
    // cheap at, and Firestore's rules have no `live` collection.
    const liveActivity = deps.store.watch ? deps.liveActivity : null;
    this.live = liveActivity
      ? new LiveTurnPublisher({
          read: (key) => {
            const session = this.deps.snapshot().active.find((candidate) => candidate.key === key);
            if (!session) {
              return null;
            }
            const conductorSessionId = session.conductorSessionId;
            return {
              activity: liveActivity(session, LIVE_STEPS, LIVE_STEP_CHARS),
              working: session.state === "working",
              state: session.state,
              turnId: conductorSessionId ? this.deps.replier.lastTurnId(conductorSessionId) : null,
            };
          },
          split: () => this.format().split,
          seq: () => this.nextSeq(),
          writeHistory: async (handle, history) => {
            const config = this.config;
            if (config) {
              this.historyWritten = true;
              await this.deps.store.set(this.channel(config, "live", liveHistoryHandle(handle)), {
                box: this.sealForPhone(config, history),
                at: this.now(),
              });
            }
          },
          history: deps.replier.transcript
            ? (key) => {
                const session = this.deps.snapshot().active.find((candidate) => candidate.key === key);
                const conductorSessionId = session?.conductorSessionId;
                const read = conductorSessionId ? this.deps.replier.transcript?.(conductorSessionId, 40) : null;
                return read ? condenseHistory(read.messages) : null;
              }
            : null,
          queue: deps.replier.queue
            ? async (key) => {
                const session = this.deps.snapshot().active.find((candidate) => candidate.key === key);
                const conductorSessionId = session?.conductorSessionId;
                return conductorSessionId ? ((await this.deps.replier.queue?.(conductorSessionId)) ?? null) : null;
              }
            : null,
          write: async (handle, turn) => {
            const config = this.config;
            if (config) {
              await this.deps.store.set(this.channel(config, "live", handle), {
                box: this.sealForPhone(config, turn),
                at: this.now(),
              });
            }
          },
          clear: async (handle) => {
            const config = this.config;
            if (config) {
              await this.deps.store.delete(this.channel(config, "live", handle));
              if (this.historyWritten) {
                await this.deps.store.delete(this.channel(config, "live", liveHistoryHandle(handle)));
              }
            }
          },
        })
      : null;
  }

  start(): void {
    this.stopped = false;
    this.schedule(0);
    this.ensureWatches();
    this.unsubscribe?.();
    this.unsubscribe =
      this.deps.onSnapshot?.((snapshot) => {
        const signature = snapshotSignature(snapshot);
        const changed = this.lastSignature !== null && signature !== this.lastSignature;
        this.lastSignature = signature;
        // A working chat's newest steps are on the phone's Home row too. They
        // change constantly, so while a phone looks they publish on the
        // active cadence rather than waiting for its next presence ping.
        const steps = stepsSignature(snapshot);
        const stepped = this.lastStepsSignature !== null && steps !== this.lastStepsSignature;
        this.lastStepsSignature = steps;
        if (changed) {
          this.nudgePublish(CHANGE_PUBLISH_DELAY_MS);
        } else if (stepped && this.phoneOpen()) {
          this.nudgePublish(ACTIVE_PUBLISH_MS);
        }
      }) ?? null;
  }

  /** Publish soon because what the phone shows just changed. */
  /** Something the phone shows changed outside the fleet (the awake session): publish it soon. */
  changed(): void {
    this.nudgePublish(0);
  }

  private nudgePublish(delayMs: number): void {
    if (this.stopped || !this.config?.devices.some((device) => !device.revokedAt)) {
      return;
    }
    const due = this.now() + delayMs;
    // One pending publish; a sooner reason (a state change behind a step) moves it up.
    if (this.changeTimer) {
      if (due >= this.changeDueAt) {
        return;
      }
      clearTimeout(this.changeTimer);
    }
    this.changeDueAt = due;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      void this.publishForChange();
    }, delayMs);
    this.changeTimer.unref?.();
  }

  private async publishForChange(): Promise<void> {
    const config = this.config;
    if (this.stopped || !config || !config.devices.some((device) => !device.revokedAt)) {
      return;
    }
    const wait = this.lastPublishedAt + CHANGE_PUBLISH_MIN_GAP_MS - this.now();
    if (wait > 0 || this.publishing) {
      this.nudgePublish(Math.max(wait, CHANGE_PUBLISH_DELAY_MS));
      return;
    }
    try {
      await this.publish(config, true);
    } catch (error) {
      logger.warn("remote change publish failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  stop(): void {
    this.stopped = true;
    this.live?.stop();
    this.stopWatches();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.changeTimer) {
      clearTimeout(this.changeTimer);
      this.changeTimer = null;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Whether any phone could act on a link to one of its sessions right now. */
  hasPairedPhone(): boolean {
    return Boolean(this.config?.devices.some((device) => !device.revokedAt));
  }

  /* ---------- what the Mac app shows and does ---------- */

  status(): unknown {
    const config = this.config;
    return {
      configured: Boolean(config),
      projectId: this.deps.projectId,
      phoneOpen: this.phoneOpen(),
      pairingOpen: this.pairingOpenUntil > this.now(),
      devices: (config?.devices ?? []).map(({ id, name, pairedAt, revokedAt }) => ({ id, name, pairedAt, revokedAt })),
      pending: [...this.pending.values()].map(({ id, name, code, requestedAt }) => ({ id, name, code, requestedAt })),
      activity: this.activity.slice(-20).reverse(),
    };
  }

  /**
   * Open the pairing window and return the QR payload. Makes the channel on
   * first use. The payload is the one secret that lets a phone read.
   */
  startPairing(): { url: string } {
    const config = this.config ?? this.createChannel();
    this.pairingOpenUntil = this.now() + PAIRING_WINDOW_MS;
    this.schedule(0);
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        p: config.projectId,
        c: config.channelId,
        k: config.key,
        n: this.macName(),
        ...(this.deps.databaseUrl ? { r: this.deps.databaseUrl } : {}),
      }),
    ).toString("base64url");
    return { url: `squeak://pair?d=${payload}` };
  }

  async approve(deviceId: string): Promise<boolean> {
    const request = this.pending.get(deviceId);
    const config = this.config;
    if (!request || !config) {
      return false;
    }
    config.devices = config.devices.filter((device) => device.id !== deviceId);
    config.devices.push({
      id: request.id,
      name: request.name,
      publicKey: request.publicKey,
      pairedAt: new Date(this.now()).toISOString(),
    });
    this.save();
    this.pending.delete(deviceId);
    await this.answerPairing(deviceId, true);
    this.log(request.name, "sent", "paired");
    return true;
  }

  async reject(deviceId: string): Promise<boolean> {
    if (!this.pending.delete(deviceId)) {
      return false;
    }
    await this.answerPairing(deviceId, false);
    return true;
  }

  revoke(deviceId: string): boolean {
    const device = this.config?.devices.find((candidate) => candidate.id === deviceId);
    if (!device) {
      return false;
    }
    device.revokedAt = new Date(this.now()).toISOString();
    this.save();
    this.log(device.name, "rejected", "revoked on this Mac");
    return true;
  }

  /**
   * Forget every phone and start a new channel. The old QR code, and any
   * copy of the old key, can no longer read anything new.
   */
  reset(): void {
    // Before the config goes, so the live document can still be deleted.
    this.live?.stop();
    this.config = null;
    this.pending.clear();
    this.stopWatches();
    this.announcedFor = "";
    try {
      fs.rmSync(this.deps.configPath, { force: true });
    } catch {
      // Nothing to remove.
    }
  }

  /* ---------- the loop ---------- */

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  /** One pass: presence, pairing, commands, snapshot. Never throws. */
  async tick(): Promise<void> {
    if (this.busy) {
      this.dirty = true;
      return;
    }
    this.busy = true;
    this.dirty = false;
    try {
      const config = this.config;
      this.ensureWatches();
      if (config) {
        await this.announceTransport(config);
        await this.readPresence(config);
        this.updateLive();
        if (this.pairingOpenUntil > this.now()) {
          await this.readPairing(config);
        }
        if (config.devices.some((device) => !device.revokedAt)) {
          await this.readCommands(config);
          await this.publish(config);
          await this.sweepResults(config);
        }
      }
    } catch (error) {
      logger.warn("remote channel pass failed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.busy = false;
      if (this.dirty) {
        this.dirty = false;
        this.schedule(0);
      } else if (this.watching) {
        this.schedule(STREAM_FALLBACK_MS);
      } else {
        this.schedule(this.phoneOpen() || this.pairingOpenUntil > this.now() ? ACTIVE_POLL_MS : IDLE_POLL_MS);
      }
    }
  }

  /**
   * Verbose: publish the turn of the session the phone is watching, only
   * while it is open, a phone is paired, the owner has not switched verbose
   * off, and that session is one the phone can see. Anything else stops it,
   * which deletes the document.
   */
  private updateLive(): void {
    const key = this.presenceWatching;
    const allowed =
      this.deps.verbose !== false &&
      key !== null &&
      this.phoneOpen() &&
      this.hasPairedPhone() &&
      this.deps.snapshot().active.some((session) => session.key === key);
    this.live?.watch(allowed ? key : null);
  }

  /* ---------- streaming (Realtime Database) ---------- */

  /** Watch what phones write: presence, pairing requests and commands. One stream each. */
  private ensureWatches(): void {
    const watch = this.deps.store.watch?.bind(this.deps.store);
    const config = this.config;
    if (!watch || this.stopped || !config) {
      if (!config) this.stopWatches();
      return;
    }
    if (this.watching?.channelId === config.channelId) {
      return;
    }
    this.stopWatches();
    const onError = (error: Error) => logger.debug("remote watch dropped; reconnecting", { error: error.message });
    this.watching = {
      channelId: config.channelId,
      stops: [
        this.channel(config, "state", "presence"),
        this.channel(config, "pairing"),
        this.channel(config, "commands"),
      ].map((path) => watch(path, () => this.wake(), { onError })),
    };
  }

  private stopWatches(): void {
    for (const stop of this.watching?.stops ?? []) {
      stop();
    }
    this.watching = null;
  }

  /** A phone wrote something: run a pass now (or right after the one running). */
  private wake(): void {
    if (this.stopped) {
      return;
    }
    if (this.busy) {
      this.dirty = true;
      return;
    }
    this.schedule(WATCH_DEBOUNCE_MS);
  }

  /** Tell phones paired before the move where the channel lives now. Once per channel per run. */
  private async announceTransport(config: RemoteConfig): Promise<void> {
    const url = this.deps.databaseUrl;
    const store = this.deps.announce;
    if (!url || !store || this.announcedFor === config.channelId) {
      return;
    }
    try {
      await store.set(this.channel(config, "state", "transport"), {
        box: seal(config.key, { r: url }),
        at: this.now(),
      });
      this.announcedFor = config.channelId;
    } catch (error) {
      // Best effort, retried next pass; it must never hold up a command.
      logger.warn("remote transport announcement failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private phoneOpen(): boolean {
    return this.now() - this.phoneSeenAt < PRESENCE_WINDOW_MS;
  }

  private channel(config: RemoteConfig, kind: string, id?: string): string {
    return id ? `channels/${config.channelId}/${kind}/${id}` : `channels/${config.channelId}/${kind}`;
  }

  private async readPresence(config: RemoteConfig): Promise<void> {
    const doc = await this.deps.store.get(this.channel(config, "state", "presence"));
    if (!doc) {
      return;
    }
    try {
      const presence = open<{ at: number; watching?: unknown; recent?: unknown; caps?: unknown }>(config.key, doc.box);
      // Timed by when this Mac saw a new ping, not by the phone's clock: a
      // phone a minute behind would otherwise never count as open. The first
      // read after a start may be an old ping, so that one keeps the phone's
      // stamp (never in the future).
      if (presence.at !== this.lastPresenceStamp) {
        const seen = this.lastPresenceStamp === null ? Math.min(presence.at, this.now()) : this.now();
        this.lastPresenceStamp = presence.at;
        this.phoneSeenAt = Math.max(this.phoneSeenAt, seen);
      }
      this.presenceWatching =
        typeof presence.watching === "string" && presence.watching.length <= 300 ? presence.watching : null;
      const wanted =
        typeof presence.recent === "number" && Number.isFinite(presence.recent)
          ? Math.min(PHONE_RECENT_MAX, Math.max(PHONE_RECENT_LIMIT, Math.trunc(presence.recent)))
          : PHONE_RECENT_LIMIT;
      if (wanted !== this.recentWanted) {
        this.recentWanted = wanted;
        this.nudgePublish(0);
      }
      const caps = Array.isArray(presence.caps)
        ? presence.caps.filter((cap): cap is string => typeof cap === "string" && cap.length <= 20).slice(0, 10)
        : [];
      if (caps.join(",") !== this.phoneCaps.join(",")) {
        // A phone that reads more (or an older one that reads less) is in front now: write everything again in its format.
        this.phoneCaps = caps;
        this.live?.invalidate();
        this.nudgePublish(0);
      }
      await this.answerPresence(config, presence.at);
    } catch {
      // Not ours — ignore it.
    }
  }

  /**
   * Say this Mac is awake, to a phone that is looking: a new presence ping
   * inside the window gets a sealed `{ at }` back. A Mac that wakes to a ping
   * from an hour ago says nothing; the phone's next ping gets the answer.
   */
  private async answerPresence(config: RemoteConfig, phoneAt: number): Promise<void> {
    const now = this.now();
    if (phoneAt <= this.answeredPresence || !this.phoneOpen() || now - this.aliveWrittenAt < ALIVE_MIN_GAP_MS) {
      return;
    }
    try {
      await this.deps.store.set(this.channel(config, "state", "alive"), {
        box: seal(config.key, { at: now }),
        at: now,
      });
      this.answeredPresence = phoneAt;
      this.aliveWrittenAt = now;
    } catch (error) {
      // Best effort: the phone only says the Mac is not answering; retried on the next ping.
      logger.warn("remote alive answer failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async readPairing(config: RemoteConfig): Promise<void> {
    for (const { id, doc } of await this.deps.store.list(this.channel(config, "pairing"))) {
      if (this.pending.has(id) || config.devices.some((device) => device.id === id && !device.revokedAt)) {
        continue;
      }
      try {
        const request = open<{ name: string; publicKey: string }>(config.key, doc.box);
        if (typeof request.publicKey !== "string" || typeof request.name !== "string") {
          continue;
        }
        this.pending.set(id, {
          id,
          name: request.name.slice(0, 60),
          publicKey: request.publicKey,
          code: pairingCode(request.publicKey),
          requestedAt: new Date(this.now()).toISOString(),
        });
      } catch {
        // Undecryptable: not from a phone that scanned this Mac's code.
      }
    }
  }

  private async answerPairing(deviceId: string, approved: boolean): Promise<void> {
    const config = this.config;
    if (!config) {
      return;
    }
    await this.deps.store.set(this.channel(config, "results", `pair-${deviceId}`), {
      box: seal(config.key, { approved, mac: this.macName() }),
      at: this.now(),
    });
    await this.deps.store.delete(this.channel(config, "pairing", deviceId)).catch(() => undefined);
  }

  private async readCommands(config: RemoteConfig): Promise<void> {
    for (const { id, doc } of await this.deps.store.list(this.channel(config, "commands"))) {
      const verdict = await this.handleCommand(config, id, doc);
      // Deleted whatever the verdict, so nothing is ever looked at twice.
      await this.deps.store.delete(this.channel(config, "commands", id)).catch(() => undefined);
      if (verdict.write) {
        await this.deps.store
          .set(this.channel(config, "results", id), { box: seal(config.key, verdict.result), at: this.now() })
          .catch(() => undefined);
      }
    }
  }

  /** Deletes results older than RESULT_RETENTION_MS, every few minutes. Best effort. */
  private async sweepResults(config: RemoteConfig): Promise<void> {
    const now = this.now();
    if (now - this.resultsSweptAt < RESULT_SWEEP_EVERY_MS) {
      return;
    }
    this.resultsSweptAt = now;
    try {
      for (const { id, doc } of await this.deps.store.list(this.channel(config, "results"))) {
        if (doc.at === undefined || now - doc.at > RESULT_RETENTION_MS) {
          await this.deps.store.delete(this.channel(config, "results", id)).catch(() => undefined);
        }
      }
    } catch (error) {
      logger.debug("remote results sweep failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Every check from docs/remote-channel.md, in order; the first failure wins. */
  async handleCommand(
    config: RemoteConfig,
    id: string,
    doc: ChannelDoc,
  ): Promise<{ write: boolean; result: Record<string, unknown> }> {
    const device = config.devices.find((candidate) => candidate.id === doc.device);
    // 1. A paired, unrevoked device signed exactly this box.
    if (!device || device.revokedAt || !doc.sig || !verifyDeviceSignature(device.publicKey, doc.box, doc.sig)) {
      this.log(device?.name ?? "unknown device", "rejected", "signature did not verify");
      // No result: an unsigned writer learns nothing, not even that it failed.
      return { write: false, result: {} };
    }

    let command: RemoteCommand;
    try {
      command = open<RemoteCommand>(config.key, doc.box);
    } catch {
      this.log(device.name, "rejected", "could not be decrypted");
      return { write: false, result: {} };
    }

    const refuse = (reason: string) => {
      this.log(device.name, "rejected", reason);
      return { write: true, result: { id, status: "refused", reason } };
    };

    // 2. Fresh, and never seen before.
    const now = this.now();
    this.forgetOldNonces(now);
    if (
      typeof command.expiresAt !== "number" ||
      command.expiresAt < now ||
      command.expiresAt > now + MAX_COMMAND_LIFETIME_MS
    ) {
      return refuse("That reply expired before this Mac saw it. Send it again.");
    }
    if (typeof command.nonce !== "string" || command.nonce.length < 16 || this.seenNonces.has(command.nonce)) {
      return refuse("That reply was already received.");
    }
    this.seenNonces.set(command.nonce, command.expiresAt);

    // 3. The actions there are: a reply to an existing chat, a new chat, a usage
    // refresh, or a change to a queued message.
    const kind = (command as { kind?: unknown }).kind;
    if (kind === "start") {
      return this.handleStart(device, id, command as unknown as StartCommand, now);
    }
    if (kind === "hotspot") {
      return this.handleHotspot(device, id, command as unknown as Record<string, unknown>);
    }
    if (kind === "awake") {
      return this.handleAwake(device, id, command as unknown as AwakeCommand);
    }
    if (kind === "usage") {
      return this.handleUsage(device, id, command as unknown as UsageCommand);
    }
    if (kind === "queue") {
      return this.handleQueue(device, id, command as unknown as QueueCommand);
    }
    if (kind === "image") {
      return this.handleImage(device, id, command as unknown as ImageCommand);
    }
    if (kind === "diff") {
      return this.handleDiff(device, id, command as unknown as DiffCommand);
    }
    if (kind === "stop") {
      return this.handleStop(device, id, command as unknown as StopCommand);
    }
    if (kind === "answer") {
      const result = await runAnswerCommand(command as unknown as AnswerCommand, {
        answerer: this.deps.answerer ?? null,
        limit: this.answerLimit,
        deviceId: device.id,
        now,
      });
      this.log(device.name, result.status === "answered" ? "sent" : "refused", "answer to a question");
      return { write: true, result: { id, ...result } };
    }
    if (kind !== undefined && kind !== "reply") {
      return refuse("Not a request this Mac understands.");
    }
    if (command.v !== 1 || typeof command.sessionId !== "string" || typeof command.text !== "string") {
      return refuse("Not a reply this Mac understands.");
    }
    if (command.mode !== undefined && command.mode !== "queue" && command.mode !== "steer") {
      return refuse("Not a reply this Mac understands.");
    }
    if (
      command.messageId !== undefined &&
      (typeof command.messageId !== "string" || !MESSAGE_ID.test(command.messageId))
    ) {
      return refuse("Not a reply this Mac understands.");
    }
    const text = command.text.trim();
    if (!text || text.length > 20_000) {
      return refuse("There is nothing to send.");
    }

    // 4. Still answering the question the phone was looking at.
    const currentTurn = this.deps.replier.lastTurnId(command.sessionId);
    if (command.answersTurn !== currentTurn) {
      return refuse("That chat has moved on since your phone last looked. Check it and reply again.");
    }

    // 5. The same busy rules as Telegram and the Mac window.
    const outcome = await this.deps.replier.send(
      command.sessionId,
      text,
      (message) => {
        this.log(device.name, "refused", `the reply failed: ${message}`);
      },
      { mode: command.mode ?? "queue", ...(command.messageId ? { messageId: command.messageId } : {}) },
    );
    if (outcome.status === "refused") {
      this.log(device.name, "refused", outcome.reason);
      return { write: true, result: { id, status: "refused", reason: outcome.reason } };
    }
    this.log(device.name, "sent", `${text.length <= 3 ? text : "a reply"} to ${command.sessionId.slice(0, 8)}`);
    return {
      write: true,
      result: {
        id,
        status: "sent",
        via: outcome.via,
        ...(outcome.via === "background" ? { fallbackReason: outcome.fallbackReason } : {}),
        ...(outcome.delivery ? { delivery: outcome.delivery } : {}),
        ...(outcome.note ? { note: outcome.note } : {}),
      },
    };
  }

  /**
   * A new chat. Everything above (signature, freshness, nonce) has already
   * held. There is no turn to match, so the guards are the workspace (looked up
   * again in the registry, never taken from the phone's copy), the text, the
   * agent and a per-device rate limit.
   */
  private async handleStart(
    device: PairedDevice,
    id: string,
    command: StartCommand,
    now: number,
  ): Promise<{ write: boolean; result: Record<string, unknown> }> {
    const refuse = (reason: string) => {
      this.log(device.name, "rejected", `new chat: ${reason}`);
      return { write: true, result: { id, status: "refused", reason } };
    };
    const starter = this.deps.newChat;
    if (!starter) {
      return refuse("This Mac can't start chats from a phone.");
    }
    if (
      command.v !== 1 ||
      typeof command.workspaceId !== "string" ||
      typeof command.text !== "string" ||
      (command.agent !== "claude" && command.agent !== "codex")
    ) {
      return refuse("Not a request this Mac understands.");
    }
    const text = command.text.trim();
    if (!text) {
      return refuse("Write a first message.");
    }
    if (text.length > NEW_CHAT_MAX_TEXT) {
      return refuse(`That message is too long (limit ${NEW_CHAT_MAX_TEXT} characters).`);
    }
    let offered: NewChatWorkspace[];
    try {
      offered = starter.workspaces().slice(0, PHONE_WORKSPACE_LIMIT);
    } catch {
      return refuse("This Mac couldn't read its workspaces.");
    }
    const workspace = offered.find((candidate) => candidate.id === command.workspaceId);
    if (!workspace) {
      return refuse("That workspace isn't available any more. Pick another.");
    }
    const last = this.lastStartAt.get(device.id);
    if (last !== undefined && now - last < START_MIN_GAP_MS) {
      return refuse("You just started a chat. Wait a few seconds and try again.");
    }
    this.lastStartAt.set(device.id, now);
    let outcome: StartChatOutcome;
    try {
      outcome = await starter.start({ workspaceId: workspace.id, agent: command.agent, text });
    } catch (error) {
      outcome = { ok: false, reason: error instanceof Error ? error.message : "The chat could not be started." };
    }
    if (!outcome.ok) {
      this.log(device.name, "refused", `new chat in ${workspace.repoName} failed: ${outcome.reason}`);
      return { write: true, result: { id, status: "refused", reason: outcome.reason } };
    }
    this.log(device.name, "sent", `new ${command.agent} chat in ${workspace.repoName} · ${workspace.branch}`);
    return { write: true, result: { id, status: "sent", sessionId: outcome.sessionId } };
  }

  /**
   * Steer or delete a queued message. Signature, freshness and nonce have
   * already held. The chat must be one the phone is shown (looked up in the
   * Mac's own snapshot, never the phone's copy), and the message must still
   * be in Conductor's queue as the Mac reads it now.
   */
  private async handleQueue(
    device: PairedDevice,
    id: string,
    command: QueueCommand,
  ): Promise<{ write: boolean; result: Record<string, unknown> }> {
    const refuse = (reason: string) => {
      this.log(device.name, "rejected", `queued message: ${reason}`);
      return { write: true, result: { id, status: "refused", reason } };
    };
    if (
      command.v !== 1 ||
      typeof command.sessionId !== "string" ||
      typeof command.messageId !== "string" ||
      !MESSAGE_ID.test(command.messageId) ||
      (command.action !== "promote" && command.action !== "cancel")
    ) {
      return refuse("Not a request this Mac understands.");
    }
    if (!this.phoneShows(command.sessionId)) {
      return refuse("That chat isn't on your phone any more.");
    }
    const replier = this.deps.replier;
    if (!replier.queue || !replier.queueAction) {
      return refuse("This Mac can't change queued messages.");
    }
    let queue: QueueItem[] | null;
    try {
      queue = await replier.queue(command.sessionId);
    } catch {
      queue = null;
    }
    if (!queue) {
      return refuse("This Mac can't read that chat's queue right now.");
    }
    if (!queue.some((item) => item.id === command.messageId)) {
      return refuse("That message already went to the agent.");
    }
    let outcome: { ok: true } | { ok: false; reason: string };
    try {
      outcome = await replier.queueAction(command.sessionId, command.messageId, command.action);
    } catch (error) {
      outcome = { ok: false, reason: error instanceof Error ? error.message : "The change could not be made." };
    }
    if (!outcome.ok) {
      this.log(device.name, "refused", `queued message: ${outcome.reason}`);
      return { write: true, result: { id, status: "refused", reason: outcome.reason } };
    }
    this.log(
      device.name,
      "sent",
      `${command.action === "promote" ? "steered in" : "deleted"} a queued message in ${command.sessionId.slice(0, 8)}`,
    );
    return { write: true, result: { id, status: "sent" } };
  }

  /**
   * Stop a working chat. Signature, freshness and nonce have already held. The
   * chat must be one the phone is shown, and still on the turn the phone saw
   * working (the same turn rule as a reply); the replier refuses anything not
   * working by Conductor's own word.
   */
  private async handleStop(
    device: PairedDevice,
    id: string,
    command: StopCommand,
  ): Promise<{ write: boolean; result: Record<string, unknown> }> {
    const refuse = (reason: string) => {
      this.log(device.name, "rejected", `stop: ${reason}`);
      return { write: true, result: { id, status: "refused", reason } };
    };
    // The phone leaves out a turn it does not know, rather than sending null.
    const turn = command.answersTurn ?? null;
    if (command.v !== 1 || typeof command.sessionId !== "string" || (turn !== null && typeof turn !== "string")) {
      return refuse("Not a request this Mac understands.");
    }
    if (!this.phoneShows(command.sessionId)) {
      return refuse("That chat isn't on your phone any more.");
    }
    const replier = this.deps.replier;
    if (!replier.stopTurn) {
      return refuse("This Mac can't stop an agent from a phone.");
    }
    if (turn !== replier.lastTurnId(command.sessionId)) {
      return refuse("That turn already ended.");
    }
    let outcome: { ok: true } | { ok: false; reason: string };
    try {
      outcome = await replier.stopTurn(command.sessionId);
    } catch (error) {
      outcome = { ok: false, reason: error instanceof Error ? error.message : "The agent could not be stopped." };
    }
    if (!outcome.ok) {
      this.log(device.name, "refused", `stop: ${outcome.reason}`);
      return { write: true, result: { id, status: "refused", reason: outcome.reason } };
    }
    this.log(device.name, "sent", `stopped ${command.sessionId.slice(0, 8)}`);
    return { write: true, result: { id, status: "sent" } };
  }

  /**
   * What a chat changed, for the phone's diff view. Signature, freshness and
   * nonce have already held. The folder and base branch come from the Mac's
   * own snapshot of a chat the phone is shown, never from the phone.
   */
  private async handleDiff(
    device: PairedDevice,
    id: string,
    command: DiffCommand,
  ): Promise<{ write: boolean; result: Record<string, unknown> }> {
    const refuse = (reason: string) => {
      this.log(device.name, "rejected", `diff: ${reason}`);
      return { write: true, result: { id, status: "refused", reason } };
    };
    if (
      command.v !== 1 ||
      typeof command.sessionId !== "string" ||
      (command.file !== undefined && (!Number.isInteger(command.file) || command.file < 0))
    ) {
      return refuse("Not a request this Mac understands.");
    }
    const reader = this.deps.diff;
    if (!reader) {
      return refuse("This Mac can't show changes on a phone.");
    }
    const session = this.shownSession(command.sessionId);
    if (!session) {
      return refuse("That chat isn't on your phone any more.");
    }
    if (!session.cwd) {
      return refuse("This chat has no folder on the Mac to read.");
    }
    let summary: WorkspaceDiff | null;
    try {
      summary = await reader.readSummary(session.cwd, session.baseRef);
    } catch {
      summary = null;
    }
    if (!summary) {
      return refuse("This Mac couldn't read that chat's changes.");
    }
    const result: Record<string, unknown> = { id, status: "sent", diff: summary };
    if (command.file !== undefined) {
      const file = summary.files[command.file];
      if (!file) {
        return refuse("That file isn't in the changes any more.");
      }
      let patch: string | null;
      try {
        patch = await reader.readFilePatch(session.cwd, session.baseRef, file);
      } catch {
        patch = null;
      }
      result.patch = { index: command.file, path: file.path, text: patch ?? "" };
    }
    this.log(device.name, "sent", `changes of ${command.sessionId.slice(0, 8)}`);
    return { write: true, result };
  }

  /**
   * An image the chat's agent showed. Signature, freshness and nonce have
   * already held. The source must be named in the chat's own messages (so a
   * phone cannot ask for any path it likes), and phone-image.ts then keeps it
   * inside the chat's workspace, an image, and shrunk.
   */
  private async handleImage(
    device: PairedDevice,
    id: string,
    command: ImageCommand,
  ): Promise<{ write: boolean; result: Record<string, unknown> }> {
    const refuse = (reason: string) => {
      this.log(device.name, "rejected", `image: ${reason}`);
      return { write: true, result: { id, status: "refused", reason } };
    };
    if (
      command.v !== 1 ||
      typeof command.sessionId !== "string" ||
      typeof command.source !== "string" ||
      !command.source.trim() ||
      command.source.length > 2_000
    ) {
      return refuse("Not a request this Mac understands.");
    }
    const read = this.deps.image;
    if (!read) {
      return refuse("This Mac can't send images to a phone.");
    }
    const session = this.shownSession(command.sessionId);
    if (!session) {
      return refuse("That chat isn't on your phone any more.");
    }
    if (!session.cwd) {
      return refuse("This chat has no folder on the Mac to read.");
    }
    const replier = this.deps.replier;
    const texts = [
      replier.lastTurnText(command.sessionId) ?? "",
      ...(replier.transcript?.(command.sessionId, 40).messages.map((message) => message.text) ?? []),
    ];
    if (!texts.some((text) => text.includes(command.source))) {
      return refuse("That image isn't in this chat.");
    }
    let outcome: PhoneImageResult;
    try {
      outcome = await read(command.source, session.cwd);
    } catch {
      outcome = { ok: false, reason: "Your Mac couldn't read that image." };
    }
    if (!outcome.ok) {
      return refuse(outcome.reason);
    }
    this.log(device.name, "sent", `an image from ${command.sessionId.slice(0, 8)}`);
    return { write: true, result: { id, status: "sent", image: outcome.image } };
  }

  /** The Mac's own record of a Conductor chat the phone is shown, or null. */
  private shownSession(conductorSessionId: string): FleetSession | null {
    if (!this.phoneShows(conductorSessionId)) {
      return null;
    }
    const snapshot = this.deps.snapshot();
    const named = (session: FleetSession) => session.conductorSessionId === conductorSessionId;
    return snapshot.active.find(named) ?? snapshot.sessions.find(named) ?? null;
  }

  /** Whether a Conductor chat is in what the phone is shown: active, or in its Recent list. */
  private phoneShows(conductorSessionId: string): boolean {
    const snapshot = this.deps.snapshot();
    if (snapshot.active.some((session) => session.conductorSessionId === conductorSessionId)) {
      return true;
    }
    const { recent } = this.recentSessions(snapshot, this.phoneOpen() ? this.recentWanted : PHONE_RECENT_LIMIT);
    return recent.some((session) => session.conductorSessionId === conductorSessionId);
  }

  /**
   * Hotspot failover from the phone: set it up (name, password, on/off),
   * switch the Mac to the hotspot now, or back to its usual Wi-Fi.
   * Signature, freshness and nonce have already held; the shape is checked
   * again in fleet/hotspot.ts. The password goes to the Mac's Keychain and
   * nowhere else, never into a result or the phone's view.
   */
  private async handleHotspot(
    device: PairedDevice,
    id: string,
    command: Record<string, unknown>,
  ): Promise<{ write: boolean; result: Record<string, unknown> }> {
    const refuse = (reason: string) => {
      this.log(device.name, "rejected", `hotspot: ${reason}`);
      return { write: true, result: { id, status: "refused", reason } };
    };
    const hotspot = this.deps.hotspot;
    if (!hotspot) {
      return refuse("This Mac can't use a hotspot from a phone.");
    }
    if (command.v !== 1) {
      return refuse("Not a request this Mac understands.");
    }
    const { action, ssid, password, enabled } = command;
    const outcome = await hotspot.apply({ action, ssid, password, enabled });
    if (!outcome.ok) {
      return refuse(outcome.reason);
    }
    this.nudgePublish(0);
    this.log(device.name, "sent", `hotspot ${String(action)}`);
    return { write: true, result: { id, status: "sent" } };
  }

  /** A keep-awake flip. Signature, freshness and nonce have already held. */
  private async handleAwake(
    device: PairedDevice,
    id: string,
    command: AwakeCommand,
  ): Promise<{ write: boolean; result: Record<string, unknown> }> {
    const awake = this.deps.awake;
    if (!awake || command.v !== 1) {
      this.log(device.name, "rejected", "keep awake: not available");
      return { write: true, result: { id, status: "refused", reason: "This Mac can't be kept awake from a phone." } };
    }
    // Only the fields an awake command has: the phone cannot reach the action shape's names.
    const outcome = await awake.apply({
      on: command.on,
      minutes: command.minutes,
      extend: command.extend,
      lid: command.lid,
    });
    if (!outcome.ok) {
      this.log(device.name, "rejected", `keep awake: ${outcome.reason}`);
      return { write: true, result: { id, status: "refused", reason: outcome.reason } };
    }
    this.nudgePublish(0);
    this.log(device.name, "sent", outcome.state ? "keep the Mac awake" : "let the Mac sleep");
    return { write: true, result: { id, status: "sent" } };
  }

  /** A usage refresh. Signature, freshness and nonce have already held. */
  private async handleUsage(
    device: PairedDevice,
    id: string,
    command: UsageCommand,
  ): Promise<{ write: boolean; result: Record<string, unknown> }> {
    const refresh = this.deps.refreshUsage;
    if (!refresh || command.v !== 1) {
      this.log(device.name, "rejected", "usage refresh: not available");
      return { write: true, result: { id, status: "refused", reason: "This Mac can't refresh usage from a phone." } };
    }
    let outcome: { refreshed: boolean; throttled: boolean; error?: string };
    try {
      outcome = await refresh();
    } catch (error) {
      outcome = { refreshed: false, throttled: false, error: error instanceof Error ? error.message : String(error) };
    }
    // The reading travels in the snapshot; send it now rather than on the next pass.
    this.nudgePublish(0);
    this.log(device.name, "sent", outcome.throttled ? "usage (read in the last minute)" : "usage refreshed");
    return {
      write: true,
      result: {
        id,
        status: "sent",
        refreshed: outcome.refreshed,
        throttled: outcome.throttled,
        ...(outcome.error ? { note: "Claude didn't answer this time; showing the last reading." } : {}),
      },
    };
  }

  private forgetOldNonces(now: number): void {
    for (const [nonce, expiresAt] of this.seenNonces) {
      if (expiresAt < now) {
        this.seenNonces.delete(nonce);
      }
    }
  }

  /** The phone's whole view, encrypted. Written only when it changed. */
  private async publish(config: RemoteConfig, force = false): Promise<void> {
    const interval = this.phoneOpen() ? ACTIVE_PUBLISH_MS : IDLE_PUBLISH_MS;
    if (this.publishing || (!force && this.now() - this.lastPublishedAt < interval)) {
      return;
    }
    this.publishing = true;
    try {
      await this.publishView(config);
    } finally {
      this.publishing = false;
    }
  }

  private async publishView(config: RemoteConfig): Promise<void> {
    const view = this.phoneView();
    const format = this.format();
    // Readings' ages are drawn on the phone from observedAt, so an unchanged
    // reading must not republish the snapshot just because it was re-read.
    const core =
      JSON.stringify(view.sessions) +
      JSON.stringify(view.duck) +
      JSON.stringify(view.keepAwake) +
      JSON.stringify(view.awakeUntil) +
      JSON.stringify(view.awakeLid) +
      JSON.stringify(view.awakeLidReady) +
      JSON.stringify(view.awakeSafety) +
      JSON.stringify(view.macPower) +
      JSON.stringify(view.hotspot) +
      JSON.stringify(view.usage, (key, value: unknown) => (key === "observedAt" ? undefined : value));
    const { recent, recentMore, workspaces, ...rest } = view;
    const lists = JSON.stringify([recent, recentMore, workspaces ?? null]);
    const kind = `${format.split ? "split" : "whole"}|${format.compress ? "z" : "plain"}|`;
    const serialized = kind + core + (format.split ? "" : lists);
    if (format.split) {
      // The recent list and the workspaces change rarely and are most of the
      // view's size, so a phone that reads them apart gets them only when
      // they change. Written first, so the view never names a list not there.
      if (kind + lists !== this.lastRecentPublished) {
        const doc = { v: 1, recent, recentMore, ...(workspaces ? { workspaces } : {}), seq: this.nextSeq() };
        const box = this.sealForPhone(config, doc);
        await this.deps.store.set(this.channel(config, "state", "recent"), { box, at: this.now() });
        logger.debug("remote recent published", { bytes: box.length });
        this.lastRecentPublished = kind + lists;
      }
    } else {
      this.lastRecentPublished = "";
    }
    if (serialized === this.lastPublished) {
      return;
    }
    const doc = format.split ? { ...rest, split: true, seq: this.nextSeq() } : { ...view, seq: this.nextSeq() };
    const box = this.sealForPhone(config, doc);
    await this.deps.store.set(this.channel(config, "state", "snapshot"), { box, at: this.now() });
    logger.debug("remote snapshot published", {
      bytes: box.length,
      split: format.split,
      compressed: format.compress,
      sinceLastMs: this.lastPublishedAt ? this.now() - this.lastPublishedAt : null,
      phoneOpen: this.phoneOpen(),
    });
    this.lastPublished = serialized;
    this.lastPublishedAt = this.now();
  }

  /**
   * How to write for the phone in front of this Mac: compressed ("z") and
   * with the recent list and the live turn's history apart ("split"), each
   * only when its presence says it reads them, and only on the Realtime
   * Database (Firestore's rules have no `recent`). Anything else, or an older
   * phone, gets the original format.
   */
  private format(): { compress: boolean; split: boolean } {
    const streaming = Boolean(this.deps.store.watch);
    return {
      compress: streaming && this.phoneCaps.includes("z"),
      split: streaming && this.phoneCaps.includes("split"),
    };
  }

  private sealForPhone(config: RemoteConfig, value: unknown): string {
    return seal(config.key, value, { compress: this.format().compress });
  }

  /** Increasing across restarts too: never below the clock. */
  private nextSeq(): number {
    this.seq = Math.max(this.seq + 1, this.now());
    return this.seq;
  }

  /** The phone's view in the split format: the snapshot and the recent document, each as published. */
  phoneViewParts() {
    const { recent, recentMore, workspaces, ...rest } = this.phoneView();
    return {
      snapshot: { ...rest, split: true as const },
      recent: { v: 1 as const, recent, recentMore, ...(workspaces ? { workspaces } : {}) },
    };
  }

  phoneView() {
    const snapshot = this.deps.snapshot();
    const { recent, more } = this.recentSessions(snapshot, this.phoneOpen() ? this.recentWanted : PHONE_RECENT_LIMIT);
    const titles = distinctTitles([...snapshot.active, ...recent]);
    const blocked = snapshot.active.filter((session) => session.state.startsWith("awaiting")).length;
    const working = snapshot.active.filter((session) => session.state === "working").length;
    return {
      v: 1,
      mac: this.macName(),
      generatedAt: new Date(this.now()).toISOString(),
      duck: { blockedCount: blocked, workingCount: working },
      // Read-only. Refreshing Claude's reading is a Mac action; commands are plain replies only.
      usage: phoneUsage(snapshot.codexUsage, this.deps.claudeLimits?.() ?? null),
      // The "Keep Mac awake" switch; absent when this Mac does not offer it (phones then hide it).
      ...this.phoneAwake(),
      // Hotspot failover: name, switch, whether the Mac is on it, the last switch. Never the password.
      ...(this.deps.hotspot ? { hotspot: this.deps.hotspot.state() } : {}),
      // Where a phone may start a chat; absent when this Mac can't (phones then hide the button).
      ...(this.deps.newChat ? { workspaces: this.phoneWorkspaces() } : {}),
      sessions: snapshot.active.map((session) => this.phoneSession(session, titles, MESSAGE_MAX_CHARS)),
      // Older phones ignore it; newer ones list it under Recent and can reply to any of them.
      recent: recent.map((session, index) =>
        this.phoneSession(
          session,
          titles,
          index < PHONE_RECENT_LIMIT ? RECENT_MESSAGE_MAX_CHARS : RECENT_MORE_MESSAGE_MAX_CHARS,
        ),
      ),
      // Whether "Show more" would find anything; older phones ignore it.
      recentMore: more,
    };
  }

  /** The awake session for the phone: on/off, and its end when it has one. Absent when this Mac can't. */
  private phoneAwake(): {
    keepAwake?: boolean;
    awakeUntil?: string;
    awakeLid?: string;
    awakeLidProblem?: string;
    awakeLidReady?: boolean;
    awakeSafety?: string;
    macPower?: { percent: number | null; onBattery: boolean | null; watts: number | null; lidClosed: boolean | null };
  } {
    const awake = this.deps.awake;
    if (!awake) {
      return {};
    }
    const state = awake.state();
    return {
      keepAwake: state !== null,
      ...(state?.until ? { awakeUntil: state.until } : {}),
      // "on" / "starting" / "failed" for a lid-closed session; absent otherwise.
      ...(state?.lid ? { awakeLid: state.lidStatus } : {}),
      ...(state?.lidProblem ? { awakeLidProblem: state.lidProblem } : {}),
      ...(awake.lidReady?.() ? { awakeLidReady: true } : {}),
      // A safety rule acting now: "Low Power Mode on · Battery at 38%".
      ...(state?.safety ? { awakeSafety: state.lowPower ? `Low Power Mode on · ${state.safety}` : state.safety } : {}),
      // Battery, draw and lid, for the phone's "Your Mac".
      ...(awake.power?.() ? { macPower: awake.power()! } : {}),
    };
  }

  /**
   * Conductor chats that are not active any more, newest first: not closed,
   * not in an archived workspace (`retired`), touched in the last week. Only
   * Conductor chats, because those are what a phone can reply to.
   */
  private recentSessions(snapshot: FleetSnapshot, limit: number): { recent: FleetSession[]; more: boolean } {
    const active = new Set(snapshot.active.map((session) => session.key));
    // The first page is the last week; asking for more reaches back a month.
    const since = this.now() - (limit > PHONE_RECENT_LIMIT ? PHONE_RECENT_MORE_AGE_MS : PHONE_RECENT_MAX_AGE_MS);
    const monthAgo = this.now() - PHONE_RECENT_MORE_AGE_MS;
    const candidates = snapshot.sessions
      .filter(
        (session) =>
          !active.has(session.key) &&
          !session.retired &&
          Boolean(session.conductorSessionId) &&
          Date.parse(session.lastActivityAt) >= monthAgo,
      )
      .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
    const inWindow = candidates.filter((session) => Date.parse(session.lastActivityAt) >= since);
    const recent = inWindow.slice(0, limit);
    return { recent, more: limit < PHONE_RECENT_MAX && candidates.length > recent.length };
  }

  private phoneSession(session: FleetSession, titles: Map<string, string | null>, maxChars: number) {
    const conductorSessionId = session.conductorSessionId;
    const title = titles.get(session.key);
    const message = conductorSessionId ? this.message(conductorSessionId, session.lastActivityAt) : null;
    const git = session.git ? describeGitState(session.git, { countCommits: false }) : null;
    const text =
      message?.text && message.text.length > maxChars ? `${message.text.slice(0, maxChars)}…` : (message?.text ?? null);
    return {
      key: session.key,
      conductorSessionId,
      label: title ? `${sessionLabel(session)} (${title})` : sessionLabel(session),
      // The phone's row headline (DESIGN.md §8.2); older phones ignore it.
      title: chatTitle(session),
      agent: session.agent,
      state: session.state,
      lastActivityAt: session.lastActivityAt,
      detail: session.detail,
      git: git && git !== "clean" ? git : null,
      contextPercent: session.contextPercent,
      turnId: conductorSessionId ? this.deps.replier.lastTurnId(conductorSessionId) : null,
      message: text,
      choices: message?.choices ?? null,
      activity: session.state === "working" ? this.activityFor(session) : null,
      // Only while it waits for an answer; older phones ignore it.
      ...(session.state === "awaiting_input" ? { question: this.questionFor(session) } : {}),
    };
  }

  /** Read once per change: the key moves with the session's activity. */
  private questionFor(session: FleetSession): PhoneQuestion | null {
    const read = this.deps.question;
    if (!read) {
      return null;
    }
    const key = `${session.key}|${session.lastActivityAt}`;
    if (this.questionCache.has(key)) {
      return this.questionCache.get(key) ?? null;
    }
    let value: PhoneQuestion | null = null;
    try {
      const found = read(session);
      // toolUseId lets the phone answer exactly this question (kind "answer"); a plan carries its text.
      value = found
        ? { toolUseId: found.toolUseId, questions: found.questions, ...(found.plan ? { plan: found.plan } : {}) }
        : null;
    } catch (error) {
      logger.debug("could not read a pending question", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (this.questionCache.size > 100) {
      this.questionCache.clear();
    }
    this.questionCache.set(key, value);
    return value;
  }

  private phoneWorkspaces(): PhoneWorkspace[] {
    try {
      return (this.deps.newChat?.workspaces() ?? []).slice(0, PHONE_WORKSPACE_LIMIT).map((workspace) => ({
        id: workspace.id,
        label: `${workspace.repoName} · ${workspace.branch}`,
        defaultAgent: workspace.defaultAgent,
      }));
    } catch (error) {
      logger.debug("could not list workspaces for the phone", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /** Read once per step: the key moves with the session's activity. */
  private activityFor(session: FleetSession): PhoneActivity | null {
    const read = this.deps.activity;
    if (!read) {
      return null;
    }
    const key = `${session.key}|${session.lastActivityAt}`;
    if (this.activityCache.has(key)) {
      return this.activityCache.get(key) ?? null;
    }
    let value: PhoneActivity | null = null;
    try {
      const activity = read(session);
      if (activity && activity.steps.length > 0) {
        value = {
          total: activity.total,
          steps: activity.steps.slice(-PHONE_ACTIVITY_STEPS).map((step) => ({
            kind: step.kind,
            text:
              step.text.length > PHONE_ACTIVITY_STEP_CHARS
                ? `${step.text.slice(0, PHONE_ACTIVITY_STEP_CHARS - 1).trimEnd()}…`
                : step.text,
          })),
        };
      }
    } catch (error) {
      logger.debug("could not read activity for the phone", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (this.activityCache.size > 200) {
      this.activityCache.clear();
    }
    this.activityCache.set(key, value);
    return value;
  }

  private message(sessionId: string, activity: string): { text: string | null; choices: ParsedChoices | null } {
    const key = `${sessionId}|${activity}`;
    const cached = this.messageCache.get(key);
    if (cached) {
      return cached;
    }
    const full = this.deps.replier.lastTurnText(sessionId);
    const text = full && full.length > MESSAGE_MAX_CHARS ? `${full.slice(0, MESSAGE_MAX_CHARS)}…` : full;
    const value = { text, choices: parseChoices(full) };
    if (this.messageCache.size > 200) {
      this.messageCache.clear();
    }
    this.messageCache.set(key, value);
    return value;
  }

  /* ---------- bookkeeping ---------- */

  private createChannel(): RemoteConfig {
    const { channelId, key } = generateChannel();
    this.config = { projectId: this.deps.projectId, channelId, key, devices: [] };
    this.save();
    return this.config;
  }

  private save(): void {
    if (!this.config) {
      return;
    }
    fs.mkdirSync(path.dirname(this.deps.configPath), { recursive: true });
    const temp = `${this.deps.configPath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.config, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.deps.configPath);
  }

  private log(device: string, outcome: RemoteActivity["outcome"], detail: string): void {
    this.activity.push({ at: new Date(this.now()).toISOString(), device, outcome, detail });
    if (this.activity.length > ACTIVITY_LIMIT) {
      this.activity.shift();
    }
    logger.info("remote command", { device, outcome, detail });
  }

  private macName(): string {
    return this.deps.macName ?? os.hostname().replace(/\.local$/, "");
  }
}

/** One plan window as the phone draws it: percent used (0-100) and when it resets. */
interface PhoneUsageWindow {
  usedPercent: number;
  resetsAt: string;
}

/** Both agents' readings in one shape, each with when it was observed. */
export interface PhoneUsage {
  claude: { fiveHour: PhoneUsageWindow | null; sevenDay: PhoneUsageWindow | null; observedAt: string } | null;
  codex: { fiveHour: PhoneUsageWindow | null; weekly: PhoneUsageWindow | null; observedAt: string } | null;
}

export function phoneUsage(codex: CodexUsage | null, claude: ClaudeLimits | null): PhoneUsage {
  const claudeWindow = (window: ClaudeLimits["fiveHour"]): PhoneUsageWindow | null =>
    window ? { usedPercent: Math.round(window.utilization * 1000) / 10, resetsAt: window.resetsAt } : null;
  const codexWindow = (window: CodexUsage["primary"]): PhoneUsageWindow | null =>
    window ? { usedPercent: Math.round(window.usedPercent * 10) / 10, resetsAt: window.resetsAt } : null;
  return {
    claude: claude
      ? {
          fiveHour: claudeWindow(claude.fiveHour),
          sevenDay: claudeWindow(claude.sevenDay),
          observedAt: claude.observedAt,
        }
      : null,
    codex: codex
      ? { fiveHour: codexWindow(codex.primary), weekly: codexWindow(codex.secondary), observedAt: codex.observedAt }
      : null,
  };
}

/** A workspace as the phone lists it for a new chat. */
export interface PhoneWorkspace {
  id: string;
  /** "repo · branch" */
  label: string;
  defaultAgent: NewChatAgent;
}

/** What the phone gets of a turn: no timestamps, fewer and shorter steps. */
interface PhoneActivity {
  total: number;
  steps: Array<{ kind: string; text: string }>;
}

function readConfig(configPath: string): RemoteConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as RemoteConfig;
    return parsed.channelId && parsed.key ? { ...parsed, devices: parsed.devices ?? [] } : null;
  } catch {
    return null;
  }
}

/**
 * What differs between two snapshots *as the phone would draw them*. Not
 * lastActivityAt: a working chat bumps that constantly, and the phone redraws
 * ages from its own clock.
 */
export function snapshotSignature(snapshot: FleetSnapshot): string {
  return JSON.stringify(
    snapshot.active.map((session) => [
      session.key,
      session.state,
      session.title,
      session.detail,
      session.conductorSessionId,
    ]),
  );
}

/** When each working chat last moved: its steps on the phone's row follow it. */
export function stepsSignature(snapshot: FleetSnapshot): string {
  return JSON.stringify(
    snapshot.active
      .filter((session) => session.state === "working")
      .map((session) => [session.key, session.lastActivityAt]),
  );
}
