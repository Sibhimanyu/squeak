import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

import { keysOfMember, memberOfDevice, readMember, trustedDevices } from "../js/guest-docs.js";
import { memberIdOf, newMemberKey, signText, signedText } from "../js/guest-crypto.js";
import { loadAccountPonds, pondsToRequest, syncAccountPonds } from "../js/guest-account.js";
import { GuestPond } from "../js/guest-pond.js";
import { readInvite } from "../js/guest-invite.js";
import { KeyStore } from "../js/key-store.js";
import { ADA, cleanup, KEY, fakeRelay, mac, RELAY_URL } from "./guest-helpers.js";
import { fakeIndexedDB } from "./helpers.js";

afterAll(cleanup);

const require = createRequire(import.meta.url);
const { issueAppToken } = require("../../cloud/catalyst-relay/functions/squeak_relay/scoped.js");
/** A real account token, as the relay's own sign-in hands out. */
const appToken = (userId) => issueAppToken(KEY, userId, "x@x.org", Date.now(), 3_600_000).token;

const ORIGIN = "https://squeak.catalystserverless.in";
const member = async (extra = {}) => {
  const key = await newMemberKey();
  return {
    key,
    doc: {
      id: await memberIdOf(key.publicKey),
      name: "Ada",
      publicKey: key.publicKey,
      role: "member",
      nest: null,
      client: "web",
      addedAt: 1,
      ...extra,
    },
  };
};
const deviceOf = async (client = "web", extra = {}) => {
  const key = await newMemberKey();
  return {
    key,
    device: {
      id: await memberIdOf(key.publicKey),
      publicKey: key.publicKey,
      boxKey: key.publicKey,
      client,
      addedAt: 2,
      ...extra,
    },
  };
};

describe("a member's device list", () => {
  it("an old single-key document reads as before, with its one key", async () => {
    const { doc } = await member();
    const read = readMember(doc);
    expect(read.devices).toBeUndefined();
    expect(keysOfMember(read)).toEqual([doc.publicKey]);
  });

  it("reads valid devices and drops forged ids, duplicates and malformed entries", async () => {
    const a = await deviceOf();
    const b = await deviceOf("ios", { nest: null });
    const forged = { ...(await deviceOf()).device, id: a.device.id.replace(/^./, "x") };
    const { doc } = await member({
      devices: [a.device, a.device, forged, { id: 1 }, { ...b.device, client: "tv" }, b.device],
    });
    const read = await trustedDevices(readMember(doc));
    // the forged id (a key whose id is not derived from it) is not trusted; the duplicate collapses
    expect(read.devices.map((d) => d.id)).toEqual([a.device.id, b.device.id]);
    expect(keysOfMember(read)).toEqual([doc.publicKey, a.device.publicKey, b.device.publicKey]);
  });

  it("caps the list at 8 devices", async () => {
    const list = [];
    for (let i = 0; i < 10; i++) list.push((await deviceOf()).device);
    const { doc } = await member({ devices: list });
    expect(readMember(doc).devices).toHaveLength(8);
  });

  it("a retired primary keeps the id but no longer counts as a key", async () => {
    const a = await deviceOf();
    const { doc } = await member({ devices: [a.device], primaryRetired: true });
    const read = await trustedDevices(readMember(doc));
    expect(keysOfMember(read)).toEqual([a.device.publicKey]);
    const members = new Map([[doc.id, read]]);
    expect(memberOfDevice(members, doc.id)).toBeUndefined();
    expect(memberOfDevice(members, a.device.id)).toBe(read);
    // primaryRetired without devices is not honoured
    expect(readMember({ ...(await member()).doc, primaryRetired: true }).primaryRetired).toBeUndefined();
  });

  it("finds a device's member by the device's own key id", async () => {
    const a = await deviceOf();
    const { doc } = await member({ devices: [a.device] });
    const read = await trustedDevices(readMember(doc));
    const members = new Map([[doc.id, read]]);
    expect(memberOfDevice(members, a.device.id)).toBe(read);
    expect(memberOfDevice(members, doc.id)).toBe(read);
    expect(memberOfDevice(members, "nobody")).toBeUndefined();
  });

  it("a signature by the second device's key verifies as the member", async () => {
    const a = await deviceOf();
    const { doc } = await member({ devices: [a.device] });
    const read = await trustedDevices(readMember(doc));
    const guest = new GuestPond({ record: { pondId: "p".repeat(10), keys: {}, relayUrl: RELAY_URL }, vault: null });
    const text = signedText(`channels/${"p".repeat(10)}/presence/m`, "1.box");
    const sig = await signText(a.key.signingKey, text);
    const keys = keysOfMember(read);
    const doc2 = { box: "1.box", sig, device: doc.id };
    const seen = [];
    // readSigned fails at opening the box (no pond key), but only after the signature passed: check via keyOf calls
    await guest.readSigned("presence", "m", doc2, (d) => (seen.push(d), keys));
    expect(seen).toEqual([doc.id]);
    const stranger = await newMemberKey();
    const forged = { ...doc2, sig: await signText(stranger.signingKey, text) };
    const opened = [];
    guest.openDoc = async () => (opened.push(1), { ok: true });
    expect(await guest.readSigned("presence", "m", doc2, () => keys)).toMatchObject({ device: doc.id });
    expect(await guest.readSigned("presence", "m", forged, () => keys)).toBeNull();
  });
});

