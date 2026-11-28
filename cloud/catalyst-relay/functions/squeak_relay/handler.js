// The relay's request handling, with every Catalyst service passed in (`deps`), so tests run it with fakes and the
// deployed function (index.js) wires the real SDK. Contract: docs/cloud-layer.md, "Catalyst: how the five operations map".
//
//   GET    /doc?path=            -> 200 {doc} | 404
//   PUT    /doc?path=  {doc}     -> 204, or 200 {ok:true} for kind cliq (then a change notice {p:"channels/<id>/<kind>"})
//   DELETE /doc?path=            -> 204 (then the notice)
//   GET    /list?prefix=         -> 200 {items:[{id,doc}]}
//   GET    /me                   -> 200 {userId, email, name, avatarAt?} (Catalyst Hosted-login user, no relay key) | bare 401
//   PUT|DELETE|GET /account/avatar (cookie or x-squeak-account token; GET also relay key + ?userId=): the account's photo,
//                         a JPEG of at most 64 KB kept under the relay-owned pk "avatars" (no /doc or /list path reaches it)
//   GET    /account/zoho-photo/start (cookie) -> 302 to Zoho's consent for profile.userphoto.READ; GET .../callback (Zoho's
//                         redirect, same cookie) reads THEIR OWN photo once, parks it 10 min under the relay-owned pk
//                         "zoho-photo" and 302s to the app with #zoho-photo=ready|denied|failed|blocked; GET /account/zoho-photo
//                         (cookie) hands the bytes over once and deletes them. Needs deps.zoho (env SQUEAK_ZOHO_*), else 503
//                         These three use the signed-in account (cookie) only, never a Mac key. Relay-owned pks ("avatars", "avatar-writes",
//                         "zoho-photo", and the tenants.js "mac-keys", "mac-owners", "mac-user/<id>") are never reachable by /doc or /list:
//                         parseDocPath/parseKindPath accept only channels/<id>/<kind>
//   POST   /account/names {ids:[userId]} (relay key or Mac key, at most 50) -> {names:{id:{name,email?}}, self?}: the display names
//                         relay-side accounts signed in with ("names", relay-owned); a Mac key also gets its own account as self
//   POST   /ponds/<pondId>/members/accounts {ownerKey, name?, add:[userId], remove:[userId]} (the pond's own Mac): the account
//                         index "acctponds/<userId>" (relay-owned); GET /account/ponds (account token or Mac key) -> {ponds:[{pondId,
//                         ownerKey, name?}]} for the caller's own account only; POST /account/pond-devices {pondId, publicKey, boxKey?,
//                         client, nest?} (same callers, 10 a minute per account) writes the relay-owned channels/<pond>/devreqs/<deviceId>
//                         and answers a join-scope token (docs/ponds.md, "Members are accounts")
//   GET    /account/overview (account token) -> {ponds:[{pondId, name, ownerName, ownerKey, mine, role, shared, lastActivityAt, seqHead,
//                         counts:{members, ducks}}], invitations:[{inviteId, pondName, inviterName, at}]}: metadata only, for the web's
//                         Ponds screen; POST /account/invitations/<inviteId>/join (-> {pondId, pond, invitation}) | /decline (-> {invitation}),
//                         the one Join (account token or a Mac's key), idempotent; the invited address only (docs/cloud-layer.md, "Invitations")
//   GET    /account/devices?deviceId=<this device> (account token or Mac key) -> {devices:[{deviceId, name, kind: mac|web|iphone,
//                         createdAt, lastSeenAt, thisDevice}]}: the account's devices, never a Pond's; POST /account/devices {publicKey,
//                         name, kind} registers or refreshes one -> {deviceId}; DELETE /account/devices/<deviceId> -> 204: removes it
//                         from the account and from every Pond at once (its tokens are refused) and leaves a relay-owned removal
//                         note in each Pond's devreqs for the Owner's Mac, which rotates the key when it is online
//   POST   /account/pond-leaves {pondId} (same callers): leaves the Pond, final at once: membership ended, every device's pond tokens
//                         refused, live subscriptions closed, a relay-owned devreqs/acct-<userId> note for the Owner's Mac; marks the caller's own index entry left (idempotent, 403 if not listed or a member);
//                         GET /account/ponds then returns it with left:true; the owner's remove or a fresh add clears it
//   POST   /account/link-ticket (cookie) | POST /account/link, /account/unlink (relay key) | GET /account/macs (cookie)
//   GET    /account/handoff?return=<pinned web origin> (cookie): the web app on another origin (squeak.onslate.in) signs in HERE
//                         (the function's own origin, where Catalyst can read the session) and gets an app token back in the URL
//                         FRAGMENT of a 302 to the return URL; no session cookie is ever needed on the other origin. The return URL
//                         must be one of HANDOFF_RETURNS exactly (https, no port/query/fragment, path / or /index.html), else 400.
//                         Signed out: 302 to Catalyst's hosted login with this same URL as its redirect (one try, then 401).
//   POST   /account/app-token (cookie only) -> {token, expiresAt, email, name}; header x-squeak-account: <token> stands in for
//                         the cookie on /me, /account/macs, /account/device-request and /account/avatar (so it lists Macs,
//                         requests devices and owns the photo; it still mints neither tokens nor tickets)
//   POST|GET /account/device-request (cookie): see docs/cloud-layer.md, "Accounts"
//   POST   /admin/clean-start {confirm:"wipe-cloud-ponds", pondIds?, userIds?} (relay key only; 403 unless the relay runs with
//                         SQUEAK_CLEAN_START=on, the development environment) -> 200 {ponds, documents, indexes, people}: clears every
//                         Pond from the cloud (clean-start.js); Mac channels, accounts and devices stay
//   GET    /changes?pond=&since=<seq|head>&limit=  -> 200 {changes:[{seq,kind,id,doc|null}], next, more} (feed.js; key, Mac key, pond
//                         token or an account token whose account is a member; 404 when the store keeps no feed)
//   PUT|GET|DELETE /blob?pond=&id=[&kind=room|rposts&doc=<post id>] -> a sealed picture or file in Stratus (blobs.js): PUT stores the
//                         request body as sent (204; 413 {error:"blob-too-large"|"blob-quota", message} past 6 MB a blob / 200 MB a
//                         Pond), GET returns the bytes (members only: a Pond's Mac, a member's account or token; 404 when paged out),
//                         DELETE the Pond's Mac or the key; 503 until SQUEAK_BLOB_BUCKET names a bucket
//   GET    /ping                 -> 200 {ok, store, channel, channelId?, version}
//   POST   /token    {name}      -> 200 {url, key, wssId}
//   POST   /pond-token {pondId, memberId, ttlSec, scope?}  (relay key) -> 200 {token, expiresAt}: a pond-scoped token;
//                      scope "guest" (default), "member" or "join" (an invite's: writes the join request only)
//   POST   /pond-revoke {pondId, memberId}         (relay key) -> 204
//   POST   /account/macs/provision {macId, name?} (cookie or x-squeak-account) -> 200 {macId, key, ...}: creates or rotates the
//                      Mac's own key (shown once, only its hash kept; at most 10 Macs per account: 409 too-many-macs)
//   POST   /account/macs/cliq-token {channel, token} (the Mac's own key) -> 200 {ok:true}: registers the Cliq ingest token of one of
//                      that Mac's channels (its hash only); the handlers' `PUT /doc?path=channels/<channel>/cliq/<id>` then
//                      carries x-squeak-cliq: <token> and counts against the Mac's account. The old shared CLIQ_KEY still works.
//   POST   /account/macs/hist-token {channel, token, previous?} (the Mac's own key) -> 200 {ok:true}: the write token of the channel's
//                      history in the cloud (kind "hist", docs/remote-channel.md "History cache" Layer 2): only a request carrying it
//                      as x-squeak-hist may PUT or DELETE there (403 otherwise); 413 {error:"cap"} past 50 MB / 4000 documents per
//                      account; GET by id works with the channel's key, /list is 403. A Mac's own key registers or rotates it (409 for another Mac's)
//   DELETE /account/macs/<macId> (cookie or x-squeak-account, the owner) -> 204: revokes that key
//   with header x-squeak-mac-key (a per-Mac key, tenants.js; /token gives the shared stream, whose hosted notices are opaque tags) instead of the relay key: /doc, /list, /ping, /token,
//   /pond-token, /pond-revoke, /account/link, /account/unlink and GET /account/avatar?userId= for that Mac's own channels
//   only (403 elsewhere), and per-account daily request/byte limits (429 {error:"quota"})
//   with header x-squeak-pond-token instead of the relay key: /doc and /list inside that one pond only (guest writes
//   limited to the scope's kinds in scoped.SCOPES), and POST /pond-stream {name} -> that pond's own Data Streams token pair
//
// Every other request needs header x-squeak-relay equal to RELAY_KEY (the operator's, opens everything; constant-time
// compare) or a valid x-squeak-mac-key; anything else is a bare 401.
const crypto = require("node:crypto");
const { CHANNEL, DOC, MAX_BODY, NAME, parseDocPath, parseKindPath, validDoc } = require("./rules");
const scoped = require("./scoped");
const { createFeed, FEED_KINDS } = require("./feed");
const { createLiveNotices } = require("./live-notice");
const { createRoomCloud } = require("./room-cloud");
const { createBlobs, BLOB_ID } = require("./blobs");
const mailing = require("./mail");
const { createTenants, HEADER: MAC_HEADER } = require("./tenants");
const { createCleanStart } = require("./clean-start");
const { createClientGate, UPDATE_MESSAGE } = require("./client-gate");

const VERSION = require("./package.json").version;
const PREFIX = /^\/server\/squeak_relay/;

const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();
/** Constant-time equality of two secrets (both hashed first, so lengths do not leak). */
const sameKey = (given, expected) =>
  typeof expected === "string" &&
  expected.length > 0 &&
  typeof given === "string" &&
  crypto.timingSafeEqual(digest(given), digest(expected));

/**
 * Kinds no pond token may touch. devreqs (a signed-in account's
 * request to add a device to its Mac) are written only by the relay itself; devresults is written by the Mac (relay key).
 */
const RELAY_OWNED_KINDS = new Set(["devreqs", "devresults"]);
const isRelayOwned = (kind) => RELAY_OWNED_KINDS.has(kind);
/** The relay key itself never PUTs these two: the relay alone writes them (devresults is the Mac's answer, so it may). */
/** The one history document that wakes readers (the index); pages are read by id from it, so they stay quiet. */
const HIST_INDEX = "idx";
const NO_KEY_PUT = new Set(["devreqs", "roomnote"]);
const TICKET_TTL_MS = 10 * 60 * 1000;
const NAMES_MAX = 50;
const APP_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_OPEN_REQUESTS = 3;
/** Device requests one account may make per minute, across all its Macs: a stolen token cannot spray device keys. */
const DEVREQ_PER_MINUTE = 5;
const DEVREQ_RATE_PK = "devreq-rate";
/** The last time a Mac's own key called the relay (`macseen/<macId>`), stamped at most this often, for "Your Macs". */
const SEEN_PK = "macseen";
const SEEN_STAMP_MS = 60 * 1000;
/** Online within this long of the last call, asleep within `ASLEEP_MS`, offline beyond (the web and iPhone word it the same). */
const ONLINE_MS = 3 * 60 * 1000;
const ASLEEP_MS = 12 * 60 * 60 * 1000;
/** `macask/<macId>` = `{ ask: boolean }`: the Mac's own word on "Ask before adding my own devices", for the list. */
const ASK_PK = "macask";
/** Per process, not per request: a request builds its own relay. */
const seenStamped = new Map();
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const B64_ANY_200 = /^[A-Za-z0-9+/_-]{1,200}={0,2}$/;
const B64URL_200 = /^[A-Za-z0-9_-]{1,200}$/;
const NO_STORE = { "Cache-Control": "no-store" };
/**
 * Account-wide pond membership (docs/ponds.md, "Members are accounts"). \`acctponds/<userId>\` holds one row per pond whose
 * owner's Mac wrote that account as a member (\`POST /ponds/<id>/members/accounts\`, the channel's own Mac); only that
 * account reads it (\`GET /account/ponds\`). A device of the account asks to be added with \`POST /account/pond-devices\`,
 * which writes the relay-owned \`devreqs\` document in the pond's channel: its presence is the relay's attestation.
 */
const ACCT_PONDS_PK = "acctponds";
const PONDDEV_RATE_PK = "ponddev-rate";
const PONDDEV_PER_MINUTE = 10;
const PONDDEV_TOKEN_TTL_SEC = 24 * 60 * 60;
const ACCT_INDEX_MAX = 50;
const ACCT_PONDS_MAX = 100;
const DEVICE_CLIENTS = new Set(["mac", "web", "ios"]);
/** The most devices one account lists in Settings > Your devices. */
const DEVICES_PER_ACCOUNT = 20;
/** The profile photo: relay-owned partition keys (not channels/..., so parseDocPath/parseKindPath can never name them). */
const AVATAR_PK = "avatars";
const NAMES_PK = "names";
const AVATAR_RATE_PK = "avatar-writes";
const AVATAR_MAX_BYTES = 64 * 1024;
/** base64 of the largest photo, plus the JSON around it. */
const AVATAR_MAX_BODY = Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 1024;
const AVATAR_WRITES_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** The Zoho photo hand-over: a relay-owned pk (like "avatars", no /doc or /list path names it), kept ten minutes. */
const ZOHO_PK = "zoho-photo";
const ZOHO_TTL_MS = 10 * 60 * 1000;
const ZOHO_PHOTO_MAX_BYTES = 256 * 1024; // base64 of this stays under a NoSQL item's ~400 KB
const ZOHO_FETCH_MS = 10_000;
const ZOHO_SCOPE = "profile.userphoto.READ";
/** Zoho's accounts hosts (one per data centre); an `accounts-server` the callback names is trusted only if it is one. */
const ZOHO_ACCOUNTS = /^accounts\.zoho\.(com|in|eu|com\.au|jp|com\.cn|sa|ca)$/;
const ZOHO_APP_PATH = "/app/index.html";
/** The only places a sign-in handoff may return to (exact origin, no wildcard): the web app's Slate home. */
const HANDOFF_ORIGINS = ["https://squeak.onslate.in"];
/** Home, or the invite page (an emailed link opens /invite?code=<invite id>). */
const HANDOFF_PROVIDERS = ["zoho", "google", "email"];
const HANDOFF_PATHS = ["/", "/index.html", "/invite"];
const handoffReturn = (value) => {
  try {
    const u = new URL(String(value));
    if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash) return null;
    if (!HANDOFF_ORIGINS.includes(u.origin) || !HANDOFF_PATHS.includes(u.pathname)) return null;
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
};
/** Invite email (docs/cloud-layer.md): limits and the fixed sentences a failure may carry. */
const INVITE_PREVIEW_PK = "invite-preview";
const INVITE_PREVIEW_PER_MIN = 60;
const INVITE_PREVIEW_MEMBERS = 10;
const INVITE_MAIL_PK = "invite-mail";
const INVITE_MAIL_STATE_PK = "invite-mail-state";
const INVITE_MAIL_MAX = 10;
const INVITE_MAIL_PER_MAC_DAY = 20;
const INVITE_PAGE = "https://squeak.onslate.in/invite";
const DAY_MS = 24 * HOUR_MS;
/** An invitation lives a week (people.js clears finished ones a week after they were reached). */
const INVITE_TTL_MS = 7 * DAY_MS;
const MAIL_NOT_SET = "Squeak's email isn't set up yet.";
const MAIL_FAILED = "Squeak couldn't send the email right now. Try again later.";
const normEmail = (e) => String(e).trim().toLowerCase();
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

