import { memberIdOf } from "./crypto.js";
import type { FlotillaService } from "./service.js";
import type { MemberDoc, Role } from "./types.js";

/**
 * Tests that need a second Member in a Pond. The way in is email through the relay (docs/spec.md, "People and remote");
 * these tests exercise what a Member can do once in, so this writes the Member the way the Owner's Mac does when it lets
 * one in: the member document, the pond key sealed to them (and their token on a relay), the account index, the "joined"
 * Ripple. It reaches the service's private methods on purpose: nothing else in a test adds a person without the cloud's
 * mail. `account` is the relay's verified account id for the person, where a test needs one.
 */
interface Inside {
  pondsFile: { data: { ponds: Record<string, Record<string, unknown>> }; save(): void };
  prepareFirstInvite(pondId: string): Promise<void>;
  pond(id: string): Record<string, unknown> & {
    ownerKey: string;
    name: string;
    location: unknown;
    keys: Record<string, string>;
    current: number;
  };
  tokenFor(pond: unknown, member: MemberDoc): Promise<{ value: string; expiresAt: number } | undefined>;
  sendKeyTo(pond: unknown, member: MemberDoc): Promise<void>;
  writeMember(pond: unknown, member: MemberDoc): Promise<void>;
  indexAccounts(pond: unknown, add: string[], remove: string[]): Promise<void>;
  accountLabel(): string;
  accountEmail(): string | null;
}
const inside = (service: FlotillaService): Inside => service as unknown as Inside;

export async function admitMember(
  owner: FlotillaService,
  member: FlotillaService,
  pondId: string,
  role: Role = "member",
  account?: { id: string },
): Promise<MemberDoc> {
  const o = inside(owner);
  const m = inside(member);
  // The first person in a Pond: it is published and the Ducks shared so far become Private (what the Owner's first invite did).
  await o.prepareFirstInvite(pondId);
  const pond = o.pond(pondId);
  const who = member.me;
  const email = m.accountEmail();
  const doc: MemberDoc = {
    id: memberIdOf(who.publicKey),
    name: m.accountLabel(),
    ...(email ? { email } : {}),
    ...(account ? { accountId: account.id } : {}),
    publicKey: who.publicKey,
    role,
    nest: who.nest,
    ...(who.nest === null ? { client: "web" as const } : {}),
    addedAt: Date.now(),
  };
  const token = await o.tokenFor(pond, doc);
  await o.sendKeyTo(pond, doc);
  await o.writeMember(pond, doc);
  if (account) await o.indexAccounts(pond, [account.id], []).catch(() => undefined);
  await owner.ripple(pondId, "joined", { id: doc.id, name: doc.name }, "joined").catch(() => undefined);
  // The Member's own Mac: the Pond as it holds it once the key has reached it.
  const where = pond.location as { provider?: string; relayUrl?: string; databaseUrl?: string } | null;
  const location =
    where?.provider === "catalyst"
      ? { provider: "catalyst", relayUrl: where.relayUrl }
      : where?.provider === "firebase"
        ? { provider: "firebase", databaseUrl: where.databaseUrl }
        : null;
  m.pondsFile.data.ponds[pondId] = {
    id: pondId,
    name: pond.name,
    status: "active",
    role,
    ownerKey: pond.ownerKey,
    ...(typeof pond.gitRemote === "string" ? { gitRemote: pond.gitRemote } : {}),
    location,
    keys: { ...pond.keys },
    current: pond.current,
    ...(token ? { token } : {}),
    threads: {},
    nonces: {},
  };
  m.pondsFile.save();
  await member.refresh(pondId);
  return doc;
}
