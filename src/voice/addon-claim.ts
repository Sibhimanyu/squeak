import type { RtdbRest } from "../remote/rtdb-rest.js";
import {
  CLAIM_GRANT_ID,
  CLAIM_REQUEST_ID,
  claimIdOf,
  claimPath,
  makeClaimCode,
  normalizeClaimCode,
  newClaimKeyPair,
  readClaimGrant,
  sealClaimRequest,
  type ClaimGrant,
} from "./claim-protocol.js";

/** The code is replaced this long after it was made, two minutes before the Mac would refuse it. */
export const CLAIM_ROTATE_MS = 13 * 60_000;

export type ClaimStore = Pick<RtdbRest, "get" | "set" | "delete">;

export interface ClaimDeps {
  store: ClaimStore;
  now: () => number;
  version: string;
  name: string;
  sleep: (ms: number) => Promise<void>;
  /** Called with every new code (and its end), so a panel and the log can show it. Never gets a key. */
  onCode: (code: string, expiresAt: number) => void;
  /** Called with a plain sentence about a failed call; the loop carries on. */
  onTrouble?: (text: string) => void;
  signal?: AbortSignal;
  pollMs?: number;
}

/**
 * Shows a code, waits for the person to type it on the Mac and for the Mac's sealed grant, and returns the Mac's
 * database address, channel and key. A failed network call is retried on the next poll; the only way out other than a
 * grant is the signal (the add-on is stopping), which rejects.
 */
export async function claimWithMac(deps: ClaimDeps): Promise<ClaimGrant> {
  const { store, now, sleep } = deps;
  const pollMs = deps.pollMs ?? 2000;
  const stopped = (): void => {
    if (deps.signal?.aborted) throw new Error("stopped");
  };
  for (;;) {
    stopped();
    // Shown with a dash; every derivation uses the 8 symbols, as the Mac does after normalizing what was typed.
    const shown = makeClaimCode();
    const code = normalizeClaimCode(shown) as string;
    const pair = newClaimKeyPair();
    const id = claimIdOf(code);
    const reqPath = claimPath(id, CLAIM_REQUEST_ID);
    const grantPath = claimPath(id, CLAIM_GRANT_ID);
    const startedAt = now();
    deps.onCode(shown, startedAt + CLAIM_ROTATE_MS);
    let written = false;
    const cleanup = async (): Promise<void> => {
      await store.delete(reqPath).catch(() => undefined);
      await store.delete(grantPath).catch(() => undefined);
    };
    while (now() - startedAt < CLAIM_ROTATE_MS) {
      stopped();
      if (!written) {
        try {
          await store.set(
            reqPath,
            sealClaimRequest(code, { name: deps.name, version: deps.version, publicKey: pair.publicKey, at: now() }),
          );
          written = true;
        } catch {
          deps.onTrouble?.("Cannot reach the pairing server yet; trying again");
        }
      } else {
        try {
          const doc = await store.get(grantPath);
          const grant = doc ? readClaimGrant(code, pair.privateKey, doc, now()) : null;
          if (grant) {
            await cleanup();
            return grant;
          }
        } catch {
          // Offline for a moment: the next poll asks again.
        }
      }
      await sleep(pollMs);
    }
    await cleanup();
  }
}
