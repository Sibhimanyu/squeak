// The Owner's Mac, for tests: it holds a Pond's key and signing key, writes sealed signed documents into the fake relay's feed
// with the daemon's own Node code (`src/flotilla/crypto.ts`), and answers a device request by sealing the Pond key to the
// requesting device's box key. Whatever the web opens here was sealed by the real daemon code.

import {
  generateMemberKey,
  memberIdOf,
  randomKey,
  sealAt,
  sealToMember,
  signedText,
  signText,
  type MemberKeyPair,
} from "../../src/flotilla/crypto.js";
import { newFakePond, type FakePond, type FakeRelayState } from "../src/relay/fake.js";

export interface MacMember {
  id: string;
  name: string;
  role: "owner" | "member" | "viewer";
  key: MemberKeyPair;
  accountId: string;
  devices: { id: string; publicKey: string; boxKey: string; client: "web"; addedAt: number }[];
}

export interface OwnerMac {
  pondId: string;
  ownerKey: string;
  ownerId: string;
  keys: Map<number, string>;
  current: number;
  pond: FakePond;
  members: MacMember[];
  /** Writes one sealed, signed document into the feed (as the Owner's Mac, or as a Member with their own key). */
  put(kind: string, id: string, value: unknown, as?: MacMember): void;
  remove(kind: string, id: string): void;
  addMember(name: string, role: MacMember["role"], accountId: string, token?: string): MacMember;
  /** Answers every device request not yet answered: adds the device to its member and seals the keys to it. */
  approveRequests(grantAll?: boolean): void;
  /** Rotates the Pond key and re-seals the keys documents of every listed device (`keepOld`: send every version). */
  rotate(keepOld: boolean): void;
  seq(): number;
}

export function createOwnerMac(
  fake: FakeRelayState,
  o: { pondId: string; ownerName: string; ownerAccountId: string; tokens: string[]; startedAt?: number },
): OwnerMac {
  const ownerKeys = generateMemberKey();
  const ownerId = memberIdOf(ownerKeys.publicKey);
  const pond = (fake.ponds[o.pondId] = newFakePond(o.tokens));
  const keys = new Map<number, string>([[1, randomKey()]]);
  let current = 1;
  let handled = 0;
  let clock = o.startedAt ?? Date.now() - 3_600_000;

  const mac: OwnerMac = {
    pondId: o.pondId,
    ownerKey: ownerKeys.publicKey,
    ownerId,
    keys,
    get current() {
      return current;
    },
    pond,
    members: [],
    seq: () => pond.feed[pond.feed.length - 1]?.seq ?? 0,
    put(kind, id, value, as) {
      const path = `channels/${o.pondId}/${kind}/${id}`;
      const box = `${current}.${sealAt(keys.get(current)!, path, value)}`;
      const signer = as?.key ?? ownerKeys;
      const doc = {
        box,
        sig: signText(signer.privateKey, signedText(path, box)),
        device: as?.id ?? ownerId,
        at: (clock += 1000),
      };
      pond.feed.push({ seq: mac.seq() + 1, kind, id, doc, at: doc.at });
    },
    remove(kind, id) {
      pond.feed.push({ seq: mac.seq() + 1, kind, id, doc: null, at: (clock += 1000) });
    },
    addMember(name, role, accountId, token) {
      const key = generateMemberKey();
      const member: MacMember = { id: memberIdOf(key.publicKey), name, role, key, accountId, devices: [] };
      mac.members.push(member);
      if (token) pond.tokens.push(token);
      publishMember(member);
      return member;
    },
    approveRequests() {
      for (const req of pond.requests.slice(handled)) {
        const member = mac.members.find(
          (m) => pond.tokens.includes(req.account) && m.accountId === accountOfToken(req.account),
        );
        if (!member) continue;
        const id = memberIdOf(req.publicKey);
        if (!member.devices.some((d) => d.id === id)) {
          member.devices.push({ id, publicKey: req.publicKey, boxKey: req.boxKey, client: "web", addedAt: clock });
          publishMember(member);
        }
        sendKeys(id, req.boxKey);
      }
      handled = pond.requests.length;
    },
    rotate(keepOld) {
      current += 1;
      keys.set(current, randomKey());
      if (!keepOld) for (const v of [...keys.keys()]) if (v !== current) keys.delete(v);
      for (const m of mac.members) for (const d of m.devices) sendKeys(d.id, d.boxKey);
    },
  };
  // The accounts a token stands for are the test's to say: the Owner Mac maps a request's token to a member by its account id.
  const accountOfToken = (token: string): string => fake.accounts[token]?.userId ?? "";

  const publishMember = (m: MacMember): void => {
    mac.put("members", m.id, {
      id: m.id,
      name: m.name,
      publicKey: m.key.publicKey,
      role: m.role,
      nest: null,
      addedAt: clock,
      accountId: m.accountId,
      ...(m.devices.length ? { devices: m.devices } : {}),
    });
  };

  const sendKeys = (deviceId: string, boxKey: string): void => {
    const path = `channels/${o.pondId}/keys/${deviceId}`;
    // Every version the Pond has had, as the daemon sends (#122).
    const grant = {
      version: current,
      key: keys.get(current)!,
      versions: Object.fromEntries(keys),
      token: tokenGrant(),
    };
    const box = sealToMember(boxKey, grant);
    pond.feed.push({
      seq: mac.seq() + 1,
      kind: "keys",
      id: deviceId,
      doc: { box, sig: signText(ownerKeys.privateKey, signedText(path, box)), device: ownerId, at: (clock += 1000) },
      at: clock,
    });
  };
  const tokenGrant = (): { value: string; expiresAt: number } => ({
    value: pond.writeToken,
    expiresAt: Date.now() + 86_400_000,
  });

  // The Owner is a member of their own Pond (their document is how the web learns their name and role).
  const owner: MacMember = {
    id: ownerId,
    name: o.ownerName,
    role: "owner",
    key: ownerKeys,
    accountId: o.ownerAccountId,
    devices: [],
  };
  mac.members.push(owner);
  publishMember(owner);
  return mac;
}
