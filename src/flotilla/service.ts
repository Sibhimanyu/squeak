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
import type { PondRelay, TokenScope } from "./relay.js";
import {
  COMMAND_KINDS,
  FlotillaError,
  HOLD_MS,
  KEEP_EVENTS,
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
  type PresenceDoc,
  type Ripple,
  type Role,
  type ThreadEvent,
} from "./types.js";

/** What a Mac keeps about one thread it starts: the session behind it never leaves this file. */
export interface LocalThread {
  sessionId: string;
  private: boolean;
  mode: "own" | "shared";
  title: string;
  agent: string;
  model: string;
  /** The last seq handed out. */
  seq: number;
  /** [first, last] seq of each batch in the cloud, oldest first. */
  batches: Array<[number, number]>;
}

interface LocalInvite {
  secret: string;
  role: Role;
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
  store: CloudStore;
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
  tint: string;
  status: LocalPond["status"];
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
}

export interface PondView {
  pond: PondSummary;
  members: MemberView[];
  threads: PondThread[];
  ripples: Ripple[];
  presence: PresenceDoc[];
  holds: Hold[];
  joins: JoinView[];
  me: { id: string; name: string; role: Role; nest: string | null };
}

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

  constructor(private readonly options: FlotillaOptions) {
    super();
    this.now = options.now ?? Date.now;
    const dir = path.join(options.supportDir, "flotilla");
    this.identityFile = new SecretFile(path.join(dir, "identity.json"), () => ({ identity: null }));
    this.pondsFile = new SecretFile(path.join(dir, "ponds.json"), () => ({ ponds: {} }));
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
    if (pond.status !== "active") throw new FlotillaError("you no longer have access to this pond", 403);
    return pond;
  }

  private save(): void {
    this.pondsFile.save();
  }

  private storeOf(pond: LocalPond): CloudStore {
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
    return this.options.store;
  }

  localThread(pondId: string, threadId: string): LocalThread | null {
    return this.pondsFile.data.ponds[pondId]?.threads[threadId] ?? null;
  }

  /** Every thread this Mac started, in every pond, for the bridge to resume after a restart. */
  ownThreads(): Array<{ pondId: string; threadId: string; thread: LocalThread }> {
    return Object.values(this.pondsFile.data.ponds)
      .filter((p) => p.status === "active")
      .flatMap((p) => Object.entries(p.threads).map(([threadId, thread]) => ({ pondId: p.id, threadId, thread })));
  }

  pondIds(): string[] {
    return Object.values(this.pondsFile.data.ponds)
      .filter((p) => p.status === "active" || p.status === "pending")
      .map((p) => p.id);
  }

  gitRemoteOf(pondId: string): string | null {
    return this.pond(pondId).gitRemote ?? null;
  }

  // sealed, signed documents

  private docPath = (pondId: string, kind: string, doc: string): string => `channels/${pondId}/${kind}/${doc}`;

  private async put(pond: LocalPond, kind: string, docId: string, value: unknown): Promise<void> {
    const docPath = this.docPath(pond.id, kind, docId);
    const box = `${pond.current}.${sealAt(pond.keys[String(pond.current)]!, docPath, value)}`;
    const id = this.identity;
    await this.storeOf(pond).set(docPath, {
      box,
      sig: signText(id.privateKey, signedText(docPath, box)),
      device: id.id,
      at: this.now(),
    });
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

  async createPond(input: { name: string; gitRemote?: string }): Promise<PondSummary> {
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
      location: this.options.location ?? null,
      keys: { "1": randomKey() },
      current: 1,
      ...(input.gitRemote ? { gitRemote: input.gitRemote } : {}),
      threads: {},
      invites: [],
      nonces: {},
    };
    this.pondsFile.data.ponds[id] = pond;
    this.save();
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
      tint: TINTS[hash % TINTS.length]!,
      status: pond.status,
    };
  }

  async list(): Promise<PondSummary[]> {
    const out: PondSummary[] = [];
    for (const pond of Object.values(this.pondsFile.data.ponds)) {
      if (pond.status !== "active" && pond.status !== "pending") continue;
      let members = 0;
      let threads: PondThread[] = [];
      if (pond.status === "active") {
        try {
          members = (await this.members(pond)).size;
          threads = await this.threadsOf(pond);
        } catch {
          // Offline: the pond still shows, with what is known.
        }
      }
      out.push(this.summary(pond, members, threads.length, threads.filter((t) => t.state === "waiting").length));
    }
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
  async invite(pondId: string, role: Role = "member"): Promise<{ code: string; expiresAt: number; link?: string }> {
    const pond = this.activePond(pondId);
    if (pond.role !== "owner") throw new FlotillaError("Only an owner can invite.", 403);
    if (role !== "member" && role !== "viewer") throw new FlotillaError("An invite is for a member or a viewer.");
    const location = this.inviteLocation(pond);
    let joinToken: string | undefined;
    if ((pond.location as { provider?: string } | null)?.provider === "catalyst") {
      if (!this.options.relay) throw new FlotillaError("This Mac cannot make an invite for a Catalyst store.", 503);
      try {
        joinToken = (await this.options.relay.issue(pond.id, `j${randomId(12)}`, "join", INVITE_TTL_MS / 1000)).token;
      } catch {
        throw new FlotillaError("The relay would not make an invite; try again.", 503);
      }
    }
    const secret = randomId(16);
    const expiresAt = this.now() + INVITE_TTL_MS;
    pond.invites = pond.invites.filter((i) => i.expiresAt > this.now());
    pond.invites.push({ secret, role, expiresAt });
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
    return { code, expiresAt, ...(base ? { link: `${base}#${code.slice(INVITE_PREFIX.length)}` } : {}) };
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
    if (e < this.now()) throw new FlotillaError("That invite has expired.", 410);
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
    const name = displayName.trim().slice(0, 100) || this.identity.name;
    const me = this.identity;
    this.identityFile.data.identity!.name = name;
    this.identityFile.save();
    const requestId = randomId(12);
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
    };
    await this.put(pond, "joins", requestId, request);
    return { pondId: p, status: "pending" };
  }

  /** Join requests an owner can decide on: signed by their own key and proving an unexpired invite's secret. */
  private async pendingJoins(pond: LocalPond): Promise<Array<JoinView & { publicKey: string; proof: string }>> {
    const out: Array<JoinView & { publicKey: string; proof: string }> = [];
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
      const invite = pond.invites.find(
        (i) => i.expiresAt > this.now() && safeEqual(joinProof(i.secret, id, request.publicKey), request.proof),
      );
      if (invite)
        out.push({
          requestId: id,
          name: request.name,
          nest: request.nest,
          ...(request.client ? { client: request.client } : {}),
          role: invite.role,
          publicKey: request.publicKey,
          proof: request.proof,
        });
    }
    return out;
  }

  /** A person on an owner's Mac decides. The approval is a members document the owner's key signed. */
  async decideJoin(pondId: string, requestId: string, input: { approve: boolean; role?: Role }): Promise<void> {
    const pond = this.activePond(pondId);
    if (pond.role !== "owner") throw new FlotillaError("Only an owner can decide a join.", 403);
    const request = (await this.pendingJoins(pond)).find((r) => r.requestId === requestId);
    if (!request) throw new FlotillaError("No such join request.", 404);
    const store = this.storeOf(pond);
    const invite = pond.invites.find(
      (i) => i.expiresAt > this.now() && safeEqual(joinProof(i.secret, requestId, request.publicKey), request.proof),
    );
    const consume = (): void => {
      pond.invites = pond.invites.filter((i) => i !== invite);
      this.save();
    };
    if (!input.approve) {
      await store.delete(this.docPath(pond.id, "joins", requestId));
      consume();
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
    consume();
    await this.ripple(pondId, `${member.name} joined`);
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
    const pond = this.activePond(pondId);
    if (pond.role !== "owner") throw new FlotillaError("Only an owner can remove a member.", 403);
    if (memberId === this.identity.id) throw new FlotillaError("An owner cannot remove themselves.");
    const members = await this.members(pond);
    const gone = members.get(memberId);
    if (!gone) throw new FlotillaError("No such member.", 404);
    const store = this.storeOf(pond);
    // Their token ends first: if the relay will not revoke it, the removal stops here and can be retried.
    if (this.options.relay && (pond.location as { provider?: string } | null)?.provider === "catalyst") {
      try {
        await this.options.relay.revoke(pond.id, memberId);
      } catch {
        throw new FlotillaError("The relay would not end that member's access; try again.", 503);
      }
      delete pond.issued?.[memberId];
      this.save();
    }
    await store.delete(this.docPath(pond.id, "members", memberId));
    await store.delete(this.docPath(pond.id, "keys", memberId));
    await store.delete(this.docPath(pond.id, "presence", memberId));
    pond.current += 1;
    pond.keys[String(pond.current)] = randomKey();
    this.save();
    for (const member of members.values()) {
      if (member.id === memberId) continue;
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
    await this.ripple(pondId, `${gone.name} was removed`);
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
    if (!pond || this.watches.has(pondId)) return;
    const stop = this.storeOf(pond).watch(`channels/${pondId}`, () => this.wake(pondId));
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
      out.push(mine ? { ...thread, sessionId: mine.sessionId } : thread);
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
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
  }

  async threads(pondId: string): Promise<PondThread[]> {
    return this.threadsOf(this.activePond(pondId));
  }

  async view(pondId: string): Promise<PondView> {
    const pond = this.activePond(pondId);
    const me = this.identity;
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
    const threads = await this.threadsOf(pond);
    return {
      pond: this.summary(pond, members.size, threads.length, threads.filter((t) => t.state === "waiting").length),
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
      joins:
        pond.role === "owner"
          ? (await this.pendingJoins(pond)).map(({ requestId, name, nest, role, client }) => ({
              requestId,
              name,
              nest,
              role,
              ...(client ? { client } : {}),
            }))
          : [],
      me: { id: me.id, name: me.name, role: pond.role, nest: me.nest },
    };
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
      if (hold && hold.requestId === id && hold.by === read!.device && hold.until > this.now()) out.push(hold);
    }
    return out;
  }

  /**
   * Whoever starts answering holds the question for 30 s, renewed while they type. First writer wins: a hold
   * somebody else has is refused (409, naming who), and the writer reads it back to see it is still theirs.
   */
  async hold(pondId: string, requestId: string): Promise<{ ok: true; heldBy: string } | { ok: false; heldBy: string }> {
    const pond = this.activePond(pondId);
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
    },
  ): Promise<PondThread> {
    const pond = this.activePond(pondId);
    if (pond.role === "viewer") throw new FlotillaError("A viewer can only watch.", 403);
    if (this.identity.nest === null) throw new FlotillaError("A web guest has no machine to run a thread on.", 403);
    const threadId = randomId(10);
    pond.threads[threadId] = {
      sessionId: input.sessionId,
      private: input.private === true,
      mode: input.mode,
      title: input.title,
      agent: input.agent,
      model: input.model,
      seq: 0,
      batches: [],
    };
    this.save();
    const thread = this.threadDoc(pond, threadId, input.state ?? "idle", input.permissionMode);
    if (!pond.threads[threadId]!.private) await this.put(pond, "threads", threadId, thread);
    await this.ripple(pondId, `${this.identity.name} ${input.mode === "own" ? "started" : "shared"} ${input.title}`);
    return { ...thread, sessionId: input.sessionId };
  }

  private threadDoc(
    pond: LocalPond,
    threadId: string,
    state: PondThread["state"],
    permissionMode?: string,
  ): PondThread {
    const local = pond.threads[threadId]!;
    const me = this.identity;
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
    };
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
    if (!local) throw new FlotillaError("Only a thread's starter can change who sees it.", 403);
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
    if (pond.role === "viewer") throw new FlotillaError("A viewer can only watch.", 403);
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
    if (from.role === "viewer") return "viewers only watch";
    if (thread.private) return "that thread is private";
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
  }
}
