import { describe, expect, it, vi } from "vitest";

import type { ChannelDoc } from "../remote/firestore-rest.js";
import { DocTree } from "../remote/mirror-store.js";
import {
  CLAIM_GRANT_ID,
  CLAIM_REQUEST_ID,
  CLAIM_TTL_MS,
  claimIdOf,
  claimPath,
  makeClaimCode,
  newClaimKeyPair,
  normalizeClaimCode,
  readClaimGrant,
  sealClaimRequest,
} from "./claim-protocol.js";
import { GatewayClaim, type ClaimStore } from "./gateway-claim.js";

const DB = "https://squeak-test-default-rtdb.firebasedatabase.app";

function setup(existing: { channel: string; key: string } | null = null) {
  const tree = new DocTree();
  const store: ClaimStore = {
    get: async (p) => tree.get(p) ?? null,
    set: async (p, doc: ChannelDoc) => void tree.set(p, doc),
    delete: async (p) => void tree.delete(p),
  };
  let now = 5_000_000;
  const saved: Array<{ channel: string; key: string }> = [];
  const restart = vi.fn();
  const claim = new GatewayClaim({
    store,
    databaseUrl: DB,
    current: () => saved.at(-1) ?? existing,
    save: (channel, key) => saved.push({ channel, key }),
    restart,
    now: () => now,
    pollMs: 1_000_000,
    cleanupMs: 10,
    restartMs: 5,
  });
  const addon = (code = makeClaimCode()) => {
    const pair = newClaimKeyPair();
    const flat = normalizeClaimCode(code)!;
    tree.set(
      claimPath(claimIdOf(flat), CLAIM_REQUEST_ID),
      sealClaimRequest(flat, { name: "Squeak Voice", version: "0.9.0", publicKey: pair.publicKey, at: now }),
    );
    return { code, flat, pair };
  };
  return { claim, tree, addon, saved, restart, advance: (ms: number) => void (now += ms), now: () => now };
}

describe("GatewayClaim", () => {
  it("reads the add-on's request, shows it without a verify, and seals the Mac's channel on approve", async () => {
    const t = setup();
    const { code, flat, pair } = t.addon();
    const started = await t.claim.start(code.toLowerCase().replace("-", " "));
    expect(started).toMatchObject({ ok: true, name: "Squeak Voice", version: "0.9.0" });
    expect(t.claim.view()).toEqual({
      state: "request",
      expiresAt: t.now() + CLAIM_TTL_MS,
      name: "Squeak Voice",
      version: "0.9.0",
    });
    expect(await t.claim.approve(true)).toEqual({ ok: true });
    expect(t.claim.view()?.state).toBe("done");
    const grantDoc = t.tree.get(claimPath(claimIdOf(flat), CLAIM_GRANT_ID))!;
    const grant = readClaimGrant(flat, pair.privateKey, grantDoc, t.now())!;
    expect(grant).toEqual({ databaseUrl: DB, channel: t.saved[0]!.channel, key: t.saved[0]!.key });
    await new Promise((r) => setTimeout(r, 40));
    expect(t.restart).toHaveBeenCalledTimes(1);
    expect(t.tree.get(claimPath(claimIdOf(flat), CLAIM_GRANT_ID))).toBeNull();
    expect(t.tree.get(claimPath(claimIdOf(flat), CLAIM_REQUEST_ID))).toBeNull();
  });

  it("reuses the Mac's channel and key and does not restart when it already has them", async () => {
    const key = Buffer.alloc(32, 3).toString("base64");
    const t = setup({ channel: "c".repeat(22), key });
    const { code, flat, pair } = t.addon();
    await t.claim.start(code);
    await t.claim.approve(true);
    const grant = readClaimGrant(
      flat,
      pair.privateKey,
      t.tree.get(claimPath(claimIdOf(flat), CLAIM_GRANT_ID))!,
      t.now(),
    );
    expect(grant).toMatchObject({ channel: "c".repeat(22), key });
    expect(t.saved).toEqual([]);
    await new Promise((r) => setTimeout(r, 30));
    expect(t.restart).not.toHaveBeenCalled();
  });

  it("answers a bad or unknown code with the plain sentence, a 400", async () => {
    const t = setup();
    for (const bad of ["", "nope", 12, null, "K7M2-QX9O"]) {
      const out = await t.claim.start(bad);
      expect(out).toMatchObject({ ok: false, status: 400 });
      expect(out.ok ? "x" : out.reason).not.toBe("");
    }
    // Well formed but not on any add-on: the plain "not showing" sentence.
    const unknown = await t.claim.start("K7M2-QX9P");
    expect(unknown.ok ? "" : unknown.reason).toContain("isn't showing on an add-on");
    expect(await t.claim.start(makeClaimCode())).toMatchObject({ ok: false, status: 400 });
    expect(t.claim.view()).toBeNull();
  });

  it("is 503 when the database cannot be reached", async () => {
    const claim = new GatewayClaim({
      store: { get: async () => Promise.reject(new Error("offline")), set: vi.fn(), delete: vi.fn() },
      databaseUrl: DB,
      current: () => null,
      save: vi.fn(),
      restart: vi.fn(),
    });
    expect(await claim.start("K7M2-QX9P")).toMatchObject({ ok: false, status: 503 });
  });

  it("decline deletes the request; expiry refuses approve; a new claim replaces the old", async () => {
    const t = setup();
    const a = t.addon();
    await t.claim.start(a.code);
    expect(await t.claim.approve(false)).toEqual({ ok: true });
    expect(t.tree.get(claimPath(claimIdOf(a.flat), CLAIM_REQUEST_ID))).toBeNull();
    expect(t.claim.view()).toBeNull();

    const b = t.addon();
    await t.claim.start(b.code);
    const c = t.addon();
    await t.claim.start(c.code);
    t.advance(CLAIM_TTL_MS + 1);
    expect(t.claim.view()?.state).toBe("expired");
    expect(await t.claim.approve(true)).toMatchObject({ ok: false });
    expect(t.tree.get(claimPath(claimIdOf(c.flat), CLAIM_GRANT_ID))).toBeNull();
  });

  it("never puts the code, channel or key in the view", async () => {
    const t = setup();
    const { code, flat } = t.addon();
    await t.claim.start(code);
    await t.claim.approve(true);
    const text = JSON.stringify(t.claim.view());
    expect(text).not.toContain(flat);
    expect(text).not.toContain(t.saved[0]!.key);
  });

  it("names a typo of the look-alike characters and a wrong length instead of saying the code is not showing", async () => {
    const claim = new GatewayClaim({
      store: { get: async () => null, set: async () => undefined, delete: async () => undefined },
      databaseUrl: "https://squeak-x-default-rtdb.asia-southeast1.firebasedatabase.app",
      current: () => null,
      save: () => undefined,
      restart: () => undefined,
    });
    const lookAlike = await claim.start("9001-4AMA");
    expect(lookAlike.ok ? "" : lookAlike.reason).toContain("never has the characters 0, 1, O, I or L");
    const short = await claim.start("K7M2");
    expect(short.ok ? "" : short.reason).toContain("8 characters");
  });
});
