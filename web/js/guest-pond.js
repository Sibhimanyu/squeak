// A web guest's side of a pond: what the Mac's `FlotillaService` does for a member, in a browser (docs/ponds.md, "Web
// guests"). It trusts keys, not the server: every document is sealed with the pond key, signed by who wrote it, and
// checked against the members the owner signed, whose public key every invite pins. A document that fails a check is
// dropped. A guest is a member with no Nest (`nest: null`, `client: "web"`): it joins shared threads only, it asks the
// thread's starter (`message`, `steer`, `answer`) and never approves or stops anything.
//
// Everything that must survive a reload lives in one record in IndexedDB (`vault`): non-extractable CryptoKeys for the
// member key and the pond keys, the join token, and later the pond-scoped token. The invite's secret is used once, to
// make the join proof, and is never kept.

import {
  importPondKey,
  joinProof,
  memberIdOf,
  newMemberKey,
  openAt,
  openFromMember,
  randomId,
  sealAt,
  signedText,
  signText,
  verifyText,
} from "./guest-crypto.js";
import {
  HOLD_MS,
  MAX_COMMAND_LIFE_MS,
  PRESENCE_MS,
  readHold,
  readMember,
  readMeta,
  readPresence,
  readThread,
  readThreadEvent,
} from "./guest-docs.js";
import { RelayError, RelayStore } from "./guest-relay.js";

export const RECORD = "guest";

/** What went wrong, in words a person can use. */
export class GuestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** What a refused join request says (docs/web-app.md, "Web guests"). */
export function joinRefusal(code) {
  if (code === "email") return "This invite is for a different email. Sign in with the email it was sent to.";
  if (code === "signin") return "You need to sign in to join. Sign in and try again.";
  return "The pond refused this request. Ask for a new invite.";
}

export class GuestPond {
  constructor({ record, vault, fetch, now = Date.now }) {
    this.record = record;
    this.vault = vault;
    this.now = now;
    this.store = new RelayStore({
      baseUrl: record.relayUrl,
      token: () => this.record.token?.value ?? this.record.joinToken,
      fetch,
    });
  }

  /** The saved guest of this browser, or null. */
  static async load({ vault, fetch, now }) {
    const record = await vault.read(RECORD);
    return record ? new GuestPond({ record, vault, fetch, now }) : null;
  }

  /** Makes the member key and writes the join request. Nothing is granted until the owner approves it on their Mac. */
  static async join(invite, displayName, { vault, fetch, now = Date.now }) {
    const name = displayName.trim().slice(0, 100);
    if (!name) throw new GuestError("Say what the flock should call you.");
    // A second attempt on the same invite (double tap, retry, the link reopened) must not make a second request: the
    // owner would see two, and approving the older one would key a member whose private key is gone. A pending record
    // for this pond and owner key keeps its key and request id, and the same request is put again (idempotent).
    const prior = await vault.read(RECORD);
    const reuse =
      prior &&
      prior.status === "pending" &&
      prior.pondId === invite.pondId &&
      prior.ownerKey === invite.ownerKey &&
      prior.current === invite.keyVersion &&
      prior.requestId &&
      prior.signingKey &&
      prior.ecdhKey &&
      prior.publicKey;
    const key = reuse
      ? { publicKey: prior.publicKey, signingKey: prior.signingKey, ecdhKey: prior.ecdhKey }
      : await newMemberKey();
    const requestId = reuse ? prior.requestId : randomId(12);
    const proof = await joinProof(invite.secret, requestId, key.publicKey);
    const record = {
      v: 1,
      status: "pending",
      pondId: invite.pondId,
      pondName: invite.name,
      displayName: name,
      requestId,
      relayUrl: invite.relayUrl,
      joinToken: invite.joinToken,
      token: null,
      ownerKey: invite.ownerKey,
      ownerId: await memberIdOf(invite.ownerKey),
      ownerName: null,
      keys: { [String(invite.keyVersion)]: await importPondKey(invite.key) },
      current: invite.keyVersion,
      signingKey: key.signingKey,
      ecdhKey: key.ecdhKey,
      publicKey: key.publicKey,
      memberId: await memberIdOf(key.publicKey),
      role: invite.role,
    };
    // Saved before anything is sent: a key that was used and then lost could never be approved.
    await vault.write(RECORD, record);
    const pond = new GuestPond({ record, vault, fetch, now });
    try {
      await pond.put("joins", requestId, {
        requestId,
        name,
        nest: null,
        client: "web",
        publicKey: key.publicKey,
        proof,
        at: now(),
      });
    } catch (error) {
      if (error instanceof RelayError && (error.status === 401 || error.status === 403)) {
        // Refused before anything was stored: the key was never sent, so it goes.
        await vault.write(RECORD, null);
        throw new GuestError(joinRefusal(error.code), error.status);
      }
      throw error;
    }
    return pond;
  }