describe("which of the account's ponds to ask for", () => {
  const listed = [
    { pondId: "A".repeat(22), ownerKey: "k1", name: "One" },
    { pondId: "B".repeat(22), ownerKey: "k2" },
    { pondId: "C".repeat(22), ownerKey: "k3" },
    { pondId: "A".repeat(22), ownerKey: "k1" },
    { pondId: "bad id", ownerKey: "k4" },
    { pondId: "D".repeat(22) },
  ];
  it("skips ponds already held in any state, refused ones, duplicates and malformed entries", () => {
    const out = pondsToRequest({ listed, held: ["B".repeat(22)], refused: new Set(["C".repeat(22)]) });
    expect(out.map((p) => p.pondId)).toEqual(["A".repeat(22)]);
    expect(out[0].name).toBe("One");
    expect(pondsToRequest({ listed: null })).toEqual([]);
  });
});

describe("a second browser of the same account", () => {
  const browser = (relay, who = ADA) => ({
    vault: new KeyStore(fakeIndexedDB()),
    fetch: (url, init) => relay.as(who).fetch(new URL(url, ORIGIN).href, init),
  });

  it("asks for the pond once, is added by the owner's Mac, and acts as the same member", async () => {
    const relay = fakeRelay();
    const owner = mac(relay, "Sibhi", { owner: true });
    const pond = await owner.createPond({ name: "Site", projectId: "proj-site" });
    const { link } = await owner.invite(pond.id, "member");
    const one = browser(relay);
    const first = await GuestPond.join(readInvite(link, Date.now(), ORIGIN).invite, one);
    const [req] = (await owner.view(pond.id)).joins;
    await owner.decideJoin(pond.id, req.requestId, { approve: true });
    expect(await first.refresh()).toBe("active");

    const two = browser(relay);
    const state = { lastAt: 0, refused: new Set() };
    const run = () => syncAccountPonds({ relayUrl: RELAY_URL, token: () => appToken(ADA.userId), ...two, state });
    const ponds = await run();
    expect(ponds).toHaveLength(1);
    expect(ponds[0].record.deviceJoin).toBe(true);
    expect(ponds[0].status).toBe("pending");
    // not more than once a minute: the second call asks nothing
    const before = relay.requests.length;
    await run();
    expect(relay.requests.length).toBe(before);

    await owner.refresh(pond.id);
    const device = (await loadAccountPonds(two))[0];
    expect(await device.refresh()).toBe("active");
    expect(device.record.memberId).toBe(first.record.memberId);
    expect(device.record.keyId).not.toBe(first.record.memberId);
    await device.setPresence({});
    const view = await device.view();
    expect(view.me.id).toBe(first.record.memberId);
    expect(view.threads).toBeDefined();
    // and the first device still reads the pond with its own key
    expect(await first.refresh()).toBe("active");
    expect((await first.view()).members.some((m) => m.id === first.record.memberId)).toBe(true);
  });

  it("remembers a refused pond for the session and does not ask again", async () => {
    const relay = fakeRelay();
    const owner = mac(relay, "Sibhi", { owner: true });
    await owner.createPond({ name: "Site", projectId: "proj-site" });
    const b = browser(relay, { userId: "2002", email: "s@x.org", name: "Stranger" });
    const state = { lastAt: 0, refused: new Set() };
    const ponds = await syncAccountPonds({ relayUrl: RELAY_URL, token: () => appToken(ADA.userId), ...b, state });
    expect(ponds).toEqual([]);
  });
});
