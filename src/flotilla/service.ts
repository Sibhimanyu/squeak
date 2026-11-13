import { EventEmitter } from "node:events";
import path from "node:path";

import { realtimeDatabaseOrigin, relayBaseUrl } from "../cloud/location.js";
import type { CloudStore, WatchSource } from "../cloud/store.js";
import { logger } from "../utils/logger.js";
import type { ChannelDoc } from "../remote/firestore-rest.js";
import {
  generateMemberKey,
  joinProof,
  memberIdOf,
  openAt,
  openFromMember,
  randomId,
  randomKey,
  safeEqual,
  sealAt,
  sealToMember,
  SecretFile,
  signedText,
  signText,
  verifyText,
} from "./crypto.js";
import {
  can,
  defaultGrant,
  readGrant,
  type Action,
  type Actor,
  type Context,
  type MachineGrant,
} from "./permissions.js";
import { PondCoordination, type CoordinationPort, type SignedDoc } from "./coordination.js";
import type { PondRelay, TokenScope } from "./relay.js";
import type { LockDoc, TaskView } from "./tasks.js";
import {
  COMMAND_KINDS,
  FlotillaError,
  HOLD_MS,
  KEEP_EVENTS,
  ONLINE_MS,
  MAX_PARTICIPANTS,
  sortParticipants,
  MAX_COMMAND_LIFE_MS,
  MAX_SKEW_MS,
  POND_ID,
  PRESENCE_MS,
  readCommand,
  readHold,
  readJoinRequest,
  readMember,
  readMeta,
  readPresence,
  readRipple,
  readThread,
  readThreadEvent,
  type CommandDoc,
  type Hold,
  type JoinRequestDoc,
  type MemberDoc,
  type PondMeta,
  type PondThread,
  type ThreadParticipant,
  type PresenceDoc,
  isRole,
  type Ripple,
  type Role,
  type ThreadEvent,
} from "./types.js";

/** What each command a member can send is, for `can`. There is no approve or stop to map. */
const COMMAND_ACTION: Record<(typeof COMMAND_KINDS)[number], Action> = {
  message: "message",
  steer: "message",
  answer: "answer-question",
  diff: "request-diff",
};

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
  /** The "shared <title>" Ripple, so making the thread private can take it away again (a title must not linger). */
  rippleId?: string;
  /** The last seq handed out. */
  seq: number;
  /** [first, last] seq of each batch in the cloud, oldest first. */
  batches: Array<[number, number]>;
}

export const VIEWERS_READ = "Viewers can read but not send.";
export const noMessageWithoutAsking = (starter: string): string =>
  `Only ${starter} can message this thread while it runs without asking.`;
const LOCAL_ONLY = "This pond is only on this Mac until you invite someone.";
const NO_CLOUD = "Set up a cloud store (Firebase or Catalyst) before inviting someone to a pond.";

/** An invite's life: pending until used, then accepted or declined; or expired (computed) or revoked by the owner. */
export type InviteState = "pending" | "accepted" | "declined" | "expired" | "revoked";

interface LocalInvite {
  secret: string;
  role: Role;
  expiresAt: number;
  /** Absent on invites made before states: they read as pending until they expire. */
  id?: string;
  state?: InviteState;
  /** The relay join token's member id (Catalyst), so a revoke can end the token too. */
  tokenId?: string;
  decidedAt?: number;
  createdAt?: number;
  /** Who it became: the name on the request that used it (accepted or declined). */
  usedBy?: string;
  /**
   * The code and link of a pending invite, kept (in this 0600 file, beside the pond key they carry) so the owner can copy
   * them again. Dropped the moment the invite is no longer pending.
   */
  code?: string;
  link?: string;
}

/** What an owner sees of an invite. `code` and `link` are present only while it is pending. */
export interface InviteView {
  id: string;
  role: Role;
  state: InviteState;
  createdAt?: number;
  expiresAt: number;
  usedBy?: string;
  link?: string;
  code?: string;
}

/** A pond-scoped relay token a member holds (docs/ponds.md, "Scoped tokens"). */
interface HeldToken {
  value: string;
  /** Unix milliseconds. */
  expiresAt: number;
}

/** A pond's state as every surface says it (docs/ponds.md, "States"). `denied` is the stored spelling of `declined`. */
export type PondStatus = "local" | "pending" | "active" | "declined" | "expired" | "revoked" | "removed";
type StoredStatus = "pending" | "active" | "removed" | "denied" | "revoked" | "expired";
/** Statuses that end a join or a membership: the row stays until the person presses Remove. */
const TERMINAL: readonly StoredStatus[] = ["removed", "denied", "revoked", "expired"];

interface LocalPond {
  id: string;
  name: string;
  status: StoredStatus;
  /** The name this person gave when joining, used in this pond only: it never replaces the Mac's own name. */
  myName?: string;
  /** The owner's name when this Mac has read it (the owner's member document), for the sentences about them. */
  ownerName?: string;
  /** A joiner: when the invite lapses (from the code) and when the request went out. */
  inviteExpiresAt?: number;
  requestedAt?: number;
  /** When a terminal status was reached. */
  endedAt?: number;
  /** The newest Ripple time an owner has already acted on (a member leaving). */
  reapedAt?: number;
  role: Role;
  ownerKey: string;
  location: unknown;
  /** Pond keys by version. The newest is `current`. */
  keys: Record<string, string>;
  current: number;
  requestId?: string;
  /** What the invite said the joiner would be, until approved. */
  requestedRole?: Role;
  gitRemote?: string;
  /** The Squeak project this Mac made the pond from. Local only: never written to the cloud or an invite. */
  projectId?: string;
  /**
   * A local pond: exists only on this Mac. No cloud document, no key published, until the first invite publishes it
   * (`publish`). Absent on every pond made before local ponds: those are published.
   */
  local?: boolean;
  /** A joiner on a Catalyst relay, until approved: the invite's join-only token (writes the join request). */
  joinToken?: string;
  /** A joiner on a Catalyst relay, once approved: the pond-scoped token the owner sent sealed to this key. */
  token?: HeldToken;
  /** An owner on a Catalyst relay: who holds a token, and until when, so it is renewed before it lapses. */
  issued?: Record<string, { expiresAt: number; scope: TokenScope }>;
  /** A member was removed but the new pond key did not finish going out: done on the next retry or view. */
  rotationPending?: boolean;
  threads: Record<string, LocalThread>;
  invites: LocalInvite[];
  /** Nonce -> its command's expiry, kept until then. */
  nonces: Record<string, number>;
}

interface Identity {
  name: string;
  nest: string | null;
  client?: "mac" | "web";
  privateKey: string;
  publicKey: string;
}

export interface FlotillaOptions {
  /** null when no cloud is set up: ponds are then local only and no network call is ever made. */
  store?: CloudStore | null;
  /** Key files live in `<supportDir>/flotilla/`, mode 0600. */
  supportDir: string;
  displayName: string;
  /** null for a web-style member with no machine of its own (tests; the browser app does this in its own code). */
  nest: string | null;
  /** How long list() and view() wait on the relay before they answer with the last good read (default 6 s). */
  budgetMs?: number;
  /** Base of an invite's link form, `https://<host>/join`; the code goes in the fragment. */
  inviteLinkBase?: string;
  /**
   * Where this Mac's store is. An invite carries only what is safe to hand out (`inviteLocation`): a Firebase
   * database address, or a Catalyst relay's URL, never its relay key.
   */
  location?: unknown;
  /**
   * Opens a store: with `pondToken` for a member who joined by invite (they never hold the relay key), without it
   * for the location this Mac owns.
   */
  storeFor?: (location: unknown, pondToken?: string | null) => CloudStore;
  /** Catalyst only: how an owner's Mac asks the relay for pond-scoped tokens. Absent with Firebase. */
  relay?: PondRelay | null;
  now?: () => number;
  /** A stream notice waits this long for company before it starts a read (default 1 s); 0 in tests. */
  wakeDebounceMs?: number;
  /** At least this long between two reads of one pond that a notice started (default 3 s). */
  wakeMinIntervalMs?: number;
  /** 0..1, for the back-off's jitter (default Math.random). */
  random?: () => number;
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
  /** A join still waiting on an owner: what the invite offered, and when the request went out. */
  requestedRole?: Role;
  requestedAt?: number;
  /** True when the relay could not be reached and this is the last known state (docs/ponds.md, "Offline"). */
  offline?: true;
  /** Unix ms of the last good read this came from; present only with `offline`. */
  asOf?: number;
  offlineLine?: string;
}

export interface MemberView {
  id: string;
  name: string;
  role: Role;
  nest: string | null;
  /** The member's machine's name (null for a browser). */
  nestName: string | null;
  client: "mac" | "web";
  /** Presence heartbeat younger than 45 s. */
  online: boolean;
  /** Unix ms of the last heartbeat, when there is one. */
  lastSeenAt?: number;
  you: boolean;
}

export interface JoinView {
  requestId: string;
  name: string;
  nest: string | null;
  client?: "mac" | "web";
  /** The role the invite offered; the owner decides. */
  role: Role;
  /** The email the relay saw signed in when the request arrived (Catalyst Hosted login); absent when none or no relay. */
  verifiedEmail?: string;
  verifiedName?: string;
  requestedAt?: number;
  /**
   * The owner's decision on this request while it runs or after it failed (kept 10 min; success removes the request), or
   * why it can no longer be decided ("Invite expired - ask them to join again", kept 24 h). `line` is the sentence.
   */
  decision?: { state: "working" | "failed"; line: string; approve?: boolean; error?: string };
}

