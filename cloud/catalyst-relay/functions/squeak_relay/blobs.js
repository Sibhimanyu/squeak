// Pictures and files in the cloud (docs/cloud-layer.md, "Pictures and files"; docs/spec.md, Cloud; issue #123). A post names a
// blob by id; the bytes are sealed on the sender's device under the Pond key and live in a Stratus bucket, never in a NoSQL
// document. The relay stores and serves bytes it cannot open: it checks the shape of a sealed blob (a key-version prefix and
// room for the box), never the content.
//
// Two ports, so this file never touches Catalyst:
//   bucket: { put(key, bytes) -> void (throws {code:"exists"} when the key is taken), get(key) -> Buffer|null, del(key) }
//           Stratus in index.js (blob-stratus.js), memory in tests (blob-memory.js).
//   store:  the NoSQL port every other module uses. Each blob has one small metadata row, `blobs/<pond>` / `<blob id>` =
//           {v, size, at, kind, doc, by}: how big, when, and which document references it (`kind` room or rposts, `doc` its
//           id; plain ids, never content), so a blob can go when its post goes, and a Pond's usage is a sum of rows.
//
// Limits (documented in docs/cloud-layer.md): one sealed blob is at most MAX_BLOB_BYTES; one Pond keeps at most POND_CAP_BYTES.
// The cap is separate from the 25 MB Room cap (room-cloud.js), which counts NoSQL bytes; blobs are in Stratus.
const MAX_BLOB_BYTES = 6 * 1024 * 1024;
const POND_CAP_BYTES = 200 * 1024 * 1024;
const BLOB_ID = /^[A-Za-z0-9_-]{16,64}$/;
/** What a sealed blob starts with: its key version and a dot (`3.`), then nonce, ciphertext and tag. */
const SEALED_HEAD = /^[A-Za-z0-9]{1,8}\./;
/** nonce (12) + tag (16): the least a sealed blob can hold besides the head. */
const BOX_OVERHEAD = 28;
/** Kinds a blob may be referenced from: the Owner's posts and a Member's own. */
const REF_KINDS = new Set(["room", "rposts"]);
/** A blob whose post never arrived is an orphan after this long, and may be swept when the Pond is full. */
const ORPHAN_MS = 60 * 60 * 1000;

const PLAIN = {
  "blob-too-large": `A picture or file can be at most ${MAX_BLOB_BYTES / 1024 / 1024} MB.`,
  "blob-quota": `This Pond has used its ${POND_CAP_BYTES / 1024 / 1024} MB of pictures and files.`,
};

const metaPk = (pond) => `blobs/${pond}`;
const objectKey = (pond, id) => `${pond}/${id}`;
const parse = (json) => {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
};

/** `createBlobs({ store, bucket, capBytes?, maxBytes?, now? })`. */
function createBlobs({ store, bucket, capBytes = POND_CAP_BYTES, maxBytes = MAX_BLOB_BYTES, now = Date.now }) {
  async function rows(pond) {
    const out = [];
    for (const r of await store.list(metaPk(pond))) {
      const meta = parse(r.json);
      if (meta) out.push({ id: r.doc, ...meta });
    }
    return out;
  }

  async function remove(pond, id) {
    await bucket.del(objectKey(pond, id)).catch(() => undefined);
    await store.del(metaPk(pond), id);
  }

  /** Drops blobs whose referencing document is gone and that are older than ORPHAN_MS; returns the bytes freed. */
  async function sweepOrphans(pond, all) {
    let freed = 0;
    for (const r of all) {
      if (now() - r.at < ORPHAN_MS) continue;
      const held = await store.get(`channels/${pond}/${r.kind}`, r.doc);
      if (held !== null && held !== undefined) continue;
      await remove(pond, r.id);
      freed += r.size;
    }
    return freed;
  }

  const refuse = (status, error, message = "") => ({ ok: false, status, error, message });

  return {
    enabled: Boolean(bucket),
    maxBytes,
    capBytes,
    sentence: (error) => PLAIN[error] || "",
    /** Whether `bytes` look like a sealed blob (a key-version head and room for a box). Says nothing of what is inside. */
    looksSealed(bytes) {
      if (!Buffer.isBuffer(bytes) || bytes.length < 3 + BOX_OVERHEAD) return false;
      return SEALED_HEAD.test(bytes.subarray(0, 10).toString("latin1"));
    },
    /**
     * Keeps one sealed blob. `ref` = {kind, doc, by}. Returns {ok:true} or {ok:false, status, error, message}.
     * Refuses an id already used (a blob never changes), a blob over the size limit and a Pond over its cap.
     */
    async put(pond, id, bytes, ref) {
      if (!BLOB_ID.test(id) || !REF_KINDS.has(ref.kind)) return refuse(400, "blob");
      if (bytes.length > maxBytes) return refuse(413, "blob-too-large", PLAIN["blob-too-large"]);
      if (!this.looksSealed(bytes)) return refuse(400, "blob-unsealed");
      if ((await store.get(metaPk(pond), id)) !== null) return refuse(409, "exists");
      const all = await rows(pond);
      let used = all.reduce((n, r) => n + r.size, 0);
      if (used + bytes.length > capBytes) {
        used -= await sweepOrphans(pond, all);
        if (used + bytes.length > capBytes) return refuse(413, "blob-quota", PLAIN["blob-quota"]);
      }
      try {
        await bucket.put(objectKey(pond, id), bytes);
      } catch (e) {
        if (e && e.code === "exists") return refuse(409, "exists");
        throw e;
      }
      await store.put(
        metaPk(pond),
        id,
        JSON.stringify({ v: 1, size: bytes.length, at: now(), kind: ref.kind, doc: ref.doc, by: ref.by }),
      );
      return { ok: true };
    },
    /** The sealed bytes, or null when the blob is not here (never uploaded or already paged out). */
    async get(pond, id) {
      if (!BLOB_ID.test(id) || (await store.get(metaPk(pond), id)) === null) return null;
      return bucket.get(objectKey(pond, id));
    },
    delete: remove,
    /** A document that carried blobs is gone (paged out, deleted): its blobs go with it. Returns how many. */
    async dropFor(pond, kind, doc) {
      let n = 0;
      for (const r of await rows(pond)) {
        if (r.kind !== kind || r.doc !== doc) continue;
        await remove(pond, r.id);
        n += 1;
      }
      return n;
    },
    /** What a Pond holds: {bytes, count}. */
    async usage(pond) {
      const all = await rows(pond);
      return { bytes: all.reduce((n, r) => n + r.size, 0), count: all.length };
    },
    /** Clean start and Pond removal: every blob of the Pond. */
    async wipe(pond) {
      let n = 0;
      for (const r of await rows(pond)) {
        await remove(pond, r.id);
        n += 1;
      }
      return n;
    },
  };
}

module.exports = { createBlobs, MAX_BLOB_BYTES, POND_CAP_BYTES, BLOB_ID, REF_KINDS };
