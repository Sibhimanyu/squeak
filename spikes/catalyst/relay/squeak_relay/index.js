// Squeak relay spike: opaque string blobs keyed by path (NoSQL: pk = channels/<id>/<kind>, sort key = doc),
// a change notice {p:"channels/<id>/<kind>"} on every write, and a Data Streams token route.
const { zcAuth } = require("@zcatalyst/auth");
const { DataStreams } = require("@zcatalyst/datastreams");
const { NoSQL, NoSQLItem, NoSQLEnum, NoSQLMarshall } = require("@zcatalyst/nosql");
const { parseDocPath, parseKindPath, MAX_BOX } = require("./paths");

const coldAt = Date.now(); // module load = cold start; compare with the first request's arrival
let served = 0;

const send = (res, status, body, extra = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...extra });
  res.end(JSON.stringify(body));
};
const readBody = (req, max) =>
  new Promise((resolve, reject) => {
    let raw = "", size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); return; }
      raw += c;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });

module.exports = async (req, res) => {
  const t0 = Date.now();
  const first = served++ === 0;
  try {
    const url = new URL(req.url, "http://x");
    // The function is mounted at /server/squeak_relay/<route>.
    const route = url.pathname.replace(/^\/server\/squeak_relay/, "") || "/";
    const timing = () => ({ "Server-Timing": `fn;dur=${Date.now() - t0}`, "X-Cold": first ? "1" : "0", "X-Loaded-Ago": String(Date.now() - coldAt) });

    if (route === "/ping") return send(res, 200, { ok: true, now: Date.now(), first }, timing());

    const app = await zcAuth.init(req);
    const table = new NoSQL(app).table(process.env.TABLE || "squeak_docs");
    const streams = new DataStreams(app);
    const notice = (pk) => streams.publishData(process.env.CHANNEL_ID, JSON.stringify({ p: pk }));

    if (route === "/token" && req.method === "POST") {
      // Custom Logic channel: this function is the channel's access control. Real product: verify a MAC over
      // the connection name with the channel secret; the spike uses one shared key.
      if (req.headers["x-relay-key"] !== process.env.RELAY_KEY) return send(res, 403, { error: "forbidden" });
      const { connectionName } = JSON.parse((await readBody(req, 1024)) || "{}");
      if (!/^[A-Za-z0-9_-]{1,20}$/.test(connectionName || "")) return send(res, 400, { error: "connectionName: 1-20 chars, no . or :" });
      const token = await streams.getTokenPair(process.env.CHANNEL_ID, { connectionName });
      return send(res, 200, { token }, timing());
    }

    if (route === "/doc") {
      const parsed = parseDocPath(url.searchParams.get("path"));
      if (!parsed) return send(res, 403, { error: "path" });
      const keys = new NoSQLItem().addString("pk", parsed.pk).addString("doc", parsed.doc);
      if (req.method === "GET") {
        const r = await table.fetchItem({ keys });
        const item = r.get?.[0]?.item;
        const box = item?.getString("box");
        return send(res, box === undefined ? 404 : 200, box === undefined ? { error: "none" } : { box }, timing());
      }
      if (req.method === "PUT") {
        const raw = await readBody(req, MAX_BOX + 1024);
        const { box } = JSON.parse(raw);
        if (typeof box !== "string" || box.length >= MAX_BOX) return send(res, 400, { error: "box" });
        const item = new NoSQLItem().addString("pk", parsed.pk).addString("doc", parsed.doc).addString("box", box).addNumber("at", Date.now());
        try {
          await table.insertItems({ item });
        } catch (e) {
          // insert refused (exists?): overwrite the attribute instead
          await table.updateItems({
            keys,
            update_attributes: [{ operation_type: NoSQLEnum.NoSQLUpdateOperationType.PUT, attribute_path: ["box"], update_value: NoSQLMarshall.makeString(box) }],
          });
        }
        await notice(parsed.pk);
        return send(res, 200, { ok: true }, timing());
      }
      if (req.method === "DELETE") {
        await table.deleteItems({ keys });
        await notice(parsed.pk);
        return send(res, 200, { ok: true }, timing());
      }
    }

    if (route === "/list" && req.method === "GET") {
      const parsed = parseKindPath(url.searchParams.get("prefix"));
      if (!parsed) return send(res, 403, { error: "prefix" });
      const r = await table.queryTable({
        key_condition: { attribute: ["pk"], operator: NoSQLEnum.NoSQLOperator.EQUALS, value: NoSQLMarshall.makeString(parsed.pk) },
        limit: 100,
      });
      const docs = (r.get ?? r.getResponseData?.() ?? []).map((d) => ({ doc: d.item?.getString("doc"), box: d.item?.getString("box") }));
      return send(res, 200, { docs }, timing());
    }

    return send(res, 404, { error: "route" });
  } catch (e) {
    return send(res, e.status || 500, { error: String(e.message || e), code: e.code });
  }
};