/** The last decision on a join request, kept in memory per request id. */
interface DecisionState {
  state: "working" | "done" | "failed";
  approve: boolean;
  error?: string;
  at: number;
}
const DECISION_KEEP_MS = 10 * 60_000;

export interface PondView {
  pond: PondSummary;
  /** Whether this Mac has a cloud store an invite could publish to. */
  cloud?: boolean;
  members: MemberView[];
  threads: PondThread[];
  ripples: Array<Ripple & { actorName?: string }>;
  presence: PresenceDoc[];
  holds: Hold[];
  /** Tasks with their live claim folded in, most recently changed first. Only with `?coordination=1`: nothing draws them. */
  tasks?: TaskView[];
  /** Standing scope locks. */
  locks?: LockDoc[];
  joins: JoinView[];
  /** An owner's invites and their states (never codes or secrets); absent for everyone else. */
  invites?: InviteView[];
  me: { id: string; name: string; role: Role; nest: string | null };
  /** The relay could not be reached: this is the last known pond, read-only. */
  offline?: true;
  /** Unix ms of the last good read; present only with `offline`. */
  asOf?: number;
  offlineLine?: string;
}

/** What the last good read of a pond left on disk: metadata only, never a thread's events or a message body. */
interface PondSnapshot {
  asOf: number;
  counts: { members: number; threads: number; needsYou: number };
  view?: PondView;
}

export const OFFLINE_WRITE = "The pond can't be reached right now, so it is read-only until the connection returns.";
/** What a read says when the relay did not answer: never `fetch failed` or a status code. */
export const CLOUD_DOWN = "Can't reach Squeak's cloud. Try again in a moment.";
const ACCESS_ENDED = "You no longer have access to this pond.";
const WAITING_FOR_KEY = "Waiting for the pond owner's Mac to send you the new pond key.";
/** A pond list or view answers within this long, from the last good read when the relay is slower. */
const DEFAULT_BUDGET_MS = 6_000;
/** The host's own heartbeat keeps a running Mac online in every pond it is in. */
/** A request that can no longer be decided stays visible, greyed, this long. */
const STALE_REQUEST_KEEP_MS = 24 * 60 * 60_000;

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
  thread: LocalThread;
}

