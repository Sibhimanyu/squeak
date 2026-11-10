// squeak_relay: the Catalyst function entry (Advanced I/O, Node). The Catalyst SDK is wired here and nowhere else;
// handler.js holds the behaviour and is tested with fakes (cloud/catalyst-relay/test).
const { zcAuth } = require("@zcatalyst/auth");
const { DataStreams } = require("@zcatalyst/datastreams");
const { pondStreamName } = require("./scoped");
const { NoSQL, NoSQLItem, NoSQLEnum, NoSQLMarshall } = require("@zcatalyst/nosql");
const { createRelay } = require("./handler");

const TABLE = "squeak_docs";
const CHANNEL_NAME = "squeak_notice";
/** A missing channel is looked up again at most this often. */
const CHANNEL_RETRY_MS = 30_000;

let channelId = null;
let channelCheckedAt = 0;

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

function streamsFor(app) {
  const streams = new DataStreams(app);
  return {
    async channelId() {
      if (channelId) return channelId;
      if (Date.now() - channelCheckedAt < CHANNEL_RETRY_MS) return null;
      channelCheckedAt = Date.now();
      const all = await streams.getAllChannels();
      const found = (all || []).find((c) => (c.channel_name ?? c.name) === CHANNEL_NAME);
      const id = found && (found.channel_id ?? found.id);
      channelId = id ? String(id) : null;
      return channelId;
    },
    publish: (id, text) => streams.publishData(id, text),
    // A pond's own channel for web guests (scoped.js). Found by name; creating it is not wired here (unverified against
    // the SDK), so until the owner makes it in the console /pond-stream answers 503.
    async pondChannelId(pondId) {
      const name = pondStreamName(pondId);
      const all = await streams.getAllChannels();
      const found = (all || []).find((c) => (c.channel_name ?? c.name) === name);
      const id = found && (found.channel_id ?? found.id);
      return id ? String(id) : null;
    },
    token: (id, name) => streams.getTokenPair(id, { connectionName: name }),
  };
}

module.exports = async (req, res) => {
  const app = await zcAuth.init(req);
  const handle = createRelay({
    key: process.env.RELAY_KEY,
    store: storeFor(app),
    streams: streamsFor(app),
    log: (s) => console.error(s),
  });
  return handle(req, res);
};
