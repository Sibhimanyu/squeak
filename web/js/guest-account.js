// Ponds that come with the signed-in account (docs/ponds.md, "Members are accounts"): a person who joined a pond in one
// place finds it in this browser too, with no code, link or approval. The relay lists the account's ponds
// (`GET /account/ponds`); for each one this browser does not hold, it makes that pond's own device key and asks the relay
// to put the device in the pond (`POST /account/pond-devices`); the owner's Mac then lists the device in the member's
// document and seals the pond key to it, and `GuestPond.refresh` picks that up like any approval. Every pond is its own
// record in the vault, and nothing here ever writes the invite flow's `guest` record.

import { newMemberKey, memberIdOf } from "./guest-crypto.js";
import { GuestPond, RECORD } from "./guest-pond.js";
import { relayFetch } from "./guest-relay.js";

/** The vault name of the list of ponds that came with the account. */
export const INDEX = "guest-account";
/** At most one ask of the relay per load, and never more than this often. */
export const SYNC_GAP_MS = 60_000;
const POND_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const slotOf = (pondId) => `guest-account:${pondId}`;

/**
 * Which listed ponds to ask for: well-formed, not held in any state, not refused earlier in this session. Pure.
 * `listed` is the relay's `ponds` array (anything else yields none).
 */
export function pondsToRequest({ listed, held = [], refused = new Set() }) {
  if (!Array.isArray(listed)) return [];
  const have = new Set(held);
  const seen = new Set();
  const out = [];
  for (const entry of listed) {
    if (!entry || typeof entry !== "object") continue;
    const { pondId, ownerKey, name } = entry;
    if (typeof pondId !== "string" || !POND_ID.test(pondId) || typeof ownerKey !== "string" || !ownerKey) continue;
    if (have.has(pondId) || refused.has(pondId) || seen.has(pondId)) continue;
    seen.add(pondId);
    out.push({ pondId, ownerKey: ownerKey.slice(0, 200), name: typeof name === "string" ? name.slice(0, 200) : "" });
  }
  return out;
}

/** The ponds this browser's account has here: the ids in the index whose record is still there. */
export async function loadAccountPonds({ vault, fetch, now } = {}) {
  const ids = await vault.read(INDEX).catch(() => null);
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const record = await vault.read(slotOf(id)).catch(() => null);
    if (record) out.push(new GuestPond({ record, vault, fetch, now, slot: slotOf(id) }));
  }
  return out;
}

async function setIndex(vault, ids) {
  await vault.write(INDEX, [...new Set(ids)]);
}

/**
 * Asks for this account's ponds that this browser lacks. One session's state (`state.lastAt`, `state.refused`) keeps it to
 * one ask a minute and never repeats a pond the relay refused; a refusal (403, 429) or a failure is silent. Returns every
 * account pond now in the vault (`GuestPond`s, pending or not), or [] when it did not run.
 */
export async function syncAccountPonds({
  relayUrl,
  token,
  vault,
  fetch: fetchImpl = relayFetch,
  now = Date.now,
  state = { lastAt: 0, refused: new Set() },
}) {
  const given = token?.();
  if (!relayUrl || !given) return loadAccountPonds({ vault, fetch: fetchImpl, now });
  if (state.lastAt && now() - state.lastAt < SYNC_GAP_MS) return loadAccountPonds({ vault, fetch: fetchImpl, now });
  state.lastAt = now();
  const base = relayUrl.replace(/\/+$/, "");
  const headers = { "x-squeak-account": given };
  let listed;
  try {
    const response = await fetchImpl(`${base}/account/ponds`, {
      headers,
      credentials: "omit",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200) return loadAccountPonds({ vault, fetch: fetchImpl, now });
    listed = (await response.json())?.ponds;
  } catch {
    return loadAccountPonds({ vault, fetch: fetchImpl, now });
  }
  const held = [];
  const mine = await vault.read(RECORD).catch(() => null);
  if (mine?.pondId) held.push(mine.pondId);
  // Only ids whose record is still there count as held: a request that lapsed left none, and is asked for again.
  const known = (await loadAccountPonds({ vault, fetch: fetchImpl, now })).map((p) => p.pondId);
  held.push(...known);
  const want = pondsToRequest({ listed, held, refused: state.refused });
  const added = [];
  for (const entry of want) {
    let key;
    let issued;
    try {
      key = await newMemberKey();
      const response = await fetchImpl(`${base}/account/pond-devices`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        credentials: "omit",
        body: JSON.stringify({
          pondId: entry.pondId,
          publicKey: key.publicKey,
          boxKey: key.publicKey,
          client: "web",
          nest: null,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 200) {
        state.refused.add(entry.pondId);
        continue;
      }
      issued = await response.json();
    } catch {
      state.refused.add(entry.pondId);
      continue;
    }
    if (typeof issued?.token !== "string" || typeof issued?.reqId !== "string") {
      state.refused.add(entry.pondId);
      continue;
    }
    const keyId = await memberIdOf(key.publicKey);
    const record = {
      v: 1,
      status: "pending",
      deviceJoin: true,
      pondId: entry.pondId,
      pondName: entry.name || "A pond",
      displayName: "",
      requestId: issued.reqId,
      relayUrl: base,
      joinToken: issued.token,
      token: null,
      ownerKey: entry.ownerKey,
      ownerId: await memberIdOf(entry.ownerKey),
      ownerName: null,
      inviteExpiresAt: typeof issued.expiresAt === "number" ? issued.expiresAt : now() + 24 * 3_600_000,
      requestedAt: now(),
      keys: {},
      current: 0,
      words: null,
      signingKey: key.signingKey,
      ecdhKey: key.ecdhKey,
      publicKey: key.publicKey,
      keyId,
      memberId: keyId,
      role: "viewer",
    };
    // Saved before the list names it: a key that is listed must be there.
    await vault.write(slotOf(entry.pondId), record);
    known.push(entry.pondId);
    await setIndex(vault, known);
    added.push(entry.pondId);
  }
  return loadAccountPonds({ vault, fetch: fetchImpl, now });
}

/** Forgets a pond's account record and its place in the list (it was removed, or its request lapsed). */
export async function forgetAccountPond(vault, pondId) {
  await vault.write(slotOf(pondId), null);
  const ids = await vault.read(INDEX).catch(() => null);
  await setIndex(
    vault,
    (Array.isArray(ids) ? ids : []).filter((id) => id !== pondId),
  );
}
