import { applyRepair, backupAndJournal, planRepair, type RepairAction, type RepairRecord } from "./repair.js";
import { joinedAccess, type DirRecord } from "./directory.js";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import { realtimeDatabaseOrigin, relayBaseUrl } from "../cloud/location.js";
import { BlobRefused, type CloudStore, type WatchSource } from "../cloud/store.js";
import { newBlobId, openBlob, sealBlob } from "./blobs.js";
import { logger } from "../utils/logger.js";
import { flag } from "../squeak/flags.js";
import type { ChannelDoc } from "../cloud/store.js";
import {
  generateMemberKey,
  memberIdOf,
  openAt,
  openFromMember,
  randomId,
  randomKey,
  sealAt,
  sealToMember,
  SecretFile,
  signedText,
  signText,
  verifyText,
} from "./crypto.js";
import { can, capsOf, type Action, type Actor, type Context, type Caps } from "./permissions.js";
import { connectionOf, overallConnection, type Connection } from "./connection.js";
import { AnnouncedInvites, buildPeople, owedLines, type PeopleView } from "./pond-people.js";
import { InviteRefused, type InviteRecord, type InviteResult, type PondInvites } from "./invites-port.js";
import { RelayRefused, type AccountDevice, type AccountNames, type PondRelay, type TokenScope } from "./relay.js";
import type { RoomPort, RoomSignedDoc } from "./room-sync.js";
import {
  ARTIFACT_CHUNK_BYTES,
  ARTIFACT_FETCH_PER_HOUR,
  ARTIFACT_ID,
  ARTIFACT_RESULT_TTL_MS,
  COMMAND_KINDS,
  DIFF_RESULT_TTL_MS,
  MAX_ARTIFACT_BYTES,
  readArtifactChunk,
  readArtifactsResult,
  type ArtifactsResult,
  type SharedArtifact,
  DOC_ID,
  FlotillaError,
  START_PER_HOUR,
  readDiffResult,
  type DiffResult,
  HOLD_MS,
  DUCK_HISTORY_MS,
  KEEP_EVENTS,
  MAX_PARTICIPANTS,
  sortParticipants,
  MAX_COMMAND_LIFE_MS,
  MAX_SKEW_MS,
  POND_ID,
  readCommand,
  readHold,
  readDeviceGone,
  readDeviceRequest,
  readMember,
  readMeta,
  devicesOf,
  keysOfMember,
  memberOfDevice,
  MAX_DEVICES_PER_MEMBER,
  type MemberDevice,
  readMemberAct,
  type MemberAct,
  readThread,
  readThreadEvent,
  type CommandDoc,
  type Hold,
  type MemberDoc,
  type PondMeta,
  type PondThread,
  type ThreadParticipant,
  type PresenceDoc,
  type Ripple,
  type RippleKind,
  type Role,
  type ThreadEvent,
} from "./types.js";

/** A P-256 public point as standard base64 (x963, 65 bytes, starts 0x04), or null: what a device request's keys must be. */
function canonicalPoint(key: string): string | null {
  const raw = Buffer.from(key, "base64");
  if (raw.length !== 65 || raw[0] !== 0x04) return null;
  try {
    sealToMember(raw.toString("base64"), {});
  } catch {
    return null;
  }
  return raw.toString("base64");
}

/** What each command a member can send is, for `can`. There is no approve to map; `stop` is the Owner's alone (`can` refuses everyone else). */
const COMMAND_ACTION: Record<(typeof COMMAND_KINDS)[number], Action> = {
  message: "message",
  steer: "message",
  answer: "answer-question",
  diff: "request-diff",
  start: "start-thread",
  artifacts: "view-pond",
  artifact: "view-pond",
  stop: "stop",
};

/** Said when anyone but the Owner asks a Mac to stop a Duck. */
const ONLY_OWNER_STOPS = "Only the Owner can stop a duck.";

/** Said when a member's Mac is asked for code in a remote pond (changes, diffs). */
export const REMOTE_NO_CODE = "This is a remote pond: you talk to their agents, and code stays on their Mac.";

/** What a Mac keeps about one thread it starts: the session behind it never leaves this file. */
export interface LocalThread {
  sessionId: string;
  private: boolean;
  mode: "own" | "shared";
  title: string;
  agent: string;
  model: string;
  /** The chat's permission mode as last seen, so a state-only update keeps it on the thread document. */
  permissionMode?: string;
  /** The chat's workspace name and branch when it was shared; kept so every republish carries them. */
  workspace?: string;
  branch?: string;
  /** The starter and every member whose message ran here, with their latest time. Never read back from events. */
  participants?: ThreadParticipant[];
  /** The thread's last state, so a private thread (never in the cloud) still says what it is doing. */
  state?: PondThread["state"];
  /** What a waiting chat waits on, kept so a state-only update keeps it on the thread document. */
  waitingFor?: "approval" | "question";
  /** A thread a member asked this Mac to start: who, and the id their Mac made the request under. */
  requester?: { memberId: string; requestId: string };
  /** The "shared <title>" Ripple, so making the thread private can take it away again (a title must not linger). */
  rippleId?: string;
  /** The last seq handed out. */
  seq: number;
  /** [first, last] seq of each batch in the cloud, oldest first. */
  batches: Array<[number, number]>;
  /** When each batch's last event happened (ms), aligned with `batches`; older records have none. */
  batchAt?: number[];
}

export const VIEWERS_READ = "Viewers can read but not send.";
export const noMessageWithoutAsking = (starter: string): string =>
  `Only ${starter} can message this thread while it runs without asking.`;
const LOCAL_ONLY = "This pond is only on this Mac until you invite someone.";
const NO_CLOUD = "Set up a cloud store (Firebase or Catalyst) before inviting someone to a pond.";

/** A pond-scoped relay token a member holds (docs/ponds.md, "Scoped tokens"). */
interface HeldToken {
  value: string;
  /** Unix milliseconds. */
  expiresAt: number;
}

/** A pond's state as every surface says it (docs/ponds.md, "States"). `denied` is the stored spelling of `declined`. */
export type PondStatus = "local" | "pending" | "active" | "declined" | "expired" | "revoked" | "removed";
type StoredStatus = "pending" | "active" | "removed" | "denied" | "revoked" | "expired";
/** Statuses that end a membership: the row stays until the person presses Remove. */
const NEEDS_PROJECT = "A pond is made from a project. Choose a project; names are not ponds.";
const ONE_PER_PROJECT = "That project already has a pond.";
const TERMINAL: readonly StoredStatus[] = ["removed", "denied", "revoked", "expired"];

interface LocalPond {
  id: string;
  name: string;
  status: StoredStatus;
  /** The owner's name when this Mac has read it (the owner's member document), for the sentences about them. */
  ownerName?: string;
  /** A later device waiting to be let in: when its read token lapses, and when the request went out. */
  inviteExpiresAt?: number;
  requestedAt?: number;
  /** When a terminal status was reached. */
  endedAt?: number;
  /** The Owner's Mac: what happened lately in the pond, newest first (the Room says the same as lines). */
  recent?: Ripple[];
  /** The Owner's Mac: the highest cloud seq of a Member's queued ask (`rposts`) it has applied; the queue is read from there. */
  ingestedSeq?: number;
  /** The Owner's Mac: the same for the asks the service applies itself (leave, end a device, a Duck). */
  actsSeq?: number;
  /** A Member's Mac: start requests the Owner has answered (declined), by request id. */
  answered?: string[];
  /** The owner's first invite has been made: Ducks shared before it were set Private then; later ones are visible. */
  invited?: true;
  role: Role;
  ownerKey: string;
  location: unknown;
  /** Pond keys by version. The newest is `current`. */
  keys: Record<string, string>;
  current: number;
  /** The relay's id of this device's request to be let in. */
  requestId?: string;
  gitRemote?: string;
  /** The Squeak project this Mac made the pond from. Local only: never written to the cloud or an invite. */
  projectId?: string;
  /**
   * "joined": a published pond that follows no project on this Mac (someone else's, or one kept by the repair). Every
   * other owned record has a `projectId`; the directory keys a joined pond by its own id.
   */
  kind?: "joined";
  /**
   * A local pond: exists only on this Mac. No cloud document, no key published, until the first invite publishes it
   * (`publish`). Absent on every pond made before local ponds: those are published.
   */
  local?: boolean;
  /**
   * This Mac is a device of a member who joined elsewhere (docs/ponds.md, "Members are accounts"): there is only the
   * relay's device request, and `joinToken` is the device's read token until the key arrives.
   */
  joinToken?: string;
  deviceJoin?: true;
  /** The member id this Mac acts as in this pond when it is a later device of someone; absent = its own key's id. */
  memberId?: string;
  /** A member on a Catalyst relay: the pond-scoped token the owner sent sealed to this key. */
  token?: HeldToken;
  /** An owner on a Catalyst relay: who holds a token, and until when, so it is renewed before it lapses. */
  issued?: Record<string, { expiresAt: number; scope: TokenScope }>;
  /** A member was removed but the new pond key did not finish going out: done on the next retry or view. */
  rotationPending?: boolean;
  threads: Record<string, LocalThread>;
  /** Answers to `diff` commands this Mac wrote (a `tevents` document each), until they are deleted. */
  results?: Array<{ doc: string; until: number }>;
  /** Nonce -> its command's expiry, kept until then. */
  nonces: Record<string, number>;
  /** The Owner's Mac: Ducks Members asked for, waiting for the Owner's Approve or Decline (never in the cloud). */
  pendingStarts?: PendingStart[];
  /** A Member's Mac: Ducks this person asked for that the Owner has not answered yet. */
  asked?: AskedStart[];
}

/** A Member's request for a Duck, held on the Owner's Mac until the Owner decides. `requestId` is the Member's own. */
export interface PendingStart {
  requestId: string;
  memberId: string;
  /** The Member's name when they asked; the view reads the current one. */
  name: string;
  text: string;
  agent: "claude" | "codex";
  model: string;
  title?: string;
  at: number;
}

/** What a Member's Mac remembers of its own request, to say "Waiting for Sibhi". */
export interface AskedStart {
  requestId: string;
  title: string;
  at: number;
}

/** One Duck waiting for the Owner, as a surface draws it. `mine` is true on the Member's own Mac. */
export interface PendingStartView {
  requestId: string;
  memberId: string;
  name: string;
  title: string;
  /** The first message (the Owner sees what they are approving); absent on a Member's Mac. */
  text?: string;
  at: number;
  mine: boolean;
}

interface Identity {
  name: string;
  nest: string | null;
  client?: "mac" | "web";
  privateKey: string;
  publicKey: string;
}

/** Who is online in a pond, from the live connections (cloud-layer.md, "Live notices"); `lastSeenAt` is ms. */
export interface LivePresence {
  memberId: string;
  online: boolean;
  lastSeenAt?: number;
}

export interface FlotillaOptions {
  /** Who is online in a pond now. Absent until the daemon wires the live client: then only this Mac shows as online. */
  presenceOf?: (pondId: string) => Promise<LivePresence[]>;
  /** null when no cloud is set up: ponds are then local only and no network call is ever made. */
  store?: CloudStore | null;
  /** Key files live in `<supportDir>/flotilla/`, mode 0600. */
  supportDir: string;
  /** Ignored: a name is the Squeak account's (name, else email), never a label from the Mac. Kept so callers still compile. */
  displayName?: string;
  /** The Squeak account this Mac is signed in to: names come from it (see `AccountPort`). */
  account?: AccountPort | null;
  /** null for a web-style member with no machine of its own (tests; the browser app does this in its own code). */
  nest: string | null;
  /** How long list() and view() wait on the relay before they answer with the last good read (default 6 s). */
  budgetMs?: number;
  /** Where this Mac's store is: a Firebase database address, or a Catalyst relay's URL and key. */
  location?: unknown;
  /**
   * Opens a store: with `pondToken` for a member (they never hold the relay key), without it for the location this
   * Mac owns.
   */
  storeFor?: (location: unknown, pondToken?: string | null) => CloudStore;
  /** Catalyst only: how an owner's Mac asks the relay for pond-scoped tokens. Absent with Firebase. */
  relay?: PondRelay | null;
  /** Catalyst only: the relay's invite record (one per address, the only source of an invite's state). Absent with Firebase. */
  invites?: PondInvites | null;
  now?: () => number;
  /**
   * The device's live stream to the cloud (`LiveClient.state`, docs/cloud-layer.md "Live notices"): "live", "reconnecting", or
   * null when `squeak-live` is not configured (the old notice path; the state then follows what the cloud answered).
   */
  liveState?: () => "live" | "reconnecting" | null;
  /** A stream notice waits this long for company before it starts a read (default 1 s); 0 in tests. */
  wakeDebounceMs?: number;
  /** At least this long between two reads of one pond that a notice started (default 3 s). */
  wakeMinIntervalMs?: number;
  /** 0..1, for the back-off's jitter (default Math.random). */
  random?: () => number;
}

/**
 * The Squeak account behind this Mac (Catalyst sign-in). A name comes only from here (docs/ponds.md, "Names"): the person
 * cannot type one.
 */
export interface AccountPort {
  /** The signed-in account's display name, or null when signed out. */
  name(): string | null;
  email(): string | null;
  /** The display names the relay holds for these account ids (an owner's Mac, to keep member names fresh). */
  names(ids: string[]): Promise<AccountNames>;
}

/** What the sync did since the last line in the log (one line per 5 minutes; `SyncStats`). */
export interface SyncStats {
  /** Reads of a pond (refresh + pass) that a notice, a poll or a start began. */
  refreshes: number;
  /** Calls to the relay (get, set, list, delete) made for ponds. */
  relayCalls: number;
  /** Data Streams notices that reached a pond's watch. */
  streamEvents: number;
  /** Notices skipped as the echo of this Mac's own write. */
  skippedOwnEcho: number;
  /** Notices folded into a read already waiting. */
  coalesced: number;
  /** Safety polls. */
  polls: number;
  /** Times a 429 put a pond into back-off. */
  backoffs: number;
  /** Presence writes made / left out because nothing changed. */
  presenceWrites: number;
  presenceSkipped: number;
}

export interface PondSummary {
  id: string;
  name: string;
  role: Role;
  memberCount: number;
  threadCount: number;
  needsYou: number;
  gitRemote?: string;
  /** Local only: the project on this Mac the pond was made from, so the app finds it without matching names. */
  projectId?: string;
  tint: string;
  status: PondStatus;
  /** One plain sentence for the current state, made here so no surface words it (docs/ponds.md, "States"). */
  statusLine: string;
  ownerName?: string;
  /** True until the first invite publishes it: only this Mac can see it. */
  local?: boolean;
  /** A new device of an account already in the Pond, waiting for the Owner's Mac to seal the key: "Connecting", no button. */
  connecting?: true;
  /** True when the relay could not be reached and this is the last known state (docs/ponds.md, "Offline"). */
  offline?: true;
  /** Unix ms of the last good read this came from; present only with `offline`. */
  asOf?: number;
  offlineLine?: string;
  /**
   * The one connection state every surface draws (connection.ts): Live, Reconnecting… or the Owner's Mac offline. Absent
   * for a Pond that is only on this Mac or not active, and from an older host.
   */
  connection?: Connection;
}

export interface MemberView {
  id: string;
  name: string;
  /** The account's email, shown under the name and on hover. Absent from an older host or a member with none on file. */
  email?: string;
  role: Role;
  nest: string | null;
  /** The member's machine's name (null for a browser). */
  nestName: string | null;
  client: "mac" | "web";
  /** What this member may do now, derived from the role; kept so an older client's shape decodes. */
  caps?: Caps;
  /** Presence heartbeat younger than 45 s. */
  online: boolean;
  /** Not sent any more (no device appears in a pond); kept so an older client's shape still type-checks. */
  devices?: number;
  /** Not sent any more; see `devices`. */
  ownDevices?: Array<{
    id: string;
    client: "mac" | "web" | "ios";
    nestName: string | null;
    addedAt: number;
    current: boolean;
  }>;
  /** Unix ms of the last heartbeat, when there is one. */
  lastSeenAt?: number;
  you: boolean;
}

/** An owner's Mac re-reads its members' account names at most this often per pond (one relay call per 50 members). */
/** Most addresses in one send (the relay refuses more). */
const MAX_EMAILS_PER_SEND = 10;
const NAME_REFRESH_MS = 30 * 60_000;
/** A Ripple a member writes to ask the owner's Mac to end one of their own devices: `removed my device <id>`. */
const DEVICE_REMOVE_PREFIX = "removed my device ";
/** Device Ripples (the request above, and older "added/removed a device" ones) are plumbing: no pond shows them. */
const isDeviceRipple = (text: string): boolean =>
  text.startsWith(DEVICE_REMOVE_PREFIX) || /(^|\s)(added|removed) a device$/.test(text);
/** A device request the relay wrote is honoured this long (the device's read token lives as long). */
const DEVICE_REQUEST_MAX_MS = 24 * 60 * 60_000;
/** An owner's Mac adds at most this many devices a minute to one pond: a stolen account token cannot spray keys. */
const DEVICE_ADDS_PER_MINUTE = 5;
/** A Mac asks the relay for its account's ponds at most this often (and at sign-in). */
const ACCOUNT_SYNC_MS = 5 * 60_000;
/** After this device leaves a pond, the account sync leaves it alone this long. */
const LEFT_SKIP_MS = 24 * 60 * 60_000;
/** What a member without a verified Squeak account is called. */
export const SIGNED_OUT_MEMBER = "Signed-out member";

export interface PondView {
  pond: PondSummary;
  /** Whether this Mac has a cloud store an invite could publish to. */
  cloud?: boolean;
  members: MemberView[];
  threads: PondThread[];
  ripples: Array<Ripple & { actorName?: string }>;
  /** Ducks waiting for the Owner's approval: all of them on the Owner's Mac, a Member's own on theirs. */
  starts?: PendingStartView[];
  presence: PresenceDoc[];
  holds: Hold[];
  me: { id: string; name: string; role: Role; nest: string | null; caps?: Caps };
  /** The relay could not be reached: this is the last known pond, read-only. */
  offline?: true;
  /** Unix ms of the last good read; present only with `offline`. */
  asOf?: number;
  offlineLine?: string;
  connection?: Connection;
}

/** What the last good read of a pond left on disk: metadata only, never a thread's events or a message body. */
interface PondSnapshot {
  asOf: number;
  counts: { members: number; threads: number; needsYou: number };
  view?: PondView;
}

export const OFFLINE_WRITE = "The pond can't be reached right now, so it is read-only until the connection returns.";
/** What a read says when the relay did not answer: never `fetch failed` or a status code. */
/** A leave the cloud did not confirm stays a Member's: the Mac shows this and Try again (issue #130). */
export const LEAVE_NOT_CONFIRMED =
  "Squeak couldn't confirm leaving with the cloud. You're still in the Pond. Try again.";
export const CLOUD_DOWN = "Can't reach Squeak's cloud. Try again in a moment.";
const ACCESS_ENDED = "You no longer have access to this pond.";
const WAITING_FOR_KEY = "Waiting for the pond owner's Mac to send you the new pond key.";
/** A pond list or view answers within this long, from the last good read when the relay is slower. */
const DEFAULT_BUDGET_MS = 6_000;
/** The host's own heartbeat keeps a running Mac online in every pond it is in. */

export interface CommandOutcome {
  id: string;
  ok: boolean;
  kind?: string;
  reason?: string;
}

/** What a verified command hands the host side. */
export interface VerifiedCommand {
  cmd: CommandDoc;
  from: MemberDoc;
  /** Null for `start`, `artifacts` and `artifact`: they name no thread. */
  thread: LocalThread | null;
}

const TINTS = ["#E8A33D", "#4C8DF6", "#3FB68B", "#E5604D", "#8E6CEF", "#D9588F", "#3AA7C9", "#7DA33B"];
const RIPPLE_KEEP = 100;
/** A scoped token lasts as long as the relay allows; the owner's Mac renews it when under 3 days remain. */
const TOKEN_TTL_SEC = 30 * 24 * 3600;
const TOKEN_RENEW_MS = 3 * 24 * 3600_000;
/** The host's own heartbeat: a running Mac is online in every pond it is in. A write only when this old (or changed). */
/** Our own write's notice comes back within seconds; one that long after is someone else's. */
const ECHO_WINDOW_MS = 5_000;
const BACKOFF_FIRST_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;
/** The safety poll: only a net under the stream. */
const POLL_ALONE_MS = 5 * 60_000;
const POLL_SHARED_MS = 2 * 60_000;
const STATS_MS = 5 * 60_000;
/** A summary row reused this long (a list asks again every few seconds). */
const SUMMARY_TTL_MS = 20_000;

/**
 * The coordination layer over a `CloudStore` (docs/ponds.md). It trusts keys, not the server: every document is
 * sealed with the pond key, signed by the member who wrote it, and checked against the members the owner signed.
 * It knows nothing of the session host; `bridge.ts` joins the two.
 */
/** Said when a member's own-Mac thread is asked for while the stashed mode is off (docs/ponds.md). */
export const OWN_THREADS_OFF =
  "Running a thread on your own Mac in someone else's pond is switched off. Use Runs on the owner's Mac.";
/** A Member may have this many requests waiting for the Owner's approval at once; a request lapses after a day. */
const PENDING_STARTS_PER_MEMBER = 10;
const PENDING_START_LIFE_MS = 24 * 60 * 60_000;

export class FlotillaService extends EventEmitter {
  private readonly now: () => number;
  private readonly identityFile: SecretFile<{ identity: Identity | null }>;
  private readonly pondsFile: SecretFile<{
    ponds: Record<string, LocalPond>;
    leftUntil?: Record<string, number>;
    /** When the start-clean migration ran on this Mac (once; docs/cloud-layer.md, "Clean start"). */
    cleanStartedAt?: number;
  }>;
  private readonly watches = new Map<string, () => void>();
  private readonly running = new Set<string>();
  private readonly dirty = new Set<string>();
  private readonly stores = new Map<string, CloudStore>();
  private readonly nameChecks = new Map<string, number>();
  private readonly indexChecks = new Map<string, number>();
  private readonly deviceAdds = new Map<string, number[]>();
  /** Ponds whose device request the relay refused or could not take: not asked again until then. */
  private readonly deviceSkips = new Map<string, number>();
  private accountSyncAt = 0;
  private accountSyncing = false;
  private readonly commandChains = new Map<string, Promise<void>>();
  private readonly snapshotFile: SecretFile<{ ponds: Record<string, PondSnapshot> }>;
  private readonly budgetMs: number;
  private statsTimer: NodeJS.Timeout | null = null;
  private stats: SyncStats = FlotillaService.emptyStats();
  /** When this Mac's own writes that echo (presence, thread events) were made, newest last. */
  private readonly echoes = new Map<string, number[]>();
  private readonly wakeTimers = new Map<string, { timer: NodeJS.Timeout; quiet: boolean }>();
  private readonly lastRunAt = new Map<string, number>();
  private readonly backoffs = new Map<string, { ms: number; until: number }>();
  private readonly summaryCache = new Map<string, { at: number; row: PondSummary }>();
  /** Whether the Owner's Mac was online at the last presence read of each Pond (connection.ts); not stored. */
  private readonly ownerSeen = new Map<string, boolean>();
  private readonly lastPresence = new Map<string, { viewing?: string; typing?: string; at: number }>();
  private readonly pendingWake = new Map<string, number>();