  get status() {
    return this.record.status;
  }
  get pondId() {
    return this.record.pondId;
  }
  get me() {
    return { id: this.record.memberId, name: this.record.displayName, role: this.record.role };
  }

  async save() {
    await this.vault.write(RECORD, this.record);
  }

  /** Leaves: the keys and the token are dropped from this browser. */
  async forget() {
    await this.vault.write(RECORD, null);
  }

  // sealed, signed documents

  docPath = (kind, doc) => `channels/${this.record.pondId}/${kind}/${doc}`;

  async put(kind, docId, value) {
    const r = this.record;
    const docPath = this.docPath(kind, docId);
    const box = `${r.current}.${await sealAt(r.keys[String(r.current)], docPath, value)}`;
    await this.store.set(docPath, {
      box,
      sig: await signText(r.signingKey, signedText(docPath, box)),
      device: r.memberId,
      at: this.now(),
    });
  }

  async openDoc(docPath, doc) {
    const dot = doc.box.indexOf(".");
    const key = this.record.keys[doc.box.slice(0, dot)];
    if (dot < 1 || !key) throw new Error("sealed with a key this browser does not have");
    return openAt(key, docPath, doc.box.slice(dot + 1));
  }

  /** `{ value, device }` if the box opens and the signature is by the key `keyOf` gives for the signer, else null. */
  async readSigned(kind, docId, doc, keyOf) {
    try {
      const docPath = this.docPath(kind, docId);
      if (!doc.sig || !doc.device) return null;
      const key = keyOf(doc.device);
      if (!key || !(await verifyText(key, signedText(docPath, doc.box), doc.sig))) return null;
      return { value: await this.openDoc(docPath, doc), device: doc.device };
    } catch {
      return null;
    }
  }

  async members() {
    const r = this.record;
    const found = new Map();
    const ownerOnly = (device) => (device === r.ownerId ? r.ownerKey : null);
    for (const { id, doc } of await this.store.list(`channels/${r.pondId}/members`)) {
      const read = await this.readSigned("members", id, doc, ownerOnly);
      const member = read ? readMember(read.value) : null;
      if (member && member.id === id && (await memberIdOf(member.publicKey)) === id) found.set(id, member);
    }
    return found;
  }

  // what a wake-up does

  /**
   * Moves the join along: approved (the owner's members document names this key; the pond-scoped token and any rotated
   * pond key arrive sealed to it), denied (the request is gone and no member), removed (members no longer list us, or the
   * relay no longer opens the pond). Returns the status.
   */
  async refresh() {
    const r = this.record;
    if (r.status === "removed" || r.status === "denied") return r.status;
    try {
      if (r.status === "pending") {
        const members = await this.members();
        const owner = members.get(r.ownerId);
        if (owner && r.ownerName !== owner.name) r.ownerName = owner.name;
        const mine = members.get(r.memberId);
        if (mine) {
          r.status = "active";
          r.role = mine.role;
          await this.syncKeys();
          const meta = await this.meta();
          if (meta) r.pondName = meta.name;
        } else if (!(await this.store.get(this.docPath("joins", r.requestId)))) {
          r.status = "denied";
        }
      } else {
        await this.syncKeys();
        const members = await this.members();
        const mine = members.get(r.memberId);
        if (mine) r.role = mine.role;
        else if (members.size > 0) r.status = "removed";
      }
    } catch (error) {
      if (error instanceof RelayError && (error.status === 401 || error.status === 403)) {
        // The relay no longer opens this pond: a removed guest's token is revoked, a lapsed invite's has expired.
        r.status = r.status === "pending" ? "denied" : "removed";
      } else {
        throw error;
      }
    }
    await this.save();
    return r.status;
  }

