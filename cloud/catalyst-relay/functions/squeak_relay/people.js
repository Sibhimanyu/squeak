// People data: who is in a Pond, readable by the server (ADR 0005, docs/cloud-layer.md "People data"). One interface,
// `createPeople({ tables, now })`, over a thin `Tables` port with two implementations: Catalyst Data Store
// (people-datastore.js) and an in-memory double that enforces the same unique columns (people-memory.js, tests only).
// Every rule that must hold under a race (one membership per account per Pond, one pending invite per address per Pond,
// the 10-person cap) is a unique column in people-schema.json, never a read-then-write here: Data Store has no
// transactions. The sealed member documents stay the cryptographic record of key holders; this is who may read.
//
// Tables port (all async; `col` is any column, a unique one for single-row lookups):
//   insert(table, row)                  -> row; throws UniqueError when a unique column already has the value
//   get(table, col, value)              -> row | null
//   select(table, col, value)           -> row[] (every page)
//   all(table)                          -> row[]
//   update(table, col, value, patch)    -> boolean (false when no row)
//   delete(table, col, value)           -> number deleted
//   clear(table)                        -> number deleted
const crypto = require("node:crypto");
const { CHANNEL } = require("./rules");
const { maskEmail, validEmail } = require("./mail");

/** The most people in a Pond, the Owner included. */
const MAX_MEMBERS = 10;
/** An invitation lives a week; a finished one stays this long past its last change, then clears. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FINISHED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const ROLES = new Set(["owner", "member", "viewer"]);
const INVITE_ROLES = new Set(["member", "viewer"]);
const DEVICE_KINDS = new Set(["mac", "ios", "web"]);
const SETTLED = new Set(["joined", "declined", "withdrawn", "expired"]);
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const VARCHAR = 255;
const FULL = `This Pond holds ${MAX_MEMBERS} people, counting invitations. Withdraw an invitation or remove someone first.`;

const T = {
  accounts: "people_accounts",
  devices: "people_devices",
  pushTokens: "people_push_tokens",
  ponds: "people_ponds",
  members: "people_memberships",
  slots: "people_slots",
  invites: "people_invites",
  locks: "people_invite_locks",
};

/** A rule refused, with a stable `code` the routes map to a status. */
class PeopleError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "PeopleError";
    this.code = code;
  }
}
/** Thrown by a Tables implementation when a unique column already holds the value. */
class UniqueError extends Error {
  constructor(table, column) {
    super(`duplicate ${table}.${column}`);
    this.name = "UniqueError";
    this.table = table;
    this.column = column;
  }
}

/**
 * Data Store stores 4-byte UTF-8 (emoji) as "?", so names are kept as escaped text: a backslash is doubled and a character
 * above U+FFFF becomes \u{hex}. Reversible; applied here so every implementation stores the same bytes.
 */
const encodeText = (s) =>
  String(s ?? "").replace(/\\|[\u{10000}-\u{10FFFF}]/gu, (c) =>
    c === "\\" ? "\\\\" : `\\u{${c.codePointAt(0).toString(16)}}`,
  );
const decodeText = (s) =>
  String(s ?? "").replace(/\\(\\|u\{[0-9a-f]+\})/g, (_m, g) =>
    g === "\\" ? "\\" : String.fromCodePoint(parseInt(g.slice(2, -1), 16)),
  );
