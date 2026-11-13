// squeak_relay: the Catalyst function entry (Advanced I/O, Node). The Catalyst SDK is wired here and nowhere else;
// handler.js holds the behaviour and is tested with fakes (cloud/catalyst-relay/test).
const { zcAuth, UserManagement } = require("@zcatalyst/auth");
const { DataStreams } = require("@zcatalyst/datastreams");
const { pondStreamName } = require("./scoped");
const { NoSQL, NoSQLItem, NoSQLEnum, NoSQLMarshall } = require("@zcatalyst/nosql");
const { createRelay } = require("./handler");
const { createChannelsCache } = require("./channels-cache");

const TABLE = "squeak_docs";
const CHANNEL_NAME = "squeak_notice";

/** Warm-instance caches for the hosted relay's usage counters and channel owners (handler.js, tenants.js). */
const usageCache = new Map();
const ownerCache = new Map();
const posInt = (v) => (Number(v) > 0 ? Math.floor(Number(v)) : undefined);

const keysOf = (pk, doc) => new NoSQLItem().addString("pk", pk).addString("doc", doc);

function storeFor(app) {
  const table = new NoSQL(app).table(TABLE);
  const query = (pk, limit, startKey) =>
    table.queryTable({
      key_condition: {
        attribute: ["pk"],
        operator: NoSQLEnum.NoSQLOperator.EQUALS,
        value: NoSQLMarshall.makeString(pk),
      },
      limit,
      ...(startKey ? { start_key: startKey } : {}),
    });
  return {
    async ready() {
      try {
        await query("squeak/probe", 1);
        return true;
      } catch {
        return false;
      }
    },
    async get(pk, doc) {
      const r = await table.fetchItem({ keys: keysOf(pk, doc) });
      return r.get?.[0]?.item?.getString("data") ?? null;
    },
    async put(pk, doc, json) {
      // Overwrite: insert, and when the item already exists update its attribute instead.
      try {
        await table.insertItems({ item: keysOf(pk, doc).addString("data", json).addNumber("at", Date.now()) });
      } catch {
        await table.updateItems({
          keys: keysOf(pk, doc),
          update_attributes: [
            {
              operation_type: NoSQLEnum.NoSQLUpdateOperationType.PUT,
              attribute_path: ["data"],
              update_value: NoSQLMarshall.makeString(json),
            },
          ],
        });
      }
    },
    async del(pk, doc) {
      await table.deleteItems({ keys: keysOf(pk, doc) });
    },
    async list(pk) {
      const rows = [];
      let startKey;
      for (let page = 0; page < 20; page++) {
        const r = await query(pk, 100, startKey);
        for (const d of r.get ?? []) {
          const doc = d.item?.getString("doc");
          const json = d.item?.getString("data");
          if (doc && json) rows.push({ doc, json });
        }
        startKey = r.next_token ?? r.start_key;
        if (!startKey) break;
      }
      return rows;
    },
  };
}

/** Module level: survives across requests on a warm instance (the app handle is per request, so the list call reads the latest). */
let latestStreams = null;
const channels = createChannelsCache({ list: () => latestStreams.getAllChannels() });

function streamsFor(app) {
  const streams = new DataStreams(app);
  latestStreams = streams;
  return {
    channelId: () => channels.idOf(CHANNEL_NAME),
    publish: (id, text) => streams.publishData(id, text),
    // A pond's own channel for web guests (scoped.js). Found by name; creating it is not wired here (unverified against
    // the SDK), so until the owner makes it in the console /pond-stream answers 503. Cached with the channel list.
    pondChannelId: (pondId) => channels.idOf(pondStreamName(pondId)),
    token: (id, name) => streams.getTokenPair(id, { connectionName: name }),
  };
}

/**
 * The signed-in Catalyst user of this request (Hosted login's cookie), or null. The user-scope app is made lazily and any
 * failure reads as anonymous. Unverified against a real deploy: the SDK's \`getCurrentUser\` shape (user_id, email_id,
 * first_name, last_name per its typings).
 */
const toUser = (u) =>
  u && u.email_id && u.user_id
    ? {
        userId: String(u.user_id),
        email: String(u.email_id),
        name: `${u.first_name || ""} ${u.last_name || ""}`.trim(),
      }
    : null;
