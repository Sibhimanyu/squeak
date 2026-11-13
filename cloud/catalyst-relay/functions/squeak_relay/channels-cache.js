// A warm-instance cache over the Data Streams channel list. getAllChannels() is an admin API call; asking it on every doc
// write put one extra round trip in front of every 204. Hits live for `ttlMs`; a name that is not in the list triggers one
// refresh, but never more often than `missRetryMs` (a pond whose channel the owner just made in the console is found then).
function createChannelsCache({ list, now = Date.now, ttlMs = 5 * 60_000, missRetryMs = 30_000 }) {
  let byName = null;
  let fetchedAt = 0;
  let inflight = null;

  async function refresh() {
    if (!inflight) {
      inflight = (async () => {
        const all = await list();
        const next = new Map();
        for (const c of all || []) {
          const name = c.channel_name ?? c.name;
          const id = c.channel_id ?? c.id;
          if (name && id) next.set(String(name), String(id));
        }
        byName = next;
        fetchedAt = now();
      })().finally(() => {
        inflight = null;
      });
    }
    await inflight;
  }

  return {
    /** The channel id for a name, or null when there is none (as of the last refresh the rate limit allows). */
    async idOf(name) {
      if (!byName || now() - fetchedAt >= ttlMs) await refresh();
      const hit = byName.get(name);
      if (hit) return hit;
      if (now() - fetchedAt >= missRetryMs) await refresh();
      return byName.get(name) ?? null;
    },
    invalidate() {
      byName = null;
    },
  };
}

module.exports = { createChannelsCache };