const send = (res, status, body, headers) => {
  if (body === undefined) {
    if (headers) res.writeHead(status, headers);
    else res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const tooLarge = () => Object.assign(new Error("too large"), { status: 413 });
const readBody = (req, max) =>
  new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(tooLarge());
        return;
      }
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
/** The request body as bytes (a sealed blob), refusing anything over `max`: unlike readBody, nothing is decoded as text. */
const readBytes = (req, max) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(tooLarge());
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
const readJson = async (req, max) => {
  const raw = await readBody(req, max);
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error("bad json"), { status: 400 });
  }
};

/**
 * deps = {
 *   key: string | undefined,                    // RELAY_KEY
 *   store: { get(pk, doc) -> string|null, put(pk, doc, json), del(pk, doc), list(pk) -> [{doc, json}], ready() -> bool },
 *   streams: { channelId() -> string|null, publish(channelId, text), token(channelId, name) -> {url, key, "wss-id"} },
 *   currentUser?: () -> {userId, email, name} | null,   // the signed-in Catalyst user of THIS request (user scope), never throws
 *   signin?: "required",                         // GUEST_SIGNIN: a join request needs a signed-in user
 *   log?: (sentence) => void,
 * }
 */
const STATE_NOTICE_KINDS = new Set(["snapshot", "alive", "recent", "presence"]);

