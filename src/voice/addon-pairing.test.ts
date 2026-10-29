import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DocTree } from "../remote/mirror-store.js";
import { addonVersion, resolveCredentials, type CredentialDeps } from "./gateway-main.js";
import { codeFingerprint, readSavedPairing, startStatusReporter, writeSavedPairing } from "./addon-pairing.js";
import { readGatewayStatus } from "./gateway-status-protocol.js";
import {
  PAIR_GRANT_ID,
  PAIR_REQUEST_ID,
  PAIR_TTL_MS,
  makePairingCode,
  pairPath,
  readPairRequest,
  readPairingCode,
  sealPairGrant,
} from "./pair-protocol.js";
import { resultPath } from "./relay-protocol.js";

const DB = "https://squeak-test-default-rtdb.firebasedatabase.app";
const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-pair-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** An in-memory store; `onSleep` lets a test play the Mac between polls. */
function fakeStore(tree = new DocTree()) {
  return {
    tree,
    get: async (p: string) => tree.get(p) ?? null,
    set: async (p: string, doc: never) => void tree.set(p, doc),
    delete: async (p: string) => void tree.delete(p),
  };
}

function setup(macApproves: boolean) {
  const dir = tmp();
  const made = makePairingCode(DB, 0);
  const store = fakeStore();
  const channel = crypto.randomBytes(16).toString("base64url");
  const key = crypto.randomBytes(32).toString("base64");
  let clock = 0;
  const log: string[] = [];
  const deps: CredentialDeps = {
    pairingFile: path.join(dir, "pairing.json"),
    triedFile: path.join(dir, "tried"),
    version: "0.7.0",
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      // The Mac approves on the second look, once it has seen the request.
      const req = store.tree.get(pairPath(made.rendezvous, PAIR_REQUEST_ID));
      if (macApproves && req && clock >= 4000) {
        store.tree.set(
          pairPath(made.rendezvous, PAIR_GRANT_ID),
          sealPairGrant(made.secret, { v: 1, channel, key, at: clock }),
        );
      }
    },
    log: (line) => log.push(line),
    storeFor: () => store,
  };
  return { made, store, channel, key, deps, log, dir, clockAt: () => clock };
}

