// An in-memory bucket for tests: the same port as blob-stratus.js. `objects` is exposed so a test can look at every stored byte.
function createMemoryBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, bytes) {
      if (objects.has(key)) throw Object.assign(new Error("exists"), { code: "exists" });
      objects.set(key, Buffer.from(bytes));
    },
    async get(key) {
      const b = objects.get(key);
      return b ? Buffer.from(b) : null;
    },
    async del(key) {
      objects.delete(key);
    },
  };
}

module.exports = { createMemoryBucket };
