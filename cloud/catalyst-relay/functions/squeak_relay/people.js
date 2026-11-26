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

  /** The invitee's side: only the address the invite names may use it (`who.email` is the account's verified address). */
  async function openInvite(inviteId, who) {
    const row = await tables.get(T.invites, "inviteId", String(inviteId));
    if (!row) throw new PeopleError("no-invite", "No such invite.");
    const view = inviteView(row);
    if (view.state === "expired" && row.state === "pending") await expireStale(row.pondId);
    if (view.state !== "pending") throw new PeopleError(`was-${view.state}`, "That invitation is no longer open.");
    if (normEmail(who && who.email) !== row.email)
      throw new PeopleError("wrong-address", "This invitation is for another address.");
    return row;
  }

  /** Join: the person becomes a Member at once (the slot the invite held is theirs) and the invite is Joined. */
  async function acceptInvite(inviteId, who) {
    need(isId(who && who.userId), "userId");
    const row = await openInvite(inviteId, who);
    const held = await tables.get(T.slots, "userId", inviteSlotOwner(row.inviteId));
    // Claim the invite first (its lock): only one of Join, Decline and Withdraw can win.
    await settleRow(row, "joined", now(), true);
    try {
      const transfer = held
        ? async () => {
            await tables.update(T.slots, "slotKey", held.slotKey, { userId: who.userId });
            return Number(held.slotKey.slice(held.slotKey.lastIndexOf(":") + 1));
          }
        : undefined;
      await enter(row.pondId, who.userId, row.role, transfer);
    } catch (e) {
      // Not in after all (already a member): the invite is closed as Withdrawn and its slot freed; anything else, back to pending.
      if (e instanceof PeopleError && e.code === "already-member") {
        await tables.update(T.invites, "inviteId", row.inviteId, { state: "withdrawn", settledAt: now() });
        await freeInviteSlot(row.inviteId);
      } else {
        await tables.update(T.invites, "inviteId", row.inviteId, { state: "pending", settledAt: 0 });
        await tables.insert(T.locks, {
          lockKey: lockKeyOf(row.pondId, row.email),
          inviteId: row.inviteId,
          pondId: row.pondId,
        });
      }
      throw e;
    }
    return getInvite(row.inviteId);
  }
  async function declineInvite(inviteId, who) {
    const row = await openInvite(inviteId, who);
    await settleRow(row, "declined", now());
    return getInvite(row.inviteId);
  }
  /** The Owner takes a pending invite back. (The route checks it is the Owner and that the invite is of that Pond.) */
  const withdrawInvite = (inviteId) => settleInvite(inviteId, "withdrawn");

  /** A finished (declined, expired or withdrawn) invite is made again as a new pending one; the old record goes. */
  async function inviteAgain(input) {
    const row = await tables.get(T.invites, "inviteId", String(input.fromInviteId));
    if (!row || row.pondId !== input.pondId) throw new PeopleError("no-invite", "No such invite.");
    const view = inviteView(row);
    if (view.state === "joined") throw new PeopleError("joined", `${row.email} already joined.`);
    if (view.state === "pending") throw new PeopleError("still-pending", "That invitation is still waiting.");
    const made = await createInvite({
      inviteId: input.inviteId,
      pondId: input.pondId,
      email: row.email,
      role: input.role || row.role,
      invitedBy: input.invitedBy,
      expiresAt: input.expiresAt,
    });
    await tables.delete(T.invites, "inviteId", row.inviteId);
    return made;
  }

  const getInvite = async (inviteId) => inviteView(await tables.get(T.invites, "inviteId", String(inviteId)));
  const invitesOf = async (pondId) => (await tables.select(T.invites, "pondId", String(pondId))).map(inviteView);
  /**
   * What the Owner sees: expired ones settled, one invite per address (the newest), newest first. A finished invite clears
   * a week after it was reached. Joined ones are returned too (the person is in Members; surfaces do not draw them again).
   */
  async function listInvites(pondId) {
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
    return [...byEmail.values()].map(inviteView).sort((a, b) => b.createdAt - a.createdAt);
  }
  const pendingInvitesFor = async (email) =>
    (await tables.select(T.invites, "email", normEmail(email))).map(inviteView).filter((i) => i.state === "pending");
  /** The invites this address joined that are still within their keep time (the Owner's Mac may not have let the person in yet). */
  const joinedInvitesFor = async (email) =>
    (await tables.select(T.invites, "email", normEmail(email)))
      .map(inviteView)
      .filter((i) => i.state === "joined" && i.settledAt + FINISHED_KEEP_MS > now());

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
    acceptInvite,
    declineInvite,
    withdrawInvite,
    inviteAgain,
    getInvite,
    invitesOf,
    listInvites,
    pendingInvitesFor,
    joinedInvitesFor,
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