function createRelay(deps) {
  const log = deps.log || (() => {});
  // Old Mac apps are refused on Pond routes (client-gate.js); deps.minMacVersion is SQUEAK_MIN_MAC_VERSION.
  const oldMac = createClientGate(deps.minMacVersion);
  const tenants = createTenants({
    store: deps.store,
    now: deps.now,
    limits: deps.limits,
    batch: deps.quotaBatch,
    usageCache: deps.usageCache,
    ownerCache: deps.ownerCache,
  });

  /**
   * Wakes the watchers after a write. Self-hosted: {"p":"channels/<id>/<kind>"}. Hosted (SQUEAK_RELAY_HOSTED=1, one shared
   * stream for every tenant): {"t":"<tag>"} only, no path and no kind, so a subscriber learns nothing about other tenants
   * (scoped.noticeTag). A notice only wakes a pass; the reader re-reads through the store.
   */
  async function publishNotice(pk, doc) {
    // `k` (optional, old readers ignore it) names which state document changed, so a reader can skip the ones that are
    // not for it (a phone's own presence ping, the Mac's own alive): only a few fixed names, never a command id.
    const k = pk.endsWith("/state") && STATE_NOTICE_KINDS.has(doc) ? doc : undefined;
    const text = deps.hosted
      ? JSON.stringify({ t: scoped.noticeTag(pk.split("/")[1]), ...(k ? { k } : {}) })
      : JSON.stringify({ p: pk, ...(k ? { k } : {}) });
    // A pond's writes also wake that pond's own stream, the only one a web guest may subscribe to. The two publishes are
    // independent (the write already happened), so they run together; a failure only costs the watchers the safety poll.
    const pondId = pk.split("/")[1];
    // The lookup is cached with the channel list (channels-cache.js), so it costs no admin call on a warm instance.
    let pondStream = null;
    try {
      pondStream = deps.streams.pondChannelId ? await deps.streams.pondChannelId(pondId, false) : null;
    } catch {
      log("pond notice not published");
    }
    await Promise.allSettled([
      (async () => {
        try {
          if (pondStream) await deps.streams.publish(pondStream, text);
        } catch {
          log("pond notice not published");
        }
      })(),
      (async () => {
        try {
          // With SQUEAK_RELAY_SHARED_NOTICE=off (once every client sends `channel` to /token) a channel that has its own
          // stream is not also announced on the shared one, which is the O(tenants x clients) fan-out.
          if (deps.sharedNotice === false && pondStream) return;
          const channelId = await deps.streams.channelId();
          if (channelId) await deps.streams.publish(channelId, text);
        } catch {
          log("notice not published");
        }
      })(),
    ]);
  }

  /** The signed-in user of this request or null: any failure of the SDK reads as anonymous. */
  async function whoIsThis() {
    try {
      const u = deps.currentUser ? await deps.currentUser() : null;
      if (!u || typeof u.email !== "string" || !u.email || typeof u.userId !== "string" || !u.userId) return null;
      return { userId: u.userId, email: u.email, name: typeof u.name === "string" ? u.name : "" };
    } catch {
      return null;
    }
  }

  const feed = createFeed(deps.store);
  const live = createLiveNotices(deps.streams, log);
  // Every invitation change wakes the Pond's members channel (the Owner's Mac) and the invitee's own account channel
  // (accounts/<userId>/invites, or `e-<hash>` before the address has an account), per ADR 0005's targeted notices.
  if (deps.people && deps.people.onChange)
    deps.people.onChange(async ({ pondId, invitee }) => {
      await invitesChanged(pondId);
      await live.invites(invitee);
    });
  /** The Room kept whole and sealed, paged out oldest first past a byte cap per Pond (room-cloud.js). */
  /** Pictures and files as sealed blobs in a Stratus bucket (blobs.js); off, and every /blob call a 503, until the bucket is wired. */
  const blobs = createBlobs({
    store: deps.store,
    bucket: deps.blobBucket,
    now: deps.now,
    ...(deps.blobCapBytes ? { capBytes: deps.blobCapBytes } : {}),
    ...(deps.blobMaxBytes ? { maxBytes: deps.blobMaxBytes } : {}),
  });
  const roomCloud = createRoomCloud({
    store: deps.store,
    feed,
    blobs,
    ...(deps.roomCapBytes ? { capBytes: deps.roomCapBytes } : {}),
  });
  /**
   * Gives a content write the Pond's next seq (feed.js) and returns the document to store: the same one with `seq` added
   * (an older client ignores the field), or the document untouched when the kind is not Pond content or the store has no
   * feed. A delete passes doc null and is recorded as a tombstone. The feed row is written first, so a seq that a reader
   * sees always has its document.
   */
  async function stamp(parsed, doc) {
    if (!feed.enabled || !FEED_KINDS.has(parsed.kind)) return doc;
    const seq = await feed.append(parsed.channel, { kind: parsed.kind, id: parsed.doc, doc });
    // The seq's row is written, so a device told "seq n" can already read it: one short notice to the live service (live-notice.js).
    if (seq !== null) await live.notice(parsed.channel, seq, parsed.kind);
    return doc && seq !== null ? { ...doc, seq } : doc;
  }

  /**
   * GET /changes?pond=<id>&since=<seq|head>&limit=<n>: the Pond's content changes after `since`, oldest first, at most 100
   * a page: { changes: [{seq, kind, id, doc|null}], next, more }. `doc` null is a delete. since=head returns only the
   * current end as `next`, so a device that is about to read a whole list can start its cursor first. 404 when the
   * store keeps no feed. The caller has already been checked against the Pond.
   */
  async function sendChanges(res, url, pondId) {
    if (!feed.enabled) return send(res, 404, { error: "no-feed" }, NO_STORE);
    const sinceText = url.searchParams.get("since") ?? "0";
    const since = sinceText === "head" ? "head" : /^\d{1,12}$/.test(sinceText) ? Number(sinceText) : -1;
    const limitText = url.searchParams.get("limit");
    if (since === -1 || (limitText !== null && !/^\d{1,4}$/.test(limitText)))
      return send(res, 400, { error: "since" }, NO_STORE);
    return send(res, 200, await feed.changes(pondId, since, limitText === null ? 100 : Number(limitText)), NO_STORE);
  }

  /**
   * A Viewer only reads (docs/adr/0006-pond-policy.md): the people tables say who an account is in a Pond, and the Owner's
   * Mac enforces the rest. True when the account (a userId), or the account a device belongs to (a memberId a pond token
   * names), is a current Viewer of the Pond. A device the relay cannot place is not refused here: the Owner's Mac drops it.
   */
  async function isViewer(pondId, ids) {
    if (!deps.people) return false;
    let userId = ids.userId;
    if (userId === undefined && ids.memberId !== undefined) {
      const dev = await deps.people.deviceOf(ids.memberId).catch(() => null);
      userId = dev ? dev.userId : undefined;
    }
    if (userId === undefined) return false;
    const m = await deps.people.membershipOf(pondId, userId).catch(() => null);
    return Boolean(m) && m.role === "viewer" && m.leftAt === 0;
  }

  /** A web guest: one pond's channel, by a scoped token, never the relay key. */
  async function handleGuest(req, res, url, route, method, given) {
    const who = scoped.verify(deps.key, given, Date.now());
    if (!who) return send(res, 401);
    const revoked = await deps.store.get(`revoked/${who.pondId}`, who.memberId);
    if (revoked !== null && revoked !== undefined) return send(res, 401);
    const inPond = (parsed) => parsed && parsed.channel === who.pondId;
    if (route === "/pond-stream") {
      if (method !== "POST") return send(res, 405, {});
      const body = await readJson(req, 1024);
      if (typeof body.name !== "string" || !NAME.test(body.name)) return send(res, 400, { error: "name" });
      // A pond's own channel when one exists, else the shared squeak_notice channel: Catalyst makes channels in the
      // console only, so most ponds share it. A notice there names only a path ("channels/<id>/<kind>"), never
      // content, so a guest on it learns that other channels changed, not what they hold.
      const own = deps.streams.pondChannelId ? await deps.streams.pondChannelId(who.pondId, false) : null;
      const id = own ?? (await deps.streams.channelId().catch(() => null));
      if (!id) return send(res, 503, { error: "channel" });
      const pair = await deps.streams.token(id, body.name);
      return send(res, 200, { url: pair.url, key: pair.key, wssId: pair["wss-id"] });
    }
    if (route === "/doc") {
      const parsed = parseDocPath(url.searchParams.get("path"));
      if (!inPond(parsed) || isRelayOwned(parsed.kind)) return send(res, 403, {});
      if (method === "GET") {
        const json = await deps.store.get(parsed.pk, parsed.doc);
        if (json === null || json === undefined) return send(res, 404, {});
        return send(res, 200, { doc: JSON.parse(json) });
      }
      if ((method === "PUT" || method === "DELETE") && scoped.SCOPES[who.scope].write.has(parsed.kind)) {
        // A Member's post is part of the Room for good: a token may add one, never overwrite or delete anyone's (the
        // Owner's own key pages and removes).
        if (parsed.kind === "rposts" && method === "DELETE") return send(res, 403, {});
        // A Viewer reads: a Room post, a Task ask or a command from one is refused here, not left for the Owner's Mac to drop.
        if (method === "PUT" && (parsed.kind === "rposts" || parsed.kind === "tcmds")) {
          if (await isViewer(who.pondId, { memberId: who.memberId })) return send(res, 403, { error: "viewer" });
        }
        if (method === "PUT") {
          const body = await readJson(req, MAX_BODY);
          if (!validDoc(body.doc)) return send(res, 400, { error: "doc" });
          if (parsed.kind === "rposts") {
            const had = await deps.store.get(parsed.pk, parsed.doc);
            if (had !== null && had !== undefined) return send(res, 409, { error: "exists" });
          }
          const stored = JSON.stringify(await stamp(parsed, body.doc));
          await deps.store.put(parsed.pk, parsed.doc, stored);
          if (roomCloud.isRoomKind(parsed.kind)) await roomCloud.wrote(parsed.channel, Buffer.byteLength(stored));
        } else {
          await stamp(parsed, null);
          await deps.store.del(parsed.pk, parsed.doc);
        }
        await publishNotice(parsed.pk, parsed.doc);
        return send(res, 204);
      }
      return send(res, 403, {});
    }
    if (route === "/changes" && method === "GET") {
      if (url.searchParams.get("pond") !== who.pondId) return send(res, 403, {});
      return await sendChanges(res, url, who.pondId);
    }
    if (route === "/list" && method === "GET") {
      const parsed = parseKindPath(url.searchParams.get("prefix"));
      if (!inPond(parsed) || isRelayOwned(parsed.kind)) return send(res, 403, {});
      const rows = await deps.store.list(parsed.pk);
      return send(res, 200, { items: rows.map((r) => ({ id: r.doc, doc: JSON.parse(r.json) })) });
    }
    return send(res, 404, {});
  }

  /**
   * /blob?pond=<id>&id=<blob id>: a sealed picture or file of a Pond (blobs.js). PUT (&kind=room|rposts&doc=<post id>) keeps the
   * request body as is, 204; GET returns the bytes (404 when paged out); DELETE (the Pond's Mac or the operator) 204. The
   * relay never sees plaintext: the body is sealed by the sender and only its shape is checked.
   *   read:  a Mac of the Pond, an account that is a member (people.isMember), a pond token of the Pond (not revoked), the key
   *   write: a Mac of the Pond or a member's Mac, a guest or member token (a Member's own post, kind rposts), the key
   */
  async function handleBlob(req, res, url, method, mac) {
    if (!blobs.enabled) return send(res, 503, { error: "blobs-off" }, NO_STORE);
    if (method !== "GET" && method !== "PUT" && method !== "DELETE") return send(res, 405, {}, NO_STORE);
    const pond = url.searchParams.get("pond");
    const id = url.searchParams.get("id");
    if (!scoped.POND.test(pond || "") || !BLOB_ID.test(id || "")) return send(res, 400, { error: "blob" }, NO_STORE);
    const hasKey = req.headers["x-squeak-relay"] !== undefined;
    const token = req.headers["x-squeak-pond-token"];
    let by = "operator";
    let kinds = ["room", "rposts"];
    let canWrite = true;
    let canDelete = true;
    if (mac) {
      if (!(await tenants.channelAllowed(mac, pond))) {
        // A Member's own Mac signed in as a member: reads, and adds to its own posts.
        if (!deps.people || !(await deps.people.isMember(pond, mac.userId))) return send(res, 403, {}, NO_STORE);
        kinds = ["rposts"];
        canDelete = false;
        if (method === "PUT" && (await isViewer(pond, { userId: mac.userId }))) return send(res, 403, {}, NO_STORE);
      }
      by = mac.macId;
    } else if (!hasKey && token !== undefined) {
      const who = scoped.verify(deps.key, Array.isArray(token) ? "" : token, Date.now());
      if (!who) return send(res, 401);
      const revoked = await deps.store.get(`revoked/${who.pondId}`, who.memberId);
      if (revoked !== null && revoked !== undefined) return send(res, 401);
      if (who.pondId !== pond) return send(res, 403, {}, NO_STORE);
      // A join token (an invite's) writes the join request only.
      if (!scoped.SCOPES[who.scope].write.has("rposts")) return send(res, 403, {}, NO_STORE);
      if (method === "PUT" && (await isViewer(pond, { memberId: who.memberId }))) return send(res, 403, {}, NO_STORE);
      by = who.memberId;
      kinds = ["rposts"];
      canDelete = false;
    } else if (!hasKey && req.headers["x-squeak-account"] !== undefined) {
      const user = await accountUser(req, true);
      if (!user) return send(res, 401, undefined, NO_STORE);
      if (!deps.people || !(await deps.people.isMember(pond, user.userId))) return send(res, 403, {}, NO_STORE);
      by = user.userId;
      canWrite = false;
      canDelete = false;
    } else if (!sameKey(req.headers["x-squeak-relay"], deps.key)) {
      return send(res, 401);
    }
    if (method === "GET") {
      const bytes = await blobs.get(pond, id);
      if (!bytes) return send(res, 404, {}, NO_STORE);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" });
      res.end(bytes);
      return;
    }
    if (method === "DELETE") {
      if (!canDelete) return send(res, 403, {}, NO_STORE);
      await blobs.delete(pond, id);
      return send(res, 204, undefined, NO_STORE);
    }
    if (!canWrite) return send(res, 403, {}, NO_STORE);
    const kind = url.searchParams.get("kind") || "";
    const doc = url.searchParams.get("doc") || "";
    if (!kinds.includes(kind) || !DOC.test(doc)) return send(res, 400, { error: "blob" }, NO_STORE);
    let bytes;
    try {
      bytes = await readBytes(req, blobs.maxBytes);
    } catch (e) {
      if (e && e.status === 413)
        return send(res, 413, { error: "blob-too-large", message: blobs.sentence("blob-too-large") }, NO_STORE);
      throw e;
    }
    const done = await blobs.put(pond, id, bytes, { kind, doc, by });
    if (!done.ok)
      return send(
        res,
        done.status,
        { error: done.error, ...(done.message ? { message: done.message } : {}) },
        NO_STORE,
      );
    return send(res, 204, undefined, NO_STORE);
  }

  const gone = (pk, doc) => deps.store.del(pk, doc).catch(() => undefined);
  const parseOr = (json) => {
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  };

  /**
   * Who an account route's caller is. A native app's x-squeak-account token wins when present, and a bad or expired one
   * is nobody (never the cookie then). Only routes that pass allowToken accept it: a token mints neither tokens nor tickets.
   */
  async function accountUser(req, allowToken) {
    const given = req.headers["x-squeak-account"];
    if (allowToken && given !== undefined) {
      const t = scoped.verifyAppToken(deps.key, Array.isArray(given) ? "" : given, Date.now());
      if (!t) return null;
      // A token carries no name: the one the account's cookie sign-in left (names/<userId>) fills it in.
      const rec = await namesOf(t.userId).catch(() => null);
      return { userId: t.userId, email: t.email, name: (rec && rec.name) || "" };
    }
    const user = await whoIsThis();
    if (user) await rememberName(user);
    return user;
  }

  /**
   * The display name a signed-in account has, kept relay-side (pk "names", never reachable by /doc or /list) so an owner's
   * Mac can resolve an accountId to a name without the person being present. Written only from a verified sign-in.
   */
  const namesOf = async (userId) => parseOr(await deps.store.get(NAMES_PK, userId));
  async function rememberName(user) {
    const name = typeof user.name === "string" ? user.name.trim().slice(0, 100) : "";
    if (!name || !USER_ID.test(String(user.userId))) return;
    try {
      const had = await namesOf(user.userId);
      if (had && had.name === name && had.email === user.email) return;
      await deps.store.put(NAMES_PK, user.userId, JSON.stringify({ name, email: user.email, at: Date.now() }));
    } catch {
      // A name that cannot be remembered is only a name that stays as it was.
    }
  }

  /** Routes a signed-in account reaches by Hosted login's cookie. Each answer is no-store; nobody signed in is a bare 401. */
  async function handleAccountCookie(req, res, url, route, method) {
    const user = await accountUser(req, route !== "/account/link-ticket" && route !== "/account/app-token");
    if (!user) return send(res, 401, undefined, NO_STORE);
    const out = (status, body) => send(res, status, body, NO_STORE);
    if (route === "/account/macs/provision") {
      if (method !== "POST") return out(405, {});
      const body = await readJson(req, 1024);
      const r = await tenants.provision(user, body);
      // A provisioned Mac has no sign-in ticket, so the link rows are written here.
      if (r.status === 200 && CHANNEL.test(r.body.macId)) await linkMac(user, r.body.macId, body.name);
      return out(r.status, r.body);
    }
    if (route.startsWith("/account/macs/")) {
      if (method !== "DELETE") return out(405, {});
      const status = await tenants.revoke(user, route.slice("/account/macs/".length));
      if (status === 204) {
        const id = route.slice("/account/macs/".length);
        const link = parseOr(await deps.store.get("maclinks", id));
        if (CHANNEL.test(id) && link && link.userId === user.userId) await unlinkMac(id);
        return send(res, 204, undefined, NO_STORE);
      }
      return out(status, {});
    }
    if (route === "/account/avatar") return handleAvatar(req, res, user, method, out);
    if (route === "/account/app-token") {
      if (method !== "POST") return out(405, {});
      const issued = scoped.issueAppToken(deps.key, user.userId, user.email, Date.now(), APP_TOKEN_TTL_MS);
      if (!issued) return out(400, { error: "user" });
      return out(200, { token: issued.token, expiresAt: issued.expiresAt, email: user.email, name: user.name.trim() });
    }
    if (route === "/account/link-ticket") {
      if (method !== "POST") return out(405, {});
      const issued = scoped.issueTicket(deps.key, user.userId, user.email, Date.now(), TICKET_TTL_MS);
      if (!issued) return out(400, { error: "user" });
      return out(200, issued);
    }
    if (route === "/account/macs") {
      if (method !== "GET") return out(405, {});
      const rows = await deps.store.list(`accounts/${user.userId}`);
      const macs = [];
      for (const r of rows) {
        const link = parseOr(await deps.store.get("maclinks", r.doc));
        if (!link || link.userId !== user.userId) continue;
        const d = parseOr(r.json);
        if (!d) continue;
        // `seenAt`: when the Mac's own key last called the relay (optional; absent = not seen since this shipped).
        const seen = parseOr(await deps.store.get(SEEN_PK, r.doc));
        const at = seen && typeof seen.at === "number" ? seen.at : null;
        const age = at === null ? null : Math.max(0, clock() - at);
        const askRow = parseOr(await deps.store.get(ASK_PK, r.doc));
        macs.push({
          macId: r.doc,
          name: d.name,
          linkedAt: d.linkedAt,
          // seenAt, lastSeenAt: epoch ms of the Mac's last call; state: online | asleep | offline (all absent until seen).
          ...(at === null
            ? {}
            : {
                seenAt: at,
                lastSeenAt: at,
                state: age <= ONLINE_MS ? "online" : age <= ASLEEP_MS ? "asleep" : "offline",
              }),
          ...(askRow && typeof askRow.ask === "boolean" ? { askOwnDevices: askRow.ask } : {}),
        });
      }
      return out(200, { macs });
    }
    // /account/device-request
    if (method === "POST") {
      const body = await readJson(req, 4096);
      if (typeof body.macId !== "string" || !CHANNEL.test(body.macId)) return out(400, { error: "mac" });
      if (typeof body.name !== "string") return out(400, { error: "name" });
      // Standard base64 (older cached web pages) or base64url; stored as base64url, the one form every reader takes.
      const keys = {};
      for (const k of ["publicKey", "boxKey"]) {
        if (typeof body[k] !== "string" || !B64_ANY_200.test(body[k])) return out(400, { error: "key" });
        keys[k] = body[k].replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
        if (!B64URL_200.test(keys[k])) return out(400, { error: "key" });
      }
      const link = parseOr(await deps.store.get("maclinks", body.macId));
      if (!link || link.userId !== user.userId) return out(403, { error: "mac" });
      if (!(await spend(DEVREQ_RATE_PK, user.userId, 60 * 1000, DEVREQ_PER_MINUTE))) return out(429, { error: "rate" });
      const pk = `channels/${body.macId}/devreqs`;
      const now = Date.now();
      let open = 0;
      for (const r of await deps.store.list(pk)) {
        const d = parseOr(r.json);
        if (!d || typeof d.at !== "number" || d.at + REQUEST_TTL_MS <= now) await gone(pk, r.doc);
        else if (d.userId === user.userId) open++;
      }
      if (open >= MAX_OPEN_REQUESTS) return out(429, { error: "busy" });
      const reqId = crypto.randomBytes(18).toString("base64url");
      const value = {
        v: 1,
        reqId,
        userId: user.userId,
        email: user.email,
        name: body.name.trim().slice(0, 100),
        publicKey: keys.publicKey,
        boxKey: keys.boxKey,
        at: now,
      };
      await deps.store.put(pk, reqId, JSON.stringify(value));
      await publishNotice(pk, reqId);
      return out(200, { reqId, expiresAt: now + REQUEST_TTL_MS });
    }
    if (method === "GET") {
      const macId = url.searchParams.get("macId");
      const id = url.searchParams.get("id");
      if (typeof macId !== "string" || !CHANNEL.test(macId) || typeof id !== "string" || !DOC.test(id))
        return out(400, { error: "ids" });
      const reqPk = `channels/${macId}/devreqs`;
      const resPk = `channels/${macId}/devresults`;
      const request = parseOr(await deps.store.get(reqPk, id));
      if (!request) return out(410, { error: "gone" });
      if (request.userId !== user.userId) return out(403, { error: "user" });
      const raw = await deps.store.get(resPk, id);
      if (raw !== null && raw !== undefined) {
        const result = parseOr(raw);
        await gone(resPk, id);
        await gone(reqPk, id);
        return out(200, { result });
      }
      if (typeof request.at !== "number" || request.at + REQUEST_TTL_MS <= Date.now()) {
        await gone(reqPk, id);
        return out(410, { error: "gone" });
      }
      return out(202, {});
    }
    return out(405, {});
  }

  // ---- "Use my Zoho photo": the person's own photo, read once with a one-time consent (never stored token) ----
  const zohoState = (userId, nonce, exp) =>
    crypto
      .createHmac("sha256", String(deps.key))
      .update(`squeak-zoho-photo\n${userId}\n${nonce}\n${exp}`)
      .digest("base64url");
  const zohoBack = (res, result) =>
    send(res, 302, undefined, { Location: `${ZOHO_APP_PATH}#zoho-photo=${result}`, ...NO_STORE });
  /** A Zoho accounts origin (https only, a known data-centre host) or null. */
  const zohoOrigin = (value) => {
    try {
      const u = new URL(String(value));
      return u.protocol === "https:" && !u.port && !u.username && ZOHO_ACCOUNTS.test(u.hostname) ? u.origin : null;
    } catch {
      return null;
    }
  };
  const imageType = (b) => {
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      return "image/png";
    if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) return "image/gif";
    if (
      b.length >= 12 &&
      b.subarray(0, 4).toString("latin1") === "RIFF" &&
      b.subarray(8, 12).toString("latin1") === "WEBP"
    )
      return "image/webp";
    return null;
  };
  const zohoFetch = (url, init) =>
    (deps.fetch || globalThis.fetch)(url, { ...init, signal: AbortSignal.timeout(ZOHO_FETCH_MS) });
  const redirectUriFor = (req) => {
    if (deps.zoho.redirectUri) return deps.zoho.redirectUri;
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    return `https://${String(host).split(",")[0].trim()}/server/squeak_relay/account/zoho-photo/callback`;
  };

  /** /account/zoho-photo/start, /callback and the hand-over GET /account/zoho-photo: cookie only (no token, key or pond token). */
  async function handleZohoPhoto(req, res, url, route, method) {
    if (req.headers["x-squeak-relay"] !== undefined || req.headers["x-squeak-pond-token"] !== undefined)
      return send(res, 401, undefined, NO_STORE);
    if (method !== "GET") return send(res, 405, {}, NO_STORE);
    const user = await whoIsThis();
    if (!user) return send(res, 401, undefined, NO_STORE);
    if (route === "/account/zoho-photo") {
      const row = parseOr(await deps.store.get(ZOHO_PK, user.userId));
      await gone(ZOHO_PK, user.userId); // once: a read spends it, fresh or stale
      if (!row || typeof row.data !== "string" || typeof row.at !== "number" || row.at + ZOHO_TTL_MS <= Date.now())
        return send(res, 404, {}, NO_STORE);
      const bytes = Buffer.from(row.data, "base64");
      const type = imageType(bytes);
      if (!type) return send(res, 404, {}, NO_STORE);
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": String(bytes.length),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      });
      return res.end(bytes);
    }
    const z = deps.zoho;
    if (!z || !z.clientId || !z.clientSecret) return send(res, 503, { error: "unconfigured" }, NO_STORE);
    const home = zohoOrigin(z.accounts) || "https://accounts.zoho.in";
    if (route === "/account/zoho-photo/start") {
      const nonce = crypto.randomBytes(16).toString("base64url");
      const exp = Date.now() + ZOHO_TTL_MS;
      const state = `${user.userId}.${nonce}.${exp}.${zohoState(user.userId, nonce, exp)}`;
      const q = new URLSearchParams({
        scope: ZOHO_SCOPE,
        client_id: z.clientId,
        response_type: "code",
        access_type: "online",
        prompt: "consent",
        redirect_uri: redirectUriFor(req),
        state,
      });
      return send(res, 302, undefined, { Location: `${home}/oauth/v2/auth?${q}`, ...NO_STORE });
    }
    // /account/zoho-photo/callback
    const p = String(url.searchParams.get("state") || "").split(".");
    const [stateUser, nonce, expText, given] = p;
    const exp = Number(expText);
    const want = p.length === 4 && /^\d{1,15}$/.test(expText) ? Buffer.from(zohoState(stateUser, nonce, exp)) : null;
    const have = Buffer.from(String(given || ""));
    if (
      !want ||
      want.length !== have.length ||
      !crypto.timingSafeEqual(want, have) ||
      exp <= Date.now() ||
      stateUser !== user.userId
    )
      return zohoBack(res, "failed");
    if (url.searchParams.get("error"))
      return zohoBack(res, url.searchParams.get("error") === "access_denied" ? "denied" : "blocked");
    const code = url.searchParams.get("code");
    if (!code || code.length > 512) return zohoBack(res, "failed");
    const given_server = url.searchParams.get("accounts-server");
    const accounts = given_server ? zohoOrigin(given_server) : home;
    if (!accounts) return zohoBack(res, "failed");
    try {
      const tokenRes = await zohoFetch(`${accounts}/oauth/v2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: z.clientId,
          client_secret: z.clientSecret,
          redirect_uri: redirectUriFor(req),
          code,
        }).toString(),
        redirect: "error",
      });
      const tokenBody = tokenRes.ok ? await tokenRes.json().catch(() => null) : null;
      const token = tokenBody && typeof tokenBody.access_token === "string" ? tokenBody.access_token : null;
      if (!token) return zohoBack(res, "blocked");
      // Zoho's profile API lives on profile.zoho.<dc> beside accounts.zoho.<dc> (docs: profiles-useractions-readoperations).
      const photoRes = await zohoFetch(
        `${accounts.replace("//accounts.", "//profile.")}/api/v1/user/self/photo?photo_size=medium`,
        {
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
          redirect: "error",
        },
      );
      if (!photoRes.ok) return zohoBack(res, "blocked");
      const declared = Number(photoRes.headers.get("content-length"));
      if (declared > ZOHO_PHOTO_MAX_BYTES) return zohoBack(res, "failed");
      let bytes = Buffer.from(await photoRes.arrayBuffer());
      // Zoho's docs say the photo comes back "Base64 encoded": accept that spelling too, never anything but an image.
      if (!imageType(bytes)) {
        const text = bytes
          .toString("latin1")
          .trim()
          .replace(/^data:[^,]*,/, "");
        if (BASE64.test(text) && text.length >= 8) bytes = Buffer.from(text, "base64");
      }
      if (bytes.length > ZOHO_PHOTO_MAX_BYTES || !imageType(bytes)) return zohoBack(res, "failed");
      await deps.store.put(
        ZOHO_PK,
        user.userId,
        JSON.stringify({ v: 1, at: Date.now(), data: bytes.toString("base64") }),
      );
      return zohoBack(res, "ready");
    } catch {
      log("zoho photo: fetch failed"); // never the code, the token or a body
      return zohoBack(res, "failed");
    }
  }

  const avatarOf = async (userId) => parseOr(await deps.store.get(AVATAR_PK, userId));

  /** The photo's bytes, as the one thing this relay sends that is not JSON. Never cached, never sniffed. */
  function sendAvatar(res, row) {
    const bytes = Buffer.from(row.data, "base64");
    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": String(bytes.length),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    });
    res.end(bytes);
  }

  /** \`/account/avatar\` for a signed-in account (cookie or token): PUT a JPEG, DELETE it, GET it back. */
  async function handleAvatar(req, res, user, method, out) {
    if (method === "GET") {
      const row = await avatarOf(user.userId);
      if (!row || typeof row.data !== "string") return out(404, {});
      return sendAvatar(res, row);
    }
    if (method === "DELETE") {
      await gone(AVATAR_PK, user.userId);
      return send(res, 204, undefined, NO_STORE);
    }
    if (method !== "PUT") return out(405, {});
    let body;
    try {
      body = await readJson(req, AVATAR_MAX_BODY);
    } catch (e) {
      if (e && e.status === 413) return out(413, { error: "size" });
      throw e;
    }
    if (!body || typeof body.data !== "string" || typeof body.type !== "string") return out(400, { error: "image" });
    if (body.data.length > AVATAR_MAX_BODY || Math.floor((body.data.length * 3) / 4) > AVATAR_MAX_BYTES + 3)
      return out(413, { error: "size" });
    if (!BASE64.test(body.data)) return out(400, { error: "image" });
    const bytes = Buffer.from(body.data, "base64");
    if (bytes.length > AVATAR_MAX_BYTES) return out(413, { error: "size" });
    if (body.type !== "image/jpeg" || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
      return out(400, { error: "image" });
    const now = Date.now();
    const rate = parseOr(await deps.store.get(AVATAR_RATE_PK, user.userId));
    const fresh = !rate || typeof rate.since !== "number" || rate.since + HOUR_MS <= now;
    const used = fresh ? 0 : Number(rate.n) || 0;
    if (used >= AVATAR_WRITES_PER_HOUR) return out(429, { error: "busy" });
    await deps.store.put(AVATAR_RATE_PK, user.userId, JSON.stringify({ since: fresh ? now : rate.since, n: used + 1 }));
    await deps.store.put(
      AVATAR_PK,
      user.userId,
      JSON.stringify({ v: 1, type: "image/jpeg", data: body.data, at: now }),
    );
    return out(200, { at: now });
  }

  /** The Mac reads a linked user's photo with the relay key: GET /account/avatar?userId=. */
  async function handleAvatarMac(res, url, method, mac) {
    if (method !== "GET") return send(res, 405, {});
    const id = url.searchParams.get("userId");
    if (typeof id !== "string" || !USER_ID.test(id)) return send(res, 400, { error: "user" }, NO_STORE);
    if (mac && id !== mac.userId) return send(res, 403, {}, NO_STORE);
    const row = await avatarOf(id);
    if (!row || typeof row.data !== "string") return send(res, 404, {}, NO_STORE);
    return sendAvatar(res, row);
  }

  /** Records that `user` owns this Mac (what /account/link writes): "Your Macs" and device requests read these rows. Idempotent. */
  async function linkMac(user, macId, name) {
    const old = parseOr(await deps.store.get("maclinks", macId));
    if (old && old.userId !== user.userId && USER_ID.test(String(old.userId)))
      await gone(`accounts/${old.userId}`, macId);
    const had = parseOr(await deps.store.get(`accounts/${user.userId}`, macId));
    const label = typeof name === "string" ? name.trim().slice(0, 100) : (had && had.name) || "";
    await deps.store.put(
      `accounts/${user.userId}`,
      macId,
      JSON.stringify({ macId, name: label, linkedAt: (had && had.linkedAt) || Date.now() }),
    );
    await deps.store.put("maclinks", macId, JSON.stringify({ userId: user.userId, email: user.email }));
  }

  /** Remembers that this Mac called just now (at most once a minute per instance; a failure is only a stale "last seen"). */
  async function stampSeen(macId) {
    const now = clock();
    const last = seenStamped.get(macId);
    if (last !== undefined && now >= last && now - last < SEEN_STAMP_MS) return;
    seenStamped.set(macId, now);
    try {
      await deps.store.put(SEEN_PK, macId, JSON.stringify({ at: now }));
    } catch {
      // Nothing depends on it.
    }
  }

  /** Drops a Mac's link and pending device requests (what /account/unlink does). */
  async function unlinkMac(macId) {
    const link = parseOr(await deps.store.get("maclinks", macId));
    if (link && USER_ID.test(String(link.userId))) await gone(`accounts/${link.userId}`, macId);
    await gone("maclinks", macId);
    await gone(SEEN_PK, macId);
    await gone(ASK_PK, macId);
    seenStamped.delete(macId);
    for (const kind of ["devreqs", "devresults"]) {
      const pk = `channels/${macId}/${kind}`;
      for (const r of await deps.store.list(pk)) await gone(pk, r.doc);
    }
  }

  /** The Mac's side of an account link (relay key): confirm a ticket, or drop a link. */
  async function handleAccountMac(req, res, route, method, mac) {
    if (method !== "POST") return send(res, 405, {});
    const body = await readJson(req, 4096);
    if (route === "/account/link") {
      const t = scoped.verifyTicket(deps.key, body.ticket, Date.now());
      if (!t) return send(res, 400, { error: "ticket" });
      if (typeof body.macId !== "string" || !CHANNEL.test(body.macId)) return send(res, 400, { error: "mac" });
      if (mac && (body.macId !== mac.macId || t.userId !== mac.userId)) return send(res, 403, {});
      if (typeof body.name !== "string") return send(res, 400, { error: "name" });
      await linkMac({ userId: t.userId, email: t.email }, body.macId, body.name);
      return send(res, 200, { userId: t.userId, email: t.email });
    }
    // /account/unlink
    if (typeof body.macId !== "string" || !CHANNEL.test(body.macId)) return send(res, 400, { error: "mac" });
    if (mac && body.macId !== mac.macId) return send(res, 403, {});
    await unlinkMac(body.macId);
    return send(res, 204);
  }

  const clock = () => (deps.now ? deps.now() : Date.now());
  /** Counts one more use in a window kept under (pk, id); false once `limit` uses are spent. */
  async function spend(pk, id, windowMs, limit, n = 1) {
    const now = clock();
    const rate = parseOr(await deps.store.get(pk, id));
    const fresh = !rate || typeof rate.since !== "number" || rate.since + windowMs <= now;
    const used = fresh ? 0 : Number(rate.n) || 0;
    if (used + n > limit) return false;
    await deps.store.put(pk, id, JSON.stringify({ since: fresh ? now : rate.since, n: used + n }));
    return true;
  }

  /**
   * POST /ponds/<pondId>/members/accounts (the pond's own Mac, or the operator's key): the owner's Mac says which accounts
   * are members of the pond now. { ownerKey, name?, add: [userId], remove: [userId] }. This is the only writer of the
   * account index; a Mac that does not own the channel is refused (`channelAllowed`), so nobody can list an account in
   * someone else's pond. Listing grants nothing: a device still needs the owner's Mac to add it.
   */
  async function handlePondAccounts(req, res, method, mac, pondId) {
    const out = (status, body) => send(res, status, body, NO_STORE);
    if (method !== "POST") return out(405, {});
    if (!scoped.POND.test(pondId)) return out(400, { error: "ids" });
    if (mac && !(await tenants.channelAllowed(mac, pondId))) return out(403, {});
    const body = await readJson(req, 8192);
    const ids = (v) =>
      Array.isArray(v) && v.length <= ACCT_INDEX_MAX && v.every((x) => typeof x === "string" && USER_ID.test(x));
    const add = body.add === undefined ? [] : body.add;
    const remove = body.remove === undefined ? [] : body.remove;
    if (!ids(add) || !ids(remove)) return out(400, { error: "ids" });
    if (add.length > 0 && (typeof body.ownerKey !== "string" || !B64_ANY_200.test(body.ownerKey)))
      return out(400, { error: "key" });
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
    const ownerName = typeof body.ownerName === "string" ? body.ownerName.trim().slice(0, 100) : "";
    // Which account owns the Pond, and each listed account's role: what the web's overview draws ("mine", the role chip).
    const ownerUserId = typeof body.ownerUserId === "string" && USER_ID.test(body.ownerUserId) ? body.ownerUserId : "";
    const roles = body.roles && typeof body.roles === "object" && !Array.isArray(body.roles) ? body.roles : {};
    const at = Date.now();
    for (const userId of new Set(add)) {
      const role = roles[userId];
      // The Owner's Mac changed a role: the people tables follow, so the relay's Viewer refusal (isViewer) is current.
      if (deps.people && (role === "member" || role === "viewer")) {
        const had = await deps.people.membershipOf(pondId, userId).catch(() => null);
        if (had && had.leftAt === 0 && had.slot >= 0 && had.role !== role)
          await deps.people.setRole({ pondId, userId, role }).catch(() => undefined);
      }
      await deps.store.put(
        `${ACCT_PONDS_PK}/${userId}`,
        pondId,
        JSON.stringify({
          v: 1,
          ownerKey: body.ownerKey,
          ...(name ? { name } : {}),
          ...(ownerName ? { ownerName } : {}),
          ...(ownerUserId ? { ownerUserId } : {}),
          ...(role === "owner" || role === "member" || role === "viewer" ? { role } : {}),
          at,
        }),
      );
    }
    for (const userId of new Set(remove)) {
      // Taking an account off the index is a removal: final at once (someone who left is no longer in: a no-op).
      const before = parseOr(await deps.store.get(`${ACCT_PONDS_PK}/${userId}`, pondId));
      if (deps.people && (!before || before.left !== true))
        await ejectAccount(pondId, userId, "removed").catch((e) => {
          if (!(e && e.name === "PeopleError")) throw e;
        });
      await gone(`${ACCT_PONDS_PK}/${userId}`, pondId);
    }
    return out(204);
  }

  /**
   * GET /account/overview (account token): what the web's Ponds screen draws, metadata only (ADR 0005, docs/web-app-v2.md).
   * Per Pond: { pondId, name, ownerName, ownerKey, mine, role, shared, lastActivityAt, seqHead, counts: {members, ducks} } from the
   * account's index rows, the people tables and the change feed's newest row (its seq and time, never a document), newest
   * activity first; plus the pending invitations for this account's email. A Pond the account has left is not listed. The
   * cloud never reads a Pond's content here: ducks and members are counted by document id.
   */
  async function handleOverview(req, res, method) {
    const out = (status, body) => send(res, status, body, NO_STORE);
    if (method !== "GET") return out(405, {});
    const user = await accountUser(req, true);
    if (!user || !USER_ID.test(String(user.userId))) return out(401, { error: "signin" });
    const rows = await deps.store.list(`${ACCT_PONDS_PK}/${user.userId}`);
    const known = deps.people ? await deps.people.pondsOf(user.userId).catch(() => []) : [];
    const roleIn = new Map(known.map((p) => [p.pondId, p]));
    const ponds = [];
    for (const r of rows) {
      const v = parseOr(r.json);
      if (!v || typeof v.ownerKey !== "string" || !scoped.POND.test(r.doc) || v.left === true) continue;
      if (ponds.length >= ACCT_PONDS_MAX) break;
      const pondId = r.doc;
      const inPeople = roleIn.get(pondId);
      const mine =
        (inPeople && inPeople.role === "owner") || (typeof v.ownerUserId === "string" && v.ownerUserId === user.userId);
      const role = mine ? "owner" : inPeople ? inPeople.role : v.role === "viewer" ? "viewer" : "member";
      let members;
      if (inPeople) members = (await deps.people.membersOf(pondId).catch(() => [])).length;
      else members = (await deps.store.list(`channels/${pondId}/members`).catch(() => [])).length;
      const ducks = (await deps.store.list(`channels/${pondId}/threads`).catch(() => [])).length;
      const head = await feed.newest(pondId).catch(() => ({ seq: 0, at: 0 }));
      let ownerName = typeof v.ownerName === "string" ? v.ownerName : "";
      if (!ownerName && inPeople && deps.people) {
        const owner = await deps.people.getAccount(inPeople.ownerUserId).catch(() => null);
        ownerName = (owner && owner.name) || "";
      }
      ponds.push({
        pondId,
        name: (typeof v.name === "string" && v.name) || (inPeople && inPeople.name) || "A pond",
        ownerName: ownerName || "Someone",
        ownerKey: v.ownerKey,
        mine,
        role,
        shared: members > 1,
        lastActivityAt: head.at || (typeof v.at === "number" ? v.at : 0),
        seqHead: head.seq,
        counts: { members, ducks },
        // The Owner ended it: the index row stays a week so a device that missed the note reads "<Pond> was deleted".
        ...(v.deleted === true ? { deleted: true } : {}),
      });
    }
    ponds.sort((a, b) => b.lastActivityAt - a.lastActivityAt || (a.pondId < b.pondId ? -1 : 1));
    const invitations = [];
    if (deps.people && user.email) {
      for (const v of await deps.people.listFor({ userId: user.userId, email: user.email }).catch(() => [])) {
        invitations.push({ inviteId: v.inviteId, pondName: v.pondName, inviterName: v.inviter.name, at: v.createdAt });
      }
    }
    invitations.sort((a, b) => b.at - a.at);
    return out(200, { ponds, invitations: invitations.slice(0, 50) });
  }

  /**
   * The one Join and Decline: POST /account/invitations/<inviteId>/join | /decline, from the web (account token) and from a
   * Mac (its own key). Join is idempotent (people.js `join`): already joined or already a Member answers 200 with the Pond.
   *   200 {pondId, pond:{pondId,name}, invitation}   (Decline: 200 {invitation})
   *   refusal {error, code, message, invitation}     `invitation` is always the fresh view; `error` keeps the old words the
   *   deployed web reads (403 email, 409 full, 409 state + `state`, 404 invite), `code` is the rule's own.
   * The older Mac's POST /invites/<id>/accept | /decline are aliases (legacy = true): the same answer plus `invite` (the old
   * record they read) and `error` = the rule's code, with the masked address on a wrong address.
   */
  async function handleInvitation(req, res, method, mac, inviteId, verb, legacy = false) {
    const out = (status, body) => send(res, status, body, NO_STORE);
    if (method !== "POST") return out(405, {});
    if (!deps.people) return out(404, { error: "invite" });
    const user = await peopleUser(req, mac);
    if (!user) return out(401, { error: "signin" });
    const old = async () => ({
      invite: await deps.people.viewOf(await deps.people.getInvite(inviteId), { userId: user.userId, owner: true }),
    });
    try {
      if (verb === "join") {
        const done = await deps.people.join(user, inviteId);
        await restoreAccount(done.pond.pondId, user.userId);
        return out(200, {
          pondId: done.pond.pondId,
          pond: done.pond,
          invitation: done.invitation,
          ...(legacy ? await old() : {}),
        });
      }
      const done = await deps.people.decline(user, inviteId);
      return out(200, { invitation: done.invitation, ...(legacy ? await old() : {}) });
    } catch (e) {
      const r = refusalOf(e, legacy);
      if (legacy && r.body.code === "wrong-address") {
        const row = await deps.people.getInvite(inviteId);
        if (row) r.body.masked = mailing.maskEmail(row.email);
      }
      return out(r.status, r.body);
    }
  }

  /** What a refusal of the Invitation module is on the wire (see handleInvitation). */
  function refusalOf(e, legacy = false) {
    if (!(e && e.name === "PeopleError")) throw e;
    const code = e.code;
    const status =
      code === "invalid"
        ? 400
        : code === "no-invite" || code === "no-pond"
          ? 404
          : code === "wrong-address" || code === "forbidden"
            ? 403
            : 409;
    const was = code.startsWith("was-") ? code.slice(4) : undefined;
    const error = legacy
      ? code
      : code === "wrong-address"
        ? "email"
        : code === "pond-full"
          ? "full"
          : was
            ? "state"
            : code === "no-invite" || code === "no-pond"
              ? "invite"
              : code;
    return {
      status,
      body: {
        error,
        code,
        message: INVITE_WORDS[code] || e.message,
        ...(was && !legacy ? { state: was } : {}),
        ...(e.invitation ? { invitation: e.invitation } : {}),
      },
    };
  }

  /** The signed-in account behind a request: a Mac's own key, or an account token (never the operator's key, a pond token or a cookie-less call). */
  async function accountOf(req, mac) {
    if (req.headers["x-squeak-pond-token"] !== undefined) return null;
    if (mac) return USER_ID.test(String(mac.userId)) ? { userId: mac.userId } : null;
    if (req.headers["x-squeak-relay"] !== undefined) return null;
    const user = await accountUser(req, true);
    return user && USER_ID.test(String(user.userId)) ? user : null;
  }

  const DELETED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

  /** GET /account/ponds: the ponds the caller's own account is a member of. Only that account reads its own row. */
  async function handleAccountPonds(req, res, method, mac) {
    const out = (status, body) => send(res, status, body, NO_STORE);
    if (method !== "GET") return out(405, {});
    const user = await accountOf(req, mac);
    if (!user) return out(401, { error: "signin" });
    const rows = await deps.store.list(`${ACCT_PONDS_PK}/${user.userId}`);
    const ponds = [];
    for (const r of rows) {
      const v = parseOr(r.json);
      if (!v || typeof v.ownerKey !== "string" || !scoped.POND.test(r.doc)) continue;
      if (v.deleted === true && !(Date.now() - Number(v.deletedAt || 0) < DELETED_KEEP_MS)) {
        await gone(`${ACCT_PONDS_PK}/${user.userId}`, r.doc);
        continue;
      }
      ponds.push({
        pondId: r.doc,
        ownerKey: v.ownerKey,
        ...(typeof v.name === "string" && v.name ? { name: v.name } : {}),
        ...(typeof v.ownerName === "string" && v.ownerName ? { ownerName: v.ownerName } : {}),
        ...(v.left === true ? { left: true } : {}),
        ...(v.deleted === true ? { deleted: true } : {}),
      });
      if (ponds.length >= ACCT_PONDS_MAX) break;
    }
    return out(200, { ponds });
  }

  /**
   * An account leaves a Pond or is removed from it (issue #128, docs/spec.md "Removal is final at once"). At once, in the cloud:
   * the membership row ends (so the feed, blobs and Mac reads refuse the account, and the live hub is told to close its
   * subscriptions), and every device of the account that this Pond knows has its tokens refused (`revoked/`). The caller then
   * writes the one `peopleNote` that tells the Owner's Mac to drop the Member and rotate the key when it is next online.
   * Returns whether the account was a member in the people tables. The Owner is never ejected (a PeopleError "owner").
   */
  async function ejectAccount(pondId, userId, reason) {
    let was = false;
    if (deps.people) {
      try {
        await deps.people.removeMember({ pondId, userId, reason });
        was = true;
      } catch (e) {
        if (!(e && e.name === "PeopleError" && e.code === "not-member")) throw e;
      }
    }
    for (const id of await accountDeviceIds(pondId, userId)) {
      await deps.store.put(`revoked/${pondId}`, id, JSON.stringify({ at: Date.now() }));
    }
    return was;
  }

  /** The devices of an account this Pond knows: the account's registered ones and those that asked to join this Pond. */
  async function accountDeviceIds(pondId, userId) {
    const ids = new Set();
    if (deps.people) for (const d of await deps.people.devicesOf(userId).catch(() => [])) ids.add(d.deviceId);
    for (const r of await deps.store.list(`channels/${pondId}/devreqs`)) {
      const v = parseOr(r.json);
      if (v && v.userId === userId && v.gone !== true && v.accountGone !== true) ids.add(r.doc);
    }
    return [...ids].filter((id) => scoped.MEMBER.test(id));
  }

  /** A new invitation was accepted: the same account's devices are let in again, and the removal note is withdrawn. */
  async function restoreAccount(pondId, userId) {
    for (const id of await accountDeviceIds(pondId, userId)) await gone(`revoked/${pondId}`, id);
    const pk = `channels/${pondId}/devreqs`;
    for (const act of ["remove", "leave"]) {
      const id = `pn-${act}-${userId}`.slice(0, 64);
      if ((await deps.store.get(pk, id)) !== null) {
        await gone(pk, id);
        await publishNotice(pk, id);
      }
    }
  }

  /**
   * POST /account/pond-leaves { pondId }: the caller's account leaves the Pond, final at once (ejectAccount). Its own index entry
   * stays, flagged `left`, so every device of the account sees it; the owner's remove clears it, and a fresh add (the put in
   * handlePondAccounts) rewrites the row without the marker. 403 when the account is neither listed nor a member; idempotent.
   */
  async function handlePondLeave(req, res, method, mac) {
    const out = (status, body) => send(res, status, body, NO_STORE);
    if (method !== "POST") return out(405, {});
    const user = await accountOf(req, mac);
    if (!user) return out(401, { error: "signin" });
    const body = await readJson(req, 1024);
    if (typeof body.pondId !== "string" || !scoped.POND.test(body.pondId)) return out(400, { error: "ids" });
    const pk = `${ACCT_PONDS_PK}/${user.userId}`;
    const row = parseOr(await deps.store.get(pk, body.pondId));
    const listed = !!row && typeof row.ownerKey === "string";
    const member = deps.people ? await deps.people.isMember(body.pondId, user.userId).catch(() => false) : false;
    if (!listed && !member) return out(403, { error: "pond" });
    try {
      if (member || row.left !== true) await ejectAccount(body.pondId, user.userId, "left");
    } catch (e) {
      if (e && e.name === "PeopleError" && e.code === "owner") return out(409, { error: "owner" });
      throw e;
    }
    if (listed && row.left !== true)
      await deps.store.put(pk, body.pondId, JSON.stringify({ ...row, left: true, leftAt: Date.now() }));
    // The note the Owner's Mac applies (key rotation, the Room line); it finds the Member by account, so it is idempotent.
    await peopleNote(body.pondId, user.userId, "leave");
    return out(204);
  }

  /** Ends every device of an account in one Pond at once (tokens refused); the Owner's Mac rotates the key from the note. */
  async function revokeAccountIn(pondId, userId) {
    if (!deps.people) return;
    const at = Date.now();
    for (const d of await deps.people.devicesOf(userId).catch(() => []))
      if (scoped.MEMBER.test(d.deviceId)) await deps.store.put(`revoked/${pondId}`, d.deviceId, JSON.stringify({ at }));
  }

  /**
   * A relay-owned note for the Owner's Mac in the Pond's `devreqs` queue (no client token can write that kind): a change that
   * takes effect in the cloud at once but needs the Mac's keys to finish (rotating the key, signing a member document, deleting
   * the sealed documents). { v:1, reqId, userId, act: "remove" | "leave" | "role" | "delete", role?, at }.
   */
  async function peopleNote(pondId, userId, act, role) {
    const pk = `channels/${pondId}/devreqs`;
    const reqId = `pn-${act}-${userId}`.slice(0, 64);
    await deps.store.put(
      pk,
      reqId,
      JSON.stringify({ v: 1, reqId, userId, act, ...(role ? { role } : {}), at: Date.now() }),
    );
    await publishNotice(pk, reqId).catch(() => undefined);
  }

  /** The account's index row for a Pond says its role now (what the overview draws). */
  async function indexRole(pondId, userId, role) {
    const pk = `${ACCT_PONDS_PK}/${userId}`;
    const row = parseOr(await deps.store.get(pk, pondId));
    if (row) await deps.store.put(pk, pondId, JSON.stringify({ ...row, role }));
  }

  /**
   * The People sheet's data and the Owner's changes (account token; a Mac's own key stands for its account).
   *   GET    /ponds/<id>/people              any member: { owner, name, cap, members:[{userId,name,email,role,lastSeenAt}], invites } (invites: Owner only)
   *   POST   /ponds/<id>/members/<userId>/role {role}   Owner: member or viewer
   *   DELETE /ponds/<id>/members/<userId>    Owner: remove someone (never themselves)
   *   DELETE /ponds/<id> {name}              Owner: delete the Pond; the typed name must match
   * Each takes effect in the cloud at once and leaves a note in the Pond's queue for the Owner's Mac to finish.
   */
  async function handlePondPeople(req, res, method, mac, pondId, userId, action) {
    const out = (status, body) => send(res, status, body, NO_STORE);
    if (!scoped.POND.test(pondId)) return out(400, { error: "ids" });
    if (userId !== null && !USER_ID.test(userId)) return out(400, { error: "ids" });
    if (mac && !(await tenants.channelAllowed(mac, pondId))) return out(403, {});
    const user = await peopleUser(req, mac);
    if (!user) return out(401, { error: "signin" });
    const pond = await deps.people.getPond(pondId);
    if (!pond) return out(404, { error: "no-pond" });
    const mine = await deps.people.membershipOf(pondId, user.userId);
    if (!mine || mine.leftAt !== 0 || mine.slot < 0) return out(403, {});
    const isOwner = pond.ownerUserId === user.userId;
    try {
      if (action === "people") {
        if (method !== "GET") return out(405, {});
        const members = [];
        for (const m of await deps.people.membersOf(pondId)) {
          const seen = (await deps.people.devicesOf(m.userId).catch(() => [])).reduce(
            (t, d) => Math.max(t, d.lastSeenAt),
            0,
          );
          members.push({ userId: m.userId, name: m.name, email: m.email, role: m.role, lastSeenAt: seen });
        }
        const invites = isOwner ? await Promise.all((await deps.people.listForPond(user, pondId)).map(withMail)) : [];
        return out(200, { owner: pond.ownerUserId, name: pond.name, cap: 10, members, invites });
      }
      if (!isOwner) return out(403, {});
      if (userId === null) {
        if (method !== "DELETE") return out(405, {});
        const body = await readJson(req, 1024);
        if (typeof body.name !== "string" || body.name.trim() !== pond.name)
          return out(400, { error: "name", message: "Type the Pond's name to delete it." });
        for (const m of await deps.people.membersOf(pondId)) {
          if (m.role === "owner") {
            await gone(`${ACCT_PONDS_PK}/${m.userId}`, pondId);
            continue;
          }
          await revokeAccountIn(pondId, m.userId);
          // The index row stays a week as "deleted", so a device that missed the Owner's note still reads "<Pond> was deleted".
          const row = parseOr(await deps.store.get(`${ACCT_PONDS_PK}/${m.userId}`, pondId));
          if (row)
            await deps.store.put(
              `${ACCT_PONDS_PK}/${m.userId}`,
              pondId,
              JSON.stringify({ ...row, deleted: true, deletedAt: Date.now() }),
            );
        }
        await deps.people.deletePond(pondId);
        await peopleNote(pondId, user.userId, "delete");
        return out(204);
      }
      if (userId === user.userId)
        return out(409, { error: "owner", message: "The Owner cannot change their own place." });
      const target = await deps.people.membershipOf(pondId, userId);
      if (!target || target.leftAt !== 0 || target.slot < 0) return out(404, { error: "not-member" });
      if (method === "DELETE" && action === null) {
        await ejectAccount(pondId, userId, "removed");
        await gone(`${ACCT_PONDS_PK}/${userId}`, pondId);
        await peopleNote(pondId, userId, "remove");
        await invitesChanged(pondId);
        return out(204);
      }
      if (method === "POST" && action === "role") {
        const body = await readJson(req, 1024);
        if (body.role !== "member" && body.role !== "viewer") return out(400, { error: "body" });
        await deps.people.setRole({ pondId, userId, role: body.role });
        await indexRole(pondId, userId, body.role);
        await peopleNote(pondId, userId, "role", body.role);
        await invitesChanged(pondId);
        return out(204);
      }
      return out(405, {});
    } catch (e) {
      const r = refusalOf(e, true);
      return out(r.status, r.body);
    }
  }

  /**
   * POST /account/pond-devices { pondId, publicKey, boxKey?, client, nest? }: a device of an account that is a member of
   * the pond asks to be added. The relay checks the account is in the pond's index and writes the relay-owned
   * `channels/<pondId>/devreqs/<deviceId>` = { v:1, reqId, userId, email, name, publicKey, boxKey, client, nest, at }
   * (no client token can write that kind: its presence says which account asked). It answers a join-scope token for the
   * device, with which the device reads what the owner's Mac writes for it. A device the owner removed (revoked) is refused.
   */
  async function handlePondDevice(req, res, method, mac) {
    const out = (status, body) => send(res, status, body, NO_STORE);
    if (method !== "POST") return out(405, {});
    const user = await accountOf(req, mac);
    if (!user) return out(401, { error: "signin" });
    const body = await readJson(req, 2048);
    if (typeof body.pondId !== "string" || !scoped.POND.test(body.pondId)) return out(400, { error: "ids" });
    const keys = {};
    for (const k of ["publicKey", "boxKey"]) {
      const given = k === "boxKey" && body.boxKey === undefined ? body.publicKey : body[k];
      if (typeof given !== "string" || !B64_ANY_200.test(given)) return out(400, { error: "key" });
      keys[k] = given;
    }
    if (typeof body.client !== "string" || !DEVICE_CLIENTS.has(body.client)) return out(400, { error: "client" });
    if (body.nest !== undefined && body.nest !== null && (typeof body.nest !== "string" || body.nest.length > 100))
      return out(400, { error: "nest" });
    const member = parseOr(await deps.store.get(`${ACCT_PONDS_PK}/${user.userId}`, body.pondId));
    if (!member || member.left === true) return out(403, { error: "pond" });
    if (!(await spend(PONDDEV_RATE_PK, user.userId, 60 * 1000, PONDDEV_PER_MINUTE))) return out(429, { error: "rate" });
    const deviceId = deviceIdOf(keys.publicKey);
    const revoked = await deps.store.get(`revoked/${body.pondId}`, deviceId);
    if (revoked !== null && revoked !== undefined) return out(403, { error: "removed" });
    const rec = await namesOf(user.userId).catch(() => null);
    const now = Date.now();
    const pk = `channels/${body.pondId}/devreqs`;
    const value = {
      v: 1,
      reqId: deviceId,
      userId: user.userId,
      email: user.email || (rec && rec.email) || "",
      name: (user.name || (rec && rec.name) || "").slice(0, 100),
      publicKey: keys.publicKey,
      boxKey: keys.boxKey,
      client: body.client,
      nest: typeof body.nest === "string" ? body.nest : null,
      at: now,
    };
    await deps.store.put(pk, deviceId, JSON.stringify(value));
    await publishNotice(pk, deviceId);
    // The device is the account's, not the Pond's: it is listed in Settings > Your devices (best effort).
    await registerDevice(user, keys.publicKey, value.nest || value.name || "Device", body.client).catch(
      () => undefined,
    );
    const issued = scoped.issue(deps.key, body.pondId, deviceId, now, PONDDEV_TOKEN_TTL_SEC, "join");
    if (!issued) return out(400, { error: "ids" });
    return out(200, { reqId: deviceId, token: issued.token, expiresAt: issued.expiresAt });
  }

  /** A device's id: what its key hashes to, the same id the Pond's member document and its tokens use. */
  const deviceIdOf = (publicKey) =>
    crypto.createHash("sha256").update(Buffer.from(publicKey, "base64")).digest().subarray(0, 12).toString("base64url");

  /** Writes (or refreshes) one of the account's devices in the people tables; no-op where there are none. */
  async function registerDevice(user, publicKey, name, kind) {
    if (!deps.people) return null;
    const deviceId = deviceIdOf(publicKey);
    await deps.people.addDevice({ deviceId, userId: user.userId, name, kind, publicKey });
    return deviceId;
  }

  /**
   * Removes one device of the account everywhere (Settings > Your devices, docs/spec.md "Devices"): out of the account's
   * list, its tokens refused in every Pond at once (`revoked/`), and a relay-owned note in each Pond's `devreqs` that the
   * Owner's Mac reads when it is online to drop the device and rotate the key. Devices belong to the account: nothing is
   * written that any Member could read.
   */
  async function removeAccountDevice(user, deviceId) {
    await deps.people.removeDevice(deviceId);
    const ponds = new Set();
    for (const r of await deps.store.list(`${ACCT_PONDS_PK}/${user.userId}`))
      if (scoped.POND.test(r.doc)) ponds.add(r.doc);
    for (const p of await deps.people.pondsOf(user.userId))
      if (p.role !== "owner" && scoped.POND.test(p.pondId)) ponds.add(p.pondId);
    const at = Date.now();
    for (const pondId of ponds) {
      if (scoped.MEMBER.test(deviceId)) await deps.store.put(`revoked/${pondId}`, deviceId, JSON.stringify({ at }));
      const pk = `channels/${pondId}/devreqs`;
      await deps.store.put(
        pk,
        deviceId,
        JSON.stringify({ v: 1, reqId: deviceId, userId: user.userId, gone: true, at }),
      );
      await publishNotice(pk, deviceId);
    }
  }

  /**
   * /account/devices (account token or the Mac's own key): GET the account's devices, POST one to register or refresh,
   * DELETE /account/devices/<id> to remove it everywhere. Only the account's own devices are ever listed or removed.
   */
  async function handleAccountDevices(req, res, url, route, method, mac) {
    const out = (status, body) => send(res, status, body, NO_STORE);
    const user = await accountOf(req, mac);
    if (!user) return out(401, { error: "signin" });
    if (!deps.people) return out(503, { error: "unavailable" });
    if (route === "/account/devices") {
      if (method === "GET") {
        const self = url.searchParams.get("deviceId");
        const devices = (await deps.people.devicesOf(user.userId))
          .sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.name.localeCompare(b.name))
          .map((d) => ({
            deviceId: d.deviceId,
            name: d.name,
            kind: d.kind === "ios" ? "iphone" : d.kind,
            createdAt: d.createdAt,
            lastSeenAt: d.lastSeenAt,
            thisDevice: self !== null && self === d.deviceId,
          }));
        return out(200, { devices });
      }
      if (method !== "POST") return out(405, {});
      const body = await readJson(req, 2048);
      const kind = body.kind === "iphone" ? "ios" : body.kind;
      if (typeof body.publicKey !== "string" || !B64_ANY_200.test(body.publicKey)) return out(400, { error: "key" });
      if (typeof body.name !== "string" || !DEVICE_CLIENTS.has(kind)) return out(400, { error: "device" });
      const mine = await deps.people.devicesOf(user.userId);
      const deviceId = deviceIdOf(body.publicKey);
      if (mine.length >= DEVICES_PER_ACCOUNT && !mine.some((d) => d.deviceId === deviceId))
        return out(429, { error: "devices" });
      try {
        await registerDevice(user, body.publicKey, body.name.slice(0, 100) || "Device", kind);
      } catch (e) {
        if (e && e.code === "device-taken") return out(403, { error: "device" });
        throw e;
      }
      return out(200, { deviceId });
    }
    // /account/devices/<deviceId>
    if (method !== "DELETE") return out(405, {});
    const id = route.slice("/account/devices/".length);
    const found = (await deps.people.devicesOf(user.userId)).find((d) => d.deviceId === id);
    if (!found) return out(404, { error: "device" });
    await removeAccountDevice(user, id);
    return out(204);
  }

  /**
   * GET /invites/preview?code=<inviteId> (no sign-in; the web's /join page shows it above the buttons). Only what the invitee
   * may see before signing in: the Pond's name, the inviter's and the members' first names, the state, the invited address masked. No full address, no ids,
   * no keys. Every miss is the same 404; guesses are counted for all callers together (a code is an unguessable id, this
   * only stops a flood).
   */
  async function handleInvitePreview(res, url, method) {
    const out = (status, body) => send(res, status, body, NO_STORE);
    if (method !== "GET") return out(405, {});
    const code = url.searchParams.get("code");
    if (!deps.people || typeof code !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(code))
      return out(404, { error: "code" });
    if (!(await spend(INVITE_PREVIEW_PK, "all", 60_000, INVITE_PREVIEW_PER_MIN))) return out(429, { error: "busy" });
    const invite = await deps.people.getInvite(code);
    if (!invite) return out(404, { error: "code" });
    const first = (a) => (a && typeof a.name === "string" ? a.name.trim().split(/\s+/)[0] || "" : "");
    const pond = await deps.people.getPond(invite.pondId);
    if (!pond) return out(404, { error: "code" });
    const inviter = (await deps.people.viewOf(invite, {})).inviter.name.split(/\s+/)[0];
    const members = (await deps.people.membersOf(invite.pondId))
      .map(first)
      .filter(Boolean)
      .slice(0, INVITE_PREVIEW_MEMBERS);
    // `masked` is the invited address masked as in the wrong-email refusal; never the address itself.
    const masked = typeof invite.email === "string" && invite.email ? mailing.maskEmail(invite.email) : "";
    return out(200, { pond: pond.name, inviter, members, state: invite.state, expiresAt: invite.expiresAt, masked });
  }

  // ---- invitations (spec: People and remote, "One way in: email"; the invite is one relay record) ----

  /** Where an invitation email sends people: the invite page on the web; it reads the record by this id. */
  const inviteUrl = (inviteId) => `${INVITE_PAGE}?code=${encodeURIComponent(inviteId)}`;
  const newInviteId = () => crypto.randomBytes(18).toString("base64url");
  /** The fixed sentences a refusal may carry, by the rule's code (never a store's words). */
  const INVITE_WORDS = {
    "was-withdrawn": "This invitation was withdrawn.",
    "was-expired": "This invitation expired.",
    "was-declined": "This invitation was declined.",
    "was-joined": "This invitation was already used.",
    "not-pending": "That invitation is no longer waiting.",
    "still-pending": "That invitation is still waiting.",
    "no-invite": "There is no such invitation.",
    "no-pond": "There is no such Pond.",
  };
  /** A Mac sends its account's name (URI-encoded) with its own key, so an invite names who sent it; empty when it does not. */
  function sentName(req, mac) {
    const raw = mac ? req.headers["x-squeak-account-name"] : undefined;
    if (typeof raw !== "string") return "";
    try {
      return decodeURIComponent(raw)
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim();
    } catch {
      return "";
    }
  }

  /** The signed-in account (account token, cookie or a Mac's own key) with the email and name sign-in gave, kept in the people tables. */
  async function peopleUser(req, mac) {
    const who = await accountOf(req, mac);
    if (!who || !deps.people) return null;
    const rec = await namesOf(who.userId).catch(() => null);
    let email = who.email || (rec && rec.email) || "";
    if (!email && mac) {
      const link = parseOr(await deps.store.get("maclinks", mac.macId));
      email = (link && link.email) || "";
    }
    const known = await deps.people.getAccount(who.userId).catch(() => null);
    const name = (who.name || sentName(req, mac) || (rec && rec.name) || (known && known.name) || "").slice(0, 100);
    if (email) await deps.people.upsertAccount({ userId: who.userId, email, name }).catch(() => undefined);
    return { userId: who.userId, email, name };
  }

  /** An invite changed: wake the Pond's watchers (the Owner's Mac re-reads the record and says join and decline in the Room). */
  const invitesChanged = (pondId) => publishNotice(`channels/${pondId}/members`, "invites").catch(() => undefined);

  /** What the Owner's lists and answers draw: the InvitationView, with "Email not delivered" when the send gave up. */
  const withMail = async (view) => {
    const m = parseOr(await deps.store.get(INVITE_MAIL_STATE_PK, view.inviteId));
    return m && m.failed === true && view.state === "pending" ? { ...view, emailFailed: true } : view;
  };
  const mailWho = (user) => {
    const first =
      String(user.name || "")
        .trim()
        .split(/\s+/)[0] || "";
    return first || (user.email ? mailing.maskEmail(user.email) : "") || "A teammate";
  };

  /** Sends the invitation email for a pending invite through the mail path; false (with the reason logged) when it did not go. */
  async function mailInvite(user, pond, invite) {
    if (!deps.mail || !deps.mail.send) return false;
    // First names only, from the accounts (the same ones the invite page shows); never the inviter's email address.
    const first = (a) => (a && typeof a.name === "string" ? a.name.trim().split(/\s+/)[0] || "" : "");
    const members = (await deps.people.membersOf(invite.pondId).catch(() => []))
      .map(first)
      .filter(Boolean)
      .slice(0, INVITE_PREVIEW_MEMBERS);
    const m = mailing.buildInviteMail({
      inviterName: mailWho(user),
      pondName: pond.name,
      email: invite.email,
      url: inviteUrl(invite.inviteId),
      members,
      expiresAt: invite.expiresAt,
    });
    try {
      await deps.mail.send({ to: invite.email, subject: m.subject, text: m.text, html: m.html });
      return true;
    } catch (error) {
      // The provider's own words go to the function's log only (the operator reads them there), never into a response.
      log("invite email not sent", String((error && (error.message || error.code)) || error).slice(0, 300));
      return false;
    }
  }

  /**
   * Emails go out after the answer: each job is tried up to three times with a short wait, and the outcome is kept
   * (invite-mail-state/<inviteId>) so the Owner's People list can say "Email not delivered" and offer Resend.
   */
  async function sendQueued(jobs) {
    const waits = deps.mailRetryMs !== undefined ? [deps.mailRetryMs, deps.mailRetryMs] : [500, 2000];
    for (const job of jobs) {
      let sent = false;
      for (let attempt = 0; attempt <= waits.length && !sent; attempt++) {
        if (attempt > 0 && waits[attempt - 1] > 0) await new Promise((r) => setTimeout(r, waits[attempt - 1]));
        sent = await mailInvite(job.user, job.pond, job.invite).catch(() => false);
      }
      await deps.store
        .put(INVITE_MAIL_STATE_PK, job.invite.inviteId, JSON.stringify({ failed: !sent, at: clock() }))
        .catch(() => undefined);
      if (!sent) await invitesChanged(job.invite.pondId); // the Owner's list now says so
    }
  }

  /**
   * /ponds/<pondId>/invites... (Owner only: the account that owns the Pond; a Mac's own key stands for its account). Every
   * answer carries the fresh InvitationView(s) (people.js); `invite`/`invites` are the same objects under the names older apps read.
   *   POST  /ponds/<id>/share {name}                           the Owner's Mac makes the Pond exist here with this account as Owner (idempotent)
   *   POST  /ponds/<id>/invites {emails:[...], role, pondName?}   (a single `email` is still accepted) one invite per address; a Pond the relay
   *                                                            does not know is refused (404 unknown-pond) unless `pondName` is sent (a Mac from
   *                                                            before /share): then the first invite makes it with this account as Owner. Emails are
   *                                                            queued and sent after the answer. -> {results:[{email, ok, status, code?, message?,
   *                                                            invitation?, invite?, mailed}]}  status: invited | already-member | already-invited | refused
   *   GET   /ponds/<id>/invites                                -> {invites, invitations} one view per address
   *   POST  /ponds/<id>/invites/<inviteId>/resend              -> {invitation, invite, mailed}
   *   POST  /ponds/<id>/invites/<inviteId>/withdraw            -> {invitation, invite}  (idempotent)
   *   POST  /ponds/<id>/invites/<inviteId>/again {role?}       -> {invitation, invite, mailed}  (declined, expired or withdrawn only)
   */
  async function handlePondInvites(req, res, method, mac, parts) {
    const later = [];
    const out = async (status, body) => {
      const sent = send(res, status, body, NO_STORE);
      await sendQueued(later);
      return sent;
    };
    const [pondId, , inviteId, action] = parts;
    if (!scoped.POND.test(pondId)) return out(400, { error: "ids" });
    if (mac && !(await tenants.channelAllowed(mac, pondId))) return out(403, {});
    const user = await peopleUser(req, mac);
    if (!user) return out(401, { error: "signin" });
    const pond = await deps.people.getPond(pondId);
    try {
      if (parts[1] === "share") {
        // The Owner's Mac makes the Pond exist here before it invites anyone (idempotent): sharing is the Mac's step, and the
        // invite route no longer makes a Pond it was not told about.
        if (method !== "POST") return out(405, {});
        if (pond) return pond.ownerUserId === user.userId ? out(200, { shared: true }) : out(403, {});
        const body = await readJson(req, 2 * 1024);
        const name = typeof (body && body.name) === "string" ? body.name.trim().slice(0, 100) : "";
        if (!name) return out(400, { error: "pondName" });
        if (!user.email) return out(401, { error: "signin" });
        await deps.people.createPond({ pondId, ownerUserId: user.userId, name });
        return out(200, { shared: true });
      }
      if (!inviteId) {
        if (method === "GET") {
          const views = await Promise.all((await deps.people.listForPond(user, pondId)).map(withMail));
          return out(200, { invites: views, invitations: views });
        }
        if (method !== "POST") return out(405, {});
        const body = await readJson(req, 8 * 1024);
        const emails = Array.isArray(body && body.emails)
          ? body.emails
          : typeof (body && body.email) === "string"
            ? [body.email]
            : null;
        const role = body && body.role === undefined ? "member" : body && body.role;
        if (!emails || emails.length < 1 || emails.length > INVITE_MAIL_MAX || (role !== "member" && role !== "viewer"))
          return out(400, { error: "body" });
        if (pond && pond.ownerUserId !== user.userId) return out(403, {});
        // A Pond the relay was not told about is refused: the Owner's Mac shares it first (`POST /ponds/<id>/share`). A Mac from
        // before that route names the Pond in the invite instead, and the relay still makes it for that Mac (`pondName`).
        const name = typeof body.pondName === "string" ? body.pondName.trim().slice(0, 100) : "";
        if (!pond && !name)
          return out(404, {
            error: "unknown-pond",
            message: "This Pond isn't shared yet. Share it first, then invite.",
          });
        if (!pond && !user.email) return out(401, { error: "signin" });
        const count = new Set(emails.map((e) => (typeof e === "string" ? normEmail(e) : ""))).size;
        if (!(await spend(INVITE_MAIL_PK, `d-${user.userId}`, DAY_MS, INVITE_MAIL_PER_MAC_DAY, count)))
          return out(429, { error: "busy" });
        const done = await deps.people.invite(user, pondId, {
          emails,
          role,
          pondName: name,
          newInviteId,
          expiresAt: clock() + INVITE_TTL_MS,
        });
        const results = [];
        for (const r of done.results) {
          if (r.status === "invited") {
            later.push({ user, pond: done.pond, invite: r.invitation });
            results.push({
              email: r.email,
              ok: true,
              status: r.status,
              mailed: true,
              queued: true,
              invitation: r.invitation,
              invite: r.invitation,
            });
          } else {
            results.push({
              email: r.email,
              ok: false,
              status: r.status,
              error: r.code,
              message: r.message,
              ...(r.invitation ? { invitation: r.invitation, invite: r.invitation } : {}),
            });
          }
        }
        return out(200, { results });
      }
      // One invite of this Pond, by the Owner.
      if (method !== "POST") return out(405, {});
      if (action === "withdraw") {
        const done = await deps.people.withdraw(user, pondId, inviteId);
        return out(200, { invitation: await withMail(done.invitation), invite: done.invitation });
      }
      if (action === "resend") {
        const view = await deps.people.pendingForResend(user, pondId, inviteId);
        if (!(await spend(INVITE_MAIL_PK, `d-${user.userId}`, DAY_MS, INVITE_MAIL_PER_MAC_DAY)))
          return out(429, { error: "busy" });
        later.push({ user, pond, invite: view });
        return out(200, { invitation: view, invite: view, mailed: true, queued: true });
      }
      if (action === "again") {
        const body = await readJson(req, 1024);
        if (body && body.role !== undefined && body.role !== "member" && body.role !== "viewer")
          return out(400, { error: "body" });
        const done = await deps.people.again(user, pondId, inviteId, {
          newInviteId,
          expiresAt: clock() + INVITE_TTL_MS,
          ...(body && body.role ? { role: body.role } : {}),
        });
        later.push({ user, pond, invite: done.invitation });
        return out(200, { invitation: done.invitation, invite: done.invitation, mailed: true, queued: true });
      }
      return out(404, {});
    } catch (e) {
      const r = refusalOf(e, true);
      return out(r.status, r.body);
    }
  }

  /**
   * The invited person's side, signed in (account token or a Mac's own key). GET /account/invitations and, for older apps,
   * GET /invites answer the same: {invitations:[InvitationView], invites:[{inviteId, pondId, pond, inviter, role, state,
   * expiresAt, invitation}]} (the old rows carry `inviter` as a string; the view's is {name}). Listed: the pending
   * invitations for the account's verified address, and the ones it joined whose Pond the Owner's Mac has not yet opened to it
   * (state "joined": the device draws "Connecting"). Join and Decline: handleInvitation (POST /invites/<id>/accept is its alias).
   */
  async function handleMyInvites(req, res, method, mac, parts) {
    const out = (status, body) => send(res, status, body, NO_STORE);
    if (parts.length !== 1)
      return handleInvitation(req, res, method, mac, parts[1], parts[2] === "accept" ? "join" : "decline", true);
    if (method !== "GET") return out(405, {});
    const user = await peopleUser(req, mac);
    if (!user || !user.email) return out(401, { error: "signin" });
    const views = await deps.people.listFor(user, {
      isListed: async (pondId) => (await deps.store.get(`${ACCT_PONDS_PK}/${user.userId}`, pondId)) !== null,
    });
    return out(200, {
      invitations: views,
      invites: views.map((v) => ({
        inviteId: v.inviteId,
        pondId: v.pondId,
        pond: v.pondName,
        inviter: v.inviter.name,
        role: v.role,
        state: v.state,
        expiresAt: v.expiresAt,
        invitation: v,
      })),
    });
  }

  return async function handle(req, res) {
    try {
      const url = new URL(req.url || "/", "http://relay");
      const route = url.pathname.replace(PREFIX, "") || "/";
      const method = req.method || "GET";
      if (oldMac(req, route, url))
        return send(res, 426, { error: "update-required", message: UPDATE_MESSAGE }, NO_STORE);
      if (route === "/invites/preview") return await handleInvitePreview(res, url, method);
      if (route === "/me") {
        if (method !== "GET") return send(res, 405, {});
        const user = await accountUser(req, true);
        if (!user) return send(res, 401, undefined);
        const photo = await avatarOf(user.userId).catch(() => null);
        const avatarAt = photo && typeof photo.at === "number" && typeof photo.data === "string" ? photo.at : undefined;
        return send(
          res,
          200,
          { userId: user.userId, email: user.email, name: user.name.trim(), ...(avatarAt ? { avatarAt } : {}) },
          NO_STORE,
        );
      }
      if (route === "/account/handoff") {
        if (method !== "GET") return send(res, 405, {}, NO_STORE);
        const back = handoffReturn(url.searchParams.get("return"));
        if (!back) return send(res, 400, { error: "return" }, NO_STORE);
        const user = await whoIsThis();
        if (!user) {
          // One hosted-login round trip: a second signed-out arrival (the session was not recognised) stops here, never loops.
          if (url.searchParams.get("n") === "1") return send(res, 401, { error: "signin" }, NO_STORE);
          // The sign-in button the person pressed (zoho, google or email) rides along as a hint; anything else is dropped.
          const hint = HANDOFF_PROVIDERS.includes(url.searchParams.get("provider"))
            ? `&provider=${url.searchParams.get("provider")}`
            : "";
          // Back to this same route on whichever origin served it (the function's prefixed path, or AppSail's bare one).
          const again = `${url.pathname}?return=${encodeURIComponent(back)}${hint}&n=1`;
          return send(res, 302, undefined, {
            ...NO_STORE,
            Location: `/__catalyst/auth/login?redirect_url=${encodeURIComponent(again)}${hint}`,
            "Referrer-Policy": "no-referrer",
          });
        }
        const issued = scoped.issueAppToken(deps.key, user.userId, user.email, Date.now(), APP_TOKEN_TTL_MS);
        if (!issued) return send(res, 400, { error: "user" }, NO_STORE);
        return send(res, 302, undefined, {
          ...NO_STORE,
          Location: `${back}#squeak-token=${issued.token}&exp=${issued.expiresAt}`,
          "Referrer-Policy": "no-referrer",
        });
      }
      // The Zoho photo routes belong to the signed-in account (cookie): never a Mac key, never the relay key.
      if (
        route === "/account/zoho-photo" ||
        route === "/account/zoho-photo/start" ||
        route === "/account/zoho-photo/callback"
      )
        return await handleZohoPhoto(req, res, url, route, method);
      const relayGiven = req.headers["x-squeak-relay"];
      let macGiven = req.headers[MAC_HEADER];
      // Phones, the voice add-on and the daemon send a grant's key as x-squeak-relay: anything that is not the operator's
      // key (compared first, constant time) is looked up as a Mac key.
      if (macGiven === undefined && relayGiven !== undefined && !sameKey(relayGiven, deps.key)) macGiven = relayGiven;
      else if (macGiven !== undefined && relayGiven !== undefined) return send(res, 401);
      let mac = null;
      if (macGiven !== undefined && route !== "/account/macs/provision") {
        // A per-Mac key (tenants.js); it counts against its account's day.
        mac = await tenants.authenticate(Array.isArray(macGiven) ? "" : macGiven);
        if (!mac) return send(res, 401);
        if (!(await tenants.chargeRequest(mac))) return send(res, 429, { error: "quota" });
        await stampSeen(mac.macId);
      }
      const forbidden = () => send(res, 403, {});
      if (route === "/account/overview") return await handleOverview(req, res, method);
      {
        const inv = /^\/account\/invitations\/([A-Za-z0-9_-]{1,100})\/(join|decline)$/.exec(route);
        if (inv) return await handleInvitation(req, res, method, mac, inv[1], inv[2]);
      }
      if (route === "/account/ponds") return await handleAccountPonds(req, res, method, mac);
      if (route === "/account/pond-leaves") return await handlePondLeave(req, res, method, mac);
      if (route === "/account/pond-devices") return await handlePondDevice(req, res, method, mac);
      if (
        route === "/account/invitations" ||
        route === "/invites" ||
        /^\/invites\/[^/]+\/(accept|decline)$/.test(route)
      )
        return await handleMyInvites(
          req,
          res,
          method,
          mac,
          route.startsWith("/invites/") ? route.split("/").slice(1) : ["list"],
        );
      {
        const m = /^\/ponds\/([^/]+)\/share$/.exec(route);
        if (m) return await handlePondInvites(req, res, method, mac, [m[1], "share"]);
      }
      {
        const m = /^\/ponds\/([^/]+)\/invites(?:\/([^/]+)\/(resend|withdraw|again))?$/.exec(route);
        if (m) return await handlePondInvites(req, res, method, mac, [m[1], "invites", m[2], m[3]]);
      }
      {
        const m = /^\/ponds\/([^/]+)(?:\/(people)|\/members\/([^/]+)\/role|\/members\/([^/]+))?$/.exec(route);
        if (
          m &&
          deps.people &&
          !(m[4] === "accounts" || m[3] === "accounts") &&
          (m[2] || m[3] || m[4] || method === "DELETE")
        )
          return await handlePondPeople(
            req,
            res,
            method,
            mac,
            m[1],
            m[3] || m[4] || null,
            m[2] ? "people" : m[3] ? "role" : null,
          );
      }
      if (route === "/account/devices" || route.startsWith("/account/devices/"))
        return await handleAccountDevices(req, res, url, route, method, mac);
      {
        const m = /^\/ponds\/([^/]+)\/members\/accounts$/.exec(route);
        if (m && (mac || (relayGiven !== undefined && sameKey(relayGiven, deps.key))))
          return await handlePondAccounts(req, res, method, mac, m[1]);
      }
      if (route === "/account/avatar") {
        const keyGiven = req.headers["x-squeak-relay"];
        if (mac) return await handleAvatarMac(res, url, method, mac);
        if (keyGiven !== undefined) {
          if (!sameKey(keyGiven, deps.key)) return send(res, 401);
          return await handleAvatarMac(res, url, method);
        }
        // a pond token is never an account
        if (req.headers["x-squeak-pond-token"] !== undefined) return send(res, 401);
        return await handleAccountCookie(req, res, url, route, method);
      }
      if (route === "/account/macs/ask") {
        // The Mac's own key only: it says whether its owner asks before adding their own devices.
        if (method !== "POST") return send(res, 405, {});
        if (!mac) return send(res, 401);
        const body = await readJson(req, 256);
        if (!body || typeof body.askOwnDevices !== "boolean" || Object.keys(body).length !== 1)
          return send(res, 400, { error: "ask" });
        await deps.store.put(ASK_PK, mac.macId, JSON.stringify({ ask: body.askOwnDevices }));
        return send(res, 204);
      }
      if (route === "/account/macs/hist-token") {
        // The Mac's own key only, like cliq-token. The first token wins; changing it needs the current one.
        if (method !== "POST") return send(res, 405, {});
        if (!mac) return send(res, 401);
        const r = await tenants.registerHistToken(mac, await readJson(req, 1024));
        return send(res, r.status, r.body);
      }
      if (route === "/account/macs/cliq-token") {
        // The Mac's own key only: the operator's key and a cookie have no Mac to bind the token to.
        if (method !== "POST") return send(res, 405, {});
        if (!mac) return send(res, 401);
        const r = await tenants.registerCliqToken(mac, await readJson(req, 1024));
        return send(res, r.status, r.body);
      }
      if (
        route === "/account/link-ticket" ||
        route === "/account/app-token" ||
        route === "/account/macs" ||
        route === "/account/macs/provision" ||
        route.startsWith("/account/macs/") ||
        route === "/account/device-request"
      )
        return await handleAccountCookie(req, res, url, route, method);
      // A Cliq handler's write-only key: it may PUT one document of kind cliq and nothing else, whatever it asks for.
      // Either the channel's own token (registered by its Mac, charged to that Mac's account) or, while Macs migrate,
      // the one shared CLIQ_KEY.
      if (req.headers["x-squeak-cliq"] !== undefined) {
        const parsed = route === "/doc" && method === "PUT" ? parseDocPath(url.searchParams.get("path")) : null;
        if (!parsed || parsed.kind !== "cliq") return send(res, 401);
        const cliqGiven = Array.isArray(req.headers["x-squeak-cliq"]) ? "" : req.headers["x-squeak-cliq"];
        const owner = await tenants.authenticateCliq(parsed.channel, cliqGiven);
        // TODO(2027-03-01): remove the shared CLIQ_KEY once every Mac's handlers carry their own token.
        if (!owner && !sameKey(cliqGiven, deps.cliqKey)) return send(res, 401);
        if (owner && !(await tenants.chargeRequest(owner))) return send(res, 429, { error: "quota" });
        const body = await readJson(req, MAX_BODY);
        if (!validDoc(body.doc)) return send(res, 400, { error: "doc" });
        const stored = JSON.stringify(body.doc);
        if (owner && !(await tenants.chargeBytes(owner, Buffer.byteLength(stored))))
          return send(res, 429, { error: "quota" });
        await deps.store.put(parsed.pk, parsed.doc, stored);
        await publishNotice(parsed.pk, parsed.doc);
        return send(res, 200, { ok: true });
      }
      if (route === "/blob") return await handleBlob(req, res, url, method, mac);
      // A signed-in account reads its Pond's changes if the people tables say it is a member (people.js isMember); a Pond
      // that is not theirs, a removed member and a Relay without the tables all read as 403, never as an empty feed.
      if (
        route === "/changes" &&
        !mac &&
        req.headers["x-squeak-account"] !== undefined &&
        !req.headers["x-squeak-relay"]
      ) {
        if (method !== "GET") return send(res, 405, {});
        const user = await accountUser(req, true);
        if (!user) return send(res, 401, undefined, NO_STORE);
        const pondId = url.searchParams.get("pond");
        if (!scoped.POND.test(pondId || "") || !deps.people || !(await deps.people.isMember(pondId, user.userId)))
          return send(res, 403, {}, NO_STORE);
        return await sendChanges(res, url, pondId);
      }
      const given = req.headers["x-squeak-pond-token"];
      if (!mac && given !== undefined && !req.headers["x-squeak-relay"])
        return await handleGuest(req, res, url, route, method, given);
      if (!mac && !sameKey(req.headers["x-squeak-relay"], deps.key)) return send(res, 401);

      // Start clean (clean-start.js): the operator's key only, and only on a relay started for it (SQUEAK_CLEAN_START=on:
      // the development environment; production leaves it off). A Mac's key never reaches it.
      if (route === "/admin/clean-start") {
        if (method !== "POST") return send(res, 405, {});
        if (mac || !deps.cleanStart) return send(res, 403, { error: "clean-start-off" });
        const body = await readJson(req, 64 * 1024);
        if (body.confirm !== "wipe-cloud-ponds") return send(res, 400, { error: "confirm" });
        const list = (v) => (Array.isArray(v) ? v.slice(0, 5000) : []);
        const done = await createCleanStart({ store: deps.store, people: deps.people, blobs }).run({
          pondIds: list(body.pondIds),
          userIds: list(body.userIds),
        });
        log(`clean start: ${done.ponds} ponds, ${done.documents} documents, ${done.indexes} index rows`);
        return send(res, 200, done);
      }

      if (route === "/account/link" || route === "/account/unlink")
        return await handleAccountMac(req, res, route, method, mac);

      // An owner's Mac resolves account ids to their display names; a Mac key also gets its own account's back as `self`.
      if (route === "/account/names") {
        if (method !== "POST") return send(res, 405, {});
        const body = await readJson(req, 4096);
        const ids = Array.isArray(body.ids) ? body.ids : [];
        if (ids.length > NAMES_MAX || !ids.every((id) => typeof id === "string" && USER_ID.test(id)))
          return send(res, 400, { error: "ids" }, NO_STORE);
        const names = {};
        const row = (r) => ({ name: r.name, ...(typeof r.email === "string" && r.email ? { email: r.email } : {}) });
        await Promise.all(
          [...new Set(ids)].map(async (id) => {
            const r = await namesOf(id);
            if (r && typeof r.name === "string" && r.name) names[id] = row(r);
          }),
        );
        let self;
        if (mac) {
          const r = await namesOf(mac.userId);
          self = { userId: mac.userId, ...(r && r.name ? row(r) : {}) };
        }
        return send(res, 200, { names, ...(self ? { self } : {}) }, NO_STORE);
      }

      if (route === "/pond-token" || route === "/pond-revoke") {
        if (method !== "POST") return send(res, 405, {});
        const body = await readJson(req, 1024);
        if (typeof body.pondId !== "string" || typeof body.memberId !== "string")
          return send(res, 400, { error: "ids" });
        if (mac && !(await tenants.channelAllowed(mac, body.pondId))) return forbidden();
        if (route === "/pond-revoke") {
          if (!scoped.POND.test(body.pondId) || !scoped.MEMBER.test(body.memberId))
            return send(res, 400, { error: "ids" });
          await deps.store.put(`revoked/${body.pondId}`, body.memberId, JSON.stringify({ at: Date.now() }));
          return send(res, 204);
        }
        const issued = scoped.issue(
          deps.key,
          body.pondId,
          body.memberId,
          Date.now(),
          body.ttlSec,
          body.scope === undefined ? "guest" : body.scope,
        );
        if (!issued) return send(res, 400, { error: "ids" });
        // A new token for a member lifts an earlier revocation (a removed guest who is invited again).
        await deps.store.del(`revoked/${body.pondId}`, body.memberId);
        if (deps.streams.pondChannelId) await deps.streams.pondChannelId(body.pondId, true).catch(() => null);
        return send(res, 200, issued);
      }

      if (route === "/ping") {
        if (method !== "GET") return send(res, 405, {});
        const store = (await deps.store.ready().catch(() => false)) ? "ready" : "missing";
        const channelId = await deps.streams.channelId().catch(() => null);
        return send(res, 200, {
          ok: true,
          store,
          channel: channelId ? "ready" : "missing",
          // the shared stream's id is the operator's business, not a tenant's
          ...(channelId && !mac ? { channelId } : {}),
          version: VERSION,
        });
      }

      // The live service (cloud/catalyst-relay/live) holds no Data Streams grant of its own: with the relay key it asks this
      // function for its token pair and has its messages published (instance to instance, nothing a device sends).
      if (route === "/live/token" || route === "/live/publish") {
        if (method !== "POST" || mac) return send(res, mac ? 403 : 405, {});
        const body = await readJson(req, 4096);
        if (route === "/live/publish") {
          if (typeof body.text !== "string" || body.text.length > 2048) return send(res, 400, { error: "text" });
          await live.raw(body.text);
          return send(res, 204);
        }
        if (typeof body.name !== "string" || !NAME.test(body.name)) return send(res, 400, { error: "name" });
        const id = deps.streams.liveChannelId ? await deps.streams.liveChannelId() : null;
        if (!id) return send(res, 503, { error: "channel" });
        const pair = await deps.streams.token(id, body.name);
        return send(res, 200, { url: pair.url, key: pair.key, wssId: pair["wss-id"] });
      }

      if (route === "/token") {
        if (method !== "POST") return send(res, 405, {});
        const body = await readJson(req, 1024);
        if (typeof body.name !== "string" || !NAME.test(body.name)) return send(res, 400, { error: "name" });
        // `channel` (optional; an old client sends none and gets the shared stream): the caller's own channel id. When that
        // channel has a stream of its own (a name from scoped.pondStreamName, made in the console, cached with the list),
        // the token is for it, so the client is woken by its own writes only and not by every tenant's. Otherwise shared.
        let own = null;
        if (typeof body.channel === "string" && scoped.POND.test(body.channel) && deps.streams.pondChannelId) {
          if (mac && !(await tenants.channelAllowed(mac, body.channel))) return forbidden();
          own = await deps.streams.pondChannelId(body.channel, false).catch(() => null);
        }
        const channelId = own ?? (await deps.streams.channelId());
        if (!channelId) return send(res, 503, { error: "channel" });
        const pair = await deps.streams.token(channelId, body.name);
        return send(res, 200, { url: pair.url, key: pair.key, wssId: pair["wss-id"] });
      }

      if (route === "/doc") {
        const parsed = parseDocPath(url.searchParams.get("path"));
        if (!parsed) return send(res, 400, { error: "path" });
        if (mac && !(await tenants.channelAllowed(mac, parsed.channel))) return forbidden();
        if (method === "GET") {
          const json = await deps.store.get(parsed.pk, parsed.doc);
          if (json === null || json === undefined) return send(res, 404, {});
          return send(res, 200, { doc: JSON.parse(json) });
        }
        if ((method === "PUT" || method === "DELETE") && parsed.kind === "hist") {
          // History in the cloud: written and deleted only by the Mac holding the channel's write token (the operator's
          // key too), capped per account. A device that merely holds the channel's key reads, and cannot write.
          const hg = req.headers["x-squeak-hist"];
          const writer = mac ? await tenants.authenticateHist(parsed.channel, Array.isArray(hg) ? "" : hg) : null;
          if (mac && !writer) return forbidden();
          const owner = writer ? writer.userId : null;
          const was = await deps.store.get(parsed.pk, parsed.doc);
          const before = was === null || was === undefined ? null : Buffer.byteLength(was);
          if (method === "DELETE") {
            await deps.store.del(parsed.pk, parsed.doc);
            if (owner && before !== null) await tenants.histApply(owner, -before, -1);
            if (parsed.doc === HIST_INDEX) await publishNotice(parsed.pk, parsed.doc);
            return send(res, 204);
          }
          const body = await readJson(req, MAX_BODY);
          if (!validDoc(body.doc)) return send(res, 400, { error: "doc" });
          const stored = JSON.stringify(body.doc);
          const size = Buffer.byteLength(stored);
          if (mac && !(await tenants.chargeRequest(mac))) return send(res, 429, { error: "quota" });
          if (owner && !(await tenants.histApply(owner, size - (before ?? 0), before === null ? 1 : 0)))
            return send(res, 413, { error: "cap" });
          await deps.store.put(parsed.pk, parsed.doc, stored);
          if (parsed.doc === HIST_INDEX) await publishNotice(parsed.pk, parsed.doc);
          return send(res, 204);
        }
        if (method === "PUT") {
          if (NO_KEY_PUT.has(parsed.kind)) return send(res, 403, {});
          const body = await readJson(req, MAX_BODY);
          // A Mac's answer to a device request is a sealed box or a bare refusal `{denied: true}`.
          const deniedAnswer =
            parsed.kind === "devresults" && body.doc && Object.keys(body.doc).length === 1 && body.doc.denied === true;
          if (!deniedAnswer && !validDoc(body.doc)) return send(res, 400, { error: "doc" });
          const stored = JSON.stringify(body.doc);
          if (mac && !(await tenants.chargeBytes(mac, Buffer.byteLength(stored))))
            return send(res, 429, { error: "quota" });
          const kept = JSON.stringify(await stamp(parsed, body.doc));
          await deps.store.put(parsed.pk, parsed.doc, kept);
          if (roomCloud.isRoomKind(parsed.kind)) await roomCloud.wrote(parsed.channel, Buffer.byteLength(kept));
          await publishNotice(parsed.pk, parsed.doc);
          // A Cliq handler (Deluge) reads the answer's body to tell success from a bare 401, and a 204 has none.
          return parsed.kind === "cliq" ? send(res, 200, { ok: true }) : send(res, 204);
        }
        if (method === "DELETE") {
          await stamp(parsed, null);
          await deps.store.del(parsed.pk, parsed.doc);
          // A removed post takes its pictures and files with it.
          if (blobs.enabled && roomCloud.isRoomKind(parsed.kind))
            await blobs.dropFor(parsed.channel, parsed.kind, parsed.doc).catch(() => undefined);
          await publishNotice(parsed.pk, parsed.doc);
          return send(res, 204);
        }
        return send(res, 405, {});
      }

      if (route === "/changes") {
        if (method !== "GET") return send(res, 405, {});
        const pondId = url.searchParams.get("pond");
        if (!scoped.POND.test(pondId || "")) return send(res, 400, { error: "pond" }, NO_STORE);
        if (mac && !(await tenants.channelAllowed(mac, pondId))) return forbidden();
        return await sendChanges(res, url, pondId);
      }

      if (route === "/list") {
        if (method !== "GET") return send(res, 405, {});
        const parsed = parseKindPath(url.searchParams.get("prefix"));
        if (!parsed) return send(res, 400, { error: "prefix" });
        if (mac && !(await tenants.channelAllowed(mac, parsed.channel))) return forbidden();
        // Stored history is read page by page by id (the index names them); a list would return every page's box.
        if (parsed.kind === "hist") return send(res, 403, {});
        const rows = await deps.store.list(parsed.pk);
        return send(res, 200, { items: rows.map((r) => ({ id: r.doc, doc: JSON.parse(r.json) })) });
      }

      return send(res, 404, {});
    } catch (e) {
      const status = e && e.status === 413 ? 413 : e && e.status === 400 ? 400 : 500;
      log("request failed");
      return send(res, status, { error: status === 500 ? "server" : status === 413 ? "too large" : "bad request" });
    }
  };
}

module.exports = { createRelay, sameKey, VERSION };
