import { EventEmitter } from "node:events";
import path from "node:path";

import { realtimeDatabaseOrigin, relayBaseUrl } from "../cloud/location.js";
import type { CloudStore } from "../cloud/store.js";
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
  /** The last seq handed out. */
  seq: number;
  /** [first, last] seq of each batch in the cloud, oldest first. */
  batches: Array<[number, number]>;
}

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
}

/** What an owner sees of an invite: never the secret or the code. */
export interface InviteView {
  id: string;
  role: Role;
  state: InviteState;
  expiresAt: number;
}

/** A pond-scoped relay token a member holds (docs/ponds.md, "Scoped tokens"). */
interface HeldToken {
  value: string;
  /** Unix milliseconds. */
  expiresAt: number;
}

interface LocalPond {
  id: string;
  name: string;
  status: "pending" | "active" | "removed" | "denied";
  role: Role;
  ownerKey: string;
  location: unknown;
  /** Pond keys by version. The newest is `current`. */
  keys: Record<string, string>;
  current: number;
  requestId?: string;
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
  status: LocalPond["status"];
  /** True until the first invite publishes it: only this Mac can see it. */
  local?: boolean;
  /** True when the relay could not be reached and this is the last known state (docs/ponds.md, "Offline"). */
  offline?: true;
  /** Unix ms of the last good read this came from; present only with `offline`. */
  asOf?: number;
}

export interface MemberView {
  id: string;
  name: string;
  role: Role;
  nest: string | null;
  online: boolean;
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
}

export interface PondView {
  pond: PondSummary;
  /** Whether this Mac has a cloud store an invite could publish to. */
  cloud?: boolean;
  members: MemberView[];
  threads: PondThread[];
  ripples: Ripple[];
  presence: PresenceDoc[];
  holds: Hold[];
  /** Tasks with their live claim folded in, most recently changed first. */
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
}

/** What the last good read of a pond left on disk: metadata only, never a thread's events or a message body. */
interface PondSnapshot {
  asOf: number;
  counts: { members: number; threads: number; needsYou: number };
  view?: PondView;
}