  async meta() {
    const r = this.record;
    const doc = await this.store.get(this.docPath("pond", "meta"));
    if (!doc) return null;
    const read = await this.readSigned("pond", "meta", doc, (d) => (d === r.ownerId ? r.ownerKey : null));
    const meta = read ? readMeta(read.value) : null;
    return meta && meta.ownerKey === r.ownerKey ? meta : null;
  }

  /** Picks up a rotated pond key and the scoped token: sealed to this member's key, signed by the owner. */
  async syncKeys() {
    const r = this.record;
    const docPath = this.docPath("keys", r.memberId);
    const doc = await this.store.get(docPath);
    if (!doc?.sig || doc.device !== r.ownerId) return;
    if (!(await verifyText(r.ownerKey, signedText(docPath, doc.box), doc.sig))) return;
    try {
      const grant = await openFromMember(r.ecdhKey, doc.box);
      if (typeof grant.version === "number" && typeof grant.key === "string" && !r.keys[String(grant.version)]) {
        r.keys[String(grant.version)] = await importPondKey(grant.key);
        r.current = Math.max(r.current, grant.version);
      }
      const t = grant.token;
      if (t && typeof t.value === "string" && typeof t.expiresAt === "number" && r.token?.value !== t.value) {
        r.token = { value: t.value, expiresAt: t.expiresAt };
      }
      await this.save();
    } catch {
      // Not sealed to this key: ignore.
    }
  }

  // reading