  constructor(private readonly options: FlotillaOptions) {
    super();
    this.now = options.now ?? Date.now;
    this.budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
    const dir = path.join(options.supportDir, "flotilla");
    this.identityFile = new SecretFile(path.join(dir, "identity.json"), () => ({ identity: null }));
    this.pondsFile = new SecretFile(path.join(dir, "ponds.json"), () => ({ ponds: {} }));
    // Same at-rest protection as the keys beside it (0600, in the 0700 folder).
    this.snapshotFile = new SecretFile(path.join(dir, "snapshot.json"), () => ({ ponds: {} }));
    this.on("changed", (pondId: string) => this.summaryCache.delete(pondId));
  }

  private static emptyStats(): SyncStats {
    return {
      refreshes: 0,
      relayCalls: 0,
      streamEvents: 0,
      skippedOwnEcho: 0,
      coalesced: 0,
      polls: 0,
      backoffs: 0,
      presenceWrites: 0,
      presenceSkipped: 0,
    };
  }

  /** The counters since the last call (and resets them): what the five-minute log line prints. */
  takeStats(): SyncStats {
    const out = this.stats;
    this.stats = FlotillaService.emptyStats();
    return out;
  }

  /** Back-off for a pond the relay rate-limited, if any (ms left). */
  backoffLeft(pondId: string): number {
    const b = this.backoffs.get(pondId);
    return b ? Math.max(0, b.until - this.now()) : 0;
  }

  /** Remembers a good read. Written only when it changed, so a busy page does not rewrite the file. */
  private remember(pondId: string, snap: Omit<PondSnapshot, "asOf">): void {
    const before = this.snapshotFile.data.ponds[pondId];
    const next: PondSnapshot = { ...snap, asOf: this.now() };
    if (before && JSON.stringify({ ...before, asOf: 0 }) === JSON.stringify({ ...next, asOf: 0 })) return;
    this.snapshotFile.data.ponds[pondId] = next;
    this.snapshotFile.save();
  }

  private forgetSnapshot(pondId: string): void {
    if (!(pondId in this.snapshotFile.data.ponds)) return;
    delete this.snapshotFile.data.ponds[pondId];
    this.snapshotFile.save();
  }

  /** A relay failure, not an answer: a refusal the relay gave (403, 404) is never served from the cache. */
  private static isOutage(error: unknown): boolean {
    if (error instanceof FlotillaError) return error.status >= 500;
    // The stores say the status in the message; 401/403/404 is the relay refusing, and a revoked member must see that.
    return !/\b40[134]\b/.test(error instanceof Error ? error.message : "");
  }

  /** The relay said this member's token or key is no longer good (401/403), as opposed to not answering. */
  private static isAccessEnded(error: unknown): boolean {
    return error instanceof FlotillaError && error.extra.access === "ended";
  }

  /**
   * The store's raw failures (`catalyst list failed: 401`, `fetch failed`, a timeout) as fixed sentences: a refusal
   * becomes an access error the service can act on, anything else is the cloud being out of reach. Nothing raw leaves.
   */
  private static relayError(error: unknown): FlotillaError {
    if (error instanceof FlotillaError) return error;
    // A refused picture or file already carries its own plain sentence (too big, the Pond is full, not in the cloud yet).
    if (error instanceof BlobRefused)
      return new FlotillaError(error.message, error.status === 413 ? 413 : 503, { blob: "refused" });
    const message = error instanceof Error ? error.message : "";
    if (/\b(401|403)\b/.test(message)) return new FlotillaError(ACCESS_ENDED, 403, { access: "ended" });
    if (/\b404\b/.test(message)) return new FlotillaError("That pond isn't there any more.", 404, { access: "gone" });
    if (/\b429\b/.test(message)) return new FlotillaError(CLOUD_DOWN, 503, { rateLimited: true });
    return new FlotillaError(CLOUD_DOWN, 503);
  }

  /** A store whose failures are sentences and whose successes say the relay is reachable. */
  private guard(pondId: string, store: CloudStore): CloudStore {
    const run = async <T>(call: () => Promise<T>): Promise<T> => {
      this.stats.relayCalls += 1;
      try {
        const out = await call();
        return out;
      } catch (error) {
        this.summaryCache.delete(pondId);
        throw FlotillaService.relayError(error);
      }
    };
    const raw = (store as CloudStore & { getRaw?: (path: string) => Promise<unknown | null> }).getRaw;
    const rawList = (store as CloudStore & { listRaw?: (c: string) => Promise<Array<{ id: string; doc: unknown }>> })
      .listRaw;
    return {
      get: (path) => run(() => store.get(path)),
      set: (path, doc, options) => run(() => store.set(path, doc, options)),
      list: (collection) => run(() => store.list(collection)),
      delete: (path) => run(() => store.delete(path)),
      watch: (path, onChange, options) => store.watch(path, onChange, options),
      ...(typeof raw === "function" ? { getRaw: (path: string) => raw.call(store, path) } : {}),
      ...(typeof rawList === "function" ? { listRaw: (c: string) => rawList.call(store, c) } : {}),
      ...(store.putBlob
        ? { putBlob: (...a: Parameters<NonNullable<CloudStore["putBlob"]>>) => run(() => store.putBlob!(...a)) }
        : {}),
      ...(store.getBlob
        ? { getBlob: (...a: Parameters<NonNullable<CloudStore["getBlob"]>>) => run(() => store.getBlob!(...a)) }
        : {}),
    } as CloudStore;
  }

