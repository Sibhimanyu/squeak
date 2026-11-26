// Clean start (docs/cloud-layer.md, "Clean start"; spec: People and remote, "Start clean"): clears every Pond from the cloud so
// shared Ponds begin again from their Owners' Macs, which keep every Pond and Duck. What goes: the Pond tables
// (people.js cleanStart), each Pond's sealed documents (every kind under channels/<pondId>/), its pins and revocations, its
// channel claim, and the account Pond indexes (acctponds/<userId>). What stays: accounts, devices, push tokens, and every
// Mac's own channel (the iPhone's way in; a Mac's key and its channel id are the same id, so those ids are skipped).
// The store cannot list partitions, so Pond ids are gathered from the Pond table, the account indexes of every known
// account, and whatever the operator names (`pondIds`, `userIds`).
const { CHANNEL, KINDS } = require("./rules");

const MAC_OWNERS = "mac-owners";
const ACCT_PONDS_PK = "acctponds";
const USER = /^[A-Za-z0-9_.:-]{1,64}$/;

function createCleanStart({ store, people }) {
  async function wipePartition(pk) {
    const rows = await store.list(pk);
    for (const r of rows) await store.del(pk, r.doc);
    return rows.length;
  }

  /** @returns {{ponds: number, documents: number, indexes: number, people: object|null}} */
  async function run({ pondIds = [], userIds = [] } = {}) {
    const ponds = new Set(pondIds.filter((id) => typeof id === "string" && CHANNEL.test(id)));
    const users = new Set(userIds.filter((id) => typeof id === "string" && USER.test(id)));
    if (people) {
      for (const id of await people.pondIds()) ponds.add(id);
      for (const id of await people.accountIds()) users.add(id);
    }
    let indexes = 0;
    for (const userId of users) {
      const pk = `${ACCT_PONDS_PK}/${userId}`;
      for (const r of await store.list(pk)) if (CHANNEL.test(r.doc)) ponds.add(r.doc);
      indexes += await wipePartition(pk);
    }
    let documents = 0;
    let wiped = 0;
    for (const id of ponds) {
      // A Mac's own channel is its key's id: never a Pond.
      if (await store.get(MAC_OWNERS, id)) continue;
      wiped++;
      for (const kind of KINDS) documents += await wipePartition(`channels/${id}/${kind}`);
      documents += await wipePartition(`pins/${id}`);
      documents += await wipePartition(`revoked/${id}`);
      await store.del("channel-owners", id);
    }
    return { ponds: wiped, documents, indexes, people: people ? await people.cleanStart() : null };
  }
  return { run };
}

module.exports = { createCleanStart };
