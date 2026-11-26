// The relay's side of live notices (docs/cloud-layer.md, "Live notices"; live/hub.js). After a content write has its seq the
// relay publishes one short message, {t:"n", pond, seq, kind}, to the internal `squeak_live` Data Streams channel; the
// `squeak-live` instances (the channel's only subscribers) forward it to the devices watching that Pond. It names no content:
// the device reads /changes. Publishing is best effort: a lost notice costs the watchers their 30 s feed poll, never a write.
const LIVE_CHANNEL = "squeak_live";

/** streams: the relay's Data Streams port; it may offer liveChannelId() (the internal channel), without it nothing is published. */
function createLiveNotices(streams, log = () => undefined) {
  async function send(msg) {
    try {
      const id = streams.liveChannelId ? await streams.liveChannelId() : null;
      if (id) await streams.publish(id, JSON.stringify(msg));
    } catch {
      log("live notice not published");
    }
  }
  return {
    /** A change was stamped with `seq`. */
    notice: (pond, seq, kind) => send({ t: "n", pond, seq, kind }),
    /** An account left or was removed: its subscriptions to the Pond close at once. */
    removed: (pond, user) => send({ t: "rm", pond, user }),
    /** Raw text from an instance (the live service has no SDK grant of its own; it publishes through the relay). */
    raw: async (text) => {
      const id = streams.liveChannelId ? await streams.liveChannelId() : null;
      if (!id) throw Object.assign(new Error("no live channel"), { status: 503 });
      await streams.publish(id, text);
    },
  };
}

/** people with removeMember announcing the removal; every other call is the people interface unchanged. */
function withRemovalNotice(people, live) {
  if (!people) return people;
  return {
    ...people,
    async removeMember(input) {
      const out = await people.removeMember(input);
      await live.removed(input.pondId, input.userId);
      return out;
    },
  };
}

module.exports = { createLiveNotices, withRemovalNotice, LIVE_CHANNEL };
