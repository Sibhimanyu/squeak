// The Stratus bucket behind the blobs port (blobs.js). UNMEASURED against a live project: written from the catalyst-stratus
// skill (`bucket.putObject(key, body, {overwrite})` throws 409 when the key exists and overwrite is false; `getObject` returns a
// stream; `deleteObject`). The owner creates the bucket (docs/cloud-layer.md, "Pictures and files"); nothing here creates one.
const status = (e) => Number((e && (e.statusCode || e.status)) || 0);

/** `createStratusBucket(bucket)`: `bucket` is `new Stratus(app).bucket(name)` from @zcatalyst/stratus. */
function createStratusBucket(bucket) {
  return {
    async put(key, bytes) {
      try {
        await bucket.putObject(key, bytes, { overwrite: false, contentType: "application/octet-stream" });
      } catch (e) {
        if (status(e) === 409 || (e && e.code === "key_already_exists")) throw Object.assign(e, { code: "exists" });
        throw e;
      }
    },
    async get(key) {
      let stream;
      try {
        stream = await bucket.getObject(key);
      } catch (e) {
        if (status(e) === 404) return null;
        throw e;
      }
      const chunks = [];
      for await (const c of stream) chunks.push(Buffer.from(c));
      return Buffer.concat(chunks);
    },
    async del(key) {
      try {
        await bucket.deleteObject(key);
      } catch (e) {
        if (status(e) !== 404) throw e;
      }
    },
  };
}

module.exports = { createStratusBucket };