const TINTS = ["#E8A33D", "#4C8DF6", "#3FB68B", "#E5604D", "#8E6CEF", "#D9588F", "#3AA7C9", "#7DA33B"];
const INVITE_PREFIX = "squeak-pond:";
const INVITE_TTL_MS = 24 * 60 * 60_000;
/** A finished invite is kept this long past its expiry, so the owner can see what became of it. */
const INVITE_KEEP_MS = 30 * 24 * 60 * 60_000;
const RIPPLE_KEEP = 100;
/** A scoped token lasts as long as the relay allows; the owner's Mac renews it when under 3 days remain. */
const TOKEN_TTL_SEC = 30 * 24 * 3600;
const TOKEN_RENEW_MS = 3 * 24 * 3600_000;
/** The host's own heartbeat: a running Mac is online in every pond it is in. A write only when this old (or changed). */
const BEAT_MS = 120_000;
/** A presence document the host writes now lasts this long, so a beat every 2 minutes keeps a member online. */
export const PRESENCE_TTL_MS = 4 * 60_000;
/** A changed presence (viewing, typing) is written at most this often. */
const PRESENCE_CHANGE_MIN_MS = 5_000;
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
export class FlotillaService extends EventEmitter {
  private readonly now: () => number;
  private readonly identityFile: SecretFile<{ identity: Identity | null }>;
  private readonly pondsFile: SecretFile<{ ponds: Record<string, LocalPond> }>;
  private readonly watches = new Map<string, () => void>();
  private readonly running = new Set<string>();
  private readonly dirty = new Set<string>();
  private readonly stores = new Map<string, CloudStore>();
  private readonly commandChains = new Map<string, Promise<void>>();
  private readonly deciding = new Map<string, Promise<void>>();
  private readonly decisions = new Map<string, DecisionState>();
  private readonly snapshotFile: SecretFile<{ ponds: Record<string, PondSnapshot> }>;
  private readonly budgetMs: number;
  private beatTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private stats: SyncStats = FlotillaService.emptyStats();
  /** What this Mac last wrote as its presence in a pond, so an unchanged one is not written again. */
  private readonly lastPresenceWrite = new Map<
    string,
    { viewing?: string; typing?: string; online: boolean; at: number }
  >();
  /** When this Mac's own writes that echo (presence, thread events) were made, newest last. */
  private readonly echoes = new Map<string, number[]>();
  private readonly wakeTimers = new Map<string, { timer: NodeJS.Timeout; quiet: boolean }>();
  private readonly lastRunAt = new Map<string, number>();
  private readonly backoffs = new Map<string, { ms: number; until: number }>();
  private readonly summaryCache = new Map<string, { at: number; row: PondSummary }>();
  private readonly lastPresence = new Map<string, { viewing?: string; typing?: string; at: number }>();
  private readonly pendingWake = new Map<string, number>();
  /** Tasks, claims and scope locks (docs/ponds.md, "Tasks, claims and scope locks"). */
  readonly coordination = new PondCoordination((pondId) => this.coordinationPort(pondId));

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
    return {
      get: (path) => run(() => store.get(path)),
      set: (path, doc, options) => run(() => store.set(path, doc, options)),
      list: (collection) => run(() => store.list(collection)),
      delete: (path) => run(() => store.delete(path)),
      watch: (path, onChange, options) => store.watch(path, onChange, options),
      ...(typeof raw === "function" ? { getRaw: (path: string) => raw.call(store, path) } : {}),
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
        name: this.options.displayName,
        nest: this.options.nest,
        ...(this.options.nest === null ? { client: "web" as const } : {}),
        ...generateMemberKey(),
      };
      this.identityFile.save();
    }
    return { ...file.identity, id: memberIdOf(file.identity.publicKey) };
  }

  /**
   * The person's real name and the Mac's computer name replace what an older install saved from the login name and
   * hostname: only a value still equal to that old default changes (a name the person chose at join stays), and the
   * owner's own member document in every published pond is rewritten (only an owner signs members documents).
   * Returns whether anything changed.
   */
  async updateOwnProfile(
    next: { name: string; nest: string | null },
    was: { name: string; nest: string | null },
  ): Promise<boolean> {
    const file = this.identityFile.data;
    if (!file.identity) return false;
    let changed = false;
    if (next.name && file.identity.name === was.name && next.name !== was.name) {
      file.identity.name = next.name;
      changed = true;
    }
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
        if (mine) await this.writeMember(pond, { ...mine, name: me.name, nest: me.nest });
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

  private activePond(id: string): LocalPond {
    const pond = this.pond(id);
    if (pond.status === "pending") throw new FlotillaError("that join is waiting for an owner to approve it", 409);
    if (pond.status !== "active") throw new FlotillaError(this.statusLineOf(pond, 0), 403);
    return pond;
  }

  private inviteState(i: LocalInvite): InviteState {
    if (i.state && i.state !== "pending") return i.state;
    return i.expiresAt <= this.now() ? "expired" : "pending";
  }

  /** Persists a lapse (an unused invite past its expiry reads expired from then on) and drops long-finished ones. */
  private sweepInvites(pond: LocalPond): void {
    let changed = false;
    const keep: LocalInvite[] = [];
    for (const i of pond.invites) {
      if (i.expiresAt + INVITE_KEEP_MS < this.now()) {
        changed = true;
        continue;
      }
      if ((!i.state || i.state === "pending") && i.expiresAt <= this.now()) {
        i.state = "expired";
        changed = true;
      }
      keep.push(i);
    }
    if (changed) {
      pond.invites = keep;
      this.save();
    }
  }

  /** The invite a join request proves, in whatever state it is in now. */
  private inviteFor(pond: LocalPond, requestId: string, publicKey: string, proof: string): LocalInvite | undefined {
    return pond.invites.find((i) => safeEqual(joinProof(i.secret, requestId, publicKey), proof));
  }

  /** The unused invite a join request proves, if any: declined, revoked, accepted and expired ones never match. */
  private pendingInviteFor(
    pond: LocalPond,
    requestId: string,
    publicKey: string,
    proof: string,
  ): LocalInvite | undefined {
    return pond.invites.find(
      (i) => this.inviteState(i) === "pending" && safeEqual(joinProof(i.secret, requestId, publicKey), proof),
    );
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

  projectRemoved(projectId: string): void {
    for (const pond of Object.values(this.pondsFile.data.ponds)) {
      if (pond.projectId === projectId && pond.local) this.forgetPond(pond.id);
    }
  }

  projectIdOf(pondId: string): string | null {
    return this.pond(pondId).projectId ?? null;
  }

  gitRemoteOf(pondId: string): string | null {
    return this.pond(pondId).gitRemote ?? null;
  }

  // permissions (permissions.ts: the one place a role, a grant or an authority is decided)

  private actorOf(pond: LocalPond): Actor {
    return { kind: "human", memberId: this.identity.id, role: pond.role };
  }

  /** Throws the refusal `can` gives (or `message` when the caller keeps an older sentence); 404 for "no such thread". */
  private allow(pond: LocalPond, action: Action, ctx: Context, message?: string): void {
    const verdict = can(this.actorOf(pond), action, ctx);
    if (verdict.ok) return;
    throw new FlotillaError(
      message ?? verdict.reason,
      verdict.reason === "no such thread" || verdict.reason === "no such machine" ? 404 : 403,
    );
  }

  /** Every member's machine grant: signed by the member whose Nest it is, and by no one else. Absent = the default. */
  async machineGrants(pondId: string): Promise<Map<string, MachineGrant>> {
    const pond = this.activePond(pondId);
    const members = await this.members(pond);
    const out = new Map<string, MachineGrant>();
    for (const { id, doc } of await this.storeOf(pond).list(`channels/${pond.id}/grants`)) {
      const read = this.readSigned(pond, "grants", id, doc, (d) => members.get(d)?.publicKey ?? null);
      const grant = read ? readGrant(read.value) : null;
      if (grant && grant.owner === id && read!.device === id && members.get(id)?.nest != null) out.set(id, grant);
    }
    return out;
  }

  /** The grant for one member's machine: what the owner wrote, or nothing for anyone but them. */
  async machineGrant(pondId: string, owner: string): Promise<MachineGrant> {
    return (await this.machineGrants(pondId)).get(owner) ?? defaultGrant(owner);
  }

  /** This Mac's owner decides what other members may run on it. Nothing launches remote agents yet. */
  async setMachineGrant(pondId: string, grant: Omit<MachineGrant, "owner" | "updatedAt">): Promise<MachineGrant> {
    const pond = this.activePond(pondId);
    if (this.identity.nest === null) throw new FlotillaError("A web guest has no machine to share.", 403);
    const written: MachineGrant = { ...grant, owner: this.identity.id, updatedAt: this.now() };
    if (!readGrant(written)) throw new FlotillaError("That is not a machine grant.");
    this.allow(pond, "start-thread", {}, VIEWERS_READ);
    await this.put(pond, "grants", this.identity.id, written);
    return written;
  }

  // sealed, signed documents

  private docPath = (pondId: string, kind: string, doc: string): string => `channels/${pondId}/${kind}/${doc}`;

  private async put(pond: LocalPond, kind: string, docId: string, value: unknown): Promise<void> {
    const docPath = this.docPath(pond.id, kind, docId);
    const box = `${pond.current}.${sealAt(pond.keys[String(pond.current)]!, docPath, value)}`;
    const id = this.identity;
    // No pre-check here: a write that cannot go says so itself (below), and a pre-check built on an earlier failed read
    // refused writes that would have worked once the relay was back.
    try {
      await this.storeOf(pond).set(docPath, {
        box,
        sig: signText(id.privateKey, signedText(docPath, box)),
        device: id.id,
        at: this.now(),
      });
      // The relay tells every watcher of the channel, this Mac included; that notice is not news.
      if (kind === "presence" || kind === "tevents") this.expectEcho(pond.id);
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
    keyOf: (device: string) => string | null,
  ): { value: unknown; device: string } | null {
    try {
      const docPath = this.docPath(pond.id, kind, docId);
      if (!doc.sig || !doc.device) return null;
      const key = keyOf(doc.device);
      if (!key || !verifyText(key, signedText(docPath, doc.box), doc.sig)) return null;
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
      invites: [],
      nonces: {},
    };
    this.pondsFile.data.ponds[id] = pond;
    this.save();
    return pond;
  }

  /** The pond a project already has, local or published: by project id, else by name for a pond with no project. */
  private pondOfProject(input: { name: string; projectId?: string }): LocalPond | null {
    const all = Object.values(this.pondsFile.data.ponds).filter((p) => p.status === "active" || p.status === "pending");
    if (input.projectId) {
      const byId = all.find((p) => p.projectId === input.projectId);
      if (byId) return byId;
    }
    const name = input.name.trim().toLowerCase();
    return all.find((p) => !p.projectId && p.name.toLowerCase() === name) ?? null;
  }

  /** Whether a project already has a pond here, local or published. */
  hasPondForProject(input: { name: string; projectId?: string }): boolean {
    return this.pondOfProject(input) !== null;
  }

  /**
   * Every project is a pond from the moment it exists: this makes the project's local pond (nothing leaves the Mac)
   * or returns the one it already has, so a project tied to a published pond never gets a second. Synchronous, so two
   * calls cannot both create.
   */
  ensureLocalPond(input: { name: string; gitRemote?: string; projectId?: string }): PondSummary {
    const found = this.pondOfProject(input);
    if (found) {
      if (input.projectId && !found.projectId && !found.local && found.role === "owner") {
        // A name-matched owner pond adopts the project so later lookups are by id.
        found.projectId = input.projectId;
        this.save();
      }
      return this.summary(found, 1, 0, 0);
    }
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
      await this.ripple(pond.id, "made the pond").catch(() => undefined);
    })().finally(() => this.publishing.delete(pondId));
    this.publishing.set(pondId, run);
    return run;
  }

  async createPond(input: { name: string; gitRemote?: string; projectId?: string }): Promise<PondSummary> {
    const existing = input.projectId ? this.pondOfProject({ name: input.name, projectId: input.projectId }) : null;
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
      publicKey: me.publicKey,
      role: "owner",
      nest: me.nest,
      addedAt: this.now(),
    });
    await this.ripple(id, "made the pond");
    return this.summary(pond, 1, 0, 0);
  }

  private async writeMember(pond: LocalPond, member: MemberDoc): Promise<void> {
    await this.put(pond, "members", member.id, member);
  }

  /** The name this Mac goes by in one pond: what was typed at joining, else its own. */
  private nameIn(pond: LocalPond): string {
    return pond.myName || this.identity.name;
  }

  private ownerLabel(pond: LocalPond): string {
    return pond.ownerName || "The owner";
  }

  /** The one sentence for a pond's state. Surfaces draw it and decide nothing. */
  private statusLineOf(pond: LocalPond, members: number): string {
    const owner = this.ownerLabel(pond);
    switch (pond.status) {
      case "pending":
        return `Waiting for ${owner} to approve you as ${pond.requestedRole === "viewer" ? "a viewer" : "a member"}.`;
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
      ...(pond.status === "pending" && pond.requestedRole ? { requestedRole: pond.requestedRole } : {}),
      ...(pond.status === "pending" && pond.requestedAt ? { requestedAt: pond.requestedAt } : {}),
      ...(pond.local ? { local: true } : {}),
    };
  }

  /** What needs this person: a question anyone but a viewer may answer, or an approval on their own thread. */
  private needsCount(pond: LocalPond, threads: PondThread[]): number {
    const me = this.identity.id;
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
      if (members.size === 0 || (pond.role !== "owner" && !members.has(this.identity.id))) {
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
    return out;
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
    const me = this.identity;
    try {
      await this.syncKeys(pond);
    } catch (error) {
      if (FlotillaService.isAccessEnded(error)) return this.markEnded(pond, "removed");
      return "offline";
    }
    try {
      const read = await this.membersRead(pond);
      const mine = read.members.get(me.id);
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

  /** What an invite may say about the store: never a relay key (docs/ponds.md, "Scoped tokens"). */
  private inviteLocation(pond: LocalPond): Record<string, unknown> | null {
    const location = pond.location as { provider?: string; relayUrl?: string; databaseUrl?: string } | null;
    if (location?.provider === "catalyst") {
      const relayUrl = this.options.relay?.url ?? relayBaseUrl(location.relayUrl);
      return relayUrl ? { provider: "catalyst", relayUrl } : null;
    }
    if (location?.provider === "firebase" && realtimeDatabaseOrigin(location.databaseUrl)) {
      return { provider: "firebase", databaseUrl: location.databaseUrl };
    }
    return null;
  }

  /**
   * An invite: the pond id and key, the owner's key, a one-time secret and where to write the join request. On a
   * Catalyst relay that is the relay's URL and a join-only token (`jt`, the relay's, good for 24 h, writes the join
   * request and nothing else): never the relay key, which opens every pond in the store.
   */
  async invite(
    pondId: string,
    role: Role = "member",
    email?: string,
  ): Promise<{ code: string; expiresAt: number; link?: string; id: string }> {
    const pond = this.activePond(pondId);
    this.allow(pond, "invite", {}, "Only an owner can invite.");
    if (role !== "member" && role !== "viewer") throw new FlotillaError("An invite is for a member or a viewer.");
    // The first invite publishes a local pond (quietly), then makes the invite.
    if (pond.local) await this.publish(pondId);
    const location = this.inviteLocation(pond);
    let joinToken: string | undefined;
    let tokenId: string | undefined;
    if ((pond.location as { provider?: string } | null)?.provider === "catalyst") {
      if (!this.options.relay) throw new FlotillaError("This Mac cannot make an invite for a Catalyst store.", 503);
      try {
        tokenId = `j${randomId(12)}`;
        joinToken = (await this.options.relay.issue(pond.id, tokenId, "join", INVITE_TTL_MS / 1000, email)).token;
      } catch {
        throw new FlotillaError("The relay would not make an invite; try again.", 503);
      }
    }
    const secret = randomId(16);
    const expiresAt = this.now() + INVITE_TTL_MS;
    const id = randomId(8);
    this.sweepInvites(pond);
    const body = {
      v: 1,
      p: pond.id,
      k: pond.keys[String(pond.current)],
      kv: pond.current,
      o: pond.ownerKey,
      n: pond.name,
      s: secret,
      e: expiresAt,
      r: role,
      on: this.identity.name,
      l: location,
      ...(joinToken ? { jt: joinToken } : {}),
    };
    const code = INVITE_PREFIX + Buffer.from(JSON.stringify(body)).toString("base64url");
    // The link form keeps the secret in the fragment, which a browser never sends to any server.
    const base = this.options.inviteLinkBase?.replace(/[#?].*$/, "").replace(/\/+$/, "");
    const link = base ? `${base}#${code.slice(INVITE_PREFIX.length)}` : undefined;
    pond.invites.push({
      id,
      secret,
      role,
      expiresAt,
      state: "pending",
      createdAt: this.now(),
      // Kept while the invite is pending so the owner can copy it again from the Invites list.
      code,
      ...(link ? { link } : {}),
      ...(tokenId ? { tokenId } : {}),
    });
    this.save();
    return { code, expiresAt, id, ...(link ? { link } : {}) };
  }

  /** Writes a join request. Nothing is granted until an owner approves it on their Mac. */
  async join(code: string, displayName: string): Promise<{ pondId: string; status: "pending" }> {
    let body: Record<string, unknown>;
    try {
      const raw = code.trim();
      const bare = raw.includes("#") ? raw.slice(raw.indexOf("#") + 1) : raw.replace(INVITE_PREFIX, "");
      body = JSON.parse(Buffer.from(bare, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new FlotillaError("That invite code is not valid.");
    }
    const { p, k, kv, o, n, s, e } = body;
    if (
      body.v !== 1 ||
      typeof p !== "string" ||
      !POND_ID.test(p) ||
      typeof k !== "string" ||
      typeof kv !== "number" ||
      typeof o !== "string" ||
      typeof s !== "string" ||
      typeof e !== "number"
    ) {
      throw new FlotillaError("That invite code is not valid.");
    }
    if (e <= this.now()) throw new FlotillaError("That invite has expired.", 410);
    // The store location comes from an untrusted code: Catalyst needs a valid relay URL and the join token, and a
    // relay key in it is never read.
    const l = body.l as { provider?: unknown; relayUrl?: unknown; databaseUrl?: unknown } | null | undefined;
    let location: unknown = null;
    let joinToken: string | undefined;
    if (l && l.provider === "catalyst") {
      const relayUrl = relayBaseUrl(l.relayUrl);
      if (!relayUrl || typeof body.jt !== "string" || !body.jt)
        throw new FlotillaError("That invite code is not valid.");
      location = { provider: "catalyst", relayUrl };
      joinToken = body.jt;
    } else if (l && l.provider === "firebase") {
      const databaseUrl = realtimeDatabaseOrigin(l.databaseUrl);
      if (!databaseUrl) throw new FlotillaError("That invite code is not valid.");
      location = { provider: "firebase", databaseUrl };
    } else if (l) {
      throw new FlotillaError("That invite code is not valid.");
    }
    const existing = this.pondsFile.data.ponds[p];
    if (existing && existing.status === "active") throw new FlotillaError("You are already in that pond.", 409);
    // A second attempt keeps the first request (same id), so the owner sees one request, not two.
    const retry =
      existing && existing.status === "pending" && existing.requestId && existing.ownerKey === o ? existing : undefined;
    const name = displayName.trim().slice(0, 100) || this.identity.name;
    const me = this.identity;
    const requestId = retry?.requestId ?? randomId(12);
    const at = this.now();
    const pond: LocalPond = {
      id: p,
      name: typeof n === "string" ? n.slice(0, 200) : "A pond",
      status: "pending",
      role: "viewer",
      ownerKey: o,
      location,
      ...(joinToken ? { joinToken } : {}),
      keys: { [String(kv)]: k },
      current: kv,
      requestId,
      myName: name,
      ...(typeof body.on === "string" && body.on ? { ownerName: body.on.slice(0, 100) } : {}),
      inviteExpiresAt: e,
      requestedAt: retry?.requestedAt ?? at,
      ...(typeof body.r === "string" && isRole(body.r) ? { requestedRole: body.r as Role } : {}),
      threads: {},
      invites: [],
      nonces: {},
    };
    this.pondsFile.data.ponds[p] = pond;
    this.save();
    const request: JoinRequestDoc = {
      requestId,
      name,
      nest: me.nest,
      ...(me.nest === null ? { client: "web" as const } : {}),
      publicKey: me.publicKey,
      proof: joinProof(s, requestId, me.publicKey),
      at,
    };
    try {
      await this.put(pond, "joins", requestId, request);
    } catch (error) {
      // The request never left: nothing may stay "waiting" for an owner who cannot see it.
      if (existing) this.pondsFile.data.ponds[p] = existing;
      else delete this.pondsFile.data.ponds[p];
      this.save();
      if (FlotillaService.isAccessEnded(error)) {
        throw new FlotillaError("That invite is no longer valid. Ask for a new one.", 403);
      }
      throw new FlotillaError("The pond couldn't be reached, so your request wasn't sent. Try again.", 503);
    }
    return { pondId: p, status: "pending" };
  }

  /**
   * Join requests an owner sees: signed by their own key and proving an invite's secret. One whose invite is unused (or
   * was declined: the person asked again) can be decided. One whose invite lapsed, was withdrawn or was already used is
   * kept 24 h, greyed, with the sentence for it, and cannot be approved.
   */
  private async pendingJoins(
    pond: LocalPond,
    known?: Map<string, MemberDoc>,
  ): Promise<Array<JoinView & { publicKey: string; proof: string; stale?: string }>> {
    type Row = JoinView & { publicKey: string; proof: string; stale?: string };
    const best = new Map<string, { row: Row; at: number }>();
    const [members, rows] = await Promise.all([
      known ? Promise.resolve(known) : this.members(pond),
      this.storeOf(pond).list(`channels/${pond.id}/joins`),
    ]);
    this.sweepInvites(pond);
    const candidates: Array<{ id: string; request: JoinRequestDoc; invite: LocalInvite; stale?: string }> = [];
    for (const { id, doc } of rows) {
      const read = this.readSigned(pond, "joins", id, doc, (device) => {
        // Self-signed: the document names the key, and the proof ties it to the invite.
        try {
          const inner = readJoinRequest(this.openDoc(pond, this.docPath(pond.id, "joins", id), doc));
          return inner && memberIdOf(inner.publicKey) === device ? inner.publicKey : null;
        } catch {
          return null;
        }
      });
      const request = read ? readJoinRequest(read.value) : null;
      if (!request || request.requestId !== id || members.has(memberIdOf(request.publicKey))) continue;
      const invite = this.inviteFor(pond, id, request.publicKey, request.proof);
      if (!invite) continue;
      const state = this.inviteState(invite);
      let stale: string | undefined;
      if (state === "expired") stale = "Invite expired. Ask them to join again.";
      else if (state === "revoked") stale = "Invite withdrawn. Ask them to join again.";
      else if (state === "accepted") stale = "That invite was already used. Ask them to join again.";
      // Kept 24 h from when it became undecidable (the invite's end or its decision), not from when it was asked.
      const since = Math.max(request.at ?? 0, state === "expired" ? invite.expiresAt : (invite.decidedAt ?? 0));
      if (stale && this.now() - since > STALE_REQUEST_KEEP_MS) continue;
      candidates.push({ id, request, invite, ...(stale ? { stale } : {}) });
    }
    const identities = await Promise.all(
      candidates.map((c) => (c.stale ? Promise.resolve({}) : this.verifiedIdentity(pond, c.id))),
    );
    candidates.forEach(({ id, request, invite, stale }, index) => {
      const row: Row = {
        requestId: id,
        name: request.name,
        nest: request.nest,
        client: request.client ?? (request.nest === null ? "web" : "mac"),
        role: invite.role,
        ...identities[index],
        ...(request.at ? { requestedAt: request.at } : {}),
        publicKey: request.publicKey,
        proof: request.proof,
        ...(stale ? { stale, decision: { state: "failed" as const, line: stale } } : {}),
      };
      // One request per invite and per key: the newest by `at` (none = oldest), ties by request id.
      const at = request.at ?? 0;
      for (const group of [`i:${invite.secret}`, `k:${request.publicKey}`]) {
        const held = best.get(group);
        if (!held || at > held.at || (at === held.at && id > held.row.requestId)) best.set(group, { row, at });
      }
    });
    // A request is shown only if it is the newest in both its groups.
    const wins = new Map<string, number>();
    for (const { row } of best.values()) wins.set(row.requestId, (wins.get(row.requestId) ?? 0) + 1);
    const out: Row[] = [];
    for (const { row } of best.values()) {
      if (wins.get(row.requestId) === 2 && !out.includes(row)) out.push(row);
    }
    return out;
  }

  /** Requests superseded by `winner` (same invite or same key) that are still in the store. */
  private async supersededJoins(pond: LocalPond, winner: { requestId: string; publicKey: string; proof: string }) {
    const invite = this.inviteFor(pond, winner.requestId, winner.publicKey, winner.proof);
    const ids: string[] = [];
    for (const { id, doc } of await this.storeOf(pond).list(`channels/${pond.id}/joins`)) {
      if (id === winner.requestId) continue;
      try {
        const inner = readJoinRequest(this.openDoc(pond, this.docPath(pond.id, "joins", id), doc));
        if (!inner || inner.requestId !== id) continue;
        const sameInvite = invite && safeEqual(joinProof(invite.secret, id, inner.publicKey), inner.proof);
        if (sameInvite || inner.publicKey === winner.publicKey) ids.push(id);
      } catch {
        // Not readable: not ours to remove.
      }
    }
    return ids;
  }

  private async dropSuperseded(pond: LocalPond, ids: string[]): Promise<void> {
    await Promise.all(
      ids.map(async (id) => {
        await this.storeOf(pond)
          .delete(this.docPath(pond.id, "joins", id))
          .catch(() => undefined);
        await this.dropJoinIdentity(pond, id);
      }),
    );
  }

  /**
   * Who the relay saw signed in when a join request came (\`joinids/<requestId>\`, plain JSON the relay wrote): context for
   * the owner's decision, never a grant. Only a Catalyst store has it; anything unreadable is simply absent.
   */
  private async verifiedIdentity(
    pond: LocalPond,
    requestId: string,
  ): Promise<{ verifiedEmail?: string; verifiedName?: string }> {
    const store = this.storeOf(pond) as CloudStore & { getRaw?: (path: string) => Promise<unknown | null> };
    if (typeof store.getRaw !== "function") return {};
    try {
      const raw = (await store.getRaw(this.docPath(pond.id, "joinids", requestId))) as Record<string, unknown> | null;
      if (!raw || raw.v !== 1 || typeof raw.email !== "string" || !raw.email) return {};
      return {
        verifiedEmail: raw.email,
        ...(typeof raw.name === "string" && raw.name ? { verifiedName: raw.name } : {}),
      };
    } catch {
      return {};
    }
  }

  /** The relay-owned identity note goes with the request; a relay-less store has none, and a failure is harmless. */
  private async dropJoinIdentity(pond: LocalPond, requestId: string): Promise<void> {
    if ((pond.location as { provider?: string } | null)?.provider !== "catalyst") return;
    await this.storeOf(pond)
      .delete(this.docPath(pond.id, "joinids", requestId))
      .catch(() => undefined);
  }

  /** A person on an owner's Mac decides. The approval is a members document the owner's key signed. */
  /**
   * The same decision, answered at once: the checks that need no relay run now (a 403/404 is immediate), the decision
   * runs in the background and its outcome is kept per request id for the view (`JoinView.decision`: "working", or
   * "failed" with a sentence). A relay of 3-15 s per call can take over a minute for one approval; a client must not
   * wait on it.
   */
  startJoinDecision(pondId: string, requestId: string, input: { approve: boolean; role?: Role }): void {
    const pond = this.activePond(pondId);
    this.allow(pond, "decide-join", {}, "Only an owner can decide a join.");
    if (input.role !== undefined && input.role !== "member" && input.role !== "viewer") {
      throw new FlotillaError("Approve as a member or a viewer.");
    }
    const key = `${pondId}/${requestId}`;
    if (this.decisions.get(key)?.state === "working") return;
    this.decisions.set(key, { state: "working", approve: input.approve, at: this.now() });
    void this.decideJoin(pondId, requestId, input).then(
      () => this.decisions.set(key, { state: "done", approve: input.approve, at: this.now() }),
      (error: unknown) =>
        this.decisions.set(key, {
          state: "failed",
          approve: input.approve,
          error: error instanceof FlotillaError ? error.message : CLOUD_DOWN,
          at: this.now(),
        }),
    );
  }

  /** The recorded decision for a request, or undefined once it is done, old or never made. */
  private decisionFor(pondId: string, requestId: string): JoinView["decision"] | undefined {
    const key = `${pondId}/${requestId}`;
    const d = this.decisions.get(key);
    if (!d) return undefined;
    if (this.now() - d.at > DECISION_KEEP_MS || d.state === "done") {
      this.decisions.delete(key);
      return undefined;
    }
    const line =
      d.state === "working"
        ? d.approve
          ? "Approving..."
          : "Declining..."
        : `Couldn't ${d.approve ? "approve" : "decline"}: ${d.error ?? CLOUD_DOWN} Try again.`;
    return { state: d.state, line, approve: d.approve, ...(d.error ? { error: d.error } : {}) };
  }

  async decideJoin(pondId: string, requestId: string, input: { approve: boolean; role?: Role }): Promise<void> {
    // A second press while the first still runs (a slow relay, a button that gave no sign) joins the first decision
    // instead of writing the member and the "joined" Ripple again.
    const key = `${pondId}/${requestId}`;
    const running = this.deciding.get(key);
    if (running) return running;
    const run = this.decideJoinOnce(pondId, requestId, input).finally(() => this.deciding.delete(key));
    this.deciding.set(key, run);
    return run;
  }

  private async decideJoinOnce(
    pondId: string,
    requestId: string,
    input: { approve: boolean; role?: Role },
  ): Promise<void> {
    const pond = this.activePond(pondId);
    this.allow(pond, "decide-join", {}, "Only an owner can decide a join.");
    const request = (await this.pendingJoins(pond)).find((r) => r.requestId === requestId);
    if (!request)
      throw new FlotillaError("That request is gone: the invite may have expired or they withdrew it.", 404);
    const store = this.storeOf(pond);
    const invite = this.inviteFor(pond, requestId, request.publicKey, request.proof);
    if (request.stale && input.approve) throw new FlotillaError(request.stale, 409);
    const supersededRead = this.supersededJoins(pond, request).catch(() => [] as string[]);
    const consume = (state: "accepted" | "declined"): void => {
      if (invite && !request.stale) {
        invite.state = state;
        invite.decidedAt = this.now();
        invite.usedBy = request.name;
        delete invite.code;
        delete invite.link;
      }
      this.save();
    };
    if (!input.approve) {
      const superseded = await supersededRead;
      await Promise.all([
        store.delete(this.docPath(pond.id, "joins", requestId)),
        this.dropJoinIdentity(pond, requestId),
        this.dropSuperseded(pond, superseded),
      ]);
      consume("declined");
      if (!request.stale) {
        await this.ripple(pondId, `turned down ${request.name}'s request to join`).catch(() => undefined);
      }
      return;
    }
    const role = input.role ?? request.role;
    if (role !== "member" && role !== "viewer") throw new FlotillaError("Approve as a member or a viewer.");
    const member: MemberDoc = {
      id: memberIdOf(request.publicKey),
      name: request.name,
      publicKey: request.publicKey,
      role,
      nest: request.nest,
      ...(request.client ? { client: request.client } : {}),
      addedAt: this.now(),
    };
    // Order that matters: the member's key reaches the relay before their member document (a member must never be listed
    // without a key). Everything else here is independent, so the slow relay calls overlap.
    await this.sendKeyTo(pond, member);
    await this.writeMember(pond, member);
    const superseded = await supersededRead;
    consume("accepted");
    // The member is in and the invite used: the cleanup and a Ripple that cannot be written (a slow relay) must not
    // turn this into a failure.
    await Promise.all([
      // A leftover request is hidden once its key is a member, so a failed delete is not a failed approval.
      store.delete(this.docPath(pond.id, "joins", requestId)).catch(() => undefined),
      this.dropJoinIdentity(pond, requestId),
      this.dropSuperseded(pond, superseded),
      this.ripple(pondId, "joined", { id: member.id, name: member.name }).catch(() => undefined),
    ]);
  }

  /**
   * An owner withdraws an unused invite. Its relay join token (Catalyst) is revoked first, so a failure stops here and
   * can be retried; a request already waiting on it is removed, and the person sees the decline sentence.
   */
  async revokeInvite(pondId: string, inviteId: string): Promise<{ id: string; state: InviteState }> {
    const pond = this.activePond(pondId);
    if (pond.role !== "owner") throw new FlotillaError("Only an owner can revoke an invite.", 403);
    this.sweepInvites(pond);
    const invite = pond.invites.find((i) => i.id === inviteId);
    if (!invite) throw new FlotillaError("No such invite.", 404);
    const state = this.inviteState(invite);
    if (state === "revoked") return { id: inviteId, state };
    if (state !== "pending") throw new FlotillaError(`That invite is already ${state}.`, 409);
    if (
      invite.tokenId &&
      this.options.relay &&
      (pond.location as { provider?: string } | null)?.provider === "catalyst"
    ) {
      try {
        await this.options.relay.revoke(pond.id, invite.tokenId);
      } catch {
        throw new FlotillaError("Squeak couldn't reach the pond to end that invite. Try again.", 503);
      }
    }
    invite.state = "revoked";
    invite.decidedAt = this.now();
    delete invite.code;
    delete invite.link;
    this.save();
    let waiting: string | undefined;
    for (const r of await this.pendingJoinsFor(pond, invite).catch(() => [])) {
      await this.storeOf(pond)
        .delete(this.docPath(pond.id, "joins", r.id))
        .catch(() => undefined);
      await this.dropJoinIdentity(pond, r.id);
      waiting = r.name;
    }
    await this.ripple(pondId, waiting ? `withdrew the invite ${waiting} was waiting on` : "withdrew an invite").catch(
      () => undefined,
    );
    return { id: inviteId, state: "revoked" };
  }

  /** Request ids whose proof matches this invite (a revoked invite no longer lists them, so this reads the store). */
  private async pendingJoinsFor(pond: LocalPond, invite: LocalInvite): Promise<Array<{ id: string; name: string }>> {
    const out: Array<{ id: string; name: string }> = [];
    for (const { id, doc } of await this.storeOf(pond).list(`channels/${pond.id}/joins`)) {
      try {
        const inner = readJoinRequest(this.openDoc(pond, this.docPath(pond.id, "joins", id), doc));
        if (inner && inner.requestId === id && safeEqual(joinProof(invite.secret, id, inner.publicKey), inner.proof))
          out.push({ id, name: inner.name });
      } catch {
        // Not readable: not ours to remove.
      }
    }
    return out;
  }

  /** A pond-scoped token for a member of a Catalyst pond, or undefined where there is no relay (Firebase). */
  private async tokenFor(pond: LocalPond, member: MemberDoc): Promise<HeldToken | undefined> {
    const relay = this.options.relay;
    if (!relay || (pond.location as { provider?: string } | null)?.provider !== "catalyst") return undefined;
    const scope: TokenScope = member.nest !== null && member.client !== "web" ? "member" : "guest";
    let issued;
    try {
      issued = await relay.issue(pond.id, member.id, scope, TOKEN_TTL_SEC);
    } catch {
      throw new FlotillaError("The relay would not give that member access; try again.", 503);
    }
    (pond.issued ??= {})[member.id] = { expiresAt: issued.expiresAt, scope };
    this.save();
    return { value: issued.token, expiresAt: issued.expiresAt };
  }

  private async sendKeyTo(pond: LocalPond, member: MemberDoc): Promise<void> {
    const docPath = this.docPath(pond.id, "keys", member.id);
    const token = await this.tokenFor(pond, member);
    const box = sealToMember(member.publicKey, {
      version: pond.current,
      key: pond.keys[String(pond.current)],
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

  private async sendRemoval(pond: LocalPond, member: MemberDoc): Promise<void> {
    const docPath = this.docPath(pond.id, "keys", member.id);
    const box = sealToMember(member.publicKey, { removed: true });
    const id = this.identity;
    await this.storeOf(pond).set(docPath, {
      box,
      sig: signText(id.privateKey, signedText(docPath, box)),
      device: id.id,
      at: this.now(),
    });
  }

  /** Before a member's token lapses, the owner's Mac issues a new one and writes it into their keys document. */
  private async renewTokens(pond: LocalPond): Promise<void> {
    const due = Object.entries(pond.issued ?? {}).filter(([, t]) => t.expiresAt - this.now() < TOKEN_RENEW_MS);
    if (due.length === 0) return;
    const members = await this.members(pond);
    for (const [memberId] of due) {
      const member = members.get(memberId);
      if (member && memberId !== this.identity.id) await this.sendKeyTo(pond, member);
      else delete pond.issued![memberId];
    }
    this.save();
  }

  /** Removes a member and rotates the pond key: a new key goes only to those who remain. */
  async removeMember(pondId: string, memberId: string): Promise<void> {
    await this.removeAndRotate(pondId, memberId, (gone) => `removed ${gone.name}`);
  }

  /**
   * A lost device: a member is one key on one Mac (`memberId` is the hash of that key), so the Mac's key is the member.
   * The device id must name that key, so a stale or guessed id removes nobody. Then the pond key rotates.
   */
  async removeDevice(pondId: string, memberId: string, deviceKeyId: string): Promise<void> {
    if (deviceKeyId !== memberId) throw new FlotillaError("No such device.", 404);
    await this.removeAndRotate(pondId, memberId, (gone) => `removed ${gone.name}'s Mac`);
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
    await this.revokeToken(pond, memberId, "Squeak couldn't end that member's access. Try again.");
    // Their keys document becomes a note sealed to their key, signed by this owner: "removed". A member whose token still
    // reads (Firebase has none) learns it from that; on Catalyst the revoked token says the same by refusing them.
    await this.sendRemoval(pond, gone).catch(() => undefined);
    await store.delete(this.docPath(pond.id, "members", memberId));
    await store.delete(this.docPath(pond.id, "presence", memberId));
    // Whatever they still held (a question being answered) goes with them: a hold by a key that is no member reads as nothing.
    await this.dropHoldsOf(pond, memberId).catch(() => undefined);
    members.delete(memberId);
    pond.rotationPending = true;
    this.save();
    // Said as soon as they are out: the rotation below is many relay calls, and a failure there must not leave the
    // removal unrecorded.
    const sentence = say(gone);
    if (sentence) await this.ripple(pondId, sentence).catch(() => undefined);
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
    await this.writeMember(pond, { ...found, role });
    await this.ripple(pondId, `made ${found.name} ${role === "viewer" ? "a viewer" : "a member"}`).catch(
      () => undefined,
    );
    this.emit("changed", pondId);
  }

  /** A member leaves: told to the owner (who then removes the key), and the pond is forgotten here. An owner deletes instead. */
  async leave(pondId: string): Promise<void> {
    const pond = this.activePond(pondId);
    if (pond.role === "owner") throw new FlotillaError("An owner can't leave a pond: delete it instead.", 409);
    await this.ripple(pondId, "left the pond");
    await this.storeOf(pond)
      .delete(this.docPath(pond.id, "presence", this.identity.id))
      .catch(() => undefined);
    this.forgetPond(pondId);
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
    const kinds = [
      "keys",
      "presence",
      "holds",
      "ripples",
      "joins",
      "joinids",
      "threads",
      "tevents",
      "tcmds",
      "grants",
      "tasks",
      "claims",
      "locks",
    ];
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
    if (pond.status === "pending") return this.cancelJoin(pondId);
    if (!TERMINAL.includes(pond.status)) {
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
        await this.revokeToken(pond, member.id, "Squeak couldn't end a member's old access. Try again.");
      }
    }
    await this.rotate(pond, members);
    await this.ripple(pondId, "changed the pond key");
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
      if (member.id !== this.identity.id) await this.sendKeyTo(pond, member);
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
    await this.republishThreads(pond);
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

  /** A joiner's request: approved, declined, withdrawn, lapsed, or still waiting. Never left "waiting" on a dead invite. */
  private async refreshPending(pond: LocalPond): Promise<void> {
    const me = this.identity;
    const lapsed = (): boolean => pond.inviteExpiresAt !== undefined && this.now() >= pond.inviteExpiresAt;
    let read: { members: Map<string, MemberDoc>; raw: number };
    try {
      read = await this.membersRead(pond);
      if (read.members.size === 0 && read.raw > 0) {
        // Approved with a newer key than the invite's: the key arrives in this member's own keys document.
        await this.syncKeys(pond, false);
        read = await this.membersRead(pond);
      }
    } catch (error) {
      if (!FlotillaService.isAccessEnded(error)) throw error;
      // The join token is refused: the owner withdrew the invite, or it ran out at 24 h.
      this.markEnded(pond, lapsed() ? "expired" : "revoked");
      return;
    }
    const mine = read.members.get(me.id);
    if (mine) {
      pond.status = "active";
      pond.role = mine.role;
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
    if (lapsed()) {
      this.markEnded(pond, "expired");
      return;
    }
    if (pond.requestId && !(await this.storeOf(pond).get(this.docPath(pond.id, "joins", pond.requestId)))) {
      // The request is gone. Approval writes the member first and deletes the request after, so look again before
      // calling it a decline.
      const again = await this.membersRead(pond);
      if (again.members.has(me.id)) return this.refreshPending(pond);
      this.markEnded(pond, "denied");
      this.emit("declined", pond.id);
    }
  }

  private async refreshActive(pond: LocalPond): Promise<void> {
    const me = this.identity;
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
      const mine = read.members.get(me.id);
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
    await this.republishThreads(pond);
    if (pond.role === "owner") {
      await this.renewTokens(pond).catch(() => undefined);
      await this.reapLeavers(pond).catch(() => undefined);
    }
  }

  /** A member who said "left the pond" is removed by the owner's Mac (their key and the pond key change). */
  private async reapLeavers(pond: LocalPond): Promise<void> {
    const members = await this.members(pond);
    const since = pond.reapedAt ?? 0;
    let newest = since;
    const leavers = new Set<string>();
    for (const { id, doc } of await this.storeOf(pond).list(`channels/${pond.id}/ripples`)) {
      const read = this.readSigned(pond, "ripples", id, doc, (d) => members.get(d)?.publicKey ?? null);
      const r = read ? readRipple(read.value) : null;
      if (!r || r.actor !== read!.device || r.at <= since) continue;
      newest = Math.max(newest, r.at);
      if (r.text === "left the pond" && r.actor !== this.identity.id && members.has(r.actor)) leavers.add(r.actor);
    }
    for (const id of leavers) await this.removeAndRotate(pond.id, id, () => "").catch(() => undefined);
    if (newest !== since) {
      pond.reapedAt = newest;
      this.save();
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
        removed?: unknown;
        token?: { value?: unknown; expiresAt?: unknown };
      }>(me.privateKey, doc.box);
      if (grant.removed === true) {
        // A person asking to join again still has the old note: it ends nothing until the owner approves.
        if (allowRemoval) this.markEnded(pond, "removed");
        return;
      }
      if (typeof grant.version === "number" && typeof grant.key === "string" && !pond.keys[String(grant.version)]) {
        pond.keys[String(grant.version)] = grant.key;
        pond.current = Math.max(pond.current, grant.version);
        this.save();
      }
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

  /** After a rotation, a starter's thread documents move to the new key. */
  private async republishThreads(pond: LocalPond): Promise<void> {
    for (const [threadId, local] of Object.entries(pond.threads)) {
      if (local.private) continue;
      const doc = await this.storeOf(pond).get(this.docPath(pond.id, "threads", threadId));
      if (doc && !doc.box.startsWith(`${pond.current}.`)) this.emit("republish", pond.id, threadId);
    }
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
  start(): void {
    for (const id of this.pondIds()) {
      this.watch(id);
      this.wake(id);
    }
    if (!this.beatTimer) {
      this.beatTimer = setInterval(() => this.beat(), BEAT_MS);
      this.beatTimer.unref?.();
    }
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
    if (this.beatTimer) clearInterval(this.beatTimer);
    this.beatTimer = null;
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
      const read = this.readSigned(pond, "threads", id, doc, (d) => members.get(d)?.publicKey ?? null);
      const thread = read ? readThread(read.value) : null;
      if (!thread || thread.id !== id || thread.starter !== read!.device || thread.private) continue;
      const mine = this.localThread(pond.id, id);
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
      const me = this.identity;
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

  async view(pondId: string, options: { coordination?: boolean } = {}): Promise<PondView> {
    const pond = this.pond(pondId);
    if (pond.status !== "active") return this.idleView(pond);
    if (pond.local) return this.liveView(pond, options);
    // One that does not finish within the budget answers with the last good read, and carries on to refresh it.
    const work = this.readView(pond, options);
    work.catch(() => undefined);
    return this.within(work, this.budgetMs, () => {
      const stale = this.staleView(pond);
      if (!stale) throw new FlotillaError(CLOUD_DOWN, 503);
      return stale;
    });
  }

  /** A pond that is not (or not yet) the person's to read: its state and the sentence for it, and nothing else. */
  private idleView(pond: LocalPond): PondView {
    const me = this.identity;
    return {
      pond: this.summary(pond, 0, 0, 0),
      cloud: this.hasCloud(),
      members: [],
      threads: [],
      ripples: [],
      presence: [],
      holds: [],
      joins: [],
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

  private async readView(pond: LocalPond, options: { coordination?: boolean }): Promise<PondView> {
    try {
      const view = await this.liveView(pond, options);
      this.remember(pond.id, {
        counts: { members: view.members.length, threads: view.threads.length, needsYou: view.pond.needsYou },
        view: this.metadataOnly(view),
      });
      return view;
    } catch (error) {
      if (FlotillaService.isAccessEnded(error)) {
        const verdict = await this.onAccessEnded(pond);
        if (verdict === "removed") return this.idleView(pond);
        if (verdict === "ok") return this.liveView(pond, options);
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
      joins: [],
    };
  }

  private async liveView(pond: LocalPond, options: { coordination?: boolean } = {}): Promise<PondView> {
    const me = this.identity;
    if (pond.local) {
      // Same page as a published pond: a flock of just you, no threads or Ripples in the cloud yet.
      return {
        pond: this.summary(pond, 1, 0, 0),
        cloud: this.hasCloud(),
        members: [
          {
            id: me.id,
            name: me.name,
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
        ...(options.coordination ? { tasks: [], locks: [] } : {}),
        joins: [],
        me: { id: me.id, name: me.name, role: pond.role, nest: me.nest },
      };
    }
    const members = await this.members(pond);
    if (members.size === 0 || (pond.role !== "owner" && !members.has(me.id))) {
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
    const memberKey = (d: string): string | null => members.get(d)?.publicKey ?? null;
    const store = this.storeOf(pond);
    // Everything here is independent of everything else: one round trip's time, not ten.
    const [presenceRows, holds, rippleRows, threadsRead, joinRows, coordination] = await Promise.all([
      store.list(`channels/${pond.id}/presence`),
      this.holdsOf(pond, members),
      store.list(`channels/${pond.id}/ripples`),
      this.threadsOf(pond, members),
      pond.role === "owner" ? this.pendingJoins(pond, members) : Promise.resolve([]),
      options.coordination
        ? Promise.all([
            this.coordination.tasks(pond.id).catch((): TaskView[] => []),
            this.coordination.locks(pond.id).catch((): LockDoc[] => []),
          ])
        : Promise.resolve(null),
    ]);
    const now = this.now();
    const presence: PresenceDoc[] = [];
    const beat = new Map<string, number>();
    for (const { id, doc } of presenceRows) {
      const read = this.readSigned(pond, "presence", id, doc, memberKey);
      const p = read ? readPresence(read.value) : null;
      if (p && p.memberId === read!.device && p.until > now) {
        const at = p.at ?? p.until - PRESENCE_MS;
        beat.set(p.memberId, at);
        // `online` is the heartbeat's age, not what the writer claimed: a document with its own `at` lives until its
        // `until`; an older writer's (45 s of beats) is judged by ONLINE_MS.
        presence.push({ ...p, online: p.online && (p.at !== undefined ? now < p.until : now - at < ONLINE_MS) });
      }
    }
    const online = new Set(presence.filter((p) => p.online).map((p) => p.memberId));
    online.add(me.id);
    const ripples: Ripple[] = [];
    for (const { id, doc } of rippleRows) {
      const read = this.readSigned(pond, "ripples", id, doc, memberKey);
      const r = read ? readRipple(read.value) : null;
      if (r && r.id === id && r.actor === read!.device) ripples.push(r);
    }
    ripples.sort((a, b) => b.at - a.at);
    const threads = threadsRead.map((t) => this.decorateThread(t, online, me.id));
    const needsYou = this.needsCount(pond, threads);
    return {
      pond: this.summary(pond, members.size, threads.length, needsYou),
      cloud: this.hasCloud(),
      members: [...members.values()].map((m) => ({
        id: m.id,
        name: m.name,
        role: m.role,
        nest: m.nest,
        nestName: m.nest,
        client: m.client ?? (m.nest === null ? "web" : "mac"),
        online: online.has(m.id),
        ...(m.id === me.id ? { lastSeenAt: now } : beat.has(m.id) ? { lastSeenAt: beat.get(m.id)! } : {}),
        you: m.id === me.id,
      })),
      threads,
      ripples: ripples.slice(0, 50).map((r) => this.rippleView(pond, r, members)),
      presence,
      holds: holds.map((h) => ({ ...h, heldBy: h.by, heldByName: h.byName })),
      ...(coordination ? { tasks: coordination[0], locks: coordination[1] } : {}),
      joins: joinRows.map(
        ({ requestId, name, nest, role, client, verifiedEmail, verifiedName, requestedAt, stale }) => {
          const decision = stale ? { state: "failed" as const, line: stale } : this.decisionFor(pond.id, requestId);
          return {
            requestId,
            name,
            nest,
            role,
            ...(client ? { client } : {}),
            ...(verifiedEmail ? { verifiedEmail } : {}),
            ...(verifiedName ? { verifiedName } : {}),
            ...(requestedAt ? { requestedAt } : {}),
            ...(decision ? { decision } : {}),
          };
        },
      ),
      ...(pond.role === "owner" ? { invites: this.inviteViews(pond) } : {}),
      me: { id: me.id, name: this.nameIn(pond), role: pond.role, nest: me.nest },
    };
  }

  /**
   * A Ripple as a surface draws it: "<actorName or You> <text>". The name is the member it is about (the Mac that wrote it
   * says so for another member's answer or joining), else the signer's, from the flock; a name already at the start of an
   * older Ripple's text is not said twice, and a thread's title never shows once that thread is private.
   */
  private rippleView(pond: LocalPond, r: Ripple, members: Map<string, MemberDoc>): Ripple & { actorName?: string } {
    const actorName = r.onBehalf?.name ?? members.get(r.actor)?.name;
    let text = r.text;
    if (actorName && text.toLowerCase().startsWith(`${actorName.toLowerCase()} `))
      text = text.slice(actorName.length + 1);
    // Ripples written before names were left out of them: "<name> made the pond".
    for (const t of Object.values(pond.threads)) {
      if (t.private && t.title && text.includes(t.title)) text = text.replace(t.title, "a private thread");
    }
    return { ...r, text, ...(actorName ? { actorName } : {}) };
  }

  private inviteViews(pond: LocalPond): InviteView[] {
    this.sweepInvites(pond);
    return pond.invites
      .filter((i): i is LocalInvite & { id: string } => typeof i.id === "string")
      .map((i) => {
        const state = this.inviteState(i);
        return {
          id: i.id,
          role: i.role,
          state,
          ...(i.createdAt ? { createdAt: i.createdAt } : {}),
          expiresAt: i.expiresAt,
          ...(i.usedBy ? { usedBy: i.usedBy } : {}),
          ...(state === "pending" && i.link ? { link: i.link } : {}),
          ...(state === "pending" && i.code ? { code: i.code } : {}),
        };
      })
      .sort((a, b) => (b.createdAt ?? b.expiresAt) - (a.createdAt ?? a.expiresAt));
  }

  // presence, ripples, holds

  async setPresence(pondId: string, input: { viewing?: string; typing?: string; online?: boolean }): Promise<void> {
    const pond = this.activePond(pondId);
    this.lastPresence.set(pondId, {
      ...(input.viewing ? { viewing: input.viewing } : {}),
      ...(input.typing ? { typing: input.typing } : {}),
      at: this.now(),
    });
    const online = input.online ?? true;
    // A write is a notice to every member's Mac: left out when nothing changed (until the next heartbeat is due),
    // and a change is written at most every few seconds.
    const prev = this.lastPresenceWrite.get(pondId);
    if (prev) {
      const age = this.now() - prev.at;
      const same = prev.online === online && prev.viewing === input.viewing && prev.typing === input.typing;
      if ((same && age < BEAT_MS - 5_000) || (!same && age < PRESENCE_CHANGE_MIN_MS)) {
        this.stats.presenceSkipped += 1;
        return;
      }
    }
    const at = this.now();
    const doc: PresenceDoc = {
      memberId: this.identity.id,
      online,
      at,
      until: at + PRESENCE_TTL_MS,
      ...(input.viewing ? { viewing: input.viewing } : {}),
      ...(input.typing ? { typing: input.typing } : {}),
    };
    await this.put(pond, "presence", this.identity.id, doc);
    this.stats.presenceWrites += 1;
    this.lastPresenceWrite.set(pondId, {
      online,
      at,
      ...(input.viewing ? { viewing: input.viewing } : {}),
      ...(input.typing ? { typing: input.typing } : {}),
    });
  }

  /** The host's own heartbeat: a running Mac is online in every pond it is in, with what its app last said it was viewing. */
  private beat(): void {
    for (const pond of Object.values(this.pondsFile.data.ponds)) {
      if (pond.status !== "active" || pond.local) continue;
      const known = this.snapshotFile.data.ponds[pond.id]?.counts.members ?? 0;
      if (pond.role === "owner" && known <= 1) continue;
      const last = this.lastPresence.get(pond.id);
      const fresh = last && this.now() - last.at < BEAT_MS * 2 ? last : undefined;
      void this.setPresence(pond.id, {
        ...(fresh?.viewing ? { viewing: fresh.viewing } : {}),
        ...(fresh?.typing ? { typing: fresh.typing } : {}),
      }).catch(() => undefined);
    }
  }

  async ripple(pondId: string, text: string, onBehalf?: { id: string; name: string }): Promise<string> {
    const pond = this.activePond(pondId);
    const at = this.now();
    const id = `${at.toString(36).padStart(9, "0")}-${randomId(3)}`;
    const ripple: Ripple = {
      id,
      at,
      actor: this.identity.id,
      text: text.slice(0, 500),
      ...(onBehalf ? { onBehalf: { id: onBehalf.id.slice(0, 64), name: onBehalf.name.slice(0, 100) } } : {}),
    };
    await this.put(pond, "ripples", id, ripple);
    // Keep the feed short: forget the oldest beyond a hundred.
    const all = await this.storeOf(pond).list(`channels/${pond.id}/ripples`);
    if (all.length > RIPPLE_KEEP + 20) {
      const old = all
        .map((r) => r.id)
        .sort()
        .slice(0, all.length - RIPPLE_KEEP);
      for (const gone of old) await this.storeOf(pond).delete(this.docPath(pond.id, "ripples", gone));
    }
    return id;
  }

  private async holdsOf(pond: LocalPond, members: Map<string, MemberDoc>): Promise<Hold[]> {
    const out: Hold[] = [];
    for (const { id, doc } of await this.storeOf(pond).list(`channels/${pond.id}/holds`)) {
      const read = this.readSigned(pond, "holds", id, doc, (d) => members.get(d)?.publicKey ?? null);
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
    this.allow(pond, "answer-question", { thread: { starter: "", private: false } }, "Viewers can read but not send.");
    const me = this.identity;
    const members = await this.members(pond);
    const existing = (await this.holdsOf(pond, members)).find((h) => h.requestId === requestId);
    if (existing && existing.by !== me.id) return { ok: false, heldBy: existing.byName };
    const mine: Hold = { requestId, by: me.id, byName: this.nameIn(pond), until: this.now() + HOLD_MS };
    await this.put(pond, "holds", requestId, mine);
    const back = (await this.holdsOf(pond, members)).find((h) => h.requestId === requestId);
    if (back && back.by !== me.id) return { ok: false, heldBy: back.byName };
    return { ok: true, heldBy: this.nameIn(pond) };
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
   * The narrow handle `coordination.ts` builds tasks, claims and scope locks on: sealed, signed documents of a kind
   * it names, read back only when a current member of the pond signed them. Nothing else of the service leaks.
   */
  coordinationPort(pondId: string): CoordinationPort {
    const pond = this.activePond(pondId);
    const me = this.identity;
    const store = this.storeOf(pond);
    return {
      me: { id: me.id, name: me.name },
      role: pond.role,
      ownerId: memberIdOf(pond.ownerKey),
      now: this.now,
      put: (kind, docId, value) => this.put(pond, kind, docId, value),
      remove: (kind, docId) => store.delete(this.docPath(pond.id, kind, docId)),
      list: async (kind) => {
        const members = await this.members(pond);
        const out: SignedDoc[] = [];
        for (const { id, doc } of await store.list(`channels/${pond.id}/${kind}`)) {
          const read = this.readSigned(pond, kind, id, doc, (d) => members.get(d)?.publicKey ?? null);
          const member = read ? members.get(read.device) : undefined;
          if (read && member) out.push({ id, value: read.value, device: read.device, role: member.role });
        }
        return out;
      },
      ripple: async (text) => void (await this.ripple(pondId, text).catch(() => undefined)),
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
    },
  ): Promise<PondThread> {
    const pond = this.activePond(pondId);
    this.allow(pond, "start-thread", {}, VIEWERS_READ);
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
      participants: [
        { memberId: this.identity.id, name: this.nameIn(pond), lastAt: new Date(this.now()).toISOString() },
      ],
      seq: 0,
      batches: [],
    };
    this.save();
    pond.threads[threadId]!.state = input.state ?? "idle";
    const thread = this.threadDoc(pond, threadId, input.state ?? "idle", input.permissionMode);
    if (!pond.threads[threadId]!.private) {
      await this.put(pond, "threads", threadId, thread);
      // A private thread says nothing to the pond, its title least of all.
      const rippleId = await this.ripple(pondId, `${input.mode === "own" ? "started" : "shared"} ${input.title}`).catch(
        () => undefined,
      );
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
    const me = this.identity;
    if (permissionMode) local.permissionMode = permissionMode;
    permissionMode ??= local.permissionMode;
    return {
      id: threadId,
      title: local.title,
      starter: me.id,
      starterName: this.nameIn(pond),
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
  private shape(local: LocalThread): Pick<PondThread, "workspace" | "branch" | "participants"> {
    return {
      ...(local.workspace ? { workspace: local.workspace } : {}),
      ...(local.branch ? { branch: local.branch } : {}),
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
      { memberId: this.identity.id, name: this.identity.name, lastAt: new Date(at).toISOString() },
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
        await store.delete(this.docPath(pond.id, "ripples", local.rippleId)).catch(() => undefined);
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

  /** One batch of events, one document; then the thread keeps only its newest 500. */
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
    let total = local.batches.reduce((n, [a, b]) => n + (b - a + 1), 0);
    while (local.batches.length > 1 && total - (local.batches[0]![1] - local.batches[0]![0] + 1) >= KEEP_EVENTS) {
      const [a, b] = local.batches.shift()!;
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
      ? this.readSigned(pond, "threads", threadId, threadDoc, (d) => members.get(d)?.publicKey ?? null)
      : null;
    const thread = threadRead ? readThread(threadRead.value) : null;
    if (!thread || thread.private) {
      const mine = pond.threads[threadId];
      if (!mine) throw new FlotillaError("no such thread", 404);
    }
    const starter = thread?.starter ?? this.identity.id;
    const starterKey = members.get(starter)?.publicKey;
    if (!starterKey) throw new FlotillaError("no such thread", 404);
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
    this.allow(pond, COMMAND_ACTION[input.kind], { thread: { starter: "", private: false } }, VIEWERS_READ);
    const me = this.identity;
    const threads = await this.threadsOf(pond);
    const thread = threads.find((t) => t.id === threadId);
    if (!thread || thread.private) throw new FlotillaError("That thread is no longer shared with the pond.", 404);
    if (thread.starter === me.id) throw new FlotillaError("That is your own thread.");
    if (input.kind !== "answer" && !FlotillaService.asks(thread.permissionMode)) {
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
    if (!pond || pond.status !== "active" || Object.keys(pond.threads).length === 0) return [];
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
    if (!doc.sig || !verifyText(from.publicKey, signedText(docPath, doc.box), doc.sig)) return "bad signature";
    if (!doc.box.startsWith(`${pond.current}.`)) return "sealed with an old key";
    let value: unknown;
    try {
      value = this.openDoc(pond, docPath, doc);
    } catch {
      return "unreadable";
    }
    const raw = value as { threadId?: unknown } | null;
    if (typeof raw?.threadId === "string" && !pond.threads[raw.threadId]) return "not-mine";
    const cmd = readCommand(value);
    if (!cmd || cmd.id !== id) return "not a command this Mac runs";
    const thread = pond.threads[cmd.threadId];
    if (!thread) return "not-mine";
    // The only things a member can ask of a starter are COMMAND_ACTION's: approving and stopping are not among them.
    const verdict = can({ kind: "human", memberId: from.id, role: from.role }, COMMAND_ACTION[cmd.kind], {
      thread: { starter: this.identity.id, private: thread.private },
    });
    if (!verdict.ok) return thread.private && from.role !== "viewer" ? "that thread is private" : VIEWERS_READ;
    const now = this.now();
    if (cmd.expiresAt <= now) return "expired";
    if (cmd.expiresAt - cmd.issuedAt > MAX_COMMAND_LIFE_MS) return "lives too long";
    if (cmd.issuedAt > now + MAX_SKEW_MS) return "from the future";
    const nonceKey = `${from.id}:${cmd.nonce}`;
    for (const [key, until] of Object.entries(pond.nonces)) if (until < now) delete pond.nonces[key];
    if (pond.nonces[nonceKey] !== undefined) return "already used";
    pond.nonces[nonceKey] = cmd.expiresAt + MAX_SKEW_MS;
    this.save();
    return { cmd, from, thread };
  }

  /**
   * Withdraws this Mac's own join request (or clears a declined one): the request document is deleted, best effort, and
   * the pending pond forgotten. An active pond is never touched.
   */
  async cancelJoin(pondId: string): Promise<void> {
    const pond = this.pondsFile.data.ponds[pondId];
    if (!pond) throw new FlotillaError("There is no such request.", 404);
    if (pond.status !== "pending" && pond.status !== "denied") {
      throw new FlotillaError("You are already in that pond.", 409);
    }
    if (pond.status === "pending" && pond.requestId) {
      await this.storeOf(pond)
        .delete(this.docPath(pond.id, "joins", pond.requestId))
        .catch(() => undefined);
    }
    this.forgetPond(pondId);
  }

  /** Forget a member's pending work and local ponds, for tests and for leaving. */
  forgetPond(pondId: string): void {
    this.watches.get(pondId)?.();
    this.watches.delete(pondId);
    delete this.pondsFile.data.ponds[pondId];
    this.save();
    this.lastPresence.delete(pondId);
    this.lastPresenceWrite.delete(pondId);
    this.echoes.delete(pondId);
    this.backoffs.delete(pondId);
    this.summaryCache.delete(pondId);
    this.forgetSnapshot(pondId);
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
  "decideJoin",
  "hold",
  "sendCommandTo",
  "invite",
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
