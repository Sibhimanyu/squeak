// Reading a pond invite from a link: `https://<host>/join#<code>`. The code is in the URL fragment, which a browser never
// sends to any server; it holds the pond key and the invite's secret, so this module only reads it, and `clearFragment`
// takes it out of the address bar and history once it has been read. Checks match the Mac's `FlotillaService.join`.

import { fromBase64Url, fromUtf8 } from "./encoding.js";

const POND_ID = /^[A-Za-z0-9_-]{22,64}$/;
const CATALYST_HOST = /\.(catalystserverless|catalystappsail)\.(com|in|eu|com\.au|jp|ca|sa)$/;
const PREFIX = "squeak-pond:";

/** The relay's URL if it is a Catalyst address with no credentials, else null (as `relayBaseUrl` on the Mac). */
export function relayBaseUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (!CATALYST_HOST.test(url.hostname)) return null;
    return `https://${url.hostname}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

const SHORT_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** "k7p 4qd", "K7P-4QD" -> "K7P-4QD"; anything else (a long code, a typo, 0/O/1/I/L) -> null. (`normalizeShortCode` on the Mac.) */
export function normalizeShortCode(text) {
  const raw = String(text ?? "");
  if (raw.length > 32) return null;
  const bare = raw.replace(/[\s-]/g, "").toUpperCase();
  if (bare.length !== 6 || [...bare].some((c) => !SHORT_ALPHABET.includes(c))) return null;
  return `${bare.slice(0, 3)}-${bare.slice(3)}`;
}

/** The code part of a fragment or of a pasted invite, or null. */
export function codeFrom(text) {
  const raw = String(text ?? "").trim();
  const bare = raw.includes("#") ? raw.slice(raw.indexOf("#") + 1) : raw.replace(PREFIX, "");
  return bare || null;
}

/**
 * Served from the relay's own domain (`origin`, Catalyst web client hosting), the relay is reached by a same-origin
 * relative path (`/server/squeak_relay`); anywhere else, by the absolute URL the invite carries.
 *
 * `{ ok: true, invite }` or `{ ok: false, reason }` with a sentence for the person. A web guest needs a Catalyst relay
 * and its join token: an invite for a Firebase store has neither, so it is for a Mac.
 */
export function readInvite(code, now = Date.now(), origin = null) {
  let body;
  try {
    body = JSON.parse(fromUtf8(fromBase64Url(codeFrom(code) ?? "")));
  } catch {
    return { ok: false, reason: "That invite link is not valid. Ask for a new one." };
  }
  return inviteFrom(body, now, origin, false);
}

/**
 * The join details the relay hands over for a short code (no pond key in them: it reaches this browser sealed to its key
 * once the owner approves), as an invite with `key: null`.
 */
export function readShortDetails(details, now = Date.now(), origin = null) {
  return inviteFrom(details, now, origin, true);
}

function inviteFrom(body, now, origin, short) {
  const { p, o, n, s, e } = body ?? {};
  const k = short ? "" : body?.k;
  const kv = short ? 0 : body?.kv;
  if (
    body?.v !== 1 ||
    typeof p !== "string" ||
    !POND_ID.test(p) ||
    typeof k !== "string" ||
    typeof kv !== "number" ||
    typeof o !== "string" ||
    typeof s !== "string" ||
    typeof e !== "number"
  ) {
    return { ok: false, reason: "That invite link is not valid. Ask for a new one." };
  }
  if (e < now) return { ok: false, reason: "That invite has expired. Ask for a new one." };
  const relayUrl = relayBaseUrl(body.l?.relayUrl);
  if (body.l?.provider !== "catalyst" || !relayUrl || typeof body.jt !== "string" || !body.jt) {
    return { ok: false, reason: "This invite is for Squeak on a Mac. Ask for a link made for the web." };
  }
  const sameOrigin = origin && new URL(relayUrl).origin === origin ? new URL(relayUrl).pathname : null;
  return {
    ok: true,
    invite: {
      pondId: p,
      key: short ? null : k,
      keyVersion: kv,
      ownerKey: o,
      name: typeof n === "string" ? n.slice(0, 200) : "A pond",
      secret: s,
      expiresAt: e,
      role: body.r === "viewer" ? "viewer" : "member",
      ownerName: typeof body.on === "string" && body.on ? body.on.slice(0, 100) : null,
      relayUrl: sameOrigin ?? relayUrl,
      joinToken: body.jt,
    },
  };
}

/** Removes the code from the address bar and the history entry; call once it is read. */
export function clearFragment(win = globalThis) {
  try {
    if (win.location?.hash)
      win.history.replaceState(win.history.state, "", win.location.pathname + win.location.search);
  } catch {
    // No history API: the fragment stays in the bar, and still goes nowhere.
  }
}
