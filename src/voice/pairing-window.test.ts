import { describe, expect, it, vi } from "vitest";

import type { ChannelDoc } from "../remote/firestore-rest.js";
import { DocTree } from "../remote/mirror-store.js";
import { GatewayPairing, type PairStore } from "./pairing-window.js";
import {
  PAIR_GRANT_ID,
  PAIR_REQUEST_ID,
  PAIR_TTL_MS,
  pairPath,
  readPairGrant,
  readPairingCode,
  sealPairRequest,
} from "./pair-protocol.js";

const DB = "https://squeak-test-default-rtdb.firebasedatabase.app";
const KEY = Buffer.alloc(32, 7).toString("base64");

function setup(existing: { channel: string; key: string } | null = null) {
  const tree = new DocTree();
  const watchers: Array<() => void> = [];
  const store: PairStore = {
    get: async (p) => tree.get(p) ?? null,
    set: async (p, doc: ChannelDoc) => void tree.set(p, doc),
    delete: async (p) => void tree.delete(p),
    watch: (_p, cb) => {
      watchers.push(cb);
      return () => undefined;
    },
  };
  let now = 1_000_000;
  const saved: Array<{ channel: string; key: string }> = [];
  const restart = vi.fn();
  const pairing = new GatewayPairing({
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
  const ask = async (code: string, verify = "4821") => {
    const read = readPairingCode(code)!;
    tree.set(
      pairPath(read.rendezvous, PAIR_REQUEST_ID),
      sealPairRequest(read.secret, { v: 1, name: "Squeak Voice", version: "0.7.0", verify, at: now }),
    );
    watchers.forEach((w) => w());
    await new Promise((r) => setTimeout(r, 5));
    return read;
  };
  return { pairing, tree, saved, restart, ask, advance: (ms: number) => (now += ms) };
}

describe("GatewayPairing", () => {
  it("has no window until started", () => {
    expect(setup().pairing.view()).toBeNull();
  });

  it("shows a request, then seals the grant and restarts once on a new channel", async () => {
    const { pairing, tree, saved, restart, ask } = setup();
    const { code, expiresAt } = pairing.start();
    expect(pairing.view()).toEqual({ state: "waiting", expiresAt });
    const read = await ask(code);
    expect(pairing.view()).toEqual({
      state: "request",
      expiresAt,
      name: "Squeak Voice",
      version: "0.7.0",
      verify: "4821",
    });
    expect(await pairing.approve(true)).toEqual({ ok: true });
    expect(pairing.view()?.state).toBe("done");
    const grant = readPairGrant(read.secret, tree.get(pairPath(read.rendezvous, PAIR_GRANT_ID))!, 1_000_000)!;
    expect(saved).toEqual([{ channel: grant.channel, key: grant.key }]);
    await new Promise((r) => setTimeout(r, 30));
    expect(restart).toHaveBeenCalledTimes(1);
    expect(tree.get(pairPath(read.rendezvous, PAIR_GRANT_ID))).toBeNull();
    expect(tree.get(pairPath(read.rendezvous, PAIR_REQUEST_ID))).toBeNull();
  });

  it("reuses the saved channel and key and does not restart", async () => {
    const existing = { channel: "c".repeat(22), key: KEY };
    const { pairing, tree, saved, restart, ask } = setup(existing);
    const read = await ask(pairing.start().code);
    await pairing.approve(true);
    const grant = readPairGrant(read.secret, tree.get(pairPath(read.rendezvous, PAIR_GRANT_ID))!, 1_000_000)!;
    expect({ channel: grant.channel, key: grant.key }).toEqual(existing);
    await new Promise((r) => setTimeout(r, 30));
    expect(saved).toEqual([]);
    expect(restart).not.toHaveBeenCalled();
  });

  it("declining deletes the request and waits again", async () => {
    const { pairing, tree, ask } = setup();
    const read = await ask(pairing.start().code);
    expect(await pairing.approve(false)).toEqual({ ok: true });
    expect(tree.get(pairPath(read.rendezvous, PAIR_REQUEST_ID))).toBeNull();
    expect(pairing.view()?.state).toBe("waiting");
    expect(tree.get(pairPath(read.rendezvous, PAIR_GRANT_ID))).toBeNull();
  });

  it("refuses to approve with no request, and ignores a request sealed under another code", async () => {
    const { pairing, ask } = setup();
    expect((await pairing.approve(true)).ok).toBe(false);
    const first = pairing.start();
    expect((await pairing.approve(true)).ok).toBe(false);
    pairing.start();
    await ask(first.code);
    expect(pairing.view()?.state).toBe("waiting");
  });

  it("expires after ten minutes and deletes the request", async () => {
    const { pairing, tree, ask, advance } = setup();
    const read = await ask(pairing.start().code);
    advance(PAIR_TTL_MS + 1);
    expect(pairing.view()?.state).toBe("expired");
    await new Promise((r) => setTimeout(r, 5));
    expect(tree.get(pairPath(read.rendezvous, PAIR_REQUEST_ID))).toBeNull();
    const refused = await pairing.approve(true);
    expect(refused.ok).toBe(false);
  });

  it("a new start replaces the old window", async () => {
    const { pairing, tree, ask } = setup();
    const first = await ask(pairing.start().code);
    const second = pairing.start();
    expect(pairing.view()?.state).toBe("waiting");
    expect(tree.get(pairPath(first.rendezvous, PAIR_REQUEST_ID))).toBeNull();
    expect(second.code).not.toBe("");
  });
});