  /** Answers with `work`'s result, or with `fallback()` once `ms` have passed (a failure of `work` is passed on); `work` keeps running to refresh the cache. */
  private within<T>(work: Promise<T>, ms: number, fallback: () => T | Promise<T>): Promise<T> {
    const fall = async (): Promise<T> => fallback();
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        fall().then(resolve, reject);
      }, ms);
      timer.unref?.();
      work.then(
        (value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  // identity and local state

  get identity(): Identity & { id: string } {
    const file = this.identityFile.data;
    if (!file.identity) {
      file.identity = {
        name: this.accountLabel(),
        nest: this.options.nest,
        ...(this.options.nest === null ? { client: "web" as const } : {}),
        ...generateMemberKey(),
      };
      this.identityFile.save();
    }
    // The name is the account's, always (name, else email); whatever the identity file saved is never read.
    return { ...file.identity, name: this.accountLabel(), id: memberIdOf(file.identity.publicKey) };
  }

  /** The one name a person has: their Squeak account's name, else its email, else (signed out) a neutral label. */
  private accountLabel(): string {
    const account = this.options.account;
    return (account?.name()?.trim() || account?.email()?.trim() || "Squeak member").slice(0, 100);
  }

  /** The signed-in account's email, shown under the name; null when signed out. */
  private accountEmail(): string | null {
    return this.options.account?.email()?.trim() || null;
  }

  /** `{ email }` for this account's own member document, or nothing when signed out. */
  private emailField(): { email?: string } {
    const email = this.accountEmail();
    return email ? { email: email.slice(0, 200) } : {};
  }

  /**
   * The Mac's computer name replaces what an older install saved from the hostname: only a value still equal to that
   * old default changes, and the owner's own member document in every published pond is rewritten (only an owner signs
   * members documents). A name is never part of this: it is the account's. Returns whether anything changed.
   */
  async updateOwnProfile(next: { nest: string | null }, was: { nest: string | null }): Promise<boolean> {
    const file = this.identityFile.data;
    if (!file.identity) return false;
    let changed = false;
    if (next.nest && file.identity.nest !== null && file.identity.nest === was.nest && next.nest !== was.nest) {
      file.identity.nest = next.nest;
      changed = true;
    }
    if (!changed) return false;
    this.identityFile.save();
    const me = this.identity;
    for (const pond of Object.values(this.pondsFile.data.ponds)) {
      if (pond.role !== "owner" || pond.local || pond.status !== "active") continue;
      try {
        const mine = (await this.members(pond)).get(me.id);
        if (mine) await this.writeMember(pond, { ...mine, name: me.name, ...this.emailField(), nest: me.nest });
      } catch {
        // Offline: the identity is already saved; the member document is not rewritten until a later run. Never blocks start.
      }
    }
    return true;
  }

  /** The public part, for tests and the Mac's "this is you". */
  get me(): { id: string; name: string; nest: string | null; publicKey: string } {
    const { id, name, nest, publicKey } = this.identity;
    return { id, name, nest, publicKey };
  }

  private pond(id: string): LocalPond {
    const pond = this.pondsFile.data.ponds[id];
    if (!pond) throw new FlotillaError("no such pond", 404);
    return pond;
  }

  /** The member id this Mac acts as in a pond: its own key's id, or the member it joined as a later device of. */
  private selfId(pond: LocalPond): string {
    return pond.memberId ?? this.identity.id;
  }

  private meIn(pond: LocalPond): Identity & { id: string } {
    return { ...this.identity, id: this.selfId(pond) };
  }

  private activePond(id: string): LocalPond {
    const pond = this.pond(id);
    if (pond.status === "pending") throw new FlotillaError("that join is waiting for an owner to approve it", 409);
    if (pond.status !== "active") throw new FlotillaError(this.statusLineOf(pond, 0), 403);
    return pond;
  }

  private save(): void {
    this.pondsFile.save();
  }

  private storeOf(pond: LocalPond): CloudStore {
    if (pond.local) throw new FlotillaError(LOCAL_ONLY, 409);
    if (pond.location && this.options.storeFor) {
      const credential = pond.token?.value ?? pond.joinToken ?? null;
      const key = JSON.stringify([pond.location, credential]);
      let store = this.stores.get(key);
      if (!store) {
        try {
          store = this.options.storeFor(pond.location, credential);
        } catch {
          throw new FlotillaError(CLOUD_DOWN, 503);
        }
        this.stores.set(key, store);
      }
      return this.guard(pond.id, store);
    }
    if (!this.options.store) throw new FlotillaError(NO_CLOUD, 503);
    return this.guard(pond.id, this.options.store);
  }

  localThread(pondId: string, threadId: string): LocalThread | null {
    return this.pondsFile.data.ponds[pondId]?.threads[threadId] ?? null;
  }

  /** Every thread this Mac started, in every pond, for the bridge to resume after a restart. */
  ownThreads(): Array<{ pondId: string; threadId: string; thread: LocalThread }> {
    return Object.values(this.pondsFile.data.ponds)
      .filter((p) => p.status === "active" && !p.local)
      .flatMap((p) => Object.entries(p.threads).map(([threadId, thread]) => ({ pondId: p.id, threadId, thread })));
  }

  pondIds(): string[] {
    return Object.values(this.pondsFile.data.ponds)
      .filter((p) => (p.status === "active" || p.status === "pending") && !p.local)
      .map((p) => p.id);
  }

  /**
   * A project whose pond is shared must not be removed from Squeak: the pond would stay in the cloud with its people and
   * invites, and adding the folder back would make a second pond. The owner deletes the pond first (or hands nothing over:
   * a pond cannot change hands yet). A local pond has no one in it and goes with the project.
   */
  projectRemovalBlock(projectId: string): string | null {
    const pond = Object.values(this.pondsFile.data.ponds).find(
      (p) => p.projectId === projectId && p.status === "active" && !p.local,
    );
    if (!pond) return null;
    const others = Math.max(0, (this.snapshotFile.data.ponds[pond.id]?.counts.members ?? 1) - 1);
    const who = others > 0 ? `It is shared with ${others} ${others === 1 ? "person" : "people"}. ` : "It is shared. ";
    return `${who}Delete the pond ${pond.name} first (Pond settings), then remove the project.`;
  }

  /**
   * The start-up repair (`repair.ts`): idempotent, journalled, `ponds.json` backed up first, a published record never
   * deleted. Returns what it did (nothing the second time). `dryRun` only plans.
   */
  repairPonds(
    projects: Array<{ id: string; name: string; remote?: string | null }>,
    options: { dryRun?: boolean } = {},
  ): RepairAction[] {
    const ponds = this.pondsFile.data.ponds;
    const records: RepairRecord[] = Object.values(ponds).map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      status: p.status,
      projectId: p.projectId ?? null,
      ...(p.local ? { local: true } : {}),
      ...(p.kind ? { kind: p.kind } : {}),
      ...(p.gitRemote ? { gitRemote: p.gitRemote } : {}),
      threads: p.threads,
      memberCount: this.snapshotFile.data.ponds[p.id]?.counts.members ?? 0,
    }));
    const plan = planRepair(records, projects).filter((a) => a.op !== "keep");
    if (options.dryRun || plan.length === 0) return plan;
    const dir = path.join(this.options.supportDir, "flotilla");
    backupAndJournal(path.join(dir, "ponds.json"), dir, plan, this.now());
    const done = applyRepair(ponds, plan);
    for (const a of done) if (a.op === "delete") this.forgetSnapshot(a.pondId);
    this.save();
    return done;
  }

  /** The records the directory is built from; a shared pond's members come from its page. */
  async directoryRecords(): Promise<DirRecord[]> {
    const summaries = await this.list();
    // Members of shared ponds are cloud reads: all at once, never one after another (each may take the whole budget).
    const memberLists = await Promise.all(
      summaries.map(async (summary): Promise<DirRecord["members"]> => {
        if (summary.local || summary.memberCount <= 1) return undefined;
        try {
          return (await this.view(summary.id)).members.map((m) => ({ name: m.name, online: m.online }));
        } catch {
          // Members unknown: the pond is still shared.
          return undefined;
        }
      }),
    );
    return summaries.map((summary, i) => {
      const members = memberLists[i];
      const stored = this.pondsFile.data.ponds[summary.id];
      return {
        id: summary.id,
        name: summary.name,
        role: summary.role,
        status: stored?.status ?? summary.status,
        projectId: summary.projectId ?? null,
        ...(summary.local ? { local: true } : {}),
        ...(stored?.kind ? { kind: stored.kind } : {}),
        ...(stored?.gitRemote ? { gitRemote: stored.gitRemote } : {}),
        memberCount: summary.memberCount,
        ...(members ? { members } : {}),
      };
    });
  }

  projectRemoved(projectId: string): void {
    for (const pond of Object.values(this.pondsFile.data.ponds)) {
      if (pond.projectId === projectId && pond.local) this.forgetPond(pond.id);
    }
  }

  projectIdOf(pondId: string): string | null {
    return this.pond(pondId).projectId ?? null;
  }

  /** What this Mac's person may do in the pond: the same answer the directory gives (`joinedAccess`). */
  accessOf(pondId: string): "owner" | "remote" | "git" {
    const pond = this.pond(pondId);
    return pond.role === "owner" ? "owner" : joinedAccess(flag("pondOwnThreads"), pond.gitRemote);
  }

  gitRemoteOf(pondId: string): string | null {
    return this.pond(pondId).gitRemote ?? null;
  }

  // permissions (permissions.ts: the one place a role, a grant or an authority is decided)

  private actorOf(pond: LocalPond): Actor {
    return { kind: "human", memberId: this.selfId(pond), role: pond.role };
  }

  /** Throws the refusal `can` gives (or `message` when the caller keeps an older sentence); 404 for "no such thread". */
  private allow(pond: LocalPond, action: Action, ctx: Context, message?: string): void {
    const verdict = can(this.actorOf(pond), action, ctx);
    if (verdict.ok) return;
    throw new FlotillaError(message ?? verdict.reason, verdict.reason === "no such thread" ? 404 : 403);
  }

  /**
   * `allow` with the role the member list says now, not the one this Mac cached at its last refresh: the Owner's change
   * (a Member made a Viewer, or back) holds on the very next thing someone does. Returns the member list it read.
   */
  private async allowLive(
    pond: LocalPond,
    action: Action,
    ctx: Context,
    message?: string,
  ): Promise<Map<string, MemberDoc>> {
    const members = await this.members(pond);
    const role = members.get(this.selfId(pond))?.role ?? pond.role;
    const verdict = can({ kind: "human", memberId: this.selfId(pond), role }, action, ctx);
    if (!verdict.ok)
      throw new FlotillaError(message ?? verdict.reason, verdict.reason === "no such thread" ? 404 : 403);
    return members;
  }

  // sealed, signed documents

  private docPath = (pondId: string, kind: string, doc: string): string => `channels/${pondId}/${kind}/${doc}`;

  private async put(pond: LocalPond, kind: string, docId: string, value: unknown): Promise<void> {
    const docPath = this.docPath(pond.id, kind, docId);
    const key = pond.keys[String(pond.current)];
    if (!key) throw new FlotillaError("This Mac has no key for that pond yet.", 403);
    const box = `${pond.current}.${sealAt(key, docPath, value)}`;
    const id = this.identity;
    // No pre-check here: a write that cannot go says so itself (below), and a pre-check built on an earlier failed read
    // refused writes that would have worked once the relay was back.
    try {
      await this.storeOf(pond).set(docPath, {
        box,
        sig: signText(id.privateKey, signedText(docPath, box)),
        // A later device of a member signs as that member (its key is in the member document's `devices`).
        device: this.selfId(pond),
        at: this.now(),
      });
      // The relay tells every watcher of the channel, this Mac included; that notice is not news.
      if (kind === "tevents") this.expectEcho(pond.id);
    } catch (error) {
      if (FlotillaService.isOutage(error)) throw new FlotillaError(OFFLINE_WRITE, 503);
      throw error;
    }
  }

  private expectEcho(pondId: string): void {
    const list = this.echoes.get(pondId) ?? [];
    list.push(this.now());
    this.echoes.set(pondId, list.slice(-20));
  }

  /** True (and used up) when a notice is the echo of a write this Mac made in the last few seconds. */
  private takeEcho(pondId: string): boolean {
    const now = this.now();
    const list = (this.echoes.get(pondId) ?? []).filter((t) => now - t < ECHO_WINDOW_MS);
    const mine = list.shift() !== undefined;
    if (list.length > 0) this.echoes.set(pondId, list);
    else this.echoes.delete(pondId);
    return mine;
  }

  private openDoc(pond: LocalPond, docPath: string, doc: ChannelDoc): unknown {
    const dot = doc.box.indexOf(".");
    const key = pond.keys[doc.box.slice(0, dot)];
    if (dot < 1 || !key) throw new FlotillaError("a document is sealed with a key this Mac does not have", 403);
    return openAt(key, docPath, doc.box.slice(dot + 1));
  }

  /** The value if the box opens and the signature is by `expectedKey` (or, as `signer`, by the id it names). */
  private readSigned(
    pond: LocalPond,
    kind: string,
    docId: string,
    doc: ChannelDoc,
    keyOf: (device: string) => string | string[] | null,
  ): { value: unknown; device: string } | null {
    try {
      const docPath = this.docPath(pond.id, kind, docId);
      const sig = doc.sig;
      if (!sig || !doc.device) return null;
      const keys = keyOf(doc.device);
      const text = signedText(docPath, doc.box);
      // A member's signature is any of its devices' (docs/ponds.md, "Members are accounts"); `device` stays the member id.
      if (!keys || ![keys].flat().some((k) => verifyText(k, text, sig))) return null;
      return { value: this.openDoc(pond, docPath, doc), device: doc.device };
    } catch {
      return null;
    }
  }

  /** The members this key can read, and how many documents there were at all (none = the pond is gone). */
  private async membersRead(pond: LocalPond): Promise<{ members: Map<string, MemberDoc>; raw: number }> {
    const found = new Map<string, MemberDoc>();
    const ownerOnly = (device: string): string | null => (device === memberIdOf(pond.ownerKey) ? pond.ownerKey : null);
    const rows = await this.storeOf(pond).list(`channels/${pond.id}/members`);
    for (const { id, doc } of rows) {
      const read = this.readSigned(pond, "members", id, doc, ownerOnly);
      const member = read ? readMember(read.value) : null;
      if (member && member.id === id && memberIdOf(member.publicKey) === id) found.set(id, member);
    }
    return { members: found, raw: rows.length };
  }

  private async members(pond: LocalPond): Promise<Map<string, MemberDoc>> {
    return (await this.membersRead(pond)).members;
  }

  // ponds

  /** True when this Mac has a cloud store a pond can be published to. */
  hasCloud(): boolean {
    return !!this.options.store && !!this.options.location;
  }

  private newPond(input: { name: string; gitRemote?: string; projectId?: string }, local: boolean): LocalPond {
    const name = input.name.trim();
    if (!name || name.length > 200) throw new FlotillaError("A pond needs a name.");
    // A pond is a project's sharing state: nothing makes one from a name, and a project has at most one.
    if (!input.projectId) throw new FlotillaError(NEEDS_PROJECT, 400);
    if (this.pondOfProject({ projectId: input.projectId })) throw new FlotillaError(ONE_PER_PROJECT, 409);
    const id = randomId(16);
    const me = this.identity;
    const pond: LocalPond = {
      id,
      name,
      status: "active",
      role: "owner",
      ownerKey: me.publicKey,
      location: local ? null : (this.options.location ?? null),
      keys: { "1": randomKey() },
      current: 1,
      ...(local ? { local: true } : {}),
      ...(input.gitRemote ? { gitRemote: input.gitRemote } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      threads: {},
      nonces: {},
    };
    this.pondsFile.data.ponds[id] = pond;
    this.save();
    return pond;
  }

  /** The pond a project already has, local or published. By project id only: a name never finds or makes a pond. */
  private pondOfProject(input: { projectId?: string }): LocalPond | null {
    if (!input.projectId) return null;
    const all = Object.values(this.pondsFile.data.ponds).filter((p) => p.status === "active" || p.status === "pending");
    return all.find((p) => p.projectId === input.projectId) ?? null;
  }

  /** Whether a project already has a pond here, local or published (by project id). */
  hasPondForProject(input: { projectId?: string }): boolean {
    return this.pondOfProject(input) !== null;
  }

  /**
   * Every project is a pond from the moment it exists: this makes the project's local pond (nothing leaves the Mac)
   * or returns the one it already has, so a project tied to a published pond never gets a second. Takes a project id
   * only (a name alone is refused). Synchronous, so two calls cannot both create.
   */
  ensureLocalPond(input: { name: string; gitRemote?: string; projectId?: string }): PondSummary {
    if (!input.projectId) throw new FlotillaError(NEEDS_PROJECT, 400);
    const found = this.pondOfProject(input);
    if (found) return this.summary(found, 1, 0, 0);
    return this.summary(this.newPond(input, true), 1, 0, 0);
  }

  private readonly publishing = new Map<string, Promise<void>>();

  /**
   * Publishes a local pond: its meta, its owner and a first Ripple go to the cloud. One run per pond (a double click
   * shares it); a failure halfway leaves it local with the same id and key, so a retry finishes it and no second pond
   * is ever made. No cloud: a plain sentence and nothing changed.
   */
  publish(pondId: string): Promise<void> {
    const pond = this.pond(pondId);
    if (!pond.local) return Promise.resolve();
    const running = this.publishing.get(pondId);
    if (running) return running;
    if (!this.hasCloud()) return Promise.reject(new FlotillaError(NO_CLOUD, 503));
    const run = (async () => {
      const me = this.identity;
      const target = { ...pond, local: false, location: this.options.location ?? null };
      const meta: PondMeta = {
        id: pond.id,
        name: pond.name,
        owner: me.id,
        ownerKey: me.publicKey,
        created: this.now(),
        ...(pond.gitRemote ? { gitRemote: pond.gitRemote } : {}),
      };
      try {
        await this.put(target, "pond", "meta", meta);
        await this.writeMember(target, {
          id: me.id,
          name: me.name,
          ...this.emailField(),
          publicKey: me.publicKey,
          role: "owner",
          nest: me.nest,
          addedAt: this.now(),
        });
      } catch {
        throw new FlotillaError("Squeak could not reach the cloud to make the invite; try again.", 503);
      }
      pond.location = target.location;
      delete pond.local;
      this.save();
      this.watch(pond.id);
      // Published already; the ripple is only the pond's first line of history, so a miss is logged, not fatal.
      await this.ripple(pond.id, "made the pond", undefined, "created").catch((error) =>
        logger.warn("pond published but its first ripple failed", { pond: pond.id, error: String(error) }),
      );
    })().finally(() => this.publishing.delete(pondId));
    this.publishing.set(pondId, run);
    return run;
  }

  async createPond(input: { name: string; gitRemote?: string; projectId?: string }): Promise<PondSummary> {
    const existing = input.projectId ? this.pondOfProject({ projectId: input.projectId }) : null;
    if (existing?.local) {
      await this.publish(existing.id);
      return this.summary(existing, 1, 0, 0);
    }
    const pond = this.newPond(input, false);
    const { id, name } = pond;
    const me = this.identity;
    const meta: PondMeta = {
      id,
      name,
      owner: me.id,
      ownerKey: me.publicKey,
      created: this.now(),
      ...(input.gitRemote ? { gitRemote: input.gitRemote } : {}),
    };
    await this.put(pond, "pond", "meta", meta);
    await this.writeMember(pond, {
      id: me.id,
      name: me.name,
      ...this.emailField(),
      publicKey: me.publicKey,
      role: "owner",
      nest: me.nest,
      addedAt: this.now(),
    });
    await this.ripple(id, "made the pond", undefined, "created");
    return this.summary(pond, 1, 0, 0);
  }

  private async writeMember(pond: LocalPond, member: MemberDoc): Promise<void> {
    await this.put(pond, "members", member.id, member);
  }

  /** The name this Mac goes by in one pond: what was typed at joining, else its own. */
  private nameIn(): string {
    return this.accountLabel();
  }

  private ownerLabel(pond: LocalPond): string {
    return pond.ownerName || "The owner";
  }

  /** The one sentence for a pond's state. Surfaces draw it and decide nothing. */
  private statusLineOf(pond: LocalPond, members: number): string {
    const owner = this.ownerLabel(pond);
    switch (pond.status) {
      case "pending":
        // Another device of an account that is already in: it is let in by the Owner's Mac itself, never by a click.
        return `Connecting: waiting for ${pond.ownerName || "the Owner"}’s Mac`;
      case "denied":
        return `${owner} declined your request.`;
      case "expired":
        return `This invite expired before ${owner} answered.`;
      case "revoked":
        return `${owner} withdrew this invite.`;
      case "removed":
        return `You were removed from ${pond.name}.`;
      case "active":
        break;
    }
    if (pond.local) return "Only on this Mac. Invite someone to share it.";
    if (pond.role === "owner") {
      const others = Math.max(0, members - 1);
      return others === 0
        ? "Shared, and nobody has joined yet."
        : `Shared with ${others} ${others === 1 ? "person" : "people"}.`;
    }
    return `You're ${pond.role === "viewer" ? "a viewer" : "a member"} of ${pond.name}.`;
  }

  /** "Can't reach Squeak's cloud. Showing what was here at 10:42." */
  private offlineLineOf(asOf: number): string {
    const d = new Date(asOf);
    const at = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return `Can't reach Squeak's cloud. Showing what was here at ${at}.`;
  }

  private summary(pond: LocalPond, members: number, threads: number, needsYou: number): PondSummary {
    const hash = [...pond.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    const status: PondStatus =
      pond.status === "denied" ? "declined" : pond.status === "active" && pond.local ? "local" : pond.status;
    return {
      id: pond.id,
      name: pond.name,
      role: pond.role,
      memberCount: members,
      threadCount: threads,
      needsYou,
      ...(pond.gitRemote ? { gitRemote: pond.gitRemote } : {}),
      ...(pond.projectId ? { projectId: pond.projectId } : {}),
      tint: TINTS[hash % TINTS.length]!,
      status,
      statusLine: this.statusLineOf(pond, members),
      ...(pond.ownerName ? { ownerName: pond.ownerName } : {}),
      ...(pond.status === "pending" && pond.deviceJoin ? { connecting: true as const } : {}),
      ...(pond.local ? { local: true } : {}),
    };
  }

  /** What needs this person: a question anyone but a viewer may answer, or an approval on their own thread. */
  private needsCount(pond: LocalPond, threads: PondThread[]): number {
    const me = this.selfId(pond);
    return threads.filter((t) => {
      if (t.state !== "waiting") return false;
      if (t.starter === me) return true;
      return pond.role !== "viewer" && t.waitingFor === "question";
    }).length;
  }

  private staleSummary(pond: LocalPond): PondSummary {
    const snap = this.snapshotFile.data.ponds[pond.id];
    if (!snap) return this.summary(pond, 0, 0, 0);
    return {
      ...this.summary(pond, snap.counts.members, snap.counts.threads, snap.counts.needsYou),
      offline: true,
      asOf: snap.asOf,
      offlineLine: this.offlineLineOf(snap.asOf),
    };
  }

  /** One pond's row. Never rejects: a relay that does not answer is the last good read, flagged offline. */
  private async summaryOf(pond: LocalPond): Promise<PondSummary> {
    if (pond.local) return this.summary(pond, 1, 0, 0);
    if (pond.status !== "active") {
      // A join still waiting is checked in the background (an answer, a lapse, a withdrawal); the row never waits on it.
      if (pond.status === "pending") this.refreshSoon(pond.id);
      return this.summary(pond, 0, 0, 0);
    }
    try {
      const members = await this.members(pond);
      if (members.size === 0 || (pond.role !== "owner" && !memberOfDevice(members, this.identity.id))) {
        throw new FlotillaError(ACCESS_ENDED, 403, { access: "ended" });
      }
      const threads = await this.threadsOf(pond, members);
      const needsYou = this.needsCount(pond, threads);
      const view = this.snapshotFile.data.ponds[pond.id]?.view;
      this.remember(pond.id, {
        counts: { members: members.size, threads: threads.length, needsYou },
        ...(view ? { view } : {}),
      });
      this.rememberOwnerName(pond, members);
      return this.summary(pond, members.size, threads.length, needsYou);
    } catch (error) {
      if (FlotillaService.isAccessEnded(error)) {
        const verdict = await this.onAccessEnded(pond);
        if (verdict === "removed") return this.summary(pond, 0, 0, 0);
        const snap = this.snapshotFile.data.ponds[pond.id];
        if (verdict === "ok") return this.staleSummary(pond);
        // Waiting for a new key: not offline, not removed. The last counts stand.
        return snap
          ? this.summary(pond, snap.counts.members, snap.counts.threads, snap.counts.needsYou)
          : this.summary(pond, 0, 0, 0);
      }
      return this.staleSummary(pond);
    }
  }

  async list(): Promise<PondSummary[]> {
    this.syncAccountPondsSoon();
    const ponds = Object.values(this.pondsFile.data.ponds).filter(
      // A declined, lapsed, withdrawn or removed pond stays listed until its person presses Remove, so the app can say so.
      (p) => p.status === "active" || p.status === "pending" || TERMINAL.includes(p.status),
    );
    const live = new Set(ponds.map((p) => p.id));
    const out = await Promise.all(
      ponds.map((pond) => {
        // A list is asked for often (the app, the phone); a pond's row is read again only when it may have changed.
        const cached = this.summaryCache.get(pond.id);
        if (cached && pond.status === "active" && this.now() - cached.at < SUMMARY_TTL_MS) return cached.row;
        return this.within(this.summaryOf(pond), this.budgetMs, () => this.staleSummary(pond)).then((row) => {
          if (pond.status === "active" && !pond.local && !row.offline)
            this.summaryCache.set(pond.id, { at: this.now(), row });
          return row;
        });
      }),
    );
    // A pond that is gone (forgotten, left) is gone from the cache too.
    for (const id of Object.keys(this.snapshotFile.data.ponds)) if (!live.has(id)) this.forgetSnapshot(id);
    return out.map((row) => this.withConnection(row));
  }

  /** The one connection state of a row (connection.ts): from the live stream, the last read and the Owner's presence. */
  private withConnection(row: PondSummary): PondSummary {
    const rest = { ...row };
    delete rest.connection;
    if (row.status !== "active" || row.local) return rest;
    const connection = connectionOf({
      stream: this.options.liveState?.() ?? null,
      reachable: row.offline !== true,
      owner: row.role === "owner",
      ...(this.ownerSeen.has(row.id) ? { ownerOnline: this.ownerSeen.get(row.id)! } : {}),
      ...(row.ownerName ? { ownerName: row.ownerName } : {}),
    });
    return { ...rest, connection };
  }

  /** The whole Mac in one word, for the list's header (the Ponds that have a connection of their own). */
  overallConnection(rows: PondSummary[]): Connection {
    return overallConnection(
      rows.map((r) => ({ owner: r.role === "owner", ...(r.connection ? { connection: r.connection } : {}) })),
    );
  }

  /** The live stream changed state: every row's word is stale, so the next list and view say the new one. */
  connectionChanged(): void {
    this.summaryCache.clear();
    for (const id of this.pondIds()) this.emit("connection", id);
  }

  /** Runs a refresh in the background at most every 15 s per pond: what a list or view wants answered, not waited on. */
  private refreshSoon(pondId: string): void {
    const last = this.pendingWake.get(pondId) ?? 0;
    if (this.now() - last < 15_000) return;
    this.pendingWake.set(pondId, this.now());
    // Quiet: a list that asks again must not, by this read alone, tell the app to read again (that was a loop).
    this.wake(pondId, { quiet: true });
  }

  private rememberOwnerName(pond: LocalPond, members: Map<string, MemberDoc>): void {
    const owner = members.get(memberIdOf(pond.ownerKey));
    if (owner && owner.name && pond.ownerName !== owner.name) {
      pond.ownerName = owner.name;
      this.save();
    }
  }

  /**
   * A read of an active pond was refused (401/403), or came back with nobody in it. A rotated pond key looks the same to a
   * member who has not picked it up yet, so: pick it up and read again before saying anything. Only then is it final:
   * `removed` when the relay still refuses, or the members are readable and this key is not among them.
   */
  private async onAccessEnded(pond: LocalPond): Promise<"ok" | "removed" | "waiting" | "offline"> {
    if (pond.role === "owner" || pond.status !== "active") return "ok";
    const me = this.meIn(pond);
    try {
      await this.syncKeys(pond);
    } catch (error) {
      if (FlotillaService.isAccessEnded(error)) return this.markEnded(pond, "removed");
      return "offline";
    }
    try {
      const read = await this.membersRead(pond);
      const mine = memberOfDevice(read.members, this.identity.id);
      void me;
      if (mine) {
        if (pond.role !== mine.role) {
          pond.role = mine.role;
          this.save();
        }
        return "ok";
      }
      if (read.members.size > 0) return this.markEnded(pond, "removed");
      if (read.raw === 0) return this.markEnded(pond, "removed");
      return "waiting";
    } catch (error) {
      if (FlotillaService.isAccessEnded(error)) return this.markEnded(pond, "removed");
      return "offline";
    }
  }

  /** Records a terminal status once: the row stays, the watch stops, what was remembered goes. */
  private markEnded(pond: LocalPond, status: "removed" | "denied" | "revoked" | "expired"): "removed" {
    if (pond.status === status) return "removed";
    pond.status = status;
    pond.endedAt = this.now();
    delete pond.token;
    delete pond.joinToken;
    this.watches.get(pond.id)?.();
    this.watches.delete(pond.id);
    this.save();
    this.forgetSnapshot(pond.id);
    this.emit("changed", pond.id);
    this.emit("ended", pond.id, status);
    return "removed";
  }

  // invites and joining

  /**
   * The owner's first invite: a local pond is published, and every Duck already shared in it becomes Private, so
   * sharing never reveals old chats by surprise (making one visible again is one click: `setThreadPrivate`). Ducks
   * shared after this are visible. A pond that already has other members is past its first invite.
   */
  async prepareFirstInvite(pondId: string): Promise<void> {
    const pond = this.activePond(pondId);
    this.allow(pond, "invite", {}, "Only an owner can invite.");
    if (pond.local) await this.publish(pond.id);
    if (pond.invited) return;
    const members = await this.members(pond).catch(() => null);
    if (!members) return; // unreadable now: ask again at the next invite rather than guess
    if (members.size <= 1) {
      for (const [threadId, local] of Object.entries(pond.threads)) {
        if (!local.private) await this.setThreadPrivate(pond.id, threadId, true).catch(() => undefined);
      }
    }
    pond.invited = true;
    this.save();
  }

  // ---- people and invitations (#126): the relay's invite record is the only source of truth ----

  private announcedInvites?: AnnouncedInvites;
  private told(): AnnouncedInvites {
    return (this.announcedInvites ??= new AnnouncedInvites(path.join(this.options.supportDir, "flotilla")));
  }
  /** The relay's invite port, or the sentence that says what is missing. */
  private invitePort(): PondInvites {
    const port = this.options.invites;
    if (!port) throw new FlotillaError("Invites need Squeak's cloud. Sign in to Squeak, then try again.", 503);
    return port;
  }
  /** A refusal from the relay keeps its plain sentence and status. */
  private async viaRelay<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof InviteRefused) throw new FlotillaError(error.message, error.status);
      throw error;
    }
  }

  /**
   * Invites by email, one record each at the relay. A local Pond is published first (quietly, with its earlier Ducks Private).
   * An address the relay refuses (already in, already invited, Pond full) comes back with its sentence and the rest go out.
   */
  async inviteEmails(pondId: string, emails: string[], role: Role): Promise<{ results: InviteResult[] }> {
    const pond = this.activePond(pondId);
    this.allow(pond, "invite", {}, "Only an owner can invite.");
    if (role !== "member" && role !== "viewer") throw new FlotillaError("An invite is for a member or a viewer.");
    if (emails.length < 1 || emails.length > MAX_EMAILS_PER_SEND)
      throw new FlotillaError(`Invite between 1 and ${MAX_EMAILS_PER_SEND} people at a time.`);
    const port = this.invitePort();
    await this.prepareFirstInvite(pondId);
    const results = await this.viaRelay(() => port.create(pond.id, { emails, role, pondName: pond.name }));
    this.emit("changed", pond.id);
    return { results };
  }

  /**
   * Who is in a Pond and every invite as the relay holds it. A Pond nobody has been invited to has no invites to read. Reading
   * the invites also puts the Room line a join or a decline is owed (once each).
   */
  async people(pondId: string): Promise<PeopleView> {
    const pond = this.activePond(pondId);
    const view = await this.view(pondId);
    let invites: InviteRecord[] = [];
    if (pond.role === "owner" && !pond.local && this.options.invites) {
      invites = await this.viaRelay(() => this.options.invites!.list(pond.id));
      await this.tellInvites(pond, invites);
    }
    return buildPeople(view.members, invites);
  }

  async resendInvite(pondId: string, inviteId: string): Promise<{ invite: InviteRecord; mailed: boolean }> {
    const pond = this.activePond(pondId);
    this.allow(pond, "invite", {}, "Only an owner can invite.");
    return this.viaRelay(() => this.invitePort().resend(pond.id, inviteId));
  }

  async withdrawInvite(pondId: string, inviteId: string): Promise<{ invite: InviteRecord }> {
    const pond = this.activePond(pondId);
    this.allow(pond, "invite", {}, "Only an owner can invite.");
    const invite = await this.viaRelay(() => this.invitePort().withdraw(pond.id, inviteId));
    this.emit("changed", pond.id);
    return { invite };
  }

  async inviteAgain(pondId: string, inviteId: string, role?: Role): Promise<{ invite: InviteRecord; mailed: boolean }> {
    const pond = this.activePond(pondId);
    this.allow(pond, "invite", {}, "Only an owner can invite.");
    if (role !== undefined && role !== "member" && role !== "viewer")
      throw new FlotillaError("An invite is for a member or a viewer.");
    const made = await this.viaRelay(() => this.invitePort().again(pond.id, inviteId, role));
    this.emit("changed", pond.id);
    return made;
  }

  /** The Room says each join and each decline once (never a withdrawal or an expiry), in the words of the person it is about. */
  private async tellInvites(pond: LocalPond, invites: InviteRecord[]): Promise<void> {
    const told = this.told();
    for (const line of owedLines(invites, told.of(pond.id))) {
      await this.ripple(pond.id, line.text, line.who, line.kind);
      told.mark(pond.id, line.inviteId, line.state);
    }
  }

  /** The Owner's own pass over the record (the relay wakes it on every change), so the Room lines come without a sheet open. */
  private async syncInvites(pond: LocalPond): Promise<void> {
    if (pond.role !== "owner" || pond.local || !this.options.invites) return;
    await this.tellInvites(pond, await this.options.invites.list(pond.id));
  }

  /** A pond-scoped token for a member of a Catalyst pond, or undefined where there is no relay (Firebase). */
  private async tokenFor(pond: LocalPond, member: MemberDoc, device?: MemberDevice): Promise<HeldToken | undefined> {
    const relay = this.options.relay;
    if (!relay || (pond.location as { provider?: string } | null)?.provider !== "catalyst") return undefined;
    // A token belongs to one device (so one device can be ended); a member's other devices keep theirs.
    const holder = device?.id ?? member.id;
    const nest = device ? (device.nest ?? null) : member.nest;
    const client = device ? device.client : member.client;
    const scope: TokenScope = nest !== null && client !== "web" && client !== "ios" ? "member" : "guest";
    let issued;
    try {
      issued = await relay.issue(pond.id, holder, scope, TOKEN_TTL_SEC);
    } catch {
      throw new FlotillaError("The relay would not give that member access; try again.", 503);
    }
    (pond.issued ??= {})[holder] = { expiresAt: issued.expiresAt, scope };
    this.save();
    return { value: issued.token, expiresAt: issued.expiresAt };
  }

  /** The pond key, sealed to every device of a member (device one by its member id, the others by their own). */
  private async sendKeyTo(pond: LocalPond, member: MemberDoc): Promise<void> {
    for (const device of devicesOf(member)) await this.sendKeyToDevice(pond, member, device);
  }

  private async sendKeyToDevice(pond: LocalPond, member: MemberDoc, device: MemberDevice): Promise<void> {
    const docPath = this.docPath(pond.id, "keys", device.id);
    const primary = device.id === member.id;
    const token = await this.tokenFor(pond, member, primary ? undefined : device);
    // Every version the Pond has had, not only the newest: a new member or device reads the history that came before it.
    const box = sealToMember(device.boxKey, {
      version: pond.current,
      key: pond.keys[String(pond.current)],
      versions: pond.keys,
      ...(token ? { token } : {}),
    });
    const id = this.identity;
    await this.storeOf(pond).set(docPath, {
      box,
      sig: signText(id.privateKey, signedText(docPath, box)),
      device: id.id,
      at: this.now(),
    });
  }

  private async sendRemoval(pond: LocalPond, member: MemberDoc, only?: MemberDevice): Promise<void> {
    for (const device of only ? [only] : devicesOf(member)) {
      const docPath = this.docPath(pond.id, "keys", device.id);
      const box = sealToMember(device.boxKey, { removed: true });
      const id = this.identity;
      await this.storeOf(pond).set(docPath, {
        box,
        sig: signText(id.privateKey, signedText(docPath, box)),
        device: id.id,
        at: this.now(),
      });
    }
  }

  /** Before a member's token lapses, the owner's Mac issues a new one and writes it into their keys document. */
  private async renewTokens(pond: LocalPond): Promise<void> {
    const due = Object.entries(pond.issued ?? {}).filter(([, t]) => t.expiresAt - this.now() < TOKEN_RENEW_MS);
    if (due.length === 0) return;
    const members = await this.members(pond);
    for (const [holder] of due) {
      const member = memberOfDevice(members, holder);
      const device = member ? devicesOf(member).find((d) => d.id === holder) : undefined;
      if (member && device && holder !== this.identity.id) await this.sendKeyToDevice(pond, member, device);
      else delete pond.issued![holder];
    }
    this.save();
  }

  /** Removes a member and rotates the pond key: a new key goes only to those who remain. */
  async removeMember(pondId: string, memberId: string): Promise<void> {
    await this.removeAndRotate(pondId, memberId, (gone) => `removed ${gone.name}`);
  }

  /**
   * One device of a member, by the owner (a lost phone or Mac). The device id must name one of the member's devices, so a
   * stale or guessed id removes nobody. A member's last device is the member: that is `removeMember`. Otherwise the device's
   * token ends, it gets a "removed" note, the member document drops it, and the pond key rotates so it opens nothing new.
   */
  async removeDevice(pondId: string, memberId: string, deviceKeyId: string): Promise<void> {
    const pond = this.activePond(pondId);
    this.allow(pond, "remove-member", {}, "Only an owner can remove a member.");
    const member = (await this.members(pond)).get(memberId);
    const device = member ? devicesOf(member).find((d) => d.id === deviceKeyId) : undefined;
    if (!member || !device) throw new FlotillaError("No such device.", 404);
    if (devicesOf(member).length === 1) {
      await this.removeAndRotate(pondId, memberId, (gone) => `removed ${gone.name}'s Mac`);
      return;
    }
    await this.removeOneDevice(pondId, memberId, deviceKeyId);
  }

  private async removeOneDevice(pondId: string, memberId: string, deviceId: string): Promise<void> {
    const key = `${pondId}/${memberId}/${deviceId}`;
    const running = this.removing.get(key);
    if (running) return running;
    const run = this.removeOneDeviceOnce(pondId, memberId, deviceId).finally(() => this.removing.delete(key));
    this.removing.set(key, run);
    return run;
  }

  private async removeOneDeviceOnce(pondId: string, memberId: string, deviceId: string): Promise<void> {
    const pond = this.activePond(pondId);
    this.allow(pond, "remove-member", {}, "Only an owner can remove a member.");
    const members = await this.members(pond);
    const member = members.get(memberId);
    const device = member ? devicesOf(member).find((d) => d.id === deviceId) : undefined;
    if (!member || !device) throw new FlotillaError("No such device.", 404);
    await this.revokeToken(pond, device.id, "Squeak couldn't end that device's access. Try again.");
    await this.sendRemoval(pond, member, device).catch(() => undefined);
    await this.dropDeviceRequest(pond, device.id);
    const left: MemberDoc =
      device.id === member.id
        ? { ...member, primaryRetired: true }
        : { ...member, devices: (member.devices ?? []).filter((d) => d.id !== device.id) };
    if (left.devices?.length === 0) delete left.devices;
    await this.writeMember(pond, left);
    members.set(left.id, left);
    pond.rotationPending = true;
    this.save();
    await this.rotate(pond, members);
    delete pond.rotationPending;
    this.save();
  }

  /** A member removes one of their own devices (any of them, this one included): the owner's Mac does it when it reads this. */
  async removeOwnDevice(pondId: string, deviceId: string): Promise<void> {
    const pond = this.activePond(pondId);
    if (pond.role === "owner") throw new FlotillaError("An owner has one Mac here: delete the pond instead.", 409);
    const members = await this.members(pond);
    const me = memberOfDevice(members, this.identity.id);
    if (!me || !devicesOf(me).some((d) => d.id === deviceId)) throw new FlotillaError("No such device.", 404);
    if (devicesOf(me).length === 1)
      throw new FlotillaError("That is your only device here: leave the pond instead.", 409);
    await this.queueForOwner(pondId, { removeDevice: deviceId });
    if (deviceId === this.identity.id) this.forgetPond(pondId);
  }

  // Members are accounts (docs/ponds.md): the owner's side

  /** Tells the relay which accounts are members of this pond (its per-account index); best effort, repeated by `reconcileAccountIndex`. */
  private async indexAccounts(pond: LocalPond, add: string[], remove: string[]): Promise<void> {
    const relay = this.options.relay;
    if (!relay?.indexAccounts || (pond.location as { provider?: string } | null)?.provider !== "catalyst") return;
    const own = pond.role === "owner" ? await this.ownAccountId() : null;
    const roles: Record<string, "owner" | "member" | "viewer"> = {};
    if (add.length > 0) {
      for (const m of (await this.members(pond)).values()) {
        if (m.accountId && add.includes(m.accountId)) roles[m.accountId] = m.role;
      }
      if (own && add.includes(own)) roles[own] = "owner";
    }
    for (let i = 0; i < Math.max(add.length, remove.length, 1); i += 50) {
      const chunk = add.slice(i, i + 50);
      await relay.indexAccounts(pond.id, {
        ownerKey: pond.ownerKey,
        name: pond.name,
        ownerName: this.accountLabel(),
        ...(own ? { ownerUserId: own } : {}),
        roles: Object.fromEntries(chunk.flatMap((id) => (roles[id] ? [[id, roles[id]!]] : []))),
        add: chunk,
        remove: remove.slice(i, i + 50),
      });
    }
  }

  /** Every 30 minutes (and on the first pass after start): the index says exactly the accounts that are members now. */
  private async reconcileAccountIndex(pond: LocalPond): Promise<void> {
    if (pond.local || !this.options.relay?.indexAccounts) return;
    const at = this.now();
    if (at - (this.indexChecks.get(pond.id) ?? 0) < NAME_REFRESH_MS) return;
    this.indexChecks.set(pond.id, at);
    const members = await this.members(pond);
    const ids = [
      ...new Set([...members.values()].filter((m) => m.role !== "owner" && m.accountId).map((m) => m.accountId!)),
    ];
    // The Owner's own account is listed too, so their other devices (the browser) can ask to be added.
    const own = pond.role === "owner" ? await this.ownAccountId() : null;
    if (own && !ids.includes(own)) ids.push(own);
    if (ids.length > 0) await this.indexAccounts(pond, ids, []);
  }

  /** This Mac's own account id, as the relay attests it (`names().self`); cached for ten minutes. Null when signed out. */
  private async ownAccountId(): Promise<string | null> {
    const at = this.now();
    if (this.ownAccountCache && at - this.ownAccountCache.at < 10 * 60_000) return this.ownAccountCache.id;
    try {
      const id = (await this.options.account?.names([]))?.self?.userId ?? null;
      this.ownAccountCache = { id, at };
      return id;
    } catch {
      return this.ownAccountCache?.id ?? null;
    }
  }
  private ownAccountCache: { id: string | null; at: number } | null = null;

  /**
   * An owner's Mac adds a device the relay says belongs to a member's account. The relay wrote the request (no client
   * token can write that kind), so its `userId` is the verified account; it is added only when a member document of this
   * pond carries that same `accountId`, as the relay's own record is checked. The pond key reaches the
   * device sealed to its own key before the member document lists it. A member with no `accountId` cannot attach devices.
   */
  private async adoptDeviceRequests(pond: LocalPond): Promise<void> {
    const store = this.storeOf(pond) as CloudStore & {
      listRaw?: (collection: string) => Promise<Array<{ id: string; doc: unknown }>>;
    };
    if ((pond.location as { provider?: string } | null)?.provider !== "catalyst" || typeof store.listRaw !== "function")
      return;
    const rows = await store.listRaw(`channels/${pond.id}/devreqs`);
    if (rows.length === 0) return;
    const members = await this.members(pond);
    const byAccount = new Map<string, MemberDoc>();
    for (const m of members.values()) if (m.accountId && m.role !== "owner") byAccount.set(m.accountId, m);
    // The Owner's own devices (their browser, another Mac) are adopted too, by the same rule: the relay says which account
    // asked, and that account is this Mac's own (relay-attested). The signing key stays on this one Mac.
    const ownerMember = pond.role === "owner" ? members.get(this.identity.id) : undefined;
    const ownAccount = ownerMember ? await this.ownAccountId() : null;
    if (ownerMember && ownAccount) byAccount.set(ownAccount, ownerMember);
    const now = this.now();
    const recent = (this.deviceAdds.get(pond.id) ?? []).filter((t) => now - t < 60_000);
    this.deviceAdds.set(pond.id, recent);
    for (const row of rows) {
      const gone = readDeviceGone(row.doc);
      if (gone && gone.deviceId === row.id) {
        await this.dropAccountDevice(pond, members, gone.deviceId);
        await this.dropDeviceRequest(pond, row.id);
        continue;
      }
      const req = readDeviceRequest(row.doc);
      if (!req || req.reqId !== row.id) {
        await this.dropDeviceRequest(pond, row.id);
        continue;
      }
      const publicKey = canonicalPoint(req.publicKey);
      const boxKey = canonicalPoint(req.boxKey);
      const member = byAccount.get(req.userId);
      if (
        !publicKey ||
        !boxKey ||
        !member ||
        memberIdOf(publicKey) !== req.reqId ||
        now - req.at > DEVICE_REQUEST_MAX_MS
      ) {
        await this.dropDeviceRequest(pond, row.id);
        continue;
      }
      const have = devicesOf(member).find((d) => d.id === req.reqId);
      if (have) {
        // Asked again (it lost its state): the key is sent again, nothing else changes.
        await this.sendKeyToDevice(pond, member, have).catch(() => undefined);
        await this.dropDeviceRequest(pond, row.id);
        continue;
      }
      if (devicesOf(member).length >= MAX_DEVICES_PER_MEMBER) {
        await this.dropDeviceRequest(pond, row.id);
        continue;
      }
      if (recent.length >= DEVICE_ADDS_PER_MINUTE) break;
      const device: MemberDevice = {
        id: req.reqId,
        publicKey,
        boxKey,
        client: req.client,
        nest: req.nest,
        addedAt: now,
      };
      const next: MemberDoc = { ...member, devices: [...(member.devices ?? []), device] };
      try {
        await this.sendKeyToDevice(pond, next, device);
        await this.writeMember(pond, next);
      } catch (error) {
        logger.warn("could not add a member's device", { pond: pond.id, error: String(error) });
        continue;
      }
      recent.push(now);
      members.set(next.id, next);
      byAccount.set(req.userId, next);
      await this.dropDeviceRequest(pond, row.id);
      this.emit("changed", pond.id);
    }
  }

  /**
   * The account removed a device (Settings > Your devices): the relay already refuses its tokens and left a note here. The
   * Owner's Mac drops the device from its member, seals it a removal and rotates the key, so it can read nothing new. A
   * rotation that did not finish is finished by the next pass. Nothing is said in the Pond.
   */
  private async dropAccountDevice(pond: LocalPond, members: Map<string, MemberDoc>, deviceId: string): Promise<void> {
    const member = memberOfDevice(members, deviceId);
    const device = member ? devicesOf(member).find((d) => d.id === deviceId) : undefined;
    // The Owner's own signing Mac is never dropped by a note about it: the Pond lives there. Only a device they added.
    if (member && device && !(member.role === "owner" && device.id === member.id)) {
      await this.revokeToken(pond, device.id, "Squeak couldn't end that device's access. Try again.");
      await this.sendRemoval(pond, member, device).catch(() => undefined);
      const left: MemberDoc =
        device.id === member.id
          ? { ...member, primaryRetired: true }
          : { ...member, devices: (member.devices ?? []).filter((d) => d.id !== device.id) };
      if (left.devices?.length === 0) delete left.devices;
      await this.writeMember(pond, left);
      members.set(left.id, left);
      pond.rotationPending = true;
      this.save();
    }
    if (!pond.rotationPending) return;
    await this.rotate(pond, members);
    delete pond.rotationPending;
    this.save();
    this.emit("changed", pond.id);
  }

  // The account's devices (Settings > Your devices): one list for the whole account, never a Pond's

  /** This device's kind as the relay lists it. */
  private deviceKind(): "mac" | "web" {
    return this.identity.nest === null ? "web" : "mac";
  }

  /** Lists this device under the account (idempotent, best effort). */
  async registerSelf(): Promise<void> {
    const relay = this.options.relay;
    if (!relay?.registerDevice) return;
    await relay
      .registerDevice({
        publicKey: this.identity.publicKey,
        name: this.identity.nest || this.accountLabel(),
        kind: this.deviceKind(),
      })
      .catch(() => undefined);
  }

  /** The account's devices, this one included and marked. Throws `FlotillaError` 503 when the cloud will not say. */
  async accountDevices(): Promise<AccountDevice[]> {
    const relay = this.options.relay;
    if (!relay?.accountDevices) throw new FlotillaError("Your devices need the Squeak cloud.", 503);
    await this.registerSelf();
    try {
      return await relay.accountDevices(this.identity.id);
    } catch {
      throw new FlotillaError("Squeak couldn't reach your devices. Try again.", 503);
    }
  }

  /** Removes one of the account's devices from the account and every Pond (the relay cuts it off; Owners' Macs rotate). */
  async removeAccountDevice(deviceId: string): Promise<void> {
    const relay = this.options.relay;
    if (!relay?.removeAccountDevice) throw new FlotillaError("Your devices need the Squeak cloud.", 503);
    if (deviceId === this.identity.id) throw new FlotillaError("This is the device you are using.", 409);
    try {
      await relay.removeAccountDevice(deviceId);
    } catch (error) {
      if (error instanceof RelayRefused && error.status === 404) throw new FlotillaError("No such device.", 404);
      throw new FlotillaError("Squeak couldn't remove that device. Try again.", 503);
    }
  }

  // Members are accounts: this Mac as a later device

  /** The account on this Mac changed (signed in): the next sync is not held back by the last one. */
  accountChanged(): void {
    this.accountSyncAt = 0;
    this.deviceSkips.clear();
    if (this.pondsFile.data.leftUntil) {
      delete this.pondsFile.data.leftUntil;
      this.pondsFile.save();
    }
  }

  /** Forgets leave skips that ran out, or whose pond the account no longer lists (the owner's Mac removed this member). */
  private pruneLeft(listed: Set<string>): void {
    const left = this.pondsFile.data.leftUntil;
    if (!left) return;
    let changed = false;
    for (const [id, until] of Object.entries(left)) {
      if (until > this.now() && listed.has(id)) continue;
      delete left[id];
      changed = true;
    }
    if (Object.keys(left).length === 0) delete this.pondsFile.data.leftUntil;
    if (changed) this.pondsFile.save();
  }

  /** Runs `syncAccountPonds` in the background at most every few minutes; never throws. */
  private syncAccountPondsSoon(): void {
    if (this.now() - this.accountSyncAt < ACCOUNT_SYNC_MS) return;
    void this.syncAccountPonds().catch(() => undefined);
  }

  /**
   * A Mac signed in to an account that is a member of ponds it has not opened (it joined in a browser first) asks to be
   * added to each: the relay lists them for this account only, and the owner's Mac adds this device. No invite, code or
   * approval. A pond already here, in any state, is left alone, and a removed device is refused by the relay.
   */
  async syncAccountPonds(): Promise<number> {
    const relay = this.options.relay;
    if (!relay?.accountPonds || !relay.requestDevice || this.accountSyncing) return 0;
    this.accountSyncing = true;
    this.accountSyncAt = this.now();
    let asked = 0;
    try {
      await this.registerSelf();
      let list;
      try {
        list = await relay.accountPonds();
      } catch {
        return 0;
      }
      const me = this.identity;
      this.pruneLeft(new Set(list.filter((e) => !e.left).map((e) => e.pondId)));
      for (const entry of list) {
        if (entry.left) {
          // This account left the pond on another device: drop it here and never ask for it again.
          const mine = this.pondsFile.data.ponds[entry.pondId];
          if (mine && mine.role !== "owner") {
            this.forgetPond(entry.pondId);
            this.emit("changed", entry.pondId);
          }
          continue;
        }
        const existing = this.pondsFile.data.ponds[entry.pondId];
        const lapsed =
          existing?.deviceJoin && existing.status === "pending" && (existing.inviteExpiresAt ?? 0) <= this.now();
        if (existing && !lapsed) continue;
        if ((this.deviceSkips.get(entry.pondId) ?? 0) > this.now()) continue;
        if ((this.pondsFile.data.leftUntil?.[entry.pondId] ?? 0) > this.now()) continue;
        if (!POND_ID.test(entry.pondId)) continue;
        let issued;
        try {
          issued = await relay.requestDevice({
            pondId: entry.pondId,
            publicKey: me.publicKey,
            boxKey: me.publicKey,
            client: me.nest === null ? "web" : "mac",
            nest: me.nest,
          });
        } catch {
          // Refused (removed, rate limit) or unreachable: not again for a while.
          this.deviceSkips.set(entry.pondId, this.now() + ACCOUNT_SYNC_MS * 3);
          continue;
        }
        const at = this.now();
        this.pondsFile.data.ponds[entry.pondId] = {
          id: entry.pondId,
          name: (entry.name ?? "A pond").slice(0, 200),
          ...(entry.ownerName ? { ownerName: entry.ownerName.slice(0, 100) } : {}),
          status: "pending",
          role: "viewer",
          ownerKey: entry.ownerKey,
          location: { provider: "catalyst", relayUrl: relay.url },
          joinToken: issued.token,
          deviceJoin: true,
          keys: {},
          current: 0,
          requestId: issued.reqId,
          inviteExpiresAt: issued.expiresAt,
          requestedAt: at,
          threads: {},
          nonces: {},
        };
        this.save();
        asked += 1;
        this.watch(entry.pondId);
        this.wake(entry.pondId);
        this.emit("changed", entry.pondId);
      }
    } finally {
      this.accountSyncing = false;
    }
    return asked;
  }

  private async dropDeviceRequest(pond: LocalPond, deviceId: string): Promise<void> {
    if ((pond.location as { provider?: string } | null)?.provider !== "catalyst") return;
    await this.storeOf(pond)
      .delete(this.docPath(pond.id, "devreqs", deviceId))
      .catch(() => undefined);
  }

  /** One removal per member at a time: a second press while the first runs joins it instead of rotating the key twice. */
  private readonly removing = new Map<string, Promise<void>>();

  private removeAndRotate(pondId: string, memberId: string, say: (gone: MemberDoc) => string): Promise<void> {
    const key = `${pondId}/${memberId}`;
    const running = this.removing.get(key);
    if (running) return running;
    const run = this.removeAndRotateOnce(pondId, memberId, say).finally(() => this.removing.delete(key));
    this.removing.set(key, run);
    return run;
  }

  /** Whether a removal of this member is running now (the pond view says "Removing..."). */
  isRemoving(pondId: string, memberId: string): boolean {
    return this.removing.has(`${pondId}/${memberId}`);
  }

  private async removeAndRotateOnce(pondId: string, memberId: string, say: (gone: MemberDoc) => string): Promise<void> {
    const pond = this.activePond(pondId);
    this.allow(pond, "remove-member", {}, "Only an owner can remove a member.");
    if (memberId === this.identity.id) throw new FlotillaError("An owner cannot remove themselves.");
    const members = await this.members(pond);
    const gone = members.get(memberId);
    if (!gone) {
      // Removed already, but its rotation never finished: a retry finishes it instead of answering 404.
      if (pond.rotationPending) {
        await this.rotate(pond, members);
        delete pond.rotationPending;
        this.save();
        return;
      }
      throw new FlotillaError("No such member.", 404);
    }
    const store = this.storeOf(pond);
    // Their token ends first: if the relay will not revoke it, the removal stops here and can be retried.
    await this.revokeMemberTokens(pond, gone, "Squeak couldn't end that member's access. Try again.");
    // Their keys document becomes a note sealed to their key, signed by this owner: "removed". A member whose token still
    // reads (Firebase has none) learns it from that; on Catalyst the revoked token says the same by refusing them.
    await this.sendRemoval(pond, gone).catch(() => undefined);
    await store.delete(this.docPath(pond.id, "members", memberId));
    // Their account no longer lists this pond, and no waiting device request of theirs may bring a device back.
    if (gone.accountId) await this.indexAccounts(pond, [], [gone.accountId]).catch(() => undefined);
    for (const d of devicesOf(gone)) await this.dropDeviceRequest(pond, d.id);
    // Whatever they still held (a question being answered) goes with them: a hold by a key that is no member reads as nothing.
    await this.dropHoldsOf(pond, memberId).catch(() => undefined);
    members.delete(memberId);
    pond.rotationPending = true;
    this.save();
    // Said as soon as they are out: the rotation below is many relay calls, and a failure there must not leave the
    // removal unrecorded.
    const sentence = say(gone);
    if (sentence) await this.ripple(pondId, sentence, undefined, "left").catch(() => undefined);
    await this.rotate(pond, members);
    delete pond.rotationPending;
    this.save();
  }

  private async dropHoldsOf(pond: LocalPond, memberId: string): Promise<void> {
    const store = this.storeOf(pond);
    for (const { id, doc } of await store.list(`channels/${pond.id}/holds`)) {
      if (doc.device === memberId) await store.delete(this.docPath(pond.id, "holds", id)).catch(() => undefined);
    }
  }

  /** Throws the calm refusal when this Mac may not start its own Ducks in the pond (before anything is started). */
  async assertCanStart(pondId: string): Promise<void> {
    const pond = this.activePond(pondId);
    if (pond.role === "owner" || pond.local) return;
    if (!flag("pondOwnThreads")) throw new FlotillaError(OWN_THREADS_OFF, 403);
    // The stashed own-Mac mode (flag on) runs on the Member's own Mac with their own account, so it spends nothing of
    // the Owner's; a Duck that runs on the Owner's Mac is asked for with `requestStart` and waits for approval.
    await this.allowLive(pond, "start-thread", {}, VIEWERS_READ);
  }

  /** What a member may do in this pond now (derived from their role; the owner always may). */
  private capsIn(pond: LocalPond, members: Map<string, MemberDoc>, memberId: string): Caps {
    if (pond.role === "owner" && memberId === this.identity.id) return capsOf("owner");
    return capsOf(members.get(memberId)?.role ?? pond.role);
  }

  /** Owner: a member becomes a viewer or a member. Their member document is signed again; the key does not change. */
  async changeRole(pondId: string, memberId: string, role: Role): Promise<void> {
    const pond = this.activePond(pondId);
    this.allow(pond, "remove-member", {}, "Only an owner can change a role.");
    if (role !== "member" && role !== "viewer") throw new FlotillaError("A role is member or viewer.");
    if (memberId === this.identity.id) throw new FlotillaError("An owner's role can't be changed.");
    if (pond.local) throw new FlotillaError(LOCAL_ONLY, 409);
    const found = (await this.members(pond)).get(memberId);
    if (!found) throw new FlotillaError("No such member.", 404);
    if (found.role === role) return;
    const changed: MemberDoc = { ...found, role };
    await this.writeMember(pond, changed);
    // The account index carries each account's role (the web's overview draws it): say the new one.
    if (found.accountId) await this.indexAccounts(pond, [found.accountId], []).catch(() => undefined);
    await this.ripple(pondId, `made ${found.name} ${role === "viewer" ? "a viewer" : "a member"}`).catch(
      () => undefined,
    );
    this.emit("changed", pondId);
  }

  /**
   * A member leaves: told to the owner (who then removes the member, the key and every device's token), and the pond is
   * forgotten here at once. Safe from any surface: a pond already gone is a plain 404, a pond still waiting or already
   * ended is simply forgotten, an owner is refused with a sentence. For a day this Mac's account sync does not ask to
   * be added back (the account index lists the pond until the owner's Mac has processed the leave).
   */
  async leave(pondId: string): Promise<void> {
    const stored = this.pond(pondId);
    if (stored.role === "owner") throw new FlotillaError("An owner can't leave a pond: delete it instead.", 409);
    if (stored.status !== "active") {
      this.forgetPond(pondId);
      return;
    }
    const pond = this.activePond(pondId);
    // Done only when the cloud confirms (issue #130): the account-level leave first, so another device of this account does
    // not take the pond back. A relay without the route (404, 405: an older one) leaves it to the owner's removal.
    try {
      await this.options.relay?.leaveAccountPond?.(pondId);
    } catch (error) {
      const missing = error instanceof RelayRefused && (error.status === 404 || error.status === 405);
      if (!missing && !(error instanceof Error && error.message === "404")) {
        throw new FlotillaError(LEAVE_NOT_CONFIRMED, 503);
      }
    }
    // Told to the Owner's Mac through the cloud queue (it waits there if that Mac is away); the relay's refusal of this
    // account's token is what ends access at once.
    try {
      await this.queueForOwner(pond.id, { leave: true });
    } catch (error) {
      // A token the Owner already ended is the leave done; any other failure leaves the person in, to try again.
      if (!FlotillaService.isAccessEnded(error)) throw error;
    }
    this.forgetPond(pondId);
    // Kept on disk: a restart inside the day must not ask to be added back.
    this.pondsFile.data.leftUntil = { ...this.pondsFile.data.leftUntil, [pondId]: this.now() + LEFT_SKIP_MS };
    this.pondsFile.save();
    this.emit("changed", pondId);
  }

  /** Owner: renames the pond for everyone (the meta document), and here. */
  async renamePond(pondId: string, name: string): Promise<void> {
    const pond = this.activePond(pondId);
    this.allow(pond, "remove-member", {}, "Only an owner can rename the pond.");
    const next = name.trim();
    if (!next || next.length > 200) throw new FlotillaError("A pond needs a name.");
    if (next === pond.name) return;
    if (!pond.local) {
      const me = this.identity;
      await this.put(pond, "pond", "meta", {
        id: pond.id,
        name: next,
        owner: me.id,
        ownerKey: me.publicKey,
        created: this.now(),
        ...(pond.gitRemote ? { gitRemote: pond.gitRemote } : {}),
      } satisfies PondMeta);
    }
    pond.name = next;
    this.save();
    if (!pond.local) await this.ripple(pondId, `renamed the pond to ${next}`).catch(() => undefined);
    this.emit("changed", pondId);
  }

  /** Owner: ends the pond for everyone. Their access ends (tokens, member documents), then its documents go. */
  async deletePond(pondId: string): Promise<void> {
    const pond = this.activePond(pondId);
    this.allow(pond, "remove-member", {}, "Only an owner can delete the pond.");
    if (pond.local) {
      this.forgetPond(pondId);
      return;
    }
    const members = await this.members(pond);
    for (const member of members.values()) {
      if (member.id !== this.identity.id) {
        await this.revokeToken(pond, member.id, "Squeak couldn't end a member's access. Try again.");
      }
    }
    const store = this.storeOf(pond);
    // Members first: from then on everyone else reads "removed".
    for (const member of members.values()) {
      if (member.id !== this.identity.id) {
        await store.delete(this.docPath(pond.id, "members", member.id));
      }
    }
    const kinds = ["keys", "holds", "threads", "tevents", "tcmds", "room", "rposts", "rtasks"];
    await Promise.all(
      kinds.map(async (kind) => {
        for (const { id } of await store.list(`channels/${pond.id}/${kind}`).catch(() => [])) {
          await store.delete(this.docPath(pond.id, kind, id)).catch(() => undefined);
        }
      }),
    );
    await store.delete(this.docPath(pond.id, "members", this.identity.id)).catch(() => undefined);
    await store.delete(this.docPath(pond.id, "pond", "meta")).catch(() => undefined);
    this.forgetPond(pondId);
  }

  /** Remove: forgets a pond whose join or membership ended, or a request not yet decided. An active pond is never forgotten here. */
  async forget(pondId: string): Promise<void> {
    const pond = this.pond(pondId);
    if (pond.status !== "pending" && !TERMINAL.includes(pond.status)) {
      throw new FlotillaError("You're still in that pond. Leave it first.", 409);
    }
    this.forgetPond(pondId);
  }

  /** Owner only: a new pond key sealed to every current member, whose old tokens are ended and issued again. */
  async rotateKey(pondId: string): Promise<void> {
    const pond = this.activePond(pondId);
    if (pond.role !== "owner") throw new FlotillaError("Only an owner can change the pond key.", 403);
    if (pond.local) throw new FlotillaError(LOCAL_ONLY, 409);
    const members = await this.members(pond);
    // Every other member's old token ends first; if the relay refuses, nothing has changed and it can be retried.
    for (const member of members.values()) {
      if (member.id !== this.identity.id) {
        await this.revokeMemberTokens(pond, member, "Squeak couldn't end a member's old access. Try again.");
      }
    }
    await this.rotate(pond, members);
    await this.ripple(pondId, "changed the pond key");
  }

  /** Every device's token of a member ends (a removal, or a changed key). */
  private async revokeMemberTokens(pond: LocalPond, member: MemberDoc, failure: string): Promise<void> {
    for (const d of devicesOf(member)) await this.revokeToken(pond, d.id, failure);
  }

  private async revokeToken(pond: LocalPond, memberId: string, failure: string): Promise<void> {
    if (!this.options.relay || (pond.location as { provider?: string } | null)?.provider !== "catalyst") return;
    try {
      await this.options.relay.revoke(pond.id, memberId);
    } catch {
      throw new FlotillaError(failure, 503);
    }
    delete pond.issued?.[memberId];
    this.save();
  }

  /** A new key, sealed to each remaining member (a fresh token with it on Catalyst), then the meta and threads on it. */
  private async rotate(pond: LocalPond, remaining: Map<string, MemberDoc>): Promise<void> {
    pond.current += 1;
    pond.keys[String(pond.current)] = randomKey();
    this.save();
    for (const member of remaining.values()) {
      // The Owner's other devices (their browser, another Mac) get the new key too; this Mac already holds it.
      for (const device of devicesOf(member)) {
        if (device.id !== this.identity.id) await this.sendKeyToDevice(pond, member, device);
      }
      await this.writeMember(pond, member);
    }
    const me = this.identity;
    await this.put(pond, "pond", "meta", {
      id: pond.id,
      name: pond.name,
      owner: me.id,
      ownerKey: me.publicKey,
      created: this.now(),
      ...(pond.gitRemote ? { gitRemote: pond.gitRemote } : {}),
    } satisfies PondMeta);
    // Nothing already in the cloud is rewritten: each document keeps the key version in its box tag, every member holds
    // every version (`sendKeyToDevice`), and only new writes use the new key.
    this.emit("rotated", pond.id);
  }

  // refresh: what a wake-up does

  /** Reads what changed that this Mac must act on: an approval, a rotated key, a removal. Then tells listeners. */
  async refresh(pondId: string, options: { quiet?: boolean } = {}): Promise<void> {
    const pond = this.pondsFile.data.ponds[pondId];
    if (!pond || TERMINAL.includes(pond.status)) return;
    if (pond.local) return;
    const before = options.quiet ? JSON.stringify(pond) : "";
    if (pond.status === "pending") {
      await this.refreshPending(pond);
    } else {
      await this.refreshActive(pond);
    }
    // A safety poll that found this Mac's own record unchanged says nothing: the app need not read the pond again.
    if (options.quiet && JSON.stringify(this.pondsFile.data.ponds[pondId]) === before) return;
    this.emit("changed", pondId);
  }

  /**
   * A later device of an account already in the Pond, waiting for the Owner's Mac to seal the key (docs/ponds.md, "Members
   * are accounts"): in once its key is a member's, gone when the relay refuses its read token or the token runs out.
   */
  private async refreshPending(pond: LocalPond): Promise<void> {
    // A pending record that is no device's (an old join request) has nothing to wait on.
    if (!pond.deviceJoin) return this.forgetPond(pond.id);
    const me = this.identity;
    const lapsed = (): boolean => pond.inviteExpiresAt !== undefined && this.now() >= pond.inviteExpiresAt;
    let read: { members: Map<string, MemberDoc>; raw: number };
    try {
      read = await this.membersRead(pond);
      if (read.members.size === 0 && read.raw > 0) {
        // Let in with a newer key than the first: the key arrives in this member's own keys document.
        await this.syncKeys(pond, false);
        read = await this.membersRead(pond);
      }
    } catch (error) {
      if (!FlotillaService.isAccessEnded(error)) throw error;
      // A device's own token refused (it ran out, or the owner ended it): nothing to show, the account's ponds ask again.
      return this.dropDeviceJoin(pond);
    }
    const mine = memberOfDevice(read.members, me.id);
    if (mine) {
      pond.status = "active";
      pond.role = mine.role;
      // A later device of someone acts as that member from here on (the id the owner's documents name).
      if (mine.id !== me.id) pond.memberId = mine.id;
      delete pond.deviceJoin;
      delete pond.requestedAt;
      this.rememberOwnerName(pond, read.members);
      this.save();
      await this.syncKeys(pond, false);
      const meta = await this.meta(pond);
      if (meta) {
        pond.name = meta.name;
        if (meta.gitRemote) pond.gitRemote = meta.gitRemote;
        this.save();
      }
      this.emit("joined", pond.id);
      return;
    }
    this.rememberOwnerName(pond, read.members);
    // No join request document: the device's read token runs out, and the next sync asks again.
    if (lapsed()) this.dropDeviceJoin(pond);
  }

  /** A device's request that nobody answered (or whose token the relay refused) leaves nothing behind. */
  private dropDeviceJoin(pond: LocalPond): void {
    this.deviceSkips.set(pond.id, this.now() + ACCOUNT_SYNC_MS);
    this.forgetPond(pond.id);
  }

  private async refreshActive(pond: LocalPond): Promise<void> {
    const me = this.meIn(pond);
    try {
      await this.syncKeys(pond);
    } catch (error) {
      if (!FlotillaService.isAccessEnded(error)) throw error;
      if ((await this.onAccessEnded(pond)) === "removed") return;
    }
    if (pond.role !== "owner") {
      const read = await this.membersRead(pond).catch((error: unknown) => {
        if (FlotillaService.isAccessEnded(error)) return "ended" as const;
        throw error;
      });
      if (read === "ended") {
        await this.onAccessEnded(pond);
        return;
      }
      const mine = memberOfDevice(read.members, this.identity.id);
      void me;
      if (mine) {
        pond.role = mine.role;
        this.rememberOwnerName(pond, read.members);
        this.save();
      } else if (read.members.size > 0 || read.raw === 0) {
        this.markEnded(pond, "removed");
        return;
      }
      // The owner may have renamed the pond.
      const meta = await this.meta(pond).catch(() => null);
      if (meta && meta.name !== pond.name) {
        pond.name = meta.name;
        this.save();
      }
    }
    // This Mac's account may be a member of ponds it has not opened yet (it joined in a browser first).
    this.syncAccountPondsSoon();
    if (pond.role === "owner") {
      await this.applyQueuedActs(pond).catch(() => undefined);
      await this.adoptDeviceRequests(pond).catch(() => undefined);
      await this.reconcileAccountIndex(pond).catch(() => undefined);
      await this.syncInvites(pond).catch(() => undefined);
      await this.renewTokens(pond).catch(() => undefined);
      await this.refreshMemberNames(pond).catch(() => undefined);
    }
  }

  /** What the flock sees for a member: their account's name, "Signed-out member" for a Catalyst member with no account. */
  private shownName(pond: LocalPond, m: MemberDoc): string {
    if (m.accountId || m.role === "owner") return m.name;
    return (pond.location as { provider?: string } | null)?.provider === "catalyst" ? SIGNED_OUT_MEMBER : m.name;
  }

  /**
   * An owner's Mac keeps member names equal to their accounts' (a person may change their name at Zoho or Google): at most
   * every 30 minutes per pond, one relay call for up to 50 members, a member document rewritten only when a name differs.
   * The owner's own document follows this Mac's account the same way.
   */
  private async refreshMemberNames(pond: LocalPond): Promise<void> {
    const account = this.options.account;
    if (!account || pond.local || pond.status !== "active") return;
    const at = this.now();
    if (at - (this.nameChecks.get(pond.id) ?? 0) < NAME_REFRESH_MS) return;
    this.nameChecks.set(pond.id, at);
    const me = this.identity;
    const members = await this.members(pond);
    const mine = members.get(me.id);
    const own = this.accountLabel();
    const ownEmail = this.accountEmail();
    if (mine && (mine.name !== own || (ownEmail && mine.email !== ownEmail))) {
      await this.writeMember(pond, { ...mine, name: own, ...this.emailField() });
    }
    const withAccount = [...members.values()].filter((m) => m.accountId && m.id !== me.id);
    for (let i = 0; i < withAccount.length; i += 50) {
      const chunk = withAccount.slice(i, i + 50);
      const found = await account.names(chunk.map((m) => m.accountId!));
      for (const m of chunk) {
        const row = found.names[m.accountId!];
        const name = row?.name || row?.email;
        if (row && name && (name !== m.name || (row.email && row.email !== m.email))) {
          await this.writeMember(pond, { ...m, name, ...(row.email ? { email: row.email.slice(0, 200) } : {}) });
        }
      }
    }
  }

  private async meta(pond: LocalPond): Promise<PondMeta | null> {
    const doc = await this.storeOf(pond).get(this.docPath(pond.id, "pond", "meta"));
    if (!doc) return null;
    const read = this.readSigned(pond, "pond", "meta", doc, (d) =>
      d === memberIdOf(pond.ownerKey) ? pond.ownerKey : null,
    );
    const meta = read ? readMeta(read.value) : null;
    return meta && meta.ownerKey === pond.ownerKey ? meta : null;
  }

  /** Picks up a rotated pond key: sealed to this member's public key, signed by the owner. */
  private async syncKeys(pond: LocalPond, allowRemoval = true): Promise<void> {
    const me = this.identity;
    const docPath = this.docPath(pond.id, "keys", me.id);
    const doc = await this.storeOf(pond).get(docPath);
    if (!doc?.sig || doc.device !== memberIdOf(pond.ownerKey)) return;
    if (!verifyText(pond.ownerKey, signedText(docPath, doc.box), doc.sig)) return;
    try {
      const grant = openFromMember<{
        version: number;
        key: string;
        versions?: unknown;
        removed?: unknown;
        token?: { value?: unknown; expiresAt?: unknown };
      }>(me.privateKey, doc.box);
      if (grant.removed === true) {
        // A person asking to join again still has the old note: it ends nothing until the owner approves.
        if (allowRemoval) this.markEnded(pond, "removed");
        return;
      }
      const held: Array<[string, string]> = [];
      if (typeof grant.version === "number" && typeof grant.key === "string")
        held.push([String(grant.version), grant.key]);
      if (grant.versions && typeof grant.versions === "object" && !Array.isArray(grant.versions)) {
        for (const [v, k] of Object.entries(grant.versions as Record<string, unknown>))
          if (/^\d{1,6}$/.test(v) && typeof k === "string" && k) held.push([v, k]);
      }
      let learned = false;
      for (const [v, k] of held) {
        if (pond.keys[v]) continue;
        pond.keys[v] = k;
        pond.current = Math.max(pond.current, Number(v));
        learned = true;
      }
      if (learned) this.save();
      const t = grant.token;
      if (t && typeof t.value === "string" && typeof t.expiresAt === "number" && pond.token?.value !== t.value) {
        pond.token = { value: t.value, expiresAt: t.expiresAt };
        this.save();
        this.rebind(pond);
      }
    } catch {
      // Not sealed to this key: ignore.
    }
  }

  /** The credential changed (the join token gave way to the pond token): watch through the store it now opens. */
  private rebind(pond: LocalPond): void {
    const stop = this.watches.get(pond.id);
    if (!stop) return;
    stop();
    this.watches.delete(pond.id);
    this.watch(pond.id);
  }

  // watching: a wake-up only, never data

  watch(pondId: string): void {
    const pond = this.pondsFile.data.ponds[pondId];
    if (!pond || pond.local || this.watches.has(pondId)) return;
    let stop: () => void;
    try {
      const alone = (this.snapshotFile.data.ponds[pondId]?.counts.members ?? 0) <= 1;
      stop = this.storeOf(pond).watch(`channels/${pondId}`, (source) => this.onNotice(pondId, source), {
        pollMs: alone ? POLL_ALONE_MS : POLL_SHARED_MS,
      });
    } catch {
      return; // no cloud on this Mac: nothing to watch
    }
    this.watches.set(pondId, stop);
  }

  /** Starts watching every pond this Mac is in and runs one pass for each. */
  /** The old invite records (a code carried the pond key) and join words are gone: they leave `ponds.json` too. */
  private dropOldInvites(): void {
    let changed = false;
    for (const pond of Object.values(this.pondsFile.data.ponds)) {
      const old = pond as unknown as Record<string, unknown>;
      for (const key of ["invites", "words", "requestedRole"]) {
        if (key in old) {
          delete old[key];
          changed = true;
        }
      }
    }
    if (changed) this.save();
  }

  start(): void {
    this.dropOldInvites();
    for (const id of this.pondIds()) {
      this.watch(id);
      this.wake(id);
    }
    // Ponds this Mac's account is a member of, joined elsewhere first (a browser), arrive here without an invite.
    this.syncAccountPondsSoon();
    if (!this.statsTimer) {
      this.statsTimer = setInterval(() => this.logStats(), STATS_MS);
      this.statsTimer.unref?.();
    }
  }

  /** One line per 5 minutes, only when something happened: how busy the pond sync was. */
  private logStats(): void {
    const stats = this.takeStats();
    if (Object.values(stats).every((n) => n === 0)) return;
    logger.info("ponds sync (5 min)", { ...stats });
  }

  stop(): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    for (const { timer } of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear();
    for (const stop of this.watches.values()) stop();
    this.watches.clear();
  }

  /**
   * What the watch's callback does. A notice from the stream is only "something in this pond may have changed": the
   * echo of this Mac's own write is dropped, a burst becomes one read a second later, and a pond the relay rate-limited
   * waits out its back-off. A safety poll reads quietly (it tells the app only if this Mac's own record changed).
   */
  onNotice(pondId: string, source: WatchSource = "stream"): void {
    if (source === "poll") this.stats.polls += 1;
    if (source === "stream") {
      this.stats.streamEvents += 1;
      if (this.takeEcho(pondId)) {
        this.stats.skippedOwnEcho += 1;
        return;
      }
    }
    // The start already read it (or is about to): the watch's own first call adds nothing.
    if (source === "first" && this.now() - (this.lastRunAt.get(pondId) ?? -Infinity) < 10_000) return;
    this.schedule(pondId, source === "poll");
  }

  private schedule(pondId: string, quiet: boolean): void {
    const waiting = this.wakeTimers.get(pondId);
    if (waiting) {
      if (!quiet) waiting.quiet = false;
      this.stats.coalesced += 1;
      return;
    }
    const now = this.now();
    const last = this.lastRunAt.get(pondId);
    const debounce = this.options.wakeDebounceMs ?? 1_000;
    const gap = Math.max(
      debounce,
      last === undefined ? 0 : last + (this.options.wakeMinIntervalMs ?? 3_000) - now,
      this.backoffLeft(pondId),
    );
    const entry = {
      quiet,
      timer: setTimeout(() => {
        this.wakeTimers.delete(pondId);
        this.wake(pondId, { quiet: entry.quiet });
      }, gap),
    };
    entry.timer.unref?.();
    this.wakeTimers.set(pondId, entry);
  }

  /** The relay said 429: this pond is left alone for a while, longer each time, with jitter. */
  private backOff(pondId: string): void {
    const prev = this.backoffs.get(pondId);
    const ms = Math.min(prev ? prev.ms * 2 : BACKOFF_FIRST_MS, BACKOFF_MAX_MS);
    const jitter = 0.8 + 0.4 * (this.options.random ?? Math.random)();
    this.backoffs.set(pondId, { ms, until: this.now() + Math.round(ms * jitter) });
    this.stats.backoffs += 1;
  }

  /** A change during a pass schedules another, so nothing is dropped until a safety poll. */
  wake(pondId: string, options: { quiet?: boolean } = {}): void {
    if (this.running.has(pondId)) {
      this.dirty.add(pondId);
      return;
    }
    let quiet = options.quiet === true;
    this.running.add(pondId);
    void (async () => {
      try {
        do {
          this.dirty.delete(pondId);
          this.lastRunAt.set(pondId, this.now());
          this.stats.refreshes += 1;
          try {
            await this.refresh(pondId, { quiet });
            await this.pass(pondId);
            this.backoffs.delete(pondId);
          } catch (error) {
            if (error instanceof FlotillaError && error.extra.rateLimited === true) this.backOff(pondId);
            this.emit("error-pass", error);
          }
          quiet = false;
          // A pond in back-off is not read again straight away, whatever changed meanwhile.
          if (this.backoffLeft(pondId) > 0) {
            this.dirty.delete(pondId);
            this.schedule(pondId, false);
          }
        } while (this.dirty.has(pondId));
      } finally {
        this.running.delete(pondId);
      }
    })();
  }

  /** The bridge's work after a refresh (commands for this Mac's threads). Subscribers may be async. */
  async pass(pondId: string): Promise<void> {
    const listeners = this.listeners("pass") as Array<(id: string) => unknown>;
    for (const listener of listeners) await listener(pondId);
  }

  // reading

  private async threadsOf(pond: LocalPond, known?: Map<string, MemberDoc>): Promise<PondThread[]> {
    const members = known ?? (await this.members(pond));
    const out: PondThread[] = [];
    for (const { id, doc } of await this.storeOf(pond).list(`channels/${pond.id}/threads`)) {
      const read = this.readSigned(pond, "threads", id, doc, (d) => keysOfMember(members.get(d)));
      const thread = read ? readThread(read.value) : null;
      if (!thread || thread.id !== id || thread.starter !== read!.device || thread.private) continue;
      const mine = this.localThread(pond.id, id);
      // Stashed: a member's own-Mac thread is not shown while SQUEAK_POND_OWN_THREADS is off.
      if (thread.mode === "own" && !flag("pondOwnThreads") && members.get(thread.starter)?.role !== "owner") continue;
      // Your own threads carry the freshest running set; someone else's carries what their Mac last published.
      out.push(
        mine
          ? {
              ...thread,
              ...this.shape(mine),
              ...(mine.waitingFor ? { waitingFor: mine.waitingFor } : {}),
              sessionId: mine.sessionId,
            }
          : thread,
      );
    }
    // Your own private threads show to you only.
    for (const [id, local] of Object.entries(pond.threads)) {
      if (!local.private) continue;
      if (local.mode === "own" && pond.role !== "owner" && !flag("pondOwnThreads")) continue;
      const me = this.meIn(pond);
      out.push({
        id,
        title: local.title,
        starter: me.id,
        starterName: me.name,
        nest: me.nest ?? "",
        agent: local.agent,
        model: local.model,
        state: local.state ?? "idle",
        private: true,
        mode: local.mode,
        sessionId: local.sessionId,
        updatedAt: this.now(),
        ...(local.permissionMode ? { permissionMode: local.permissionMode } : {}),
        ...(local.waitingFor ? { waitingFor: local.waitingFor } : {}),
        ...this.shape(local),
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
  }

  async threads(pondId: string): Promise<PondThread[]> {
    return this.threadsOf(this.activePond(pondId));
  }

  /** Whether a chat's permission mode lets members message it: only a chat that asks first can be steered by others. */
  private static asks(permissionMode: string | undefined): boolean {
    return permissionMode !== "bypassPermissions";
  }

  /** What a thread says about itself to this reader: derived here, never stored (docs/ponds.md, "Thread fields"). */
  private decorateThread(thread: PondThread, online: Set<string>, me: string): PondThread {
    const mine = thread.starter === me;
    const starterOnline = mine || online.has(thread.starter);
    const first = thread.starterName;
    let line: string;
    if (!starterOnline && thread.state !== "idle") line = `${first}'s Mac is offline`;
    else if (thread.state === "working") line = mine ? "Working on your Mac" : `Working on ${first}'s Mac`;
    else if (thread.state === "waiting") {
      line =
        thread.waitingFor === "question"
          ? "Waiting for an answer"
          : mine
            ? "Waiting for you to approve an edit"
            : `Waiting for ${first} to approve an edit`;
    } else if (thread.state === "error") line = "Stopped with an error";
    else line = !starterOnline ? `${first}'s Mac is offline` : "Ready for the next message";
    return {
      ...thread,
      asks: FlotillaService.asks(thread.permissionMode),
      waitingOn: thread.state === "waiting" ? (thread.waitingFor ?? "approval") : null,
      starterOnline,
      ...(thread.nest ? { nestName: thread.nest } : {}),
      stateLine: line,
    };
  }

  async view(pondId: string): Promise<PondView> {
    const pond = this.pond(pondId);
    if (pond.status !== "active") return this.idleView(pond);
    if (pond.local) return this.liveView(pond);
    // One that does not finish within the budget answers with the last good read, and carries on to refresh it.
    const work = this.readView(pond);
    work.catch(() => undefined);
    const view = await this.within(work, this.budgetMs, () => {
      const stale = this.staleView(pond);
      if (!stale) throw new FlotillaError(CLOUD_DOWN, 503);
      return stale;
    });
    const row = this.withConnection(view.pond);
    return { ...view, pond: row, ...(row.connection ? { connection: row.connection } : {}) };
  }

  /** A pond that is not (or not yet) the person's to read: its state and the sentence for it, and nothing else. */
  private idleView(pond: LocalPond): PondView {
    const me = this.meIn(pond);
    return {
      pond: this.summary(pond, 0, 0, 0),
      cloud: this.hasCloud(),
      members: [],
      threads: [],
      ripples: [],
      presence: [],
      holds: [],
      me: { id: me.id, name: me.name, role: pond.role, nest: me.nest },
    };
  }

  private staleView(pond: LocalPond): PondView | null {
    const snap = this.snapshotFile.data.ponds[pond.id];
    if (!snap?.view) return null;
    const { counts } = snap;
    return {
      ...snap.view,
      pond: {
        ...this.summary(pond, counts.members, counts.threads, counts.needsYou),
        offline: true,
        asOf: snap.asOf,
        offlineLine: this.offlineLineOf(snap.asOf),
      },
      offline: true,
      asOf: snap.asOf,
      offlineLine: this.offlineLineOf(snap.asOf),
    };
  }

  private async readView(pond: LocalPond): Promise<PondView> {
    try {
      const view = await this.liveView(pond);
      this.remember(pond.id, {
        counts: { members: view.members.length, threads: view.threads.length, needsYou: view.pond.needsYou },
        view: this.metadataOnly(view),
      });
      return view;
    } catch (error) {
      if (FlotillaService.isAccessEnded(error)) {
        const verdict = await this.onAccessEnded(pond);
        if (verdict === "removed") return this.idleView(pond);
        if (verdict === "ok") return this.liveView(pond);
        if (verdict === "waiting") {
          const stale = this.staleView(pond);
          if (stale) return stale;
          throw new FlotillaError(WAITING_FOR_KEY, 503);
        }
      } else if (!FlotillaService.isOutage(error)) {
        throw error;
      }
      const stale = this.staleView(pond);
      if (stale) return stale;
      throw error instanceof FlotillaError && error.status >= 500 ? error : new FlotillaError(CLOUD_DOWN, 503);
    }
  }

  /** What may rest on disk: names, titles and the Ripples feed. No presence, holds, pending joins or session ids. */
  private metadataOnly(view: PondView): PondView {
    return {
      ...view,
      pond: { ...view.pond },
      threads: view.threads.map((t) => {
        const copy = { ...t };
        delete copy.sessionId;
        return copy;
      }),
      presence: [],
      holds: [],
    };
  }

  private async liveView(pond: LocalPond): Promise<PondView> {
    const me = this.meIn(pond);
    if (pond.local) {
      // Same page as a published pond: a flock of just you, no threads or Ripples in the cloud yet.
      return {
        pond: this.summary(pond, 1, 0, 0),
        cloud: this.hasCloud(),
        members: [
          {
            id: me.id,
            name: me.name,
            ...this.emailField(),
            role: "owner",
            nest: me.nest,
            nestName: me.nest,
            client: me.nest === null ? "web" : "mac",
            online: true,
            lastSeenAt: this.now(),
            you: true,
          },
        ],
        threads: [],
        ripples: [],
        presence: [],
        holds: [],
        me: { id: me.id, name: me.name, role: pond.role, nest: me.nest },
      };
    }
    const members = await this.members(pond);
    if (members.size === 0 || (pond.role !== "owner" && !memberOfDevice(members, this.identity.id))) {
      throw new FlotillaError(ACCESS_ENDED, 403, { access: "ended" });
    }
    this.rememberOwnerName(pond, members);
    if (pond.role === "owner" && pond.rotationPending) {
      // A removal whose new key did not finish going out: finished here, quietly, the next time anyone looks.
      try {
        await this.rotate(pond, members);
        delete pond.rotationPending;
        this.save();
      } catch {
        // Still pending; the next view or a retry of the removal tries again.
      }
    }
    // Everything here is independent of everything else: one round trip's time, not ten.
    const [holds, threadsRead, live] = await Promise.all([
      this.holdsOf(pond, members),
      this.threadsOf(pond, members),
      this.options.presenceOf ? this.options.presenceOf(pond.id).catch(() => []) : Promise.resolve([]),
    ]);
    const now = this.now();
    // Who is online comes from the live connections (#121); this Mac is always online to itself.
    const presence: PresenceDoc[] = [];
    const beat = new Map<string, number>();
    const online = new Set<string>([me.id]);
    for (const l of live) {
      if (!members.has(l.memberId)) continue;
      if (l.online) online.add(l.memberId);
      if (l.lastSeenAt) beat.set(l.memberId, l.lastSeenAt);
      this.ownerSeen.set(pond.id, pond.role === "owner" || online.has(memberIdOf(pond.ownerKey)));
    }
    // The Ripples feed is this Owner's Mac's own record of what happened (the Room carries the same lines).
    const ripples: Ripple[] = [...(pond.recent ?? [])];
    ripples.sort((a, b) => b.at - a.at);
    const threads = threadsRead.map((t) => this.decorateThread(t, online, me.id));
    const needsYou = this.needsCount(pond, threads);
    const starts = this.startsView(pond, members, me, ripples, threads);
    return {
      pond: this.summary(pond, members.size, threads.length, needsYou),
      cloud: this.hasCloud(),
      ...(starts.length ? { starts } : {}),
      members: [...members.values()].map((m) => ({
        id: m.id,
        name: this.shownName(pond, m),
        // Under the name and on hover: the account's email (this Mac's own account for you, else what the document says).
        ...(m.id === me.id ? this.emailField() : m.email ? { email: m.email } : {}),
        role: m.role,
        nest: m.nest,
        nestName: m.nest,
        client: m.client ?? (m.nest === null ? "web" : "mac"),
        // Derived from the role, in the shape older clients read.
        caps: capsOf(m.role),
        online: online.has(m.id),
        // A person once. Nothing about their devices is in a pond (docs/ponds.md, "Members are accounts").
        ...(m.id === me.id ? { lastSeenAt: now } : beat.has(m.id) ? { lastSeenAt: beat.get(m.id)! } : {}),
        you: m.id === me.id,
      })),
      threads,
      ripples: ripples
        .filter((r) => !isDeviceRipple(r.text))
        .slice(0, 50)
        .map((r) => this.rippleView(pond, r, members)),
      presence,
      holds: holds.map((h) => ({ ...h, heldBy: h.by, heldByName: h.byName })),
      me: {
        id: me.id,
        name: this.nameIn(),
        role: pond.role,
        nest: me.nest,
        caps: this.capsIn(pond, members, me.id),
      },
    };
  }

  /**
   * A Ripple as a surface draws it: "<actorName or You> <text>". The name is the member it is about (the Mac that wrote it
   * says so for another member's answer or joining), else the signer's, from the flock; a name already at the start of an
   * older Ripple's text is not said twice, and a thread's title never shows once that thread is private.
   */
  private rippleView(pond: LocalPond, r: Ripple, members: Map<string, MemberDoc>): Ripple & { actorName?: string } {
    const actor = members.get(r.actor);
    const actorName = r.onBehalf?.name ?? (actor ? this.shownName(pond, actor) : undefined);
    let text = r.text;
    if (actorName && text.toLowerCase().startsWith(`${actorName.toLowerCase()} `))
      text = text.slice(actorName.length + 1);
    // Ripples written before names were left out of them: "<name> made the pond".
    for (const t of Object.values(pond.threads)) {
      if (t.private && t.title && text.includes(t.title)) text = text.replace(t.title, "a private thread");
    }
    return { ...r, text, ...(actorName ? { actorName } : {}) };
  }

  // presence, ripples, holds

  /**
   * What this Mac's app is viewing or typing. Nothing is written to the cloud: a person is online while a device holds a
   * live connection, and typing travels on it (cloud-layer.md, "Live notices"); this only remembers it for that.
   */
  async setPresence(pondId: string, input: { viewing?: string; typing?: string; online?: boolean }): Promise<void> {
    const pond = this.activePond(pondId);
    if (pond.local) throw new FlotillaError(LOCAL_ONLY, 409);
    this.lastPresence.set(pondId, {
      ...(input.viewing ? { viewing: input.viewing } : {}),
      ...(input.typing ? { typing: input.typing } : {}),
      at: this.now(),
    });
  }

  /**
   * Something happened in the pond (made, joined, left, removed, renamed...). The Owner's Mac keeps it in its recent list
   * and says it in the Room as a line every Member reads (`line` event, room-sync.ts); nothing is written as its own
   * document. A Member's Mac has no say in it: the Owner's Mac writes the line when it learns of the change.
   */
  async ripple(
    pondId: string,
    text: string,
    onBehalf?: { id: string; name: string },
    kind?: RippleKind,
    ref?: string,
  ): Promise<string> {
    const pond = this.activePond(pondId);
    const at = this.now();
    const id = `${at.toString(36).padStart(9, "0")}-${randomId(3)}`;
    if (pond.role !== "owner") return id;
    const ripple: Ripple = {
      id,
      at,
      actor: this.selfId(pond),
      text: text.slice(0, 500),
      ...(onBehalf ? { onBehalf: { id: onBehalf.id.slice(0, 64), name: onBehalf.name.slice(0, 100) } } : {}),
      ...(kind ? { kind } : {}),
      ...(ref ? { ref: ref.slice(0, 80) } : {}),
    };
    pond.recent = [ripple, ...(pond.recent ?? [])].slice(0, RIPPLE_KEEP);
    this.save();
    this.emit("line", pondId, ripple);
    return id;
  }

  private async holdsOf(pond: LocalPond, members: Map<string, MemberDoc>): Promise<Hold[]> {
    const out: Hold[] = [];
    for (const { id, doc } of await this.storeOf(pond).list(`channels/${pond.id}/holds`)) {
      const read = this.readSigned(pond, "holds", id, doc, (d) => keysOfMember(members.get(d)));
      // A hold signed by a key that is no longer a member reads as nothing (readSigned finds no key for it).
      if (!read) continue;
      const hold = readHold(read.value);
      const holder = members.get(read.device);
      // A viewer cannot answer, so a hold of theirs would only lock the question against the people who can.
      if (
        hold &&
        holder &&
        holder.role !== "viewer" &&
        hold.requestId === id &&
        hold.by === read.device &&
        hold.until > this.now()
      )
        out.push(hold);
    }
    return out;
  }

  /**
   * Whoever starts answering holds the question for 2 minutes, renewed while they type (the Mac stops renewing after a
   * pause). First writer wins: a hold somebody else has is refused (409, naming who), and the writer reads it back.
   */
  async hold(pondId: string, requestId: string): Promise<{ ok: true; heldBy: string } | { ok: false; heldBy: string }> {
    const pond = this.activePond(pondId);
    const members = await this.allowLive(
      pond,
      "answer-question",
      { thread: { starter: "", private: false } },
      "Viewers can read but not send.",
    );
    const me = this.meIn(pond);
    const existing = (await this.holdsOf(pond, members)).find((h) => h.requestId === requestId);
    if (existing && existing.by !== me.id) return { ok: false, heldBy: existing.byName };
    const mine: Hold = { requestId, by: me.id, byName: this.nameIn(), until: this.now() + HOLD_MS };
    await this.put(pond, "holds", requestId, mine);
    const back = (await this.holdsOf(pond, members)).find((h) => h.requestId === requestId);
    if (back && back.by !== me.id) return { ok: false, heldBy: back.byName };
    return { ok: true, heldBy: this.nameIn() };
  }

  async releaseHold(pondId: string, requestId: string): Promise<void> {
    const pond = this.activePond(pondId);
    await this.storeOf(pond).delete(this.docPath(pond.id, "holds", requestId));
  }

  /** Who holds a request now, or null. */
  async heldBy(pondId: string, requestId: string): Promise<Hold | null> {
    const pond = this.activePond(pondId);
    return (await this.holdsOf(pond, await this.members(pond))).find((h) => h.requestId === requestId) ?? null;
  }

  /**
   * The pond a project of this Mac was published as (this Mac its owner), else null: only a shared pond carries its Room to
   * Members. A local pond never leaves the Mac.
   */
  sharedPondOfProject(projectId: string): string | null {
    const found = Object.values(this.pondsFile.data.ponds).find(
      (p) => p.projectId === projectId && p.role === "owner" && p.status === "active" && !p.local,
    );
    return found ? found.id : null;
  }

  /**
   * The narrow handle `room-sync.ts` builds the Room and its Tasks on (docs/ponds.md, "The Room reaches Members"): sealed,
   * signed documents of a kind it names, each read back with who signed it and what that member may do now; and whether the
   * owner's Mac has shown itself lately (the same presence the thread lines use).
   */
  roomPort(pondId: string): RoomPort {
    const pond = this.activePond(pondId);
    if (pond.local) throw new FlotillaError("This pond is not shared yet.", 409);
    const store = this.storeOf(pond);
    const ownerId = memberIdOf(pond.ownerKey);
    return {
      pondId: pond.id,
      projectId: pond.projectId ?? null,
      role: pond.role,
      me: { id: this.selfId(pond), name: this.nameIn() },
      ownerId,
      now: this.now,
      put: (kind, docId, value) => this.put(pond, kind, docId, value),
      remove: (kind, docId) => store.delete(this.docPath(pond.id, kind, docId)),
      list: async (kind) => {
        const members = await this.members(pond);
        const out: RoomSignedDoc[] = [];
        for (const { id, doc } of await store.list(`channels/${pond.id}/${kind}`)) {
          const read = this.readSigned(pond, kind, id, doc, (d) => keysOfMember(members.get(d)));
          const member = read ? members.get(read.device) : undefined;
          if (!read || !member) continue;
          out.push({
            id,
            value: read.value,
            device: read.device,
            role: member.role,
            name: this.shownName(pond, member),
            caps: capsOf(member.role),
            ...(doc.seq !== undefined ? { seq: doc.seq } : {}),
            ...(doc.at !== undefined ? { at: doc.at } : {}),
          });
        }
        return out;
      },
      note: async () => {
        // The relay's own plain note that it paged the oldest posts out (cloud: room-cloud.js); nothing else is read this way.
        const raw = (await (store as unknown as { getRaw?: (p: string) => Promise<unknown> })
          .getRaw?.(this.docPath(pond.id, "roomnote", "trim"))
          .catch(() => null)) as { removed?: unknown; before?: unknown; at?: unknown } | null | undefined;
        if (!raw || typeof raw.removed !== "number" || raw.removed < 1) return null;
        return { removed: raw.removed, before: Number(raw.before) || 0, at: Number(raw.at) || 0 };
      },
      putBlob: async (bytes, ref) => {
        const store = this.storeOf(pond);
        const key = pond.keys[String(pond.current)];
        if (!key) throw new FlotillaError("This Mac has no key for that pond yet.", 403);
        if (!store.putBlob) throw new FlotillaError("Pictures and files aren't available in the cloud yet.", 503);
        const id = newBlobId();
        await store.putBlob(pond.id, id, sealBlob(key, pond.current, pond.id, id, bytes), ref);
        return id;
      },
      getBlob: async (id) => {
        const store = this.storeOf(pond);
        if (!store.getBlob) return null;
        const sealed = await store.getBlob(pond.id, id);
        if (!sealed) return null;
        try {
          return openBlob(pond.keys, pond.id, id, sealed);
        } catch {
          // Sealed with a key this Mac never held, or altered on the way: the same as not there.
          return null;
        }
      },
      ingested: () => pond.ingestedSeq ?? 0,
      setIngested: (seq: number) => {
        if (seq > (pond.ingestedSeq ?? 0)) {
          pond.ingestedSeq = seq;
          this.save();
        }
      },
      noteAnswered: (ids) => this.noteAnswered(pondId, ids),
      caps: async () => this.capsIn(pond, await this.members(pond), this.selfId(pond)),
      owner: async () => {
        const members = await this.members(pond);
        const owner = members.get(ownerId);
        const ownerName = owner ? owner.name : this.ownerLabel(pond);
        if (pond.role === "owner") return { name: ownerName, online: true };
        // Without a live-connection source there is nothing to say the Owner's Mac is away: say nothing.
        const live = this.options.presenceOf ? await this.options.presenceOf(pond.id).catch(() => null) : null;
        if (!live) return { name: ownerName, online: true };
        const up = live.some((l) => l.memberId === ownerId && l.online);
        this.ownerSeen.set(pond.id, up);
        return { name: ownerName, online: up };
      },
    };
  }

  // threads (the starter's side)

  async publishThread(
    pondId: string,
    input: {
      sessionId: string;
      title: string;
      agent: string;
      model: string;
      mode: "own" | "shared";
      private?: boolean;
      permissionMode?: string;
      state?: PondThread["state"];
      workspace?: string;
      branch?: string;
      /** A member asked for this thread: it is theirs to see first, and the Ripple says they started it. */
      requester?: { memberId: string; requestId: string; name: string };
    },
  ): Promise<PondThread> {
    const pond = this.activePond(pondId);
    this.allow(pond, "start-thread", {}, VIEWERS_READ);
    // Stashed: a member's own thread (their agent on their Mac) is never published unless SQUEAK_POND_OWN_THREADS is on.
    if (input.mode === "own" && !input.requester && pond.role !== "owner" && !flag("pondOwnThreads")) {
      throw new FlotillaError(OWN_THREADS_OFF, 403);
    }
    if (this.identity.nest === null) throw new FlotillaError("A web guest has no machine to run a thread on.", 403);
    const threadId = randomId(10);
    pond.threads[threadId] = {
      sessionId: input.sessionId,
      private: input.private === true,
      mode: input.mode,
      title: input.title,
      agent: input.agent,
      model: input.model,
      ...(input.workspace ? { workspace: input.workspace } : {}),
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.requester
        ? { requester: { memberId: input.requester.memberId, requestId: input.requester.requestId } }
        : {}),
      participants: [{ memberId: this.selfId(pond), name: this.nameIn(), lastAt: new Date(this.now()).toISOString() }],
      seq: 0,
      batches: [],
    };
    this.save();
    pond.threads[threadId]!.state = input.state ?? "idle";
    const thread = this.threadDoc(pond, threadId, input.state ?? "idle", input.permissionMode);
    if (!pond.threads[threadId]!.private) {
      await this.put(pond, "threads", threadId, thread);
      // A private thread says nothing to the pond, its title least of all.
      const rippleId = await this.ripple(
        pondId,
        `${input.mode === "own" || input.requester ? "started" : "shared"} ${input.title}`,
        input.requester ? { id: input.requester.memberId, name: input.requester.name } : undefined,
      ).catch(() => undefined);
      if (rippleId) pond.threads[threadId]!.rippleId = rippleId;
      this.save();
    }
    return { ...thread, private: input.private === true, sessionId: input.sessionId };
  }

  private threadDoc(
    pond: LocalPond,
    threadId: string,
    state: PondThread["state"],
    permissionMode?: string,
  ): PondThread {
    const local = pond.threads[threadId]!;
    const me = this.meIn(pond);
    if (permissionMode) local.permissionMode = permissionMode;
    permissionMode ??= local.permissionMode;
    return {
      id: threadId,
      title: local.title,
      starter: me.id,
      starterName: this.nameIn(),
      nest: me.nest ?? "",
      agent: local.agent,
      model: local.model,
      state,
      private: false,
      mode: local.mode,
      updatedAt: this.now(),
      ...(permissionMode ? { permissionMode } : {}),
      ...(state === "waiting" && local.waitingFor ? { waitingFor: local.waitingFor } : {}),
      ...this.shape(local),
    };
  }

  /** The fields a thread carries beyond its basics: workspace, branch and who has taken part (newest first). */
  private shape(local: LocalThread): Pick<PondThread, "workspace" | "branch" | "participants" | "requester"> {
    return {
      ...(local.workspace ? { workspace: local.workspace } : {}),
      ...(local.branch ? { branch: local.branch } : {}),
      ...(local.requester ? { requester: local.requester } : {}),
      ...(local.participants ? { participants: sortParticipants(local.participants) } : {}),
    };
  }

  /**
   * A member's message ran in one of this Mac's threads: remember them (running set, saved with the pond state, so
   * no history is re-read). Republishes the thread document only when someone new joined.
   */
  async noteParticipant(
    pondId: string,
    threadId: string,
    who: { id: string; name: string },
    at: number,
    state: PondThread["state"] = "idle",
  ): Promise<void> {
    const pond = this.pond(pondId);
    const local = pond.threads[threadId];
    if (!local) return;
    const list = (local.participants ??= [
      { memberId: this.selfId(pond), name: this.identity.name, lastAt: new Date(at).toISOString() },
    ]);
    const lastAt = new Date(at).toISOString();
    const known = list.find((p) => p.memberId === who.id);
    if (known) {
      if (Date.parse(lastAt) > (Date.parse(known.lastAt) || 0)) known.lastAt = lastAt;
      known.name = who.name;
      this.save();
      return;
    }
    list.push({ memberId: who.id, name: who.name, lastAt });
    if (list.length > MAX_PARTICIPANTS) {
      list.sort((a, b) => (Date.parse(b.lastAt) || 0) - (Date.parse(a.lastAt) || 0));
      list.length = MAX_PARTICIPANTS;
    }
    this.save();
    if (!local.private && pond.status === "active") {
      await this.put(pond, "threads", threadId, this.threadDoc(pond, threadId, state)).catch(() => undefined);
    }
  }

  /** Rewrites one of this Mac's thread documents (state, title, mode). */
  async updateThread(
    pondId: string,
    threadId: string,
    patch: {
      state: PondThread["state"];
      title?: string;
      permissionMode?: string;
      waitingFor?: "approval" | "question" | null;
    },
  ): Promise<void> {
    const pond = this.activePond(pondId);
    const local = pond.threads[threadId];
    if (!local) throw new FlotillaError("no such thread", 404);
    if (patch.title) local.title = patch.title;
    local.state = patch.state;
    if (patch.waitingFor === null || patch.state !== "waiting") delete local.waitingFor;
    else if (patch.waitingFor) local.waitingFor = patch.waitingFor;
    if (patch.permissionMode) local.permissionMode = patch.permissionMode;
    this.save();
    if (!local.private)
      await this.put(pond, "threads", threadId, this.threadDoc(pond, threadId, patch.state, patch.permissionMode));
  }

  async setThreadPrivate(
    pondId: string,
    threadId: string,
    isPrivate: boolean,
    state: PondThread["state"] = "idle",
  ): Promise<void> {
    const pond = this.activePond(pondId);
    const local = pond.threads[threadId];
    this.allow(pond, "set-private", { thread: { starter: local ? this.identity.id : "", private: false } });
    if (!local) return;
    if (local.private === isPrivate) return;
    local.private = isPrivate;
    this.save();
    const store = this.storeOf(pond);
    if (isPrivate) {
      // Its title is not left behind in the feed.
      if (local.rippleId) {
        pond.recent = (pond.recent ?? []).filter((r) => r.id !== local.rippleId);
        delete local.rippleId;
      }
      await store.delete(this.docPath(pond.id, "threads", threadId));
      for (const { id } of await store.list(`channels/${pond.id}/tevents`)) {
        if (id.startsWith(`${threadId}-`)) await store.delete(this.docPath(pond.id, "tevents", id));
      }
      local.batches = [];
      this.save();
    } else {
      await this.put(pond, "threads", threadId, this.threadDoc(pond, threadId, state));
    }
    this.emit("visibility", pondId, threadId, isPrivate);
  }

  /** Reserves `count` sequence numbers for a thread's next events; returns the first. */
  allocSeq(pondId: string, threadId: string, count: number): number {
    const local = this.pond(pondId).threads[threadId];
    if (!local) throw new FlotillaError("no such thread", 404);
    const first = local.seq + 1;
    local.seq += count;
    this.save();
    return first;
  }

  /**
   * One batch of events, one document; then the thread keeps the last 30 days of them (and never more than `KEEP_EVENTS`). What is
   * published is only what a person reads: messages and short step labels. A tool's output, a diff or a file is never in an event;
   * a Member opening one asks the Owner's Mac (`diff` and `artifact` commands) and is told when that Mac is away.
   */
  async publishEvents(pondId: string, threadId: string, events: ThreadEvent[]): Promise<void> {
    if (events.length === 0) return;
    const pond = this.activePond(pondId);
    const local = pond.threads[threadId];
    if (!local) throw new FlotillaError("no such thread", 404);
    if (local.private) return;
    const first = events[0]!.seq;
    const last = events[events.length - 1]!.seq;
    await this.put(pond, "tevents", `${threadId}-${first}`, { events });
    local.batches.push([first, last]);
    const times = [...(local.batchAt ?? []), events[events.length - 1]!.at];
    while (times.length < local.batches.length) times.unshift(0); // older records: unknown, kept until counted out
    local.batchAt = times;
    let total = local.batches.reduce((n, [a, b]) => n + (b - a + 1), 0);
    const cutoff = this.now() - DUCK_HISTORY_MS;
    // Whatever is older than 30 days goes (wherever it sits in the list), then the oldest while over the safety ceiling.
    for (let i = local.batches.length - 1; i >= 0; i--) {
      if (!(local.batchAt[i]! > 0 && local.batchAt[i]! < cutoff)) continue;
      const [a, b] = local.batches.splice(i, 1)[0]!;
      local.batchAt.splice(i, 1);
      total -= b - a + 1;
      await this.storeOf(pond).delete(this.docPath(pond.id, "tevents", `${threadId}-${a}`));
    }
    while (local.batches.length > 1 && total - (local.batches[0]![1] - local.batches[0]![0] + 1) >= KEEP_EVENTS) {
      const [a, b] = local.batches.shift()!;
      local.batchAt.shift();
      total -= b - a + 1;
      await this.storeOf(pond).delete(this.docPath(pond.id, "tevents", `${threadId}-${a}`));
    }
    this.save();
  }

  /** Events after `after`, in order, for any member; `gap` says what a resume missed was pruned. */
  async readEvents(
    pondId: string,
    threadId: string,
    after = 0,
  ): Promise<{ events: ThreadEvent[]; lastSeq: number; gap: boolean }> {
    const pond = this.activePond(pondId);
    const members = await this.members(pond);
    const threadDoc = await this.storeOf(pond).get(this.docPath(pond.id, "threads", threadId));
    const threadRead = threadDoc
      ? this.readSigned(pond, "threads", threadId, threadDoc, (d) => keysOfMember(members.get(d)))
      : null;
    const thread = threadRead ? readThread(threadRead.value) : null;
    if (!thread || thread.private) {
      const mine = pond.threads[threadId];
      if (!mine) throw new FlotillaError("no such thread", 404);
    }
    const starter = thread?.starter ?? this.selfId(pond);
    const starterKey = keysOfMember(members.get(starter));
    if (starterKey.length === 0) throw new FlotillaError("no such thread", 404);
    const events: ThreadEvent[] = [];
    for (const { id, doc } of await this.storeOf(pond).list(`channels/${pond.id}/tevents`)) {
      if (!id.startsWith(`${threadId}-`)) continue;
      const read = this.readSigned(pond, "tevents", id, doc, (d) => (d === starter ? starterKey : null));
      const batch = read && (read.value as { events?: unknown[] }).events;
      if (!Array.isArray(batch)) continue;
      for (const raw of batch) {
        const ev = readThreadEvent(raw);
        if (ev && ev.seq > after) events.push(ev);
      }
    }
    events.sort((a, b) => a.seq - b.seq);
    // `author` marks a teammate's message; the starter's own words carry none.
    for (const ev of events) if (ev.type === "user" && ev.by === starter) delete ev.author;
    return {
      events,
      lastSeq: events.length ? events[events.length - 1]!.seq : after,
      gap: events.length > 0 && events[0]!.seq > after + 1 && after > 0,
    };
  }

  // commands: a member asks, the starter's Mac decides

  /** Signs and writes a command for a thread someone else started. Nothing runs until the starter's Mac verifies it. */
  async sendCommand(
    pondId: string,
    threadId: string,
    input: { kind: (typeof COMMAND_KINDS)[number]; text?: string; requestId?: string; answer?: string; path?: string },
    lifeMs = 5 * 60_000,
  ): Promise<string> {
    return (await this.sendCommandTo(pondId, threadId, input, lifeMs)).id;
  }

  /** `sendCommand`, saying whose thread it went to. */
  async sendCommandTo(
    pondId: string,
    threadId: string,
    input: { kind: (typeof COMMAND_KINDS)[number]; text?: string; requestId?: string; answer?: string; path?: string },
    lifeMs = 5 * 60_000,
  ): Promise<{ id: string; starterName: string }> {
    const pond = this.activePond(pondId);
    await this.allowLive(pond, COMMAND_ACTION[input.kind], { thread: { starter: "", private: false } }, VIEWERS_READ);
    const me = this.meIn(pond);
    const threads = await this.threadsOf(pond);
    const thread = threads.find((t) => t.id === threadId);
    if (!thread || thread.private) throw new FlotillaError("That thread is no longer shared with the pond.", 404);
    if (thread.starter === me.id) throw new FlotillaError("That is your own thread.");
    if ((input.kind === "message" || input.kind === "steer") && !FlotillaService.asks(thread.permissionMode)) {
      throw new FlotillaError(noMessageWithoutAsking(thread.starterName), 403, { refused: true });
    }
    const now = this.now();
    const cmd: CommandDoc = {
      id: randomId(12),
      kind: input.kind,
      threadId,
      issuedAt: now,
      expiresAt: now + Math.min(lifeMs, MAX_COMMAND_LIFE_MS),
      nonce: randomId(12),
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(input.answer !== undefined ? { answer: input.answer } : {}),
      ...(input.path !== undefined ? { path: input.path } : {}),
    };
    await this.put(pond, "tcmds", cmd.id, cmd);
    return { id: cmd.id, starterName: thread.starterName };
  }

  /** A member's Mac asks this thread's starter for what changed (and, with a path, that file's patch). Nothing polls. */
  async requestDiff(pondId: string, threadId: string, path?: string): Promise<{ requestId: string }> {
    // A remote pond shows no code: this Mac never asks for a diff there (the owner's caps are a separate switch).
    if (this.accessOf(pondId) === "remote") throw new FlotillaError(REMOTE_NO_CODE, 403);
    const requestId = await this.sendCommand(pondId, threadId, {
      kind: "diff",
      ...(path ? { path: path.slice(0, 500) } : {}),
    });
    return { requestId };
  }

  /**
   * The starter's answer to a `diff` command: sealed with the pond key and signed by the starter, in `tevents` beside the
   * thread's events (`<thread>-r<command id>`; the event reader skips it), deleted after `DIFF_RESULT_TTL_MS`.
   */
  async publishDiffResult(
    pondId: string,
    threadId: string,
    input: Omit<DiffResult, "id" | "threadId" | "at" | "expiresAt"> & { id: string },
  ): Promise<DiffResult> {
    const pond = this.activePond(pondId);
    const local = pond.threads[threadId];
    if (!local || local.private) throw new FlotillaError("no such thread", 404);
    const at = this.now();
    const result: DiffResult = { ...input, threadId, at, expiresAt: at + DIFF_RESULT_TTL_MS };
    const doc = `${threadId}-r${input.id}`;
    if (!DOC_ID.test(doc)) throw new FlotillaError("not a command this Mac runs");
    await this.put(pond, "tevents", doc, { result });
    (pond.results ??= []).push({ doc, until: result.expiresAt });
    this.save();
    const timer = setTimeout(
      () => void this.deleteResult(pond.id, doc).catch(() => undefined),
      DIFF_RESULT_TTL_MS + 1000,
    );
    timer.unref?.();
    return result;
  }

  private async deleteResult(pondId: string, doc: string): Promise<void> {
    const pond = this.pondsFile.data.ponds[pondId];
    if (!pond) return;
    await this.storeOf(pond).delete(this.docPath(pond.id, "tevents", doc));
    pond.results = (pond.results ?? []).filter((r) => r.doc !== doc);
    this.save();
  }

  /** Results past their time are deleted (from the list this Mac keeps: no listing of the cloud). */
  private sweepResults(pond: LocalPond): void {
    const now = this.now();
    for (const r of [...(pond.results ?? [])]) {
      if (r.until <= now) void this.deleteResult(pond.id, r.doc).catch(() => undefined);
    }
  }

  /** The answer to a diff request, or null while the starter's Mac has not written it (or it has expired or was withdrawn). */
  async diffResult(pondId: string, threadId: string, requestId: string): Promise<DiffResult | null> {
    const pond = this.activePond(pondId);
    const doc = `${threadId}-r${requestId}`;
    if (!DOC_ID.test(doc)) throw new FlotillaError("not a request");
    const members = await this.members(pond);
    const threads = await this.threadsOf(pond, members);
    const thread = threads.find((th) => th.id === threadId);
    // A thread that went private is gone for everyone but its starter, results included.
    if (!thread) return null;
    const starterKey = keysOfMember(members.get(thread.starter));
    const raw = await this.storeOf(pond).get(this.docPath(pond.id, "tevents", doc));
    if (!raw || starterKey.length === 0) return null;
    const read = this.readSigned(pond, "tevents", doc, raw, (d) => (d === thread.starter ? starterKey : null));
    const result = read ? readDiffResult(read.value) : null;
    if (!result || result.id !== requestId || result.threadId !== threadId) return null;
    return result.expiresAt > this.now() ? result : null;
  }

  // artifacts: the owner's outputs, for a member who cannot see code (docs/ponds.md, "Artifacts across Macs")

  /** The chats of this pond that are private on this Mac: nothing they made is ever handed to a member. */
  privateSessionIds(pondId: string): Set<string> {
    const out = new Set<string>();
    for (const th of Object.values(this.pond(pondId).threads)) if (th.private) out.add(th.sessionId);
    return out;
  }

  /** A member's Mac asks the pond owner's Mac for its artifacts (`kind: "artifacts"`) or one file (`"artifact"`). */
  async requestArtifacts(pondId: string, id?: string): Promise<{ requestId: string; ownerName: string }> {
    const pond = this.activePond(pondId);
    if (pond.role === "owner") throw new FlotillaError("That is your own Mac: its artifacts are here.");
    if (id !== undefined && !ARTIFACT_ID.test(id)) throw new FlotillaError("not an artifact");
    this.allow(pond, "view-pond", {}, VIEWERS_READ);
    const members = await this.members(pond);
    const owner = members.get(memberIdOf(pond.ownerKey));
    if (!owner) throw new FlotillaError("Can't reach Squeak's cloud.", 503);
    const now = this.now();
    const cmd: CommandDoc = {
      id: randomId(12),
      kind: id ? "artifact" : "artifacts",
      threadId: "",
      issuedAt: now,
      expiresAt: now + 5 * 60_000,
      nonce: randomId(12),
      ...(id ? { path: id } : {}),
    };
    await this.put(pond, "tcmds", cmd.id, cmd);
    return { requestId: cmd.id, ownerName: owner.name };
  }

  /**
   * The owner's answer: a file's chunks first (so a result that exists means every chunk does), then the result document.
   * All are deleted after `ARTIFACT_RESULT_TTL_MS`.
   */
  async publishArtifactsResult(
    pondId: string,
    input: {
      id: string;
      to: string;
      items: SharedArtifact[];
      file?: { path: string; name: string; kind: string; bytes: Buffer };
    },
  ): Promise<ArtifactsResult> {
    const pond = this.activePond(pondId);
    const doc = `art-r${input.id}`;
    if (!DOC_ID.test(doc) || pond.role !== "owner") throw new FlotillaError("not a command this Mac runs");
    const at = this.now();
    const expiresAt = at + ARTIFACT_RESULT_TTL_MS;
    const docs: string[] = [];
    let file: ArtifactsResult["file"];
    if (input.file) {
      const bytes = input.file.bytes;
      if (bytes.length > MAX_ARTIFACT_BYTES) throw new FlotillaError("That file is too large to send.");
      const chunks = Math.ceil(bytes.length / ARTIFACT_CHUNK_BYTES);
      for (let i = 0; i < chunks; i++) {
        const piece = bytes.subarray(i * ARTIFACT_CHUNK_BYTES, (i + 1) * ARTIFACT_CHUNK_BYTES);
        const chunkDoc = `${doc}-${i}`;
        await this.put(pond, "tevents", chunkDoc, { chunk: { id: input.id, n: i, data: piece.toString("base64") } });
        docs.push(chunkDoc);
        (pond.results ??= []).push({ doc: chunkDoc, until: expiresAt });
      }
      file = {
        path: input.file.path,
        name: input.file.name,
        kind: input.file.kind,
        size: bytes.length,
        chunks,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      };
    }
    const result: ArtifactsResult = {
      id: input.id,
      to: input.to,
      at,
      expiresAt,
      ownerName: this.meIn(pond).name,
      items: input.items,
      ...(file ? { file } : {}),
    };
    await this.put(pond, "tevents", doc, { artifacts: result });
    docs.push(doc);
    (pond.results ??= []).push({ doc, until: expiresAt });
    this.save();
    const timer = setTimeout(
      () => void Promise.all(docs.map((d) => this.deleteResult(pond.id, d).catch(() => undefined))),
      ARTIFACT_RESULT_TTL_MS + 1000,
    );
    timer.unref?.();
    return result;
  }

  /** The owner's refusal of one request, kept short and fixed (a file gone, too large): the member's Mac shows it. */
  async publishArtifactsRefusal(pondId: string, id: string, to: string, error: string): Promise<void> {
    const pond = this.activePond(pondId);
    const doc = `art-r${id}`;
    if (!DOC_ID.test(doc) || pond.role !== "owner") return;
    const at = this.now();
    const result: ArtifactsResult = {
      id,
      to,
      at,
      expiresAt: at + ARTIFACT_RESULT_TTL_MS,
      ownerName: this.meIn(pond).name,
      items: [],
      error,
    };
    await this.put(pond, "tevents", doc, { artifacts: result });
    (pond.results ??= []).push({ doc, until: result.expiresAt });
    this.save();
    const timer = setTimeout(
      () => void this.deleteResult(pond.id, doc).catch(() => undefined),
      ARTIFACT_RESULT_TTL_MS + 1000,
    );
    timer.unref?.();
  }

  /** The owner's answer to an `artifacts` / `artifact` request, or null until its Mac writes it (or after it expires). */
  async artifactsResult(pondId: string, requestId: string): Promise<ArtifactsResult | null> {
    const pond = this.activePond(pondId);
    const doc = `art-r${requestId}`;
    if (!DOC_ID.test(doc)) throw new FlotillaError("not a request");
    const members = await this.members(pond);
    const ownerId = memberIdOf(pond.ownerKey);
    const ownerKey = keysOfMember(members.get(ownerId));
    const raw = await this.storeOf(pond).get(this.docPath(pond.id, "tevents", doc));
    if (!raw || ownerKey.length === 0) return null;
    const read = this.readSigned(pond, "tevents", doc, raw, (d) => (d === ownerId ? ownerKey : null));
    const result = read ? readArtifactsResult(read.value) : null;
    if (!result || result.id !== requestId) return null;
    return result.expiresAt > this.now() ? result : null;
  }

  private readonly downloads = new Map<string, { chunks: Buffer[]; busy: Promise<void> | null; done?: string }>();

  /**
   * A member's Mac reads the file the owner sent: chunk by chunk (a poll takes what it can in a few seconds), checked
   * against the size and hash the owner signed, then kept under `<support>/artifact-cache/<pond>/` (pruned). Answers
   * `{ ready: false, progress? }` until the whole file is here, then `{ ready: true, file }` with the local path.
   */
  async artifactFile(
    pondId: string,
    requestId: string,
  ): Promise<{
    ready: boolean;
    error?: string;
    progress?: { have: number; total: number };
    file?: { path: string; name: string; kind: string; size: number; ownerName?: string };
  }> {
    const result = await this.artifactsResult(pondId, requestId);
    if (!result) return { ready: false };
    if (result.error) return { ready: false, error: result.error };
    const meta = result.file;
    if (!meta) return { ready: false };
    const key = `${pondId}:${requestId}`;
    const state = this.downloads.get(key) ?? { chunks: [], busy: null };
    this.downloads.set(key, state);
    const done = (p: string) => ({
      ready: true,
      file: {
        path: p,
        name: meta.name,
        kind: meta.kind,
        size: meta.size,
        ...(result.ownerName ? { ownerName: result.ownerName } : {}),
      },
    });
    if (state.done && fs.existsSync(state.done)) return done(state.done);
    if (!state.busy) {
      state.busy = this.pullChunks(pondId, requestId, meta.chunks, state).finally(() => {
        state.busy = null;
      });
    }
    await Promise.race([state.busy, new Promise((r) => setTimeout(r, 4000))]).catch(() => undefined);
    if (state.chunks.length < meta.chunks) {
      return { ready: false, progress: { have: state.chunks.length, total: meta.chunks } };
    }
    const bytes = Buffer.concat(state.chunks);
    if (bytes.length !== meta.size || crypto.createHash("sha256").update(bytes).digest("hex") !== meta.sha256) {
      this.downloads.delete(key);
      return { ready: false, error: "The file did not arrive intact. Try again." };
    }
    const dir = path.join(this.options.supportDir, "artifact-cache", pondId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const safe =
      meta.name
        .replace(/[^A-Za-z0-9._ -]/g, "_")
        .replace(/^\.+/, "_")
        .slice(-100) || "file";
    const file = path.join(dir, `${meta.path}-${safe}`);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    state.done = file;
    state.chunks = [];
    this.pruneArtifactCache(dir, file);
    return done(file);
  }

  private async pullChunks(
    pondId: string,
    requestId: string,
    total: number,
    state: { chunks: Buffer[] },
  ): Promise<void> {
    const pond = this.activePond(pondId);
    const members = await this.members(pond);
    const ownerId = memberIdOf(pond.ownerKey);
    const ownerKey = keysOfMember(members.get(ownerId));
    const store = this.storeOf(pond);
    while (state.chunks.length < total) {
      const n = state.chunks.length;
      const doc = `art-r${requestId}-${n}`;
      const raw = await store.get(this.docPath(pond.id, "tevents", doc));
      const read = raw ? this.readSigned(pond, "tevents", doc, raw, (d) => (d === ownerId ? ownerKey : null)) : null;
      const chunk = read ? readArtifactChunk(read.value) : null;
      if (!chunk || chunk.id !== requestId || chunk.n !== n)
        throw new FlotillaError("The file is no longer available.");
      state.chunks.push(Buffer.from(chunk.data, "base64"));
    }
  }

  /** Keeps a pond's cache to a week, 40 files and 400 MB, oldest first; the file just written stays. */
  pruneArtifactCache(dir: string, keep: string): void {
    try {
      const now = this.now();
      const rows = fs
        .readdirSync(dir)
        .map((name) => ({ file: path.join(dir, name), st: fs.statSync(path.join(dir, name)) }))
        .filter((r) => r.st.isFile())
        .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
      let bytes = 0;
      rows.forEach((r, i) => {
        bytes += r.st.size;
        const old = now - r.st.mtimeMs > 7 * 24 * 3600_000;
        if (r.file !== keep && (old || i >= 40 || bytes > 400 * 1024 * 1024)) fs.rmSync(r.file, { force: true });
      });
    } catch {
      // a cache that cannot be pruned is only large
    }
  }

  /** A member asks the pond owner's Mac to start a thread there (a pond with no Git remote, or "Run on their Mac"). */
  async requestStart(
    pondId: string,
    input: { text: string; title?: string; agent: string; model: string },
  ): Promise<{ requestId: string; ownerName: string }> {
    const pond = this.activePond(pondId);
    if (pond.role === "owner") throw new FlotillaError("That is your own Mac: start the thread here.");
    const members = await this.allowLive(pond, "start-thread", {}, VIEWERS_READ);
    const ownerId = memberIdOf(pond.ownerKey);
    const owner = members.get(ownerId);
    if (!owner) throw new FlotillaError("Can't reach Squeak's cloud.", 503);
    const text = input.text.trim();
    if (!text) throw new FlotillaError("empty message");
    const now = this.now();
    const requestId = randomId(10);
    const title = input.title ? input.title.slice(0, 200) : undefined;
    // Sealed, signed and ordered by the cloud: it waits there for the Owner's Mac as long as that Mac is away (a command
    // expires in 5 minutes; this does not), and is applied in order when it is back (room-sync.ts).
    await this.queueForOwner(pondId, {
      start: { requestId, text, agent: input.agent, model: input.model, ...(title ? { title } : {}) },
    });
    const cmd = { requestId, title, text };
    // Remembered here so this Mac can say "Waiting for <Owner>" until the Duck appears or the Owner declines.
    pond.asked = [
      ...(pond.asked ?? []).filter((a) => now - a.at < PENDING_START_LIFE_MS),
      { requestId, title: (cmd.title ?? text).replace(/\s+/g, " ").slice(0, 80), at: now },
    ].slice(-PENDING_STARTS_PER_MEMBER);
    this.save();
    this.emit("changed", pondId);
    return { requestId, ownerName: owner.name };
  }

  /**
   * A Member's Mac asks the Owner's Mac for something that must wait if that Mac is away: a post, a Task, a Duck, leaving, ending
   * a device. One sealed, signed `rposts` document in the Pond's own queue: the cloud gives it its place in the one order, and
   * the Owner's Mac applies it, oldest first, when it is running (`applyMemberAct`, room-sync.ts).
   */
  async queueForOwner(pondId: string, act: Record<string, unknown>): Promise<string> {
    const pond = this.activePond(pondId);
    if (pond.role === "owner") throw new FlotillaError("That is your own Mac.", 400);
    const at = this.now();
    const id = `${at.toString(36).padStart(9, "0")}-${randomId(6)}`;
    await this.put(pond, "rposts", id, { v: 1, id, text: "", at, ...act });
    return id;
  }

  /**
   * The Owner's Mac reads the Members' queued asks (`rposts` documents carrying a leave, a device removal or a Duck request) and
   * applies each once, in the cloud's order (seq; the Member's own time on a store that does not number). A numbered document
   * stays in the cloud, as the Room's record; the Mac remembers how far it has applied (`actsSeq`). An unnumbered one is
   * deleted when applied.
   */
  async applyQueuedActsOf(pondId: string): Promise<void> {
    const pond = this.pondsFile.data.ponds[pondId];
    if (pond && pond.role === "owner" && pond.status === "active" && !pond.local) await this.applyQueuedActs(pond);
  }

  private async applyQueuedActs(pond: LocalPond): Promise<void> {
    const members = await this.members(pond);
    const cursor = pond.actsSeq ?? 0;
    const waiting: Array<{ id: string; act: MemberAct; from: MemberDoc; seq: number | undefined; at: number }> = [];
    for (const { id, doc } of await this.storeOf(pond).list(`channels/${pond.id}/rposts`)) {
      const read = this.readSigned(pond, "rposts", id, doc, (d) => keysOfMember(members.get(d)));
      const from = read ? members.get(read.device) : undefined;
      const act = read ? readMemberAct(read.value) : null;
      if (!read || !from || !act || (read.value as { id?: unknown }).id !== id) continue;
      if (doc.seq !== undefined && doc.seq <= cursor) continue;
      waiting.push({ id, act, from, seq: doc.seq, at: Number((read.value as { at?: unknown }).at) || 0 });
    }
    const numbered = waiting.every((w) => w.seq !== undefined);
    waiting.sort((a, b) => (numbered ? a.seq! - b.seq! : a.at - b.at || (a.id < b.id ? -1 : 1)));
    for (const w of waiting) {
      await this.applyMemberAct(
        pond.id,
        { id: w.from.id, name: this.shownName(pond, w.from), role: w.from.role },
        w.act,
      );
      if (w.seq !== undefined) {
        pond.actsSeq = Math.max(pond.actsSeq ?? 0, w.seq);
        this.save();
      } else {
        await this.storeOf(pond)
          .delete(this.docPath(pond.id, "rposts", w.id))
          .catch(() => undefined);
      }
    }
  }

  /**
   * The Owner's Mac applies one queued ask of a Member (leave, end one of their devices, a Duck), under the same rules as
   * the command it replaced. Anything the rules refuse is dropped quietly.
   */
  async applyMemberAct(pondId: string, from: { id: string; name: string; role: Role }, act: MemberAct): Promise<void> {
    const pond = this.activePond(pondId);
    if (pond.role !== "owner") return;
    if (act.leave) {
      if (from.id === this.identity.id) return;
      await this.removeAndRotate(pondId, from.id, (gone) => `${gone.name} left the pond`).catch(() => undefined);
    } else if (act.removeDevice) {
      const member = (await this.members(pond)).get(from.id);
      if (member && devicesOf(member).some((d) => d.id === act.removeDevice))
        await this.removeDevice(pondId, from.id, act.removeDevice).catch(() => undefined);
    } else if (act.start) {
      const r = act.start;
      // The Owner's own device (their browser) asks for a Duck: no approval, it starts at once, as it would on this Mac.
      if (from.role === "owner" && from.id === this.identity.id) {
        if (!this.takeStartSlot(pondId, from.id)) return;
        await this.ownerStarter?.(pondId, {
          requestId: r.requestId,
          memberId: from.id,
          name: from.name,
          text: r.text,
          agent: r.agent,
          model: r.model,
          ...(r.title ? { title: r.title } : {}),
          at: this.now(),
        }).catch(() => undefined);
        return;
      }
      if (from.role !== "member" || !this.takeStartSlot(pondId, from.id)) return;
      await this.holdStart(pondId, from, {
        id: r.requestId,
        kind: "start",
        threadId: "",
        issuedAt: this.now(),
        expiresAt: this.now(),
        nonce: "",
        text: r.text,
        agent: r.agent,
        model: r.model,
        ...(r.title ? { title: r.title } : {}),
        requestId: r.requestId,
      }).catch(() => undefined);
    }
  }

  /** Set by the bridge: starts the Owner's own Duck at once (no approval). Without it this Mac drops the Owner's own start. */
  private ownerStarter: ((pondId: string, request: PendingStart) => Promise<void>) | null = null;
  setOwnerStarter(starter: ((pondId: string, request: PendingStart) => Promise<void>) | null): void {
    this.ownerStarter = starter;
  }

  /** A Member's Mac learns the Owner answered (declined) these start requests: they stop saying "Waiting". */
  noteAnswered(pondId: string, requestIds: string[]): void {
    const pond = this.pondsFile.data.ponds[pondId];
    if (!pond || pond.role === "owner" || requestIds.length === 0) return;
    const have = new Set(pond.answered ?? []);
    const fresh = requestIds.filter((id) => !have.has(id));
    if (fresh.length === 0) return;
    pond.answered = [...(pond.answered ?? []), ...fresh].slice(-200);
    this.save();
    this.emit("changed", pondId);
  }

  /**
   * The Owner's Mac: a Member's verified `start` is recorded as waiting (who asked and the first message) and shown to
   * the Owner to Approve or Decline. Nothing runs, and nothing is spent, until then. Said to the Room in one line.
   */
  async holdStart(pondId: string, from: { id: string; name: string }, cmd: CommandDoc): Promise<void> {
    const pond = this.activePond(pondId);
    if (pond.role !== "owner") throw new FlotillaError("Only the Owner's Mac holds a Duck for approval.", 403);
    const text = cmd.text?.trim();
    const agent = cmd.agent === "codex" ? "codex" : cmd.agent === "claude" ? "claude" : null;
    if (!text || !agent || !cmd.model) throw new FlotillaError("choose Claude or Codex and a model");
    const requestId = cmd.requestId ?? cmd.id;
    const now = this.now();
    const kept = (pond.pendingStarts ?? []).filter((p) => now - p.at < PENDING_START_LIFE_MS);
    if (kept.some((p) => p.requestId === requestId)) return;
    if (kept.filter((p) => p.memberId === from.id).length >= PENDING_STARTS_PER_MEMBER) {
      throw new FlotillaError("too many ducks waiting for approval");
    }
    pond.pendingStarts = [
      ...kept,
      {
        requestId,
        memberId: from.id,
        name: from.name,
        text,
        agent,
        model: cmd.model,
        ...(cmd.title ? { title: cmd.title } : {}),
        at: now,
      },
    ];
    this.save();
    this.emit("changed", pondId);
    await this.ripple(pondId, "asked for a duck", { id: from.id, name: from.name }).catch(() => undefined);
  }

  /** The Owner takes one waiting request to run it (nothing is left behind), or hears it is gone. */
  async takeStart(pondId: string, requestId: string): Promise<PendingStart> {
    const pond = this.activePond(pondId);
    this.allow(pond, "remove-member", {}, "Only an owner can approve a duck.");
    const found = (pond.pendingStarts ?? []).find((p) => p.requestId === requestId);
    if (!found) throw new FlotillaError("That duck is no longer waiting.", 404);
    const from = (await this.members(pond)).get(found.memberId);
    if (!from || from.role !== "member") {
      pond.pendingStarts = (pond.pendingStarts ?? []).filter((p) => p.requestId !== requestId);
      this.save();
      this.emit("changed", pondId);
      throw new FlotillaError(`${found.name} is no longer a member, so that duck was dropped.`, 409);
    }
    pond.pendingStarts = (pond.pendingStarts ?? []).filter((p) => p.requestId !== requestId);
    this.save();
    this.emit("changed", pondId);
    return { ...found, name: this.shownName(pond, from) };
  }

  /** A taken request that could not start goes back to waiting (its place by time kept). */
  async restoreStart(pondId: string, request: PendingStart): Promise<void> {
    const pond = this.activePond(pondId);
    if ((pond.pendingStarts ?? []).some((p) => p.requestId === request.requestId)) return;
    pond.pendingStarts = [...(pond.pendingStarts ?? []), request];
    this.save();
    this.emit("changed", pondId);
  }

  /** The Owner declines: the request is dropped and the Room says so in one line, naming the request for its Member's Mac. */
  async declineStart(pondId: string, requestId: string): Promise<void> {
    const pond = this.activePond(pondId);
    this.allow(pond, "remove-member", {}, "Only an owner can decline a duck.");
    const found = (pond.pendingStarts ?? []).find((p) => p.requestId === requestId);
    if (!found) throw new FlotillaError("That duck is no longer waiting.", 404);
    pond.pendingStarts = (pond.pendingStarts ?? []).filter((p) => p.requestId !== requestId);
    this.save();
    this.emit("changed", pondId);
    const title = (found.title ?? found.text).replace(/\s+/g, " ").slice(0, 60);
    await this.ripple(
      pondId,
      `declined the duck "${title}"`,
      { id: found.memberId, name: found.name },
      undefined,
      requestId,
    ).catch(() => undefined);
  }

  /** What waits for the Owner, for the pond view: all of it for the Owner, a Member's own for that Member. */
  private startsView(
    pond: LocalPond,
    members: Map<string, MemberDoc>,
    me: { id: string; name: string },
    ripples: Ripple[],
    threads: PondThread[],
  ): PendingStartView[] {
    const now = this.now();
    if (pond.role === "owner") {
      const live = (pond.pendingStarts ?? []).filter(
        (p) => now - p.at < PENDING_START_LIFE_MS && members.get(p.memberId)?.role === "member",
      );
      return live
        .map((p) => ({
          requestId: p.requestId,
          memberId: p.memberId,
          name: this.shownName(pond, members.get(p.memberId)!),
          title: (p.title ?? p.text).replace(/\s+/g, " ").slice(0, 80),
          text: p.text.slice(0, 500),
          at: p.at,
          mine: false,
        }))
        .sort((a, b) => a.at - b.at);
    }
    const answered = new Set<string>();
    for (const id of pond.answered ?? []) answered.add(id);
    for (const t of threads) if (t.requester?.requestId) answered.add(t.requester.requestId);
    return (pond.asked ?? [])
      .filter((a) => now - a.at < PENDING_START_LIFE_MS && !answered.has(a.requestId))
      .map((a) => ({
        requestId: a.requestId,
        memberId: me.id,
        name: this.nameIn(),
        title: a.title,
        at: a.at,
        mine: true,
      }));
  }

  /** At most `START_PER_HOUR` starts per member per pond per hour; kept in memory (a restart is a fresh hour). */
  private takeStartSlot(pondId: string, memberId: string): boolean {
    const key = `${pondId}:${memberId}`;
    const now = this.now();
    const recent = (this.startLog.get(key) ?? []).filter((at) => now - at < 60 * 60_000);
    if (recent.length >= START_PER_HOUR) {
      this.startLog.set(key, recent);
      return false;
    }
    recent.push(now);
    this.startLog.set(key, recent);
    return true;
  }
  private readonly startLog = new Map<string, number[]>();

  /** At most `ARTIFACT_FETCH_PER_HOUR` file fetches per member per pond per hour (in memory). */
  private takeArtifactSlot(pondId: string, memberId: string): boolean {
    const key = `${pondId}:${memberId}`;
    const now = this.now();
    const recent = (this.artifactLog.get(key) ?? []).filter((at) => now - at < 60 * 60_000);
    if (recent.length >= ARTIFACT_FETCH_PER_HOUR) {
      this.artifactLog.set(key, recent);
      return false;
    }
    recent.push(now);
    this.artifactLog.set(key, recent);
    return true;
  }
  private readonly artifactLog = new Map<string, number[]>();

  /**
   * The starter's side: every pending command for one of this Mac's threads, checked, handed to `run` if good,
   * and deleted either way. A refusal is a fixed sentence, never the command's content.
   */
  processCommands(pondId: string, run: (verified: VerifiedCommand) => Promise<void>): Promise<CommandOutcome[]> {
    // One at a time per pond: a second listing must see the first one's deletions, or a command runs twice.
    const previous = this.commandChains.get(pondId) ?? Promise.resolve();
    const next = previous.then(
      () => this.drainCommands(pondId, run),
      () => this.drainCommands(pondId, run),
    );
    this.commandChains.set(
      pondId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private async drainCommands(
    pondId: string,
    run: (verified: VerifiedCommand) => Promise<void>,
  ): Promise<CommandOutcome[]> {
    const pond = this.pondsFile.data.ponds[pondId];
    // An owner's Mac also answers `start`, which names no thread; any other Mac needs a thread of its own to answer for.
    if (!pond || pond.status !== "active" || (Object.keys(pond.threads).length === 0 && pond.role !== "owner"))
      return [];
    this.sweepResults(pond);
    const store = this.storeOf(pond);
    const members = await this.members(pond);
    const outcomes: CommandOutcome[] = [];
    for (const { id, doc } of await store.list(`channels/${pond.id}/tcmds`)) {
      const checked = this.verifyCommand(pond, members, id, doc);
      if (checked === "not-mine") continue;
      await store.delete(this.docPath(pond.id, "tcmds", id));
      if (typeof checked === "string") {
        outcomes.push({ id, ok: false, reason: checked });
        continue;
      }
      try {
        await run(checked);
        outcomes.push({ id, ok: true, kind: checked.cmd.kind });
      } catch (error) {
        outcomes.push({
          id,
          ok: false,
          kind: checked.cmd.kind,
          reason: error instanceof Error ? error.message : "failed",
        });
      }
    }
    return outcomes;
  }

  /** A verified command, a fixed reason it is refused, or `not-mine` (leave it for its starter). */
  private verifyCommand(
    pond: LocalPond,
    members: Map<string, MemberDoc>,
    id: string,
    doc: ChannelDoc,
  ): VerifiedCommand | string {
    const docPath = this.docPath(pond.id, "tcmds", id);
    const from = doc.device ? members.get(doc.device) : undefined;
    if (!from) return "not a member";
    if (!doc.sig || !keysOfMember(from).some((k) => verifyText(k, signedText(docPath, doc.box), doc.sig!)))
      return "bad signature";
    if (!doc.box.startsWith(`${pond.current}.`)) return "sealed with an old key";
    let value: unknown;
    try {
      value = this.openDoc(pond, docPath, doc);
    } catch {
      return "unreadable";
    }
    const raw = value as { threadId?: unknown; kind?: unknown } | null;
    // `start` names no thread: the pond's owner's Mac is the one that answers it, and every other Mac leaves it be.
    const starting = raw?.kind === "start";
    // `artifacts` / `artifact` are pond-level too: only the owner's Mac holds the outputs, and it answers.
    const podLevel = starting || raw?.kind === "artifacts" || raw?.kind === "artifact";
    if (podLevel) {
      if (pond.role !== "owner") return "not-mine";
    } else if (typeof raw?.threadId === "string" && !pond.threads[raw.threadId]) return "not-mine";
    const cmd = readCommand(value);
    if (!cmd || cmd.id !== id) return "not a command this Mac runs";
    const thread = podLevel ? null : (pond.threads[cmd.threadId] ?? null);
    if (!podLevel && !thread) return "not-mine";
    // The only things a member can ask of a starter are COMMAND_ACTION's: approving is not among them, and stopping is the Owner's.
    if (thread?.private) return "that thread is private";
    const verdict = can({ kind: "human", memberId: from.id, role: from.role }, COMMAND_ACTION[cmd.kind], {
      thread: { starter: this.selfId(pond), private: false },
    });
    if (!verdict.ok) return cmd.kind === "stop" ? ONLY_OWNER_STOPS : VIEWERS_READ;
    // Code (changed files, patches) leaves this Mac only for a member at the "git" level: the owner's own flag is on, the
    // pond has a Git remote and the member has a machine of their own. Anyone else is remote, whatever their client claims.
    if (
      cmd.kind === "diff" &&
      from.role !== "owner" &&
      !(flag("pondOwnThreads") && pond.gitRemote && from.nest !== null)
    )
      return REMOTE_NO_CODE;
    const now = this.now();
    if (cmd.expiresAt <= now) return "expired";
    if (cmd.expiresAt - cmd.issuedAt > MAX_COMMAND_LIFE_MS) return "lives too long";
    if (cmd.issuedAt > now + MAX_SKEW_MS) return "from the future";
    const nonceKey = `${from.id}:${cmd.nonce}`;
    for (const [key, until] of Object.entries(pond.nonces)) if (until < now) delete pond.nonces[key];
    if (pond.nonces[nonceKey] !== undefined) return "already used";
    if (starting && !this.takeStartSlot(pond.id, from.id)) return "too many threads started this hour";
    if (cmd.kind === "artifact" && !this.takeArtifactSlot(pond.id, from.id))
      return "too many files asked for this hour";
    pond.nonces[nonceKey] = cmd.expiresAt + MAX_SKEW_MS;
    this.save();
    return { cmd, from, thread };
  }

  /**
   * The start-clean migration (spec: People and remote, "Start clean"; docs/cloud-layer.md, "Clean start"), run once after
   * the cloud's Pond data was cleared. Every Pond this Mac owns becomes a local Pond again: same id, name, project and
   * key, its Ducks (threads) and Room history untouched, no cloud call. What the cloud held (invites, tokens handed out)
   * is dropped, so the Owner re-invites people by email. A record that cannot be local (a Pond this Mac only joined, or
   * one with no project) is forgotten; nothing of the Owner's is lost, since Ducks and the Room live under the project.
   * Idempotent: it records that it ran, so a Pond shared again later is never undone.
   */
  startClean(): { madeLocal: number; dropped: number } {
    const done = { madeLocal: 0, dropped: 0 };
    if (this.pondsFile.data.cleanStartedAt) return done;
    for (const pond of Object.values(this.pondsFile.data.ponds)) {
      if (pond.local) continue;
      if (pond.role !== "owner" || !pond.projectId || pond.kind === "joined" || pond.deviceJoin) {
        this.forgetPond(pond.id);
        done.dropped++;
        continue;
      }
      this.watches.get(pond.id)?.();
      this.watches.delete(pond.id);
      this.stores.delete(pond.id);
      pond.local = true;
      pond.location = null;
      pond.status = "active";
      pond.issued = {};
      pond.nonces = {};
      pond.results = [];
      for (const key of [
        "rotationPending",
        "joinToken",
        "token",
        "requestId",
        "inviteExpiresAt",
        "requestedAt",
        "endedAt",
        "recent",
        "ingestedSeq",
        "actsSeq",
        "answered",
      ] as const)
        delete pond[key];
      this.summaryCache.delete(pond.id);
      this.forgetSnapshot(pond.id);
      done.madeLocal++;
    }
    delete this.pondsFile.data.leftUntil;
    this.pondsFile.data.cleanStartedAt = this.now();
    this.save();
    for (const id of Object.keys(this.pondsFile.data.ponds)) this.emit("changed", id);
    return done;
  }

  /** Forget a member's pending work and local ponds, for tests and for leaving. */
  forgetPond(pondId: string): void {
    this.watches.get(pondId)?.();
    this.watches.delete(pondId);
    delete this.pondsFile.data.ponds[pondId];
    this.save();
    this.lastPresence.delete(pondId);
    this.echoes.delete(pondId);
    this.backoffs.delete(pondId);
    this.summaryCache.delete(pondId);
    this.forgetSnapshot(pondId);
    fs.rmSync(path.join(this.options.supportDir, "artifact-cache", pondId), { recursive: true, force: true });
  }
}

/**
 * A write that cannot reach the relay always says the one fixed sentence (`OFFLINE_WRITE`), whichever read it failed on
 * first (a removal reads the members before it deletes anything); reads say `CLOUD_DOWN`.
 */
const WRITES = [
  "removeMember",
  "removeDevice",
  "changeRole",
  "leave",
  "renamePond",
  "deletePond",
  "rotateKey",
  "hold",
  "sendCommandTo",
] as const;
for (const name of WRITES) {
  const proto = FlotillaService.prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = proto[name]!;
  proto[name] = async function (this: FlotillaService, ...args: unknown[]) {
    try {
      return await original.apply(this, args);
    } catch (error) {
      if (error instanceof FlotillaError && error.status === 503 && error.message === CLOUD_DOWN) {
        throw new FlotillaError(OFFLINE_WRITE, 503);
      }
      throw error;
    }
  };
}
