import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { RtdbRest } from "../remote/rtdb-rest.js";
import {
  PAIR_GRANT_ID,
  PAIR_REQUEST_ID,
  PAIR_TTL_MS,
  newVerifyCode,
  pairPath,
  readPairGrant,
  sealPairRequest,
  type ReadPairingCode,
} from "./pair-protocol.js";
import { GATEWAY_STATUS_ID, sealGatewayStatus, type GatewayStatusDoc } from "./gateway-status-protocol.js";
import { resultPath } from "./relay-protocol.js";
import { cleanVersion } from "./addon-update.js";

/** What pairing leaves behind in the add-on's own storage: the three things the old options used to hold. */
export interface SavedPairing {
  databaseUrl: string;
  channel: string;
  key: string;
}

export function readSavedPairing(file: string): SavedPairing | null {
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (typeof r.databaseUrl === "string" && typeof r.channel === "string" && typeof r.key === "string") {
      return { databaseUrl: r.databaseUrl, channel: r.channel, key: r.key };
    }
  } catch {
    // Missing or unreadable: not paired.
  }
  return null;
}

/** Written whole, then moved into place, so a crash never leaves half a key. */
export function writeSavedPairing(file: string, pairing: SavedPairing): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(pairing), { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** A hash, not the code: enough to know this one was already tried without keeping its secret. */
export function codeFingerprint(code: string): string {
  return crypto.createHash("sha256").update(code.trim()).digest("hex").slice(0, 16);
}

export type PairingStore = Pick<RtdbRest, "get" | "set" | "delete">;

export interface PairDeps {
  store: PairingStore;
  code: ReadPairingCode;
  version: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  name?: string;
  pollMs?: number;
}

export type PairOutcome = { ok: true; channel: string; key: string } | { ok: false; reason: string };

/**
 * Asks the Mac to pair and waits for its answer for the code's life. The 4 digits are printed here and shown on the
 * Mac, so the person can tell this request is the one they are expecting. Nothing secret is logged.
 */
export async function pairWithMac(deps: PairDeps): Promise<PairOutcome> {
  const { store, code, now, sleep } = deps;
  const startedAt = now();
  const verify = newVerifyCode();
  await store.set(
    pairPath(code.rendezvous, PAIR_REQUEST_ID),
    sealPairRequest(code.secret, {
      v: 1,
      name: deps.name ?? "Squeak Voice",
      version: deps.version,
      verify,
      at: startedAt,
    }),
  );
  deps.log(`Pairing: confirm ${verify} on your Mac`);
  const grantPath = pairPath(code.rendezvous, PAIR_GRANT_ID);
  while (now() - startedAt < PAIR_TTL_MS) {
    await sleep(deps.pollMs ?? 2000);
    const doc = await store.get(grantPath).catch(() => null);
    const grant = doc ? readPairGrant(code.secret, doc, now()) : null;
    if (grant) {
      await store.delete(grantPath).catch(() => undefined);
      await store.delete(pairPath(code.rendezvous, PAIR_REQUEST_ID)).catch(() => undefined);
      return { ok: true, channel: grant.channel, key: grant.key };
    }
  }
  await store.delete(pairPath(code.rendezvous, PAIR_REQUEST_ID)).catch(() => undefined);
  return { ok: false, reason: "The pairing code ran out before it was approved on the Mac." };
}

export interface StatusSources {
  version: string;
  registration(): { registered: boolean; error?: string };
  pin(): "set" | "off" | "none";
  /** The newest add-on version found (x.y.z), or null/absent. */
  latestVersion?(): string | null;
}

export function gatewayStatusNow(sources: StatusSources, now: number): GatewayStatusDoc {
  const registration = sources.registration();
  const latestVersion = cleanVersion(sources.latestVersion?.());
  return {
    v: 1,
    id: GATEWAY_STATUS_ID,
    at: now,
    version: sources.version,
    ...(latestVersion ? { latestVersion } : {}),
    sipRegistered: registration.registered,
    ...(registration.error ? { sipError: registration.error.slice(0, 200) } : {}),
    paired: true,
    pin: sources.pin(),
  };
}

/**
 * Tells the Mac this add-on is alive every 30 s, and straight away when registration or the pin changes. A failed
 * write is dropped: the next one carries the same news.
 */
export function startStatusReporter(deps: {
  store: Pick<RtdbRest, "set">;
  channel: string;
  key: string;
  sources: StatusSources;
  now?: () => number;
  intervalMs?: number;
  checkMs?: number;
}): { poke(): void; stop(): void } {
  const now = deps.now ?? Date.now;
  let last = "";
  const send = (): void => {
    const body = gatewayStatusNow(deps.sources, now());
    last = JSON.stringify({ ...body, at: 0 });
    void deps.store
      .set(resultPath(deps.channel, GATEWAY_STATUS_ID), sealGatewayStatus(deps.key, body))
      .catch(() => undefined);
  };
  send();
  const timer = setInterval(send, deps.intervalMs ?? 30_000);
  // A pin changes inside the gateway with no event to hook, so a cheap look every few seconds catches it.
  const poke = (): void => {
    // Only a real change goes out early, so a flapping line cannot flood the database.
    if (JSON.stringify(gatewayStatusNow(deps.sources, 0)) !== last) send();
  };
  const watcher = setInterval(poke, deps.checkMs ?? 5_000);
  timer.unref?.();
  watcher.unref?.();
  return {
    poke,
    stop: () => {
      clearInterval(timer);
      clearInterval(watcher);
    },
  };
}