  async threads(members) {
    const out = [];
    const memberKey = (d) => members.get(d)?.publicKey ?? null;
    for (const { id, doc } of await this.store.list(`channels/${this.record.pondId}/threads`)) {
      const read = await this.readSigned("threads", id, doc, memberKey);
      const thread = read ? readThread(read.value) : null;
      if (!thread || thread.id !== id || thread.starter !== read.device || thread.private) continue;
      out.push(thread);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
  }

  /** What the pond screen draws: its name, the flock with who is online, and the shared threads. */
  async view() {
    const r = this.record;
    const members = await this.members();
    if (members.size === 0 || !members.has(r.memberId)) {
      r.status = "removed";
      await this.save();
      throw new GuestError("You no longer have access to this pond.", 403);
    }
    const memberKey = (d) => members.get(d)?.publicKey ?? null;
    const presence = [];
    for (const { id, doc } of await this.store.list(`channels/${r.pondId}/presence`)) {
      const read = await this.readSigned("presence", id, doc, memberKey);
      const p = read ? readPresence(read.value) : null;
      if (p && p.memberId === read.device && p.until > this.now()) presence.push(p);
    }
    const online = new Set(presence.filter((p) => p.online).map((p) => p.memberId));
    online.add(r.memberId);
    const holds = await this.holds(members);
    const meta = await this.meta();
    if (meta && meta.name !== r.pondName) {
      r.pondName = meta.name;
      await this.save();
    }
    return {
      pond: { id: r.pondId, name: r.pondName },
      me: { id: r.memberId, name: r.displayName, role: members.get(r.memberId).role },
      members: [...members.values()].map((m) => ({
        id: m.id,
        name: m.name,
        role: m.role,
        nest: m.nest,
        online: online.has(m.id),
        viewing: presence.find((p) => p.memberId === m.id)?.viewing ?? null,
        you: m.id === r.memberId,
      })),
      threads: await this.threads(members),
      holds,
    };
  }

  /** One shared thread's document, or null (a private thread has none). */
  async thread(threadId, members) {
    const doc = await this.store.get(this.docPath("threads", threadId));
    if (!doc) return null;
    const read = await this.readSigned("threads", threadId, doc, (d) => members.get(d)?.publicKey ?? null);
    const thread = read ? readThread(read.value) : null;
    return thread && thread.id === threadId && thread.starter === read.device && !thread.private ? thread : null;
  }

  /** Events after `after`, in order; `gap` says a resume missed what was pruned. */
  async readEvents(threadId, after = 0) {
    const members = await this.members();
    const thread = await this.thread(threadId, members);
    const starterKey = thread ? members.get(thread.starter)?.publicKey : null;
    if (!thread || !starterKey) throw new GuestError("That thread is not shared with the pond.", 404);
    const events = [];
    // A batch is named `<thread>-<firstSeq>`, so one whose successor starts at or before `after + 1` holds nothing new.
    const batches = (await this.store.list(`channels/${this.record.pondId}/tevents`))
      .filter(({ id }) => id.startsWith(`${threadId}-`))
      .map((b) => ({ ...b, first: Number(b.id.slice(threadId.length + 1)) }))
      .sort((a, b) => a.first - b.first);
    for (const [i, { id, doc }] of batches.entries()) {
      const next = batches[i + 1];
      if (after > 0 && next && Number.isFinite(next.first) && next.first - 1 <= after) continue;
      const read = await this.readSigned("tevents", id, doc, (d) => (d === thread.starter ? starterKey : null));
      if (!read || !Array.isArray(read.value?.events)) continue;
      for (const raw of read.value.events) {
        const ev = readThreadEvent(raw);
        if (ev && ev.seq > after) events.push(ev);
      }
    }
    events.sort((a, b) => a.seq - b.seq);
    return {
      thread,
      events,
      lastSeq: events.length ? events[events.length - 1].seq : after,
      gap: events.length > 0 && events[0].seq > after + 1 && after > 0,
    };
  }

  // doing

  async setPresence({ viewing, online = true } = {}) {
    const r = this.record;
    await this.put("presence", r.memberId, {
      memberId: r.memberId,
      online,
      until: this.now() + PRESENCE_MS,
      ...(viewing ? { viewing } : {}),
    });
  }

  /** Signs and writes a command; nothing runs until the thread's starter's Mac verifies it. Returns its id. */
  async sendCommand(threadId, input, lifeMs = 5 * 60_000) {
    const r = this.record;
    if (r.role === "viewer") throw new GuestError("Viewers can watch, not message.", 403);
    if (!["message", "steer", "answer"].includes(input.kind)) throw new GuestError("A guest cannot do that.", 403);
    const members = await this.members();
    const thread = await this.thread(threadId, members);
    if (!thread) throw new GuestError("That thread is not shared with the pond.", 404);
    const now = this.now();
    const cmd = {
      id: randomId(12),
      kind: input.kind,
      threadId,
      issuedAt: now,
      expiresAt: now + Math.min(lifeMs, MAX_COMMAND_LIFE_MS),
      nonce: randomId(12),
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(input.answer !== undefined ? { answer: input.answer } : {}),
    };
    await this.put("tcmds", cmd.id, cmd);
    return cmd.id;
  }

  async holds(members) {
    const out = [];
    const memberKey = (d) => members.get(d)?.publicKey ?? null;
    for (const { id, doc } of await this.store.list(`channels/${this.record.pondId}/holds`)) {
      const read = await this.readSigned("holds", id, doc, memberKey);
      const hold = read ? readHold(read.value) : null;
      if (hold && hold.requestId === id && hold.by === read.device && hold.until > this.now()) out.push(hold);
    }
    return out;
  }

  /** Whoever starts answering holds the question for 30 s. First writer wins; the writer reads it back. */
  async hold(requestId) {
    const r = this.record;
    const members = await this.members();
    const existing = (await this.holds(members)).find((h) => h.requestId === requestId);
    if (existing && existing.by !== r.memberId) return { ok: false, heldBy: existing.byName };
    await this.put("holds", requestId, {
      requestId,
      by: r.memberId,
      byName: r.displayName,
      until: this.now() + HOLD_MS,
    });
    const back = (await this.holds(members)).find((h) => h.requestId === requestId);
    if (back && back.by !== r.memberId) return { ok: false, heldBy: back.byName };
    return { ok: true, heldBy: r.displayName };
  }

  async releaseHold(requestId) {
    await this.store.delete(this.docPath("holds", requestId));
  }
}
