import { describe, expect, it, vi } from "vitest";

import { canonicalMessageId, CliqRelayInbox, signCliqBox } from "./inbox.js";

const SECRET = "a".repeat(64);
const RELAY = "r".repeat(43);

function signed(box: object, secret = SECRET) {
  const text = JSON.stringify(box);
  return { box: text, sig: signCliqBox(secret, text), at: 1 };
}

function setup(docs: Array<{ id: string; doc: { box: string; sig?: string; at?: number } }>) {
  const seen = new Set<string>();
  const store = {
    list: vi.fn<(collection: string) => Promise<typeof docs>>(async () => docs.splice(0)),
    delete: vi.fn<(path: string) => Promise<void>>(async () => undefined),
  };
  const inbox = new CliqRelayInbox({
    store,
    relayId: RELAY,
    secret: SECRET,
    seen: { hasSeenCliqSignature: (sig) => seen.has(sig), markCliqSignatureSeen: (sig) => seen.add(sig) },
  });
  return { inbox, store, seen };
}

describe("canonicalMessageId", () => {
  it("reads Cliq's three spellings of one id as the same card", () => {
    expect(canonicalMessageId("1790492118179%2033850494115")).toBe("1790492118179_33850494115");
    expect(canonicalMessageId("1790492118179 33850494115")).toBe("1790492118179_33850494115");
    expect(canonicalMessageId("1790492118179_33850494115")).toBe("1790492118179_33850494115");
    expect(canonicalMessageId("")).toBeNull();
    expect(canonicalMessageId(null)).toBeNull();
  });
});

describe("signCliqBox", () => {
  it('matches Deluge\'s zoho.encryption.hmacsha256(key, data, "hex")', () => {
    // RFC 4231 test case 2.
    expect(signCliqBox("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });
});

describe("CliqRelayInbox", () => {
  it("reads signed records oldest first, from this relay's collection", async () => {
    const t = setup([
      { id: "2", doc: signed({ kind: "button", arg: "pick:A", msgid: "1_2", userid: "7", sentat: 200 }) },
      { id: "1", doc: signed({ kind: "message", body: "radar", userid: 7, sentat: 100 }) },
    ]);
    const records = await t.inbox.list();

    expect(t.store.list).toHaveBeenCalledWith(`cliq/${RELAY}/inbox`);
    expect(records.map((r) => [r.id, r.kind, r.msgid, r.userId, r.sentAt, r.body])).toEqual([
      ["1", "message", null, "7", 100, "radar"],
      ["2", "button", "1_2", "7", 200, ""],
    ]);
  });

  it("deletes unread anything unsigned, signed with another secret, or altered", async () => {
    const good = signed({ kind: "message", body: "go", userid: "7", sentat: 1 });
    const t = setup([
      { id: "none", doc: { box: good.box } },
      { id: "other", doc: signed({ kind: "message", body: "go", userid: "7", sentat: 1 }, "b".repeat(64)) },
      { id: "altered", doc: { ...good, box: good.box.replace("go", "rm") } },
      { id: "junk", doc: { box: good.box, sig: "not hex" } },
    ]);
    expect(await t.inbox.list()).toEqual([]);
    expect(t.store.delete.mock.calls.map(([p]) => p)).toEqual([
      `cliq/${RELAY}/inbox/none`,
      `cliq/${RELAY}/inbox/other`,
      `cliq/${RELAY}/inbox/altered`,
      `cliq/${RELAY}/inbox/junk`,
    ]);
  });

  it("refuses a copy of a record it has already acted on", async () => {
    const doc = signed({ kind: "button", arg: "pick:A", msgid: "1", userid: "7", sentat: 1 });
    const t = setup([{ id: "a", doc }]);
    await t.inbox.list();
    await t.inbox.delete("a");
    expect(t.seen.size).toBe(1);

    t.store.list.mockResolvedValueOnce([{ id: "copy", doc }]);
    expect(await t.inbox.list()).toEqual([]);
  });
});
