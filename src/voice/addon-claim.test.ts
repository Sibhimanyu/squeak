import { describe, expect, it } from "vitest";

import { DocTree } from "../remote/mirror-store.js";
import { claimWithMac, CLAIM_ROTATE_MS } from "./addon-claim.js";
import {
  CLAIM_GRANT_ID,
  CLAIM_REQUEST_ID,
  claimIdOf,
  claimPath,
  normalizeClaimCode,
  readClaimRequest,
  sealClaimGrant,
} from "./claim-protocol.js";

const DB = "https://squeak-test-default-rtdb.firebasedatabase.app";
const KEY = Buffer.alloc(32, 7).toString("base64");

function setup() {
  const tree = new DocTree();
  let t = 1_000_000;
  const store = {
    get: async (p: string) => tree.get(p) ?? null,
    set: async (p: string, doc: never) => void tree.set(p, doc),
    delete: async (p: string) => void tree.delete(p),
  };
  return { tree, store, clock: () => t, advance: (ms: number) => (t += ms) };
}

describe("claimWithMac", () => {
  it("writes a request, reads the Mac's grant, and deletes both", async () => {
    const s = setup();
    const codes: string[] = [];
    let polls = 0;
    const grant = await claimWithMac({
      store: s.store,
      now: s.clock,
      version: "0.9.0",
      name: "Squeak Voice",
      onCode: (c) => codes.push(c),
      sleep: async (ms) => {
        s.advance(ms);
        if (++polls < 2) return;
        const code = normalizeClaimCode(codes[0])!;
        const req = readClaimRequest(code, s.tree.get(claimPath(claimIdOf(code), CLAIM_REQUEST_ID))!, s.clock())!;
        s.tree.set(
          claimPath(claimIdOf(code), CLAIM_GRANT_ID),
          sealClaimGrant(code, req, { databaseUrl: DB, channel: "c".repeat(24), key: KEY }, s.clock()),
        );
      },
    });
    expect(grant).toEqual({ databaseUrl: DB, channel: "c".repeat(24), key: KEY });
    const code = normalizeClaimCode(codes[0])!;
    expect(s.tree.get(claimPath(claimIdOf(code), CLAIM_REQUEST_ID))).toBeNull();
    expect(s.tree.get(claimPath(claimIdOf(code), CLAIM_GRANT_ID))).toBeNull();
  });

  it("rotates the code at 13 minutes and removes the old request", async () => {
    const s = setup();
    const codes: string[] = [];
    await expect(
      claimWithMac({
        store: s.store,
        now: s.clock,
        version: "0.9.0",
        name: "Squeak Voice",
        pollMs: 60_000,
        onCode: (c) => codes.push(c),
        signal: (() => {
          const a = new AbortController();
          (globalThis as { __abort?: () => void }).__abort = () => a.abort();
          return a.signal;
        })(),
        sleep: async (ms) => {
          s.advance(ms);
          if (codes.length === 2) (globalThis as unknown as { __abort: () => void }).__abort();
        },
      }),
    ).rejects.toThrow("stopped");
    expect(codes).toHaveLength(2);
    expect(codes[0]).not.toBe(codes[1]);
    const first = normalizeClaimCode(codes[0])!;
    expect(s.tree.get(claimPath(claimIdOf(first), CLAIM_REQUEST_ID))).toBeNull();
    expect(CLAIM_ROTATE_MS).toBe(13 * 60_000);
  });

  it("retries a failed network call instead of throwing", async () => {
    const s = setup();
    let fails = 2;
    const store = {
      ...s.store,
      set: async (p: string, doc: never) => {
        if (fails-- > 0) throw new Error("offline");
        s.tree.set(p, doc);
      },
    };
    const codes: string[] = [];
    let sleeps = 0;
    const grant = await claimWithMac({
      store,
      now: s.clock,
      version: "0.9.0",
      name: "Squeak Voice",
      onCode: (c) => codes.push(c),
      sleep: async (ms) => {
        s.advance(ms);
        if (++sleeps < 4) return;
        const code = normalizeClaimCode(codes[0])!;
        const req = readClaimRequest(code, s.tree.get(claimPath(claimIdOf(code), CLAIM_REQUEST_ID))!, s.clock())!;
        s.tree.set(
          claimPath(claimIdOf(code), CLAIM_GRANT_ID),
          sealClaimGrant(code, req, { databaseUrl: DB, channel: "c".repeat(24), key: KEY }, s.clock()),
        );
      },
    });
    expect(grant.channel).toBe("c".repeat(24));
  });
});