const why = (e) =>
  `${(e && e.name) || "Error"} ${(e && (e.statusCode || e.status || e.code)) || ""} ${String((e && e.message) || "").slice(0, 120)}`;

const { CONSTANTS } = require("@zcatalyst/utils");
const shape = (o) => (o && typeof o === "object" ? Object.keys(o).slice(0, 10).join(",") : typeof o);
/** The signed-in app user behind this request (Hosted login cookies), read from the raw response so its envelope is ours to check. */
const currentUserOf = (req, app) => async () => {
  try {
    const um = new UserManagement(app);
    const resp = await um.requester.send({
      method: CONSTANTS.REQ_METHOD.get,
      path: "/project-user/current",
      service: "baas",
      track: true,
      user: CONSTANTS.CREDENTIAL_USER.user,
    });
    const body = resp && resp.data;
    const candidates = [body && body.data, body && body.content, body, resp && resp.content];
    for (const c of candidates) {
      const user = toUser(c);
      if (user) return user;
    }
    console.error(`me: sdk gave no user (data.data ${body && body.data === null ? "null" : shape(body && body.data)})`);
  } catch (e) {
    console.error(`me: sdk lookup failed: ${why(e)}`);
  }
  // Ask Catalyst ourselves with the browser's own session cookies (the SDK's user call came back empty).
  try {
    const cookie = req.headers.cookie;
    if (!cookie) return null;
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const project = req.headers["x-zc-projectid"] || process.env.CATALYST_PROJECT_ID || "53069000000381140";
    const csrf = (/(?:^|;\s*)ZD_CSRF_TOKEN=([^;]+)/.exec(cookie) || [])[1];
    const r = await fetch(`https://${host}/baas/v1/project/${project}/project-user/current`, {
      headers: { cookie, ...(csrf ? { "X-ZCSRF-TOKEN": `zd_csrparam=${csrf}` } : {}) },
    });
    const text = await r.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {
      j = null; // not JSON: no user
    }
    const user = toUser(j && j.data) || toUser(j && j.content) || toUser(j);
    if (!user)
      console.error(
        `me: rest gave no user; status ${r.status}; host ${String(host).slice(0, 80)}; keys {${shape(j)}} data ${j && j.data === null ? "null" : shape(j && j.data)}`,
      );
    return user;
  } catch (e) {
    console.error(`me: lookup failed: ${why(e)}`);
    return null;
  }
};

/** An env value that was really provided: the committed placeholder counts as unset. */
const set = (v) => (v && v !== "REPLACED_AT_DEPLOY" ? v : undefined);

module.exports = async (req, res) => {
  const app = await zcAuth.init(req);
  const handle = createRelay({
    key: process.env.RELAY_KEY,
    cliqKey: process.env.CLIQ_KEY,
    store: storeFor(app),
    streams: streamsFor(app),
    // AppSail: no Catalyst user, ever (signing in is the function's job); the account-token routes still verify their own signature.
    currentUser: process.env.SQUEAK_NO_CATALYST_USER === "1" ? async () => null : currentUserOf(req, app),
    zoho: {
      clientId: set(process.env.SQUEAK_ZOHO_CLIENT_ID),
      clientSecret: set(process.env.SQUEAK_ZOHO_CLIENT_SECRET),
      accounts: process.env.SQUEAK_ZOHO_ACCOUNTS || "https://accounts.zoho.in",
      redirectUri: process.env.SQUEAK_ZOHO_REDIRECT_URI,
    },
    signin: process.env.GUEST_SIGNIN === "required" ? "required" : undefined,
    limits: {
      requests: posInt(process.env.SQUEAK_RELAY_DAILY_REQUESTS),
      bytes: posInt(process.env.SQUEAK_RELAY_DAILY_BYTES),
    },
    quotaBatch: posInt(process.env.SQUEAK_RELAY_QUOTA_BATCH) ?? 10,
    hosted: process.env.SQUEAK_RELAY_HOSTED === "1",
    usageCache,
    ownerCache,
    log: (s) => console.error(s),
  });
  return handle(req, res);
};