/** Escaped, and cut (by whole characters) so the stored text fits a varchar. */
const nameColumn = (raw) => {
  let chars = Array.from(
    String(raw ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim(),
  );
  let out = encodeText(chars.join(""));
  while (out.length > VARCHAR) {
    chars = chars.slice(0, -1);
    out = encodeText(chars.join(""));
  }
  return out;
};

const normEmail = (e) =>
  String(e ?? "")
    .trim()
    .toLowerCase();
const emailHash = (email) => crypto.createHash("sha256").update(email).digest("base64url");
const need = (cond, message) => {
  if (!cond) throw new PeopleError("invalid", message);
};
const isId = (s) => typeof s === "string" && ID.test(s);
const isPond = (s) => typeof s === "string" && CHANNEL.test(s);
const isUnique = (e) => e instanceof UniqueError || (e && e.name === "UniqueError");
const num = (v) => Number(v) || 0;

const account = (r) =>
  r && {
    userId: r.userId,
    email: r.email,
    name: decodeText(r.name),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  };
const device = (r) =>
  r && {
    deviceId: r.deviceId,
    userId: r.userId,
    name: decodeText(r.name),
    kind: r.kind,
    publicKey: r.publicKey,
    createdAt: num(r.createdAt),
    lastSeenAt: num(r.lastSeenAt),
  };
const pond = (r) =>
  r && { pondId: r.pondId, ownerUserId: r.ownerUserId, name: decodeText(r.name), createdAt: num(r.createdAt) };
const membership = (r) =>
  r && {
    pondId: r.pondId,
    userId: r.userId,
    role: r.role,
    slot: num(r.slot),
    joinedAt: num(r.joinedAt),
    leftAt: num(r.leftAt),
    leftReason: r.leftReason || "",
  };
/** In the Pond now: a slot is held and nobody has left. A row still claiming its slot is not yet in. */
const isIn = (m) => !!m && m.slot >= 0 && m.leftAt === 0;

function createPeople(deps) {
  const tables = deps.tables;
  const now = deps.now || Date.now;
  const memberKey = (pondId, userId) => `${pondId}:${userId}`;

  /** The invite as every surface draws it: a pending invite past its expiry reads as expired. */
  const inviteView = (r) => {
    if (!r) return null;
    const expiresAt = num(r.expiresAt);
    const state = r.state === "pending" && expiresAt <= now() ? "expired" : r.state;
    return {
      inviteId: r.inviteId,
      pondId: r.pondId,
      email: r.email,
      role: r.role,
      invitedBy: r.invitedBy,
      state,
      createdAt: num(r.createdAt),
      expiresAt,
      settledAt: num(r.settledAt),
    };
  };

  // ---- accounts (names come from sign-in) ----

  async function upsertAccount(input) {
    need(isId(input.userId), "userId");
    const email = normEmail(input.email);
    need(EMAIL.test(email), "email");
    const name = nameColumn(input.name);
    const t = now();
    // A name is never blanked: a request that carries none (a Mac key, a sign-in without a profile) keeps the stored one.
    const patch = { email, ...(name ? { name } : {}), updatedAt: t };
    if (await tables.update(T.accounts, "userId", input.userId, patch)) return getAccount(input.userId);
    try {
      await tables.insert(T.accounts, { userId: input.userId, name, ...patch, createdAt: t });
    } catch (e) {
      if (!isUnique(e)) throw e;
      await tables.update(T.accounts, "userId", input.userId, patch); // a concurrent first sign-in won: just refresh
    }
    return getAccount(input.userId);
  }
  const getAccount = async (userId) => account(await tables.get(T.accounts, "userId", String(userId)));
  const accountByEmail = async (email) =>
    account((await tables.select(T.accounts, "email", normEmail(email)))[0] ?? null);

  // ---- devices and push tokens ----

  async function addDevice(input) {
    need(isId(input.deviceId) && isId(input.userId), "ids");
    need(DEVICE_KINDS.has(input.kind), "kind");
    need(
      typeof input.publicKey === "string" && input.publicKey.length > 0 && input.publicKey.length <= VARCHAR,
      "publicKey",
    );
    const t = now();
    const fields = { userId: input.userId, name: nameColumn(input.name), kind: input.kind, publicKey: input.publicKey };
    const existing = await tables.get(T.devices, "deviceId", input.deviceId);
    if (existing) {
      if (existing.userId !== input.userId)
        throw new PeopleError("device-taken", "That device belongs to another account.");
      await tables.update(T.devices, "deviceId", input.deviceId, { ...fields, lastSeenAt: t });
    } else {
      try {
        await tables.insert(T.devices, { deviceId: input.deviceId, ...fields, createdAt: t, lastSeenAt: t });
      } catch (e) {
        if (isUnique(e)) throw new PeopleError("device-taken", "That device was just added.");
        throw e;
      }
    }
    return device(await tables.get(T.devices, "deviceId", input.deviceId));
  }
  const devicesOf = async (userId) => (await tables.select(T.devices, "userId", String(userId))).map(device);
  async function removeDevice(deviceId) {
    await tables.delete(T.pushTokens, "deviceId", String(deviceId));
    return (await tables.delete(T.devices, "deviceId", String(deviceId))) > 0;
  }
  async function setPushToken(input) {
    need(isId(input.deviceId) && isId(input.userId), "ids");
    need(typeof input.token === "string" && input.token.length > 0 && input.token.length <= 4000, "token");
    need(typeof input.platform === "string" && /^[a-z]{1,16}$/.test(input.platform), "platform");
    const row = { userId: input.userId, token: input.token, platform: input.platform, updatedAt: now() };
    if (await tables.update(T.pushTokens, "deviceId", input.deviceId, row)) return;
    try {
      await tables.insert(T.pushTokens, { deviceId: input.deviceId, ...row });
    } catch (e) {
      if (!isUnique(e)) throw e;
      await tables.update(T.pushTokens, "deviceId", input.deviceId, row);
    }
  }
  const pushTokensOf = async (userId) =>
    (await tables.select(T.pushTokens, "userId", String(userId))).map((r) => ({
      deviceId: r.deviceId,
      userId: r.userId,
      token: r.token,
      platform: r.platform,
      updatedAt: num(r.updatedAt),
    }));

  // ---- ponds and memberships ----

  const getPond = async (pondId) => pond(await tables.get(T.ponds, "pondId", String(pondId)));
  const membershipOf = async (pondId, userId) =>
    membership(await tables.get(T.members, "memberKey", memberKey(pondId, userId)));
  const isMember = async (pondId, userId) => isIn(await membershipOf(pondId, userId));

  /** Claims the first free of the Pond's ten slots; the unique slotKey refuses a taken one. Returns the slot or -1. */
  async function claimSlot(pondId, userId) {
    for (let n = 0; n < MAX_MEMBERS; n++) {
      try {
        await tables.insert(T.slots, { slotKey: `${pondId}:${n}`, pondId, userId });
        return n;
      } catch (e) {
        if (!isUnique(e)) throw e;
      }
    }
    return -1;
  }
  const freeSlot = (pondId, slot) => (slot >= 0 ? tables.delete(T.slots, "slotKey", `${pondId}:${slot}`) : 0);

  /**
   * The one place a person enters a Pond. The membership row goes in first (its unique key refuses a second membership
   * before any slot is touched), then a slot is claimed (the unique slot key is the cap), and a refusal there removes the row.
   * A person who left has a row already: it is reopened if a slot is free. (Two simultaneous reopenings of the same person
   * could leave one slot claimed twice; harmless to who is in, and the Owner's next remove or the clean start frees it.)
   */
  async function enter(pondId, userId, role, claim) {
    const t = now();
    const takeSlot = claim || (() => claimSlot(pondId, userId));
    const key = memberKey(pondId, userId);
    const existing = membership(await tables.get(T.members, "memberKey", key));
    if (existing) {
      if (isIn(existing) || existing.leftAt === 0) throw new PeopleError("already-member", "Already in this Pond.");
      const slot = await takeSlot();
      if (slot < 0) throw new PeopleError("pond-full", FULL);
      await tables.update(T.members, "memberKey", key, { role, slot, joinedAt: t, leftAt: 0, leftReason: "" });
      return membershipOf(pondId, userId);
    }
    try {
      await tables.insert(T.members, {
        memberKey: key,
        pondId,
        userId,
        role,
        slot: -1,
        joinedAt: t,
        leftAt: 0,
        leftReason: "",
      });
    } catch (e) {
      if (isUnique(e)) throw new PeopleError("already-member", "Already in this Pond.");
      throw e;
    }
    const slot = await takeSlot();
    if (slot < 0) {
      await tables.delete(T.members, "memberKey", key);
      throw new PeopleError("pond-full", FULL);
    }
    await tables.update(T.members, "memberKey", key, { slot });
    return membershipOf(pondId, userId);
  }

  async function createPond(input) {
    need(isPond(input.pondId), "pondId");
    need(isId(input.ownerUserId), "ownerUserId");
    const name = nameColumn(input.name);
    need(name.length > 0, "name");
    try {
      await tables.insert(T.ponds, { pondId: input.pondId, ownerUserId: input.ownerUserId, name, createdAt: now() });
    } catch (e) {
      if (isUnique(e)) throw new PeopleError("pond-exists", "That Pond already exists.");
      throw e;
    }
    await enter(input.pondId, input.ownerUserId, "owner");
    return getPond(input.pondId);
  }

  async function addMember(input) {
    need(isPond(input.pondId) && isId(input.userId), "ids");
    need(INVITE_ROLES.has(input.role), "role");
    if (!(await getPond(input.pondId))) throw new PeopleError("no-pond", "No such Pond.");
    return enter(input.pondId, input.userId, input.role);
  }

  /** Someone leaves or is removed. The Owner never can. The row stays (who, when, why); the slot is freed. */
  async function removeMember(input) {
    const m = await membershipOf(input.pondId, input.userId);
    if (!isIn(m)) throw new PeopleError("not-member", "Not in this Pond.");
    if (m.role === "owner") throw new PeopleError("owner", "The Owner cannot leave their own Pond.");
    const reason = input.reason === "removed" ? "removed" : "left";
    await tables.update(T.members, "memberKey", memberKey(input.pondId, input.userId), {
      slot: -1,
      leftAt: now(),
      leftReason: reason,
    });
    await freeSlot(input.pondId, m.slot);
  }

  /** The Owner changes a member's role (member or viewer); the Owner's own never changes. */
  async function setRole(input) {
    need(INVITE_ROLES.has(input.role), "role");
    const m = await membershipOf(input.pondId, input.userId);
    if (!isIn(m)) throw new PeopleError("not-member", "Not in this Pond.");
    if (m.role === "owner") throw new PeopleError("owner", "The Owner's role cannot change.");
    await tables.update(T.members, "memberKey", memberKey(input.pondId, input.userId), { role: input.role });
  }

  /** Ends the Pond for everyone: pending invites withdrawn, every membership and slot cleared, the Pond row gone. */
  async function deletePond(pondId) {
    for (const row of await tables.select(T.invites, "pondId", String(pondId))) {
      if (row.state === "pending") await settleInvite(row.inviteId, "withdrawn").catch(() => undefined);
    }
    for (const row of await tables.select(T.members, "pondId", String(pondId))) {
      await tables.delete(T.members, "memberKey", row.memberKey);
      await freeSlot(pondId, Number(row.slot));
    }
    await tables.delete(T.ponds, "pondId", String(pondId));
  }

  async function membersOf(pondId) {
    const rows = (await tables.select(T.members, "pondId", String(pondId))).map(membership).filter(isIn);
    const out = [];
    for (const m of rows) {
      const a = await getAccount(m.userId);
      out.push({ ...m, name: a ? a.name : "", email: a ? a.email : "" });
    }
    return out.sort((a, b) => Number(b.role === "owner") - Number(a.role === "owner") || a.joinedAt - b.joinedAt);
  }

  async function pondsOf(userId) {
    const mine = (await tables.select(T.members, "userId", String(userId))).map(membership).filter(isIn);
    const out = [];
    for (const m of mine) {
      const p = await getPond(m.pondId);
      if (p) out.push({ ...p, role: m.role, joinedAt: m.joinedAt });
    }
    return out.sort((a, b) => b.joinedAt - a.joinedAt || a.name.localeCompare(b.name));
  }

  const accountIds = async () => (await tables.all(T.accounts)).map((r) => r.userId);
  const pondIds = async () => (await tables.all(T.ponds)).map((r) => r.pondId);

  // ---- invites ----
  //
  // The invite is one row and the only source of truth: pending -> joined | declined | expired | withdrawn, each with the
  // time it was reached (`settledAt`). A pending invite holds one of the Pond's ten slots (slot userId "invite:<id>"), so
  // the cap counts pending people; the slot passes to the person when they join and is freed by every other end.

  const lockKeyOf = (pondId, email) => `${pondId}:${emailHash(email)}`;
  const inviteSlotOwner = (inviteId) => `invite:${inviteId}`;
  const SETTLED_ALREADY = "That invite is already settled.";

  /** Ends a pending invite, once: the lock row (deleted, atomically) is the claim, so two racing ends cannot both win. */
  async function settleRow(row, state, at, keepSlot = false) {
    const key = lockKeyOf(row.pondId, row.email);
    const lock = await tables.get(T.locks, "lockKey", key);
    if (!lock || lock.inviteId !== row.inviteId) throw new PeopleError("not-pending", SETTLED_ALREADY);
    if ((await tables.delete(T.locks, "lockKey", key)) === 0) throw new PeopleError("not-pending", SETTLED_ALREADY);
    await tables.update(T.invites, "inviteId", row.inviteId, { state, settledAt: at });
    if (!keepSlot) await freeInviteSlot(row.inviteId);
  }
  async function freeInviteSlot(inviteId) {
    const slot = await tables.get(T.slots, "userId", inviteSlotOwner(inviteId));
    if (slot) await tables.delete(T.slots, "slotKey", slot.slotKey);
  }

  async function settleInvite(inviteId, state) {
    if (!SETTLED.has(state)) throw new PeopleError("invalid", "state");
    const row = await tables.get(T.invites, "inviteId", String(inviteId));
    if (!row) throw new PeopleError("no-invite", "No such invite.");
    if (row.state !== "pending") throw new PeopleError("not-pending", SETTLED_ALREADY);
    await settleRow(row, state, state === "expired" ? Math.min(num(row.expiresAt), now()) : now());
    return getInvite(row.inviteId);
  }

  /** Pending invites of a Pond past their expiry become Expired (at the moment they lapsed) and give their slot back. */
  async function expireStale(pondId) {
    for (const row of await tables.select(T.invites, "pondId", String(pondId))) {
      if (row.state === "pending" && num(row.expiresAt) <= now()) {
        try {
          await settleRow(row, "expired", num(row.expiresAt));
        } catch (e) {
          if (!(e instanceof PeopleError)) throw e;
        }
      }
    }
  }

  /**
   * An invite for an address: refused when that address is already in the Pond, already has a pending invite, or the Pond
   * is full counting pending invites. The lock row (unique lockKey) goes in first, then a slot, then the invite; a refusal
   * or a failure undoes what went before.
   */
  async function createInvite(input) {
    need(isId(input.inviteId) && isId(input.invitedBy), "ids");
    need(isPond(input.pondId), "pondId");
    const email = normEmail(input.email);
    need(EMAIL.test(email), "email");
    need(INVITE_ROLES.has(input.role), "role");
    need(Number(input.expiresAt) > now(), "expiresAt");
    if (!(await getPond(input.pondId))) throw new PeopleError("no-pond", "No such Pond.");
    await expireStale(input.pondId);
    const known = await accountByEmail(email);
    if (known && (await isMember(input.pondId, known.userId)))
      throw new PeopleError("already-member", `${email} is already in this Pond.`);
    const lockKey = lockKeyOf(input.pondId, email);
    const lock = { lockKey, inviteId: input.inviteId, pondId: input.pondId };
    for (let attempt = 0; ; attempt++) {
      try {
        await tables.insert(T.locks, lock);
        break;
      } catch (e) {
        if (!isUnique(e)) throw e;
        const held = await tables.get(T.locks, "lockKey", lockKey);
        const heldBy = held ? await tables.get(T.invites, "inviteId", held.inviteId) : null;
        const stale = !held || !heldBy || heldBy.state !== "pending" || num(heldBy.expiresAt) <= now();
        if (!stale || attempt > 0)
          throw new PeopleError("invite-pending", `${email} already has a pending invitation.`);
        if (heldBy && heldBy.state === "pending") await settleInvite(heldBy.inviteId, "expired").catch(() => undefined);
        await tables.delete(T.locks, "lockKey", lockKey); // a no-op once settled freed it, and clears an orphan
      }
    }
    const slot = await claimSlot(input.pondId, inviteSlotOwner(input.inviteId));
    if (slot < 0) {
      await tables.delete(T.locks, "lockKey", lockKey);
      throw new PeopleError("pond-full", FULL);
    }
    try {
      await tables.insert(T.invites, {
        inviteId: input.inviteId,
        pondId: input.pondId,
        email,
        role: input.role,
        invitedBy: input.invitedBy,
        state: "pending",
        createdAt: now(),
        expiresAt: Number(input.expiresAt),
        settledAt: 0,
      });
    } catch (e) {
      await tables.delete(T.slots, "slotKey", `${input.pondId}:${slot}`);
      await tables.delete(T.locks, "lockKey", lockKey);
      if (isUnique(e)) throw new PeopleError("invite-exists", "That invite id is taken.");
      throw e;
    }
    return getInvite(input.inviteId);
  }

  // ---- the Invitation module's interface (issue #141) ----
  //
  // invite, join, decline, withdraw, again, listFor, listForPond. Each returns InvitationViews computed here, once:
  //   { inviteId, pondId, pondName, inviter: {name}, role, state, youAreMember, expiresAt }
  // and, for the Owner's side, also { email, invitedBy, createdAt, settledAt, userId?, name? } (what the People list draws).
  // A refusal is a PeopleError carrying `.invitation`, the fresh view, so the caller redraws from the answer.
  // Every change is announced through the notifier the relay sets (`onChange`): { pondId, invitee } where invitee is the
  // account that holds the address (accounts/<userId>/invites) or, before it has one, "e-<hash of the address>".

  let notifier = null;
  const announce = async (row) => {
    if (!notifier) return;
    try {
      const known = await accountByEmail(row.email);
      await notifier({ pondId: row.pondId, invitee: known ? known.userId : `e-${emailHash(row.email)}` });
    } catch {
      /* a lost notice costs the watcher its next read, never the action */
    }
  };

  const labelOf = (a) => (a && String(a.name || "").trim()) || (a && a.email ? maskEmail(a.email) : "") || "A teammate";

  /** The one InvitationView of a stored invite for one viewer: `viewer.userId` (for youAreMember) and/or `viewer.owner`. */
  async function viewOf(row, viewer = {}) {
    const base = inviteView(row);
    const p = await getPond(row.pondId);
    const inviter = await getAccount(row.invitedBy);
    const out = {
      inviteId: base.inviteId,
      pondId: base.pondId,
      pondName: p ? p.name : "",
      inviter: { name: labelOf(inviter) },
      role: base.role,
      state: base.state,
      youAreMember: viewer.userId ? await isMember(row.pondId, viewer.userId) : false,
      expiresAt: base.expiresAt,
      createdAt: base.createdAt,
    };
    if (viewer.owner) {
      const known = await accountByEmail(row.email);
      Object.assign(out, {
        email: base.email,
        invitedBy: base.invitedBy,
        settledAt: base.settledAt,
        ...(known ? { userId: known.userId } : {}),
        ...(known && known.name ? { name: known.name } : {}),
      });
    }
    return out;
  }
  const rowOf = (inviteId) => tables.get(T.invites, "inviteId", String(inviteId));
  const viewById = async (inviteId, viewer) => viewOf(await rowOf(inviteId), viewer);
  /** Refuses with the fresh view attached. */
  async function refuse(code, message, inviteId, viewer) {
    const e = new PeopleError(code, message);
    const row = inviteId ? await rowOf(inviteId) : null;
    if (row) e.invitation = await viewOf(row, viewer);
    throw e;
  }
  const WORDS = {
    "was-withdrawn": "This invitation was withdrawn.",
    "was-expired": "This invitation expired.",
    "was-declined": "This invitation was declined.",
    "was-joined": "This invitation was already used.",
    "not-pending": "That invitation is no longer waiting.",
    "wrong-address": "This invitation is for another address.",
  };
  const wasWords = (state) => WORDS[`was-${state}`] || WORDS["not-pending"];

  /** The invitee's side: finds the invite, checks the address, applies expiry in this one place. */
  async function forInvitee(inviteId, person) {
    const row = await rowOf(inviteId);
    if (!row) throw new PeopleError("no-invite", "No such invite.");
    const viewer = { userId: person && person.userId };
    if (normEmail(person && person.email) !== row.email)
      await refuse("wrong-address", WORDS["wrong-address"], row.inviteId, viewer);
    let state = inviteView(row).state;
    if (state === "expired" && row.state === "pending") await expireStale(row.pondId);
    return { row, state, viewer };
  }
  /** After a lost race: what the invite became, as a refusal unless it became `okState`. */
  async function lostRace(row, okState, viewer) {
    const was = inviteView(await rowOf(row.inviteId)).state;
    if (was !== okState) await refuse(`was-${was}`, wasWords(was), row.inviteId, viewer);
  }

  /**
   * Join, idempotent: the membership goes in first (the slot the invite held becomes the person's), then the invite settles.
   * Joined already, or already a Member: success with the Pond. A crash between the two steps is finished by the next call.
   * Only a withdrawn, declined or expired invite, another address, or a person who has since left refuse.
   */
  async function join(person, inviteId) {
    need(isId(person && person.userId), "userId");
    const { row, state, viewer } = await forInvitee(inviteId, person);
    if (state === "withdrawn" || state === "declined" || state === "expired")
      await refuse(`was-${state}`, wasWords(state), row.inviteId, viewer);
    const pondRow = await getPond(row.pondId);
    if (!pondRow) await refuse("no-pond", "There is no such Pond.", row.inviteId, viewer);
    const key = memberKey(row.pondId, person.userId);
    const mine = membership(await tables.get(T.members, "memberKey", key));
    if (state === "joined" && mine && !isIn(mine) && mine.leftAt > 0)
      await refuse("was-joined", wasWords("joined"), row.inviteId, viewer); // let in once, and has since left
    if (!isIn(mine)) {
      if (mine && mine.leftAt === 0) await tables.delete(T.members, "memberKey", key); // a half-made row from a crash
      const held = state === "pending" ? await tables.get(T.slots, "userId", inviteSlotOwner(row.inviteId)) : null;
      const transfer = held
        ? async () => {
            await tables.update(T.slots, "slotKey", held.slotKey, { userId: person.userId });
            return Number(held.slotKey.slice(held.slotKey.lastIndexOf(":") + 1));
          }
        : undefined;
      try {
        await enter(row.pondId, person.userId, row.role, transfer);
      } catch (e) {
        if (!(e instanceof PeopleError)) throw e;
        if (e.code !== "already-member") await refuse(e.code, e.message, row.inviteId, viewer);
      }
    }
    if (state === "pending") {
      try {
        await settleRow(row, "joined", now());
      } catch (e) {
        if (!(e instanceof PeopleError && e.code === "not-pending")) throw e;
        await lostRace(row, "joined", viewer); // another Join won: fine; anything else says what it was
      }
    }
    await announce(row);
    return { pond: { pondId: pondRow.pondId, name: pondRow.name }, invitation: await viewById(row.inviteId, viewer) };
  }

  /** Decline, idempotent: declined already is success; a joined, withdrawn or expired invite refuses with its fresh view. */
  async function decline(person, inviteId) {
    const { row, state, viewer } = await forInvitee(inviteId, person);
    if (state === "pending") {
      try {
        await settleRow(row, "declined", now());
      } catch (e) {
        if (!(e instanceof PeopleError && e.code === "not-pending")) throw e;
        await lostRace(row, "declined", viewer);
      }
    } else if (state !== "declined") await refuse(`was-${state}`, wasWords(state), row.inviteId, viewer);
    await announce(row);
    return { invitation: await viewById(row.inviteId, viewer) };
  }

  /**
   * One call for many addresses. Returns one result per address, in order:
   *   { email, status: "invited" | "already-member" | "already-invited" | "refused", invitation?, message? }
   * The first invite of a Pond that is not in the cloud yet creates it with `owner` as its Owner (`pondName` names it).
   * Rows are written here; sending the emails is the caller's job and happens after it has answered.
   */
  async function invite(owner, pondId, input) {
    need(isId(owner && owner.userId), "userId");
    need(isPond(pondId), "pondId");
    need(INVITE_ROLES.has(input.role), "role");
    need(Array.isArray(input.emails) && input.emails.length > 0, "emails");
    let p = await getPond(pondId);
    if (p && p.ownerUserId !== owner.userId) throw new PeopleError("forbidden", "Only the Owner invites.");
    if (!p) {
      const name = String(input.pondName || "").trim();
      need(name.length > 0, "pondName");
      p = await createPond({ pondId, ownerUserId: owner.userId, name });
    }
    const viewer = { owner: true };
    const results = [];
    for (const email of [...new Set(input.emails.map((e) => (typeof e === "string" ? normEmail(e) : "")))]) {
      if (!validEmail(email)) {
        results.push({
          email,
          status: "refused",
          code: "email",
          message: `${email || "That"} is not an email address.`,
        });
        continue;
      }
      try {
        const made = await createInvite({
          inviteId: input.newInviteId(),
          pondId,
          email,
          role: input.role,
          invitedBy: owner.userId,
          expiresAt: input.expiresAt,
        });
        await announce(made);
        results.push({ email, status: "invited", invitation: await viewById(made.inviteId, viewer) });
      } catch (e) {
        if (!(e instanceof PeopleError)) throw e;
        const status =
          e.code === "already-member" ? "already-member" : e.code === "invite-pending" ? "already-invited" : "refused";
        const existing =
          status === "already-invited"
            ? (await tables.select(T.invites, "pondId", pondId)).find(
                (r) => r.email === email && inviteView(r).state === "pending",
              )
            : null;
        results.push({
          email,
          status,
          code: e.code,
          message: e.message,
          ...(existing ? { invitation: await viewOf(existing, viewer) } : {}),
        });
      }
    }
    return { pond: p, results };
  }

  /** The Owner's guard for acting on one invite of their Pond. */
  async function ownedInvite(owner, pondId, inviteId) {
    const p = await getPond(pondId);
    if (!p) throw new PeopleError("no-pond", "There is no such Pond.");
    if (p.ownerUserId !== (owner && owner.userId)) throw new PeopleError("forbidden", "Only the Owner can do that.");
    const row = await rowOf(inviteId);
    if (!row || row.pondId !== pondId) throw new PeopleError("no-invite", "There is no such invitation.");
    return row;
  }

  /** Withdraw, idempotent: a withdrawn invite answers as it is; a joined, declined or expired one refuses with its fresh view. */
  async function withdraw(owner, pondId, inviteId) {
    const row = await ownedInvite(owner, pondId, inviteId);
    const state = inviteView(row).state;
    if (state === "pending") {
      try {
        await settleRow(row, "withdrawn", now());
      } catch (e) {
        if (!(e instanceof PeopleError && e.code === "not-pending")) throw e;
        await lostRace(row, "withdrawn", { owner: true });
      }
    } else if (state !== "withdrawn") await refuse("not-pending", WORDS["not-pending"], row.inviteId, { owner: true });
    await announce(row);
    return { invitation: await viewById(row.inviteId, { owner: true }) };
  }

  /** A finished (declined, expired or withdrawn) invite is made again as a new pending one; the old record goes. */
  async function again(owner, pondId, fromInviteId, input) {
    const row = await ownedInvite(owner, pondId, fromInviteId);
    const state = inviteView(row).state;
    const viewer = { owner: true };
    if (state === "joined") await refuse("joined", `${row.email} already joined.`, row.inviteId, viewer);
    if (state === "pending") await refuse("still-pending", "That invitation is still waiting.", row.inviteId, viewer);
    const made = await createInvite({
      inviteId: input.newInviteId(),
      pondId,
      email: row.email,
      role: input.role || row.role,
      invitedBy: owner.userId,
      expiresAt: input.expiresAt,
    });
    await tables.delete(T.invites, "inviteId", row.inviteId);
    await announce(made);
    return { invitation: await viewById(made.inviteId, viewer) };
  }

  /** Resend is only meaningful for a pending invite; the caller sends the email. Returns the fresh view. */
  async function pendingForResend(owner, pondId, inviteId) {
    const row = await ownedInvite(owner, pondId, inviteId);
    if (inviteView(row).state !== "pending")
      await refuse("not-pending", WORDS["not-pending"], row.inviteId, { owner: true });
    return viewById(row.inviteId, { owner: true });
  }

  /** The stored invite, as the preview and a mail need it. */
  const getInvite = async (inviteId) => inviteView(await rowOf(inviteId));

  /**
   * What the Owner sees (`listForPond`): expired ones settled, one invite per address (the newest), newest first. A finished
   * invite clears a week after it was reached. Joined ones are returned too (the person is in Members; surfaces do not draw
   * them again).
   */
  async function listForPond(owner, pondId) {
    const p = await getPond(pondId);
    if (!p) return [];
    if (p.ownerUserId !== (owner && owner.userId))
      throw new PeopleError("forbidden", "Only the Owner can see invitations.");
    await expireStale(pondId);
    const byEmail = new Map();
    for (const row of await tables.select(T.invites, "pondId", String(pondId))) {
      if (row.state !== "pending" && num(row.settledAt) + FINISHED_KEEP_MS <= now()) {
        await tables.delete(T.invites, "inviteId", row.inviteId);
        continue;
      }
      const seen = byEmail.get(row.email);
      if (!seen || num(row.createdAt) > num(seen.createdAt)) byEmail.set(row.email, row);
    }
    const views = [];
    for (const row of byEmail.values()) views.push(await viewOf(row, { owner: true }));
    return views.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * What a person sees (`listFor`): their pending invitations, and ones they joined that are not yet "listed" (the caller's
   * test: the Owner's Mac has not opened the Pond to the account yet), newest first. Nothing else is drawn.
   */
  async function listFor(person, options = {}) {
    const listed = options.isListed || (async () => true);
    const rows = await tables.select(T.invites, "email", normEmail(person && person.email));
    const views = [];
    for (const row of rows) {
      const state = inviteView(row).state;
      const viewer = { userId: person.userId };
      if (state === "pending") views.push(await viewOf(row, viewer));
      else if (
        state === "joined" &&
        num(row.settledAt) + FINISHED_KEEP_MS > now() &&
        (await isMember(row.pondId, person.userId)) &&
        !(await listed(row.pondId))
      )
        views.push(await viewOf(row, viewer));
    }
    return views.filter((v) => v.pondName).sort((a, b) => b.expiresAt - a.expiresAt);
  }

  /** The relay sets one notifier: it is told { pondId, invitee } after every change (see the interface note above). */
  const onChange = (fn) => {
    notifier = typeof fn === "function" ? fn : null;
  };

  // ---- clean start ----

  /**
   * Clears the Pond tables (Ponds, memberships, slots, invites and their locks) for the start-clean migration
   * (docs/cloud-layer.md, "Clean start"). Accounts, devices and push tokens are who people are, not Pond data: kept.
   */
  async function cleanStart() {
    return {
      ponds: await tables.clear(T.ponds),
      memberships: await tables.clear(T.members),
      slots: await tables.clear(T.slots),
      invites: await tables.clear(T.invites),
      locks: await tables.clear(T.locks),
    };
  }

  return {
    upsertAccount,
    getAccount,
    accountByEmail,
    addDevice,
    devicesOf,
    removeDevice,
    setPushToken,
    pushTokensOf,
    createPond,
    getPond,
    pondIds,
    accountIds,
    addMember,
    removeMember,
    setRole,
    deletePond,
    isMember,
    membershipOf,
    membersOf,
    pondsOf,
    createInvite,
    settleInvite,
    getInvite,
    invite,
    join,
    decline,
    withdraw,
    again,
    pendingForResend,
    listFor,
    listForPond,
    viewOf,
    onChange,
    cleanStart,
  };
}

module.exports = {
  createPeople,
  PeopleError,
  UniqueError,
  encodeText,
  decodeText,
  MAX_MEMBERS,
  INVITE_TTL_MS,
  ROLES,
  TABLES: T,
};