export const OFFLINE_WRITE = "The pond can't be reached right now, so it is read-only until the connection returns.";

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
const DECLINED_SENTENCE = "The owner declined your request to join.";
const RIPPLE_KEEP = 100;
/** A scoped token lasts as long as the relay allows; the owner's Mac renews it when under 3 days remain. */
const TOKEN_TTL_SEC = 30 * 24 * 3600;
const TOKEN_RENEW_MS = 3 * 24 * 3600_000;

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
  private readonly snapshotFile: SecretFile<{ ponds: Record<string, PondSnapshot> }>;
  /** Ponds whose last read failed: writes are refused with a fixed sentence until a read succeeds. */
  private readonly unreachable = new Set<string>();
  /** Tasks, claims and scope locks (docs/ponds.md, "Tasks, claims and scope locks"). */
  readonly coordination = new PondCoordination((pondId) => this.coordinationPort(pondId));

  constructor(private readonly options: FlotillaOptions) {
    super();
    this.now = options.now ?? Date.now;
    const dir = path.join(options.supportDir, "flotilla");
    this.identityFile = new SecretFile(path.join(dir, "identity.json"), () => ({ identity: null }));
    this.pondsFile = new SecretFile(path.join(dir, "ponds.json"), () => ({ ponds: {} }));
    // Same at-rest protection as the keys beside it (0600, in the 0700 folder).
    this.snapshotFile = new SecretFile(path.join(dir, "snapshot.json"), () => ({ ponds: {} }));
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

  private assertReachable(pond: LocalPond): void {
    if (this.unreachable.has(pond.id)) throw new FlotillaError(OFFLINE_WRITE, 503);
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
    if (pond.status === "denied") throw new FlotillaError(DECLINED_SENTENCE, 403);
    if (pond.status !== "active") throw new FlotillaError("you no longer have access to this pond", 403);
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
        store = this.options.storeFor(pond.location, credential);
        this.stores.set(key, store);
      }
      return store;
    }
    if (!this.options.store) throw new FlotillaError(NO_CLOUD, 503);
    return this.options.store;
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
    this.allow(pond, "start-thread", {}, "A viewer can only watch.");
    await this.put(pond, "grants", this.identity.id, written);
    return written;
  }

  // sealed, signed documents

  private docPath = (pondId: string, kind: string, doc: string): string => `channels/${pondId}/${kind}/${doc}`;

  private async put(pond: LocalPond, kind: string, docId: string, value: unknown): Promise<void> {
    const docPath = this.docPath(pond.id, kind, docId);
    const box = `${pond.current}.${sealAt(pond.keys[String(pond.current)]!, docPath, value)}`;
    const id = this.identity;
    this.assertReachable(pond);
    try {
      await this.storeOf(pond).set(docPath, {
        box,
        sig: signText(id.privateKey, signedText(docPath, box)),
        device: id.id,
        at: this.now(),
      });
    } catch (error) {
      if (FlotillaService.isOutage(error)) throw new FlotillaError(OFFLINE_WRITE, 503);
      throw error;
    }
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

  private async members(pond: LocalPond): Promise<Map<string, MemberDoc>> {
    const found = new Map<string, MemberDoc>();
    const ownerOnly = (device: string): string | null => (device === memberIdOf(pond.ownerKey) ? pond.ownerKey : null);
    for (const { id, doc } of await this.storeOf(pond).list(`channels/${pond.id}/members`)) {
      const read = this.readSigned(pond, "members", id, doc, ownerOnly);
      const member = read ? readMember(read.value) : null;
      if (member && member.id === id && memberIdOf(member.publicKey) === id) found.set(id, member);
    }
    return found;
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
      await this.ripple(pond.id, `${me.name} made the pond`).catch(() => undefined);
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
    await this.ripple(id, `${me.name} made the pond`);
    return this.summary(pond, 1, 0, 0);
  }

  private async writeMember(pond: LocalPond, member: MemberDoc): Promise<void> {
    await this.put(pond, "members", member.id, member);
  }

  private summary(pond: LocalPond, members: number, threads: number, needsYou: number): PondSummary {
    const hash = [...pond.id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
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
      status: pond.status,
      ...(pond.local ? { local: true } : {}),
    };
  }

  async list(): Promise<PondSummary[]> {
    const out: PondSummary[] = [];
    const live = new Set<string>();
    for (const pond of Object.values(this.pondsFile.data.ponds)) {
      if (pond.status !== "active" && pond.status !== "pending") continue;
      live.add(pond.id);
      if (pond.local) {
        out.push(this.summary(pond, 1, 0, 0));
        continue;
      }
      let members = 0;
      let threads: PondThread[] = [];
      let failed = false;
      if (pond.status === "active") {
        try {
          members = (await this.members(pond)).size;
          threads = await this.threadsOf(pond);
          this.unreachable.delete(pond.id);
          const view = this.snapshotFile.data.ponds[pond.id]?.view;
          // A member who reads no members at all has lost access (the pond key moved on without them).
          if (members === 0 && pond.role !== "owner") this.forgetSnapshot(pond.id);
          else
            this.remember(pond.id, {
              counts: {
                members,
                threads: threads.length,
                needsYou: threads.filter((t) => t.state === "waiting").length,
              },
              ...(view ? { view } : {}),
            });
        } catch (error) {
          if (FlotillaService.isOutage(error)) this.unreachable.add(pond.id);
          failed = true;
        }
      }
      const snap = this.snapshotFile.data.ponds[pond.id];
      if (failed && snap) {
        out.push({
          ...this.summary(pond, snap.counts.members, snap.counts.threads, snap.counts.needsYou),
          offline: true,
          asOf: snap.asOf,
        });
        continue;
      }
      out.push(this.summary(pond, members, threads.length, threads.filter((t) => t.state === "waiting").length));
    }
    // A pond that is gone (removed, denied, left) is gone from the cache too.
    for (const id of Object.keys(this.snapshotFile.data.ponds)) if (!live.has(id)) this.forgetSnapshot(id);
    return out;
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
    pond.invites.push({ id, secret, role, expiresAt, state: "pending", ...(tokenId ? { tokenId } : {}) });
    this.save();
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
      l: location,
      ...(joinToken ? { jt: joinToken } : {}),
    };
    const code = INVITE_PREFIX + Buffer.from(JSON.stringify(body)).toString("base64url");
    // The link form keeps the secret in the fragment, which a browser never sends to any server.
    const base = this.options.inviteLinkBase?.replace(/[#?].*$/, "").replace(/\/+$/, "");
    return { code, expiresAt, id, ...(base ? { link: `${base}#${code.slice(INVITE_PREFIX.length)}` } : {}) };
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
    this.identityFile.data.identity!.name = name;
    this.identityFile.save();
    const requestId = retry?.requestId ?? randomId(12);
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
      at: this.now(),
    };
    await this.put(pond, "joins", requestId, request);
    return { pondId: p, status: "pending" };
  }

  /** Join requests an owner can decide on: signed by their own key and proving an unexpired invite's secret. */
  private async pendingJoins(pond: LocalPond): Promise<Array<JoinView & { publicKey: string; proof: string }>> {
    type Row = JoinView & { publicKey: string; proof: string };
    const best = new Map<string, { row: Row; at: number }>();
    const members = await this.members(pond);
    for (const { id, doc } of await this.storeOf(pond).list(`channels/${pond.id}/joins`)) {
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
      const invite = this.pendingInviteFor(pond, id, request.publicKey, request.proof);
      if (invite) {
        const who = await this.verifiedIdentity(pond, id);
        const row: Row = {
          requestId: id,
          name: request.name,
          nest: request.nest,
          ...(request.client ? { client: request.client } : {}),
          role: invite.role,
          ...who,
          publicKey: request.publicKey,
          proof: request.proof,
        };
        // One request per invite and per key: the newest by `at` (none = oldest), ties by request id.
        const at = request.at ?? 0;
        for (const group of [`i:${invite.secret}`, `k:${request.publicKey}`]) {
          const held = best.get(group);
          if (!held || at > held.at || (at === held.at && id > held.row.requestId)) best.set(group, { row, at });
        }
      }
    }
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
    const invite = this.pendingInviteFor(pond, winner.requestId, winner.publicKey, winner.proof);
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
    for (const id of ids) {
      await this.storeOf(pond)
        .delete(this.docPath(pond.id, "joins", id))
        .catch(() => undefined);
      await this.dropJoinIdentity(pond, id);
    }
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
  async decideJoin(pondId: string, requestId: string, input: { approve: boolean; role?: Role }): Promise<void> {
    const pond = this.activePond(pondId);
    this.allow(pond, "decide-join", {}, "Only an owner can decide a join.");
    const request = (await this.pendingJoins(pond)).find((r) => r.requestId === requestId);
    if (!request) throw new FlotillaError("No such join request.", 404);
    const store = this.storeOf(pond);
    const invite = this.pendingInviteFor(pond, requestId, request.publicKey, request.proof);
    const superseded = await this.supersededJoins(pond, request).catch(() => [] as string[]);
    const consume = (state: "accepted" | "declined"): void => {
      if (invite) {
        invite.state = state;
        invite.decidedAt = this.now();
      }
      this.save();
    };
    if (!input.approve) {
      await store.delete(this.docPath(pond.id, "joins", requestId));
      await this.dropJoinIdentity(pond, requestId);
      await this.dropSuperseded(pond, superseded);
      consume("declined");
      await this.ripple(pondId, `${request.name}'s request to join was declined`).catch(() => undefined);
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
    await this.sendKeyTo(pond, member);
    await this.writeMember(pond, member);
    await store.delete(this.docPath(pond.id, "joins", requestId));
    await this.dropJoinIdentity(pond, requestId);
    await this.dropSuperseded(pond, superseded);
    consume("accepted");
    await this.ripple(pondId, `${member.name} joined`);
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
        throw new FlotillaError("The relay would not end that invite; try again.", 503);
      }
    }
    invite.state = "revoked";
    invite.decidedAt = this.now();
    this.save();
    for (const r of await this.pendingJoinsFor(pond, invite).catch(() => [])) {
      await this.storeOf(pond)
        .delete(this.docPath(pond.id, "joins", r))
        .catch(() => undefined);
      await this.dropJoinIdentity(pond, r);
    }
    await this.ripple(pondId, "An invite was revoked").catch(() => undefined);
    return { id: inviteId, state: "revoked" };
  }

  /** Request ids whose proof matches this invite (a revoked invite no longer lists them, so this reads the store). */
  private async pendingJoinsFor(pond: LocalPond, invite: LocalInvite): Promise<string[]> {
    const out: string[] = [];
    for (const { id, doc } of await this.storeOf(pond).list(`channels/${pond.id}/joins`)) {
      try {
        const inner = readJoinRequest(this.openDoc(pond, this.docPath(pond.id, "joins", id), doc));
        if (inner && inner.requestId === id && safeEqual(joinProof(invite.secret, id, inner.publicKey), inner.proof))
          out.push(id);
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
    await this.removeAndRotate(pondId, memberId, (gone) => `${gone.name} was removed`);
  }

  /**
   * A lost device: a member is one key on one Mac (`memberId` is the hash of that key), so the Mac's key is the member.
   * The device id must name that key, so a stale or guessed id removes nobody. Then the pond key rotates.
   */
  async removeDevice(pondId: string, memberId: string, deviceKeyId: string): Promise<void> {
    if (deviceKeyId !== memberId) throw new FlotillaError("No such device.", 404);
    await this.removeAndRotate(pondId, memberId, (gone) => `${gone.name}'s Mac was removed`);
  }

  private async removeAndRotate(pondId: string, memberId: string, say: (gone: MemberDoc) => string): Promise<void> {
    const pond = this.activePond(pondId);
    this.allow(pond, "remove-member", {}, "Only an owner can remove a member.");
    if (memberId === this.identity.id) throw new FlotillaError("An owner cannot remove themselves.");
    this.assertReachable(pond);
    const members = await this.members(pond);
    const gone = members.get(memberId);
    if (!gone) throw new FlotillaError("No such member.", 404);
    const store = this.storeOf(pond);
    // Their token ends first: if the relay will not revoke it, the removal stops here and can be retried.
    await this.revokeToken(pond, memberId, "The relay would not end that member's access; try again.");
    await store.delete(this.docPath(pond.id, "members", memberId));
    await store.delete(this.docPath(pond.id, "keys", memberId));
    await store.delete(this.docPath(pond.id, "presence", memberId));
    members.delete(memberId);
    await this.rotate(pond, members);
    await this.ripple(pondId, say(gone));
  }

  /** Owner only: a new pond key sealed to every current member, whose old tokens are ended and issued again. */
  async rotateKey(pondId: string): Promise<void> {
    const pond = this.activePond(pondId);
    if (pond.role !== "owner") throw new FlotillaError("Only an owner can change the pond key.", 403);
    if (pond.local) throw new FlotillaError(LOCAL_ONLY, 409);
    this.assertReachable(pond);
    const members = await this.members(pond);
    // Every other member's old token ends first; if the relay refuses, nothing has changed and it can be retried.
    for (const member of members.values()) {
      if (member.id !== this.identity.id) {
        await this.revokeToken(pond, member.id, "The relay would not end a member's old access; try again.");
      }
    }
    await this.rotate(pond, members);
    await this.ripple(pondId, "The pond key was changed");
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
  async refresh(pondId: string): Promise<void> {
    const pond = this.pondsFile.data.ponds[pondId];
    if (!pond || pond.status === "removed" || pond.status === "denied") return;
    const store = this.storeOf(pond);
    const me = this.identity;
    if (pond.status === "pending") {
      const members = await this.members(pond);
      const mine = members.get(me.id);
      if (mine) {
        pond.status = "active";
        pond.role = mine.role;
        this.save();
        await this.syncKeys(pond);
        const meta = await this.meta(pond);
        if (meta) {
          pond.name = meta.name;
          if (meta.gitRemote) pond.gitRemote = meta.gitRemote;
          this.save();
        }
      } else if (pond.requestId && !(await store.get(this.docPath(pond.id, "joins", pond.requestId)))) {
        pond.status = "denied";
        this.save();
      }
    } else {
      await this.syncKeys(pond);
      if (pond.role !== "owner") {
        const members = await this.members(pond).catch(() => null);
        const mine = members?.get(me.id);
        if (mine) {
          pond.role = mine.role;
        } else if (members && members.size > 0) {
          pond.status = "removed";
        }
        this.save();
      }
      if (pond.status === "active") await this.republishThreads(pond);
      if (pond.status === "active" && pond.role === "owner") await this.renewTokens(pond).catch(() => undefined);
    }
    this.emit("changed", pondId);
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
  private async syncKeys(pond: LocalPond): Promise<void> {
    const me = this.identity;
    const docPath = this.docPath(pond.id, "keys", me.id);
    const doc = await this.storeOf(pond).get(docPath);
    if (!doc?.sig || doc.device !== memberIdOf(pond.ownerKey)) return;
    if (!verifyText(pond.ownerKey, signedText(docPath, doc.box), doc.sig)) return;
    try {
      const grant = openFromMember<{ version: number; key: string; token?: { value?: unknown; expiresAt?: unknown } }>(
        me.privateKey,
        doc.box,
      );
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
      stop = this.storeOf(pond).watch(`channels/${pondId}`, () => this.wake(pondId));
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
  }

  stop(): void {
    for (const stop of this.watches.values()) stop();
    this.watches.clear();
  }

  /** A change during a pass schedules another, so nothing is dropped until a safety poll. */
  wake(pondId: string): void {
    if (this.running.has(pondId)) {
      this.dirty.add(pondId);
      return;
    }
    this.running.add(pondId);
    void (async () => {
      try {
        do {
          this.dirty.delete(pondId);
          try {
            await this.refresh(pondId);
            await this.pass(pondId);
          } catch (error) {
            this.emit("error-pass", error);
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

  private async threadsOf(pond: LocalPond): Promise<PondThread[]> {
    const members = await this.members(pond);
    const out: PondThread[] = [];
    for (const { id, doc } of await this.storeOf(pond).list(`channels/${pond.id}/threads`)) {
      const read = this.readSigned(pond, "threads", id, doc, (d) => members.get(d)?.publicKey ?? null);
      const thread = read ? readThread(read.value) : null;
      if (!thread || thread.id !== id || thread.starter !== read!.device || thread.private) continue;
      const mine = this.localThread(pond.id, id);
      // Your own threads carry the freshest running set; someone else's carries what their Mac last published.
      out.push(mine ? { ...thread, ...this.shape(mine), sessionId: mine.sessionId } : thread);
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
        state: "idle",
        private: true,
        mode: local.mode,
        sessionId: local.sessionId,
        updatedAt: this.now(),
        ...this.shape(local),
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
  }

  async threads(pondId: string): Promise<PondThread[]> {
    return this.threadsOf(this.activePond(pondId));
  }

  async view(pondId: string): Promise<PondView> {
    const pond = this.activePond(pondId);
    if (pond.local) return this.liveView(pond);
    try {
      const view = await this.liveView(pond);
      this.unreachable.delete(pondId);
      this.remember(pondId, {
        counts: { members: view.members.length, threads: view.threads.length, needsYou: view.pond.needsYou },
        view: this.metadataOnly(view),
      });
      return view;
    } catch (error) {
      if (!FlotillaService.isOutage(error)) {
        // The relay answered and said no: access is gone, so is what was remembered.
        if (error instanceof FlotillaError && error.status === 403) this.forgetSnapshot(pondId);
        throw error;
      }
      this.unreachable.add(pondId);
      const snap = this.snapshotFile.data.ponds[pondId];
      if (!snap?.view) throw error;
      const { counts } = snap;
      return {
        ...snap.view,
        pond: {
          ...this.summary(pond, counts.members, counts.threads, counts.needsYou),
          offline: true,
          asOf: snap.asOf,
        },
        offline: true,
        asOf: snap.asOf,
      };
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

  private async liveView(pond: LocalPond): Promise<PondView> {
    const me = this.identity;
    if (pond.local) {
      // Same page as a published pond: a flock of just you, no threads or Ripples in the cloud yet.
      return {
        pond: this.summary(pond, 1, 0, 0),
        cloud: this.hasCloud(),
        members: [{ id: me.id, name: me.name, role: "owner", nest: me.nest, online: true, you: true }],
        threads: [],
        ripples: [],
        presence: [],
        holds: [],
        tasks: [],
        locks: [],
        joins: [],
        me: { id: me.id, name: me.name, role: pond.role, nest: me.nest },
      };
    }
    const members = await this.members(pond);
    if (members.size === 0 || (pond.role !== "owner" && !members.has(me.id))) {
      throw new FlotillaError("you no longer have access to this pond", 403);
    }
    const memberKey = (d: string): string | null => members.get(d)?.publicKey ?? null;
    const store = this.storeOf(pond);
    const presence: PresenceDoc[] = [];
    for (const { id, doc } of await store.list(`channels/${pond.id}/presence`)) {
      const read = this.readSigned(pond, "presence", id, doc, memberKey);
      const p = read ? readPresence(read.value) : null;
      if (p && p.memberId === read!.device && p.until > this.now()) presence.push(p);
    }
    const holds = await this.holdsOf(pond, members);
    const ripples: Ripple[] = [];
    for (const { id, doc } of await store.list(`channels/${pond.id}/ripples`)) {
      const read = this.readSigned(pond, "ripples", id, doc, memberKey);
      const r = read ? readRipple(read.value) : null;
      if (r && r.id === id && r.actor === read!.device) ripples.push(r);
    }
    ripples.sort((a, b) => b.at - a.at);
    const online = new Set(presence.filter((p) => p.online).map((p) => p.memberId));
    online.add(me.id);
    // Tasks and locks never stop the page from loading: a failed read shows none.
    const [tasks, locks] = await Promise.all([
      this.coordination.tasks(pond.id).catch((): TaskView[] => []),
      this.coordination.locks(pond.id).catch((): LockDoc[] => []),
    ]);
    const threads = await this.threadsOf(pond);
    return {
      pond: this.summary(pond, members.size, threads.length, threads.filter((t) => t.state === "waiting").length),
      cloud: this.hasCloud(),
      members: [...members.values()].map((m) => ({
        id: m.id,
        name: m.name,
        role: m.role,
        nest: m.nest,
        online: online.has(m.id),
        you: m.id === me.id,
      })),
      threads,
      ripples: ripples.slice(0, 50),
      presence,
      holds,
      tasks,
      locks,
      joins:
        pond.role === "owner"
          ? (await this.pendingJoins(pond)).map(
              ({ requestId, name, nest, role, client, verifiedEmail, verifiedName }) => ({
                requestId,
                name,
                nest,
                role,
                ...(client ? { client } : {}),
                ...(verifiedEmail ? { verifiedEmail } : {}),
                ...(verifiedName ? { verifiedName } : {}),
              }),
            )
          : [],
      ...(pond.role === "owner" ? { invites: this.inviteViews(pond) } : {}),
      me: { id: me.id, name: me.name, role: pond.role, nest: me.nest },
    };
  }

  private inviteViews(pond: LocalPond): InviteView[] {
    this.sweepInvites(pond);
    return pond.invites
      .filter((i): i is LocalInvite & { id: string } => typeof i.id === "string")
      .map((i) => ({ id: i.id, role: i.role, state: this.inviteState(i), expiresAt: i.expiresAt }))
      .sort((a, b) => b.expiresAt - a.expiresAt);
  }

  // presence, ripples, holds

  async setPresence(pondId: string, input: { viewing?: string; typing?: string; online?: boolean }): Promise<void> {
    const pond = this.activePond(pondId);
    const doc: PresenceDoc = {
      memberId: this.identity.id,
      online: input.online ?? true,
      until: this.now() + PRESENCE_MS,
      ...(input.viewing ? { viewing: input.viewing } : {}),
      ...(input.typing ? { typing: input.typing } : {}),
    };
    await this.put(pond, "presence", this.identity.id, doc);
  }

  async ripple(pondId: string, text: string): Promise<void> {
    const pond = this.activePond(pondId);
    const at = this.now();
    const id = `${at.toString(36).padStart(9, "0")}-${randomId(3)}`;
    const ripple: Ripple = { id, at, actor: this.identity.id, text: text.slice(0, 500) };
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
  }

  private async holdsOf(pond: LocalPond, members: Map<string, MemberDoc>): Promise<Hold[]> {
    const out: Hold[] = [];
    for (const { id, doc } of await this.storeOf(pond).list(`channels/${pond.id}/holds`)) {
      const read = this.readSigned(pond, "holds", id, doc, (d) => members.get(d)?.publicKey ?? null);
      const hold = read ? readHold(read.value) : null;
      // A viewer cannot answer, so a hold of theirs would only lock the question against the people who can.
      const holder = members.get(read!.device);
      if (
        hold &&
        holder &&
        holder.role !== "viewer" &&
        hold.requestId === id &&
        hold.by === read!.device &&
        hold.until > this.now()
      )
        out.push(hold);
    }
    return out;
  }

  /**
   * Whoever starts answering holds the question for 30 s, renewed while they type. First writer wins: a hold
   * somebody else has is refused (409, naming who), and the writer reads it back to see it is still theirs.
   */
  async hold(pondId: string, requestId: string): Promise<{ ok: true; heldBy: string } | { ok: false; heldBy: string }> {
    const pond = this.activePond(pondId);
    this.allow(pond, "answer-question", { thread: { starter: "", private: false } }, "A viewer can only watch.");
    const me = this.identity;
    const members = await this.members(pond);
    const existing = (await this.holdsOf(pond, members)).find((h) => h.requestId === requestId);
    if (existing && existing.by !== me.id) return { ok: false, heldBy: existing.byName };
    const mine: Hold = { requestId, by: me.id, byName: me.name, until: this.now() + HOLD_MS };
    await this.put(pond, "holds", requestId, mine);
    const back = (await this.holdsOf(pond, members)).find((h) => h.requestId === requestId);
    if (back && back.by !== me.id) return { ok: false, heldBy: back.byName };
    return { ok: true, heldBy: me.name };
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
      ripple: (text) => this.ripple(pondId, text).catch(() => undefined),
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
    this.allow(pond, "start-thread", {}, "A viewer can only watch.");
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
        { memberId: this.identity.id, name: this.identity.name, lastAt: new Date(this.now()).toISOString() },
      ],
      seq: 0,
      batches: [],
    };
    this.save();
    const thread = this.threadDoc(pond, threadId, input.state ?? "idle", input.permissionMode);
    if (!pond.threads[threadId]!.private) await this.put(pond, "threads", threadId, thread);
    await this.ripple(pondId, `${this.identity.name} ${input.mode === "own" ? "started" : "shared"} ${input.title}`);
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
      starterName: me.name,
      nest: me.nest ?? "",
      agent: local.agent,
      model: local.model,
      state,
      private: false,
      mode: local.mode,
      updatedAt: this.now(),
      ...(permissionMode ? { permissionMode } : {}),
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
    patch: { state: PondThread["state"]; title?: string; permissionMode?: string },
  ): Promise<void> {
    const pond = this.activePond(pondId);
    const local = pond.threads[threadId];
    if (!local) throw new FlotillaError("no such thread", 404);
    if (patch.title) local.title = patch.title;
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
    const pond = this.activePond(pondId);
    this.allow(
      pond,
      COMMAND_ACTION[input.kind],
      { thread: { starter: "", private: false } },
      "A viewer can only watch.",
    );
    const me = this.identity;
    const threads = await this.threadsOf(pond);
    const thread = threads.find((t) => t.id === threadId);
    if (!thread || thread.private) throw new FlotillaError("no such thread", 404);
    if (thread.starter === me.id) throw new FlotillaError("That is your own thread.");
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
    return cmd.id;
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
    if (!verdict.ok) return thread.private && from.role !== "viewer" ? "that thread is private" : verdict.reason;
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

  /** Forget a member's pending work and local ponds, for tests and for leaving. */
  forgetPond(pondId: string): void {
    this.watches.get(pondId)?.();
    this.watches.delete(pondId);
    delete this.pondsFile.data.ponds[pondId];
    this.save();
    this.unreachable.delete(pondId);
    this.forgetSnapshot(pondId);
  }
}