describe("resolveCredentials", () => {
  it("pairs, saves 0600, and cleans up the rendezvous", async () => {
    const t = setup(true);
    const got = await resolveCredentials({ SQUEAK_VOICE_PAIRING_CODE: t.made.code }, t.deps);
    expect(got).toMatchObject({ databaseUrl: DB, channel: t.channel, key: t.key, source: "paired now" });
    expect(readSavedPairing(t.deps.pairingFile)).toEqual({ databaseUrl: DB, channel: t.channel, key: t.key });
    expect(fs.statSync(t.deps.pairingFile).mode & 0o777).toBe(0o600);
    expect(t.store.tree.get(pairPath(t.made.rendezvous, PAIR_REQUEST_ID))).toBeNull();
    expect(t.store.tree.get(pairPath(t.made.rendezvous, PAIR_GRANT_ID))).toBeNull();
    const line = t.log.find((l) => l.startsWith("Pairing: confirm "));
    expect(line).toMatch(/^Pairing: confirm \d{4} on your Mac$/);
    expect(t.log.join("\n")).not.toContain(t.key);
    expect(t.log.join("\n")).not.toContain(t.channel);
    expect(t.log.join("\n")).not.toContain(t.made.code);
  });

  it("writes a request only the code's holder can read, carrying the printed digits", async () => {
    const t = setup(true);
    let seen = "";
    const original = t.deps.sleep;
    t.deps.sleep = async (ms) => {
      const doc = t.store.tree.get(pairPath(t.made.rendezvous, PAIR_REQUEST_ID));
      const request = doc ? readPairRequest(t.made.secret, doc, 0) : null;
      if (request) seen = request.verify;
      await original(ms);
    };
    await resolveCredentials({ SQUEAK_VOICE_PAIRING_CODE: t.made.code }, t.deps);
    expect(t.log.find((l) => l.includes(seen))).toBeTruthy();
    expect(seen).toMatch(/^\d{4}$/);
  });

  it("gives up when the code runs out, stays unpaired, and never spends the same code twice", async () => {
    const t = setup(false);
    const env = { SQUEAK_VOICE_PAIRING_CODE: t.made.code };
    expect(await resolveCredentials(env, t.deps)).toBeNull();
    expect(t.clockAt()).toBeGreaterThanOrEqual(PAIR_TTL_MS);
    expect(readSavedPairing(t.deps.pairingFile)).toBeNull();
    expect(t.store.tree.get(pairPath(t.made.rendezvous, PAIR_REQUEST_ID))).toBeNull();
    const before = t.log.length;
    expect(await resolveCredentials(env, t.deps)).toBeNull();
    expect(t.log.slice(before).join("\n")).toContain("already used");
  });

  it("uses legacy options before anything else, then pairing.json", async () => {
    const t = setup(false);
    writeSavedPairing(t.deps.pairingFile, { databaseUrl: DB, channel: "saved-channel-aaaaaaaaaa", key: "k" });
    const legacy = await resolveCredentials(
      {
        SQUEAK_REMOTE_DATABASE_URL: DB,
        SQUEAK_VOICE_RELAY_CHANNEL: "old-channel",
        SQUEAK_VOICE_RELAY_KEY: "old-key",
        SQUEAK_VOICE_PAIRING_CODE: t.made.code,
      },
      t.deps,
    );
    expect(legacy).toMatchObject({ channel: "old-channel", source: "options" });
    expect(await resolveCredentials({}, t.deps)).toMatchObject({
      channel: "saved-channel-aaaaaaaaaa",
      source: "pairing",
    });
    expect(t.store.tree.get(pairPath(t.made.rendezvous, PAIR_REQUEST_ID))).toBeNull();
  });

  it("stays unpaired with a clear line when there is no code, or a bad one", async () => {
    const t = setup(false);
    expect(await resolveCredentials({}, t.deps)).toBeNull();
    expect(t.log[0]).toContain("Not paired");
    expect(await resolveCredentials({ SQUEAK_VOICE_PAIRING_CODE: "SQ1-nonsense" }, t.deps)).toBeNull();
    expect(readPairingCode("SQ1-nonsense")).toBeNull();
    expect(t.log.at(-1)).toContain("not a Squeak pairing code");
  });
});

describe("helpers", () => {
  it("fingerprints a code without containing it", () => {
    expect(codeFingerprint(" abc ")).toBe(codeFingerprint("abc"));
    expect(codeFingerprint("abc")).not.toContain("abc");
  });

  it("reads the version from config.yaml", () => {
    const file = path.join(tmp(), "config.yaml");
    fs.writeFileSync(file, 'name: Squeak Voice\nversion: "0.7.0"\nslug: x\n');
    expect(addonVersion(file)).toBe("0.7.0");
    expect(addonVersion(path.join(tmp(), "none"))).toBe("unknown");
  });
});

describe("startStatusReporter", () => {
  it("writes at once, and again early only when registration or the pin changes", async () => {
    const store = fakeStore();
    const key = crypto.randomBytes(32).toString("base64");
    let registered = false;
    let error: string | undefined = "401";
    const writes = () => store.tree.get(resultPath("chan", "gwstatus"));
    const reporter = startStatusReporter({
      store,
      channel: "chan",
      key,
      sources: {
        version: "0.7.0",
        registration: () => ({ registered, ...(error ? { error } : {}) }),
        pin: () => "set",
      },
      now: () => 5000,
      intervalMs: 60_000_000,
      checkMs: 60_000_000,
    });
    await new Promise((r) => setTimeout(r, 5));
    const first = readGatewayStatus(key, writes()!, 5000);
    expect(first).toMatchObject({ sipRegistered: false, sipError: "401", pin: "set", version: "0.7.0", paired: true });
    registered = true;
    error = undefined;
    reporter.poke();
    await new Promise((r) => setTimeout(r, 5));
    expect(readGatewayStatus(key, writes()!, 5000)).toMatchObject({ sipRegistered: true });
    expect(readGatewayStatus(key, writes()!, 5000)?.sipError).toBeUndefined();
    reporter.stop();
  });
});
