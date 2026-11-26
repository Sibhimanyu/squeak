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

/** The most people in a Pond, the Owner included. */
const MAX_MEMBERS = 10;
const ROLES = new Set(["owner", "member", "viewer"]);
const INVITE_ROLES = new Set(["member", "viewer"]);
const DEVICE_KINDS = new Set(["mac", "ios", "web"]);
const SETTLED = new Set(["joined", "declined", "withdrawn", "expired"]);
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const VARCHAR = 255;

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
    const patch = { email, name, updatedAt: t };
    if (await tables.update(T.accounts, "userId", input.userId, patch)) return getAccount(input.userId);
    try {
      await tables.insert(T.accounts, { userId: input.userId, ...patch, createdAt: t });
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
  async function enter(pondId, userId, role) {
    const t = now();
    const key = memberKey(pondId, userId);
    const existing = membership(await tables.get(T.members, "memberKey", key));
    if (existing) {
      if (isIn(existing) || existing.leftAt === 0) throw new PeopleError("already-member", "Already in this Pond.");
      const slot = await claimSlot(pondId, userId);
      if (slot < 0) throw new PeopleError("pond-full", `A Pond holds ${MAX_MEMBERS} people.`);
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
    const slot = await claimSlot(pondId, userId);
    if (slot < 0) {
      await tables.delete(T.members, "memberKey", key);
      throw new PeopleError("pond-full", `A Pond holds ${MAX_MEMBERS} people.`);
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

  const lockKeyOf = (pondId, email) => `${pondId}:${emailHash(email)}`;

  async function settleInvite(inviteId, state) {
    if (!SETTLED.has(state)) throw new PeopleError("invalid", "state");
    const row = await tables.get(T.invites, "inviteId", String(inviteId));
    if (!row) throw new PeopleError("no-invite", "No such invite.");
    if (row.state !== "pending") throw new PeopleError("not-pending", "That invite is already settled.");
    await tables.update(T.invites, "inviteId", row.inviteId, { state, settledAt: now() });
    await freeLock(row);
    return inviteView(await tables.get(T.invites, "inviteId", row.inviteId));
  }
  /** Deletes an invite's lock, only when the lock is still its own. */
  async function freeLock(inviteRow) {
    const key = lockKeyOf(inviteRow.pondId, inviteRow.email);
    const lock = await tables.get(T.locks, "lockKey", key);
    if (lock && lock.inviteId === inviteRow.inviteId) await tables.delete(T.locks, "lockKey", key);
  }

  /**
   * One pending invite per address per Pond: the lock row (unique lockKey) goes in first, then the invite. A lock whose
   * invite has expired (or is gone) is cleared once, so an Owner can invite the address again.
   */
  async function createInvite(input) {
    need(isId(input.inviteId) && isId(input.invitedBy), "ids");
    need(isPond(input.pondId), "pondId");
    const email = normEmail(input.email);
    need(EMAIL.test(email), "email");
    need(INVITE_ROLES.has(input.role), "role");
    need(Number(input.expiresAt) > now(), "expiresAt");
    if (!(await getPond(input.pondId))) throw new PeopleError("no-pond", "No such Pond.");
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
          throw new PeopleError("invite-pending", "That address already has a pending invite.");
        if (heldBy && heldBy.state === "pending") await settleInvite(heldBy.inviteId, "expired").catch(() => undefined);
        await tables.delete(T.locks, "lockKey", lockKey); // a no-op once settleInvite freed it, and clears an orphan
      }
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
      await tables.delete(T.locks, "lockKey", lockKey);
      if (isUnique(e)) throw new PeopleError("invite-exists", "That invite id is taken.");
      throw e;
    }
    return getInvite(input.inviteId);
  }
  const getInvite = async (inviteId) => inviteView(await tables.get(T.invites, "inviteId", String(inviteId)));
  const invitesOf = async (pondId) => (await tables.select(T.invites, "pondId", String(pondId))).map(inviteView);
  const pendingInvitesFor = async (email) =>
    (await tables.select(T.invites, "email", normEmail(email))).map(inviteView).filter((i) => i.state === "pending");

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
    isMember,
    membershipOf,
    membersOf,
    pondsOf,
    createInvite,
    settleInvite,
    getInvite,
    invitesOf,
    pendingInvitesFor,
    cleanStart,
  };
}

module.exports = { createPeople, PeopleError, UniqueError, encodeText, decodeText, MAX_MEMBERS, ROLES, TABLES: T };
