import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { logger } from "../utils/logger.js";
import { makePairingCode, readPairingCode } from "../voice/pair-protocol.js";
import { CatalystStore } from "./catalyst-store.js";
import { activeLocation, createCloudStore, hostedLocation, readCloudConfig, writeCloudConfig } from "./config.js";
import { HOSTED_RELAY_URL, HostedCloud, deferMoveRequested, hostedRelayUrl, type LegacyCloud } from "./hosted.js";
import { grantFields, type CloudLocation } from "./location.js";

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-hosted-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const URL_ = hostedRelayUrl({});
const TOKEN = "account-token-0123456789";
const MAC_KEY = crypto.randomBytes(32).toString("base64url");
const OLD_CHANNEL = crypto.randomBytes(16).toString("base64url");
const FIREBASE: CloudLocation = {
  provider: "firebase",
  databaseUrl: "https://squeak-x-default-rtdb.asia-southeast1.firebasedatabase.app",
};

interface Relay {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  calls: Array<{ route: string; headers: Record<string, string>; body: unknown }>;
  provision: () => Response;
  me: () => Response;
}

function relay(overrides: Partial<Pick<Relay, "provision" | "me">> = {}): Relay {
  const r: Relay = {
    calls: [],
    me: overrides.me ?? (() => Response.json({ userId: "u1", email: "me@example.com", name: "" })),
    provision: overrides.provision ?? (() => new Response("{}", { status: 500 })),
    fetch: async (url, init) => {
      const route = url.replace(URL_, "");
      r.calls.push({
        route,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (route === "/me") return r.me();
      if (route === "/account/macs/provision") return r.provision();
      return new Response("{}", { status: 404 });
    },
  };
  return r;
}

const okProvision = (macIdOf: () => string) => () =>
  Response.json({ macId: macIdOf(), key: MAC_KEY, createdAt: 1, rotated: false });

function build(opts: {
  dir: string;
  relay: Relay;
  current?: () => CloudLocation | null;
  legacy?: () => LegacyCloud | null;
  channelId?: string | null;
  moveTo?: (target: CloudLocation) => Promise<{ ok: boolean }>;
  restart?: () => void;
  retryMs?: number[];
  deferMove?: () => boolean;
  onSettled?: () => void;
}) {
  return new HostedCloud({
    supportDir: opts.dir,
    url: URL_,
    current: opts.current ?? (() => null),
    legacy: opts.legacy ?? (() => null),
    channelId: () => opts.channelId ?? null,
    moveTo:
      opts.moveTo ??
      (async () => {
        throw new Error("no move expected");
      }),
    restart: opts.restart ?? (() => undefined),
    ...(opts.deferMove ? { deferMove: opts.deferMove } : {}),
    ...(opts.onSettled ? { onSettled: opts.onSettled } : {}),
    fetch: opts.relay.fetch,
    retryMs: opts.retryMs ?? [1],
    name: () => "Test Mac",
  });
}

describe("hosted cloud", () => {
  it("defaults to Squeak's relay, and SQUEAK_CLOUD_URL overrides it only with a Catalyst address", () => {
    expect(hostedRelayUrl({})).toBe(HOSTED_RELAY_URL);
    expect(hostedRelayUrl({ SQUEAK_CLOUD_URL: "https://x.catalystserverless.in/server/squeak_relay/" })).toBe(
      "https://x.catalystserverless.in/server/squeak_relay",
    );
    expect(hostedRelayUrl({ SQUEAK_CLOUD_URL: "https://evil.example.com" })).toBe(HOSTED_RELAY_URL);
  });

  it("a fresh install waits in needs-sign-in and never defaults to the shared server", () => {
    const dir = tmp();
    const hosted = build({ dir, relay: relay() });
    expect(hosted.view()).toMatchObject({ state: "needs-sign-in", legacy: null });
    expect(hosted.view().error).toBeUndefined();
    expect(activeLocation(readCloudConfig(dir), null)).toBeNull();
    expect(hosted.connect()).toBe(false);
  });

  it("provisions after sign-in: stores the key (0600), never logs it, and restarts a fresh install once", async () => {
    const dir = tmp();
    const spies = (["debug", "info", "warn", "error"] as const).map((l) => vi.spyOn(logger, l));
    const restart = vi.fn();
    const r = relay();
    r.provision = okProvision(() => (r.calls.at(-1)!.body as { macId: string }).macId);
    const hosted = build({ dir, relay: r, restart });
    expect(await hosted.signIn(TOKEN)).toEqual({ ok: true, email: "me@example.com" });
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
    const call = r.calls.find((c) => c.route === "/account/macs/provision")!;
    expect(call.headers["x-squeak-account"]).toBe(TOKEN);
    const macId = (call.body as { macId: string }).macId;
    expect(macId).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
    expect((call.body as { name: string }).name).toBe("Test Mac");
    const file = readCloudConfig(dir)!;
    expect(file.active).toBe("hosted");
    expect(file.hosted).toMatchObject({ provider: "catalyst", url: URL_, macKey: MAC_KEY, macId, hosted: true });
    expect(fs.statSync(path.join(dir, "cloud.json")).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(dir, "hosted-account.json"))).toBe(false);
    expect(hosted.view()).toMatchObject({ state: "ready", email: "me@example.com", legacy: null });
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(MAC_KEY);
    expect(JSON.stringify(hosted.view())).not.toContain(MAC_KEY);
    expect(activeLocation(file, null)).toEqual({
      provider: "catalyst",
      relayUrl: URL_,
      relayKey: MAC_KEY,
      hosted: true,
    });
  });

  it("one-step sign-in on a brand-new Mac: the ticket waits (0600) across the restart and is read once, young only", async () => {
    const dir = tmp();
    const restart = vi.fn();
    const r = relay();
    r.provision = okProvision(() => (r.calls.at(-1)!.body as { macId: string }).macId);
    const hosted = build({ dir, relay: r, restart });
    hosted.holdTicket("ticket-abc", 1_000);
    expect(fs.statSync(path.join(dir, "hosted-ticket.json")).mode & 0o777).toBe(0o600);
    expect(await hosted.signIn(TOKEN)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
    expect(readCloudConfig(dir)?.active).toBe("hosted");
    // The restarted daemon is a new object over the same folder.
    const again = build({ dir, relay: r });
    expect(again.heldTicket(1_000 + 60_000)).toBe("ticket-abc");
    expect(again.heldTicket(1_000 + 10 * 60_000)).toBeNull();
    expect(fs.existsSync(path.join(dir, "hosted-ticket.json"))).toBe(false);
    again.holdTicket("t2", 5);
    again.dropTicket();
    expect(again.heldTicket(6)).toBeNull();
  });

  it("tells the daemon when provisioning settled without a restart", async () => {
    const dir = tmp();
    const onSettled = vi.fn();
    const r = relay();
    r.provision = okProvision(() => OLD_CHANNEL);
    const hosted = build({
      dir,
      relay: r,
      channelId: OLD_CHANNEL,
      current: () => FIREBASE,
      moveTo: async () => ({ ok: true }),
      onSettled,
    });
    await hosted.signIn(TOKEN);
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
  });

  it("reuses the Mac's existing channel id as its macId", async () => {
    const dir = tmp();
    const r = relay();
    r.provision = okProvision(() => OLD_CHANNEL);
    const hosted = build({
      dir,
      relay: r,
      channelId: OLD_CHANNEL,
      current: () => FIREBASE,
      moveTo: async () => ({ ok: true }),
    });
    await hosted.signIn(TOKEN);
    await vi.waitFor(() => expect(readCloudConfig(dir)?.hosted).toBeDefined());
    expect((r.calls.find((c) => c.route === "/account/macs/provision")!.body as { macId: string }).macId).toBe(
      OLD_CHANNEL,
    );
  });

  it("a refused token (401) goes back to needs-sign-in and forgets the token", async () => {
    const dir = tmp();
    const r = relay({ provision: () => new Response(null, { status: 401 }) });
    const hosted = build({ dir, relay: r });
    await hosted.signIn(TOKEN);
    await vi.waitFor(() => expect(fs.existsSync(path.join(dir, "hosted-account.json"))).toBe(false));
    expect(hosted.view().state).toBe("needs-sign-in");
    expect(readCloudConfig(dir)?.hosted).toBeUndefined();
  });

  it("sign-in with an expired token is refused up front", async () => {
    const hosted = build({ dir: tmp(), relay: relay({ me: () => new Response(null, { status: 401 }) }) });
    expect(await hosted.signIn(TOKEN)).toEqual({ ok: false, reason: "That sign-in expired. Sign in again." });
    expect(await hosted.signIn({ token: 1 })).toMatchObject({ ok: false });
    expect(hosted.view().state).toBe("needs-sign-in");
  });

  it("retries a network error with backoff, then connects", async () => {
    const dir = tmp();
    const restart = vi.fn();
    const r = relay();
    let tries = 0;
    r.provision = () => {
      tries += 1;
      if (tries < 3) throw new TypeError("fetch failed");
      return Response.json({ macId: (r.calls.at(-1)!.body as { macId: string }).macId, key: MAC_KEY });
    };
    const hosted = build({ dir, relay: r, restart });
    await hosted.signIn(TOKEN);
    expect(hosted.view().state).toBe("connecting");
    await vi.waitFor(() => expect(restart).toHaveBeenCalled(), { timeout: 3000 });
    expect(tries).toBe(3);
  });

  it("too many Macs is an error the person can read", async () => {
    const hosted = build({
      dir: tmp(),
      relay: relay({ provision: () => Response.json({ error: "too-many-macs" }, { status: 409 }) }),
    });
    await hosted.signIn(TOKEN);
    await vi.waitFor(() => expect(hosted.view().state).toBe("error"));
    expect(hosted.view().error).toMatch(/most Macs/);
  });

  it("a revoked key (401 from the relay) clears it and needs sign-in again", () => {
    const dir = tmp();
    writeCloudConfig(dir, {
      active: "hosted",
      hosted: { provider: "catalyst", url: URL_, macKey: MAC_KEY, macId: OLD_CHANNEL, hosted: true },
    });
    const restart = vi.fn();
    const hosted = build({ dir, relay: relay(), restart });
    expect(hosted.view().state).toBe("ready");
    hosted.onUnauthorized();
    expect(readCloudConfig(dir)?.hosted).toBeUndefined();
    expect(readCloudConfig(dir)?.active).toBe("firebase");
    expect(restart).toHaveBeenCalledTimes(1);
    expect(hosted.view().state).toBe("needs-sign-in");
  });

  it("the store tells the daemon when the relay refuses its Mac key", async () => {
    const seen: Array<Record<string, string>> = [];
    const onUnauthorized = vi.fn();
    const store = createCloudStore(
      { provider: "catalyst", relayUrl: URL_, relayKey: MAC_KEY, hosted: true },
      {
        onUnauthorized,
        fetch: async (_url, init) => {
          seen.push(init?.headers as Record<string, string>);
          return new Response(null, { status: 401 });
        },
      },
    ) as CatalystStore;
    await expect(store.get("channels/x/state/a")).rejects.toThrow();
    expect(seen[0]).toMatchObject({ "x-squeak-mac-key": MAC_KEY });
    expect(seen[0]).not.toHaveProperty("x-squeak-relay");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("a Mac linked to an account on its own relay still needs a hosted token: nothing provisions without one", async () => {
    const dir = tmp();
    const r = relay();
    r.provision = okProvision(() => OLD_CHANNEL);
    const hosted = build({
      dir,
      relay: r,
      channelId: OLD_CHANNEL,
      current: () => FIREBASE,
      legacy: () => "catalyst-own",
    });
    hosted.start();
    // The own relay's link (a ticket, its operator key) is no credential on the hosted relay.
    expect(hosted.view()).toMatchObject({ state: "needs-sign-in", legacy: "catalyst-own" });
    expect(hosted.view().signInUrl).toBe(`${new URL(URL_).origin}/app/index.html`);
    expect(hosted.connect()).toBe(false);
    expect(r.calls).toEqual([]);
    // The Mac app's Connect: the hosted page yields an account token, handed over as `{ token }`; that provisions.
    let moved = false;
    const connected = build({
      dir,
      relay: r,
      channelId: OLD_CHANNEL,
      current: () => FIREBASE,
      legacy: () => (moved ? null : "catalyst-own"),
      moveTo: async () => {
        writeCloudConfig(dir, { ...readCloudConfig(dir)!, active: "hosted" });
        moved = true;
        return { ok: true };
      },
    });
    expect(await connected.signIn(TOKEN)).toEqual({ ok: true, email: "me@example.com" });
    await vi.waitFor(() => expect(connected.view()).toMatchObject({ state: "ready", legacy: null }));
    expect(r.calls.find((c) => c.route === "/account/macs/provision")!.headers["x-squeak-account"]).toBe(TOKEN);
  });

  it("a legacy Firebase install keeps working until sign-in, then moves and records legacy: null", async () => {
    const dir = tmp();
    writeCloudConfig(dir, {
      active: "firebase",
      firebase: { databaseUrl: "https://x.firebaseio.com", projectId: "p" },
    });
    let onHostedStore = false;
    const r = relay();
    r.provision = okProvision(() => OLD_CHANNEL);
    const moves: CloudLocation[] = [];
    const hosted = build({
      dir,
      relay: r,
      channelId: OLD_CHANNEL,
      current: () => (onHostedStore ? hostedLocation(readCloudConfig(dir)!.hosted) : FIREBASE),
      legacy: () => (onHostedStore ? null : "firebase"),
      moveTo: async (target) => {
        moves.push(target);
        writeCloudConfig(dir, { ...readCloudConfig(dir)!, active: "hosted" });
        onHostedStore = true;
        return { ok: true };
      },
    });
    hosted.start();
    expect(hosted.view()).toMatchObject({ state: "needs-sign-in", legacy: "firebase" });
    expect(activeLocation(readCloudConfig(dir), null)).toEqual(
      FIREBASE.provider === "firebase" ? { provider: "firebase", databaseUrl: "https://x.firebaseio.com" } : null,
    );
    await hosted.signIn(TOKEN);
    await vi.waitFor(() => expect(hosted.view().state).toBe("ready"));
    expect(moves).toEqual([{ provider: "catalyst", relayUrl: URL_, relayKey: MAC_KEY, hosted: true }]);
    expect(hosted.view().legacy).toBeNull();
  });

  it("deferMove: a legacy Mac gets its key but does not move until move-now", async () => {
    const dir = tmp();
    const r = relay();
    r.provision = okProvision(() => OLD_CHANNEL);
    const moves: CloudLocation[] = [];
    const hosted = build({
      dir,
      relay: r,
      channelId: OLD_CHANNEL,
      current: () => FIREBASE,
      legacy: () => "firebase",
      deferMove: () => true,
      moveTo: async (target) => {
        moves.push(target);
        writeCloudConfig(dir, { ...readCloudConfig(dir)!, active: "hosted" });
        return { ok: true };
      },
    });
    await hosted.signIn(TOKEN);
    await vi.waitFor(() => expect(hosted.view()).toMatchObject({ state: "connecting", moveDeferred: true }));
    expect(readCloudConfig(dir)?.hosted?.macKey).toBe(MAC_KEY);
    expect(readCloudConfig(dir)?.active).toBe("firebase");
    expect(moves).toEqual([]);
    expect(hosted.moveNow()).toBe(true);
    await vi.waitFor(() => expect(hosted.view().state).toBe("ready"));
    expect(moves).toHaveLength(1);
    expect(r.calls.filter((c) => c.route === "/account/macs/provision")).toHaveLength(1);
  });

  it("deferMove never holds a fresh install, and moveNow needs an account", async () => {
    const dir = tmp();
    const r = relay();
    r.provision = okProvision(() => OLD_CHANNEL);
    let restarts = 0;
    const hosted = build({
      dir,
      relay: r,
      channelId: OLD_CHANNEL,
      deferMove: () => true,
      restart: () => (restarts += 1),
    });
    expect(hosted.moveNow()).toBe(false);
    await hosted.signIn(TOKEN);
    await vi.waitFor(() => expect(restarts).toBe(1));
  });

  it("the defer switch reads the env or a cloud-defer-move file", () => {
    const dir = tmp();
    expect(deferMoveRequested(dir, {})).toBe(false);
    expect(deferMoveRequested(dir, { SQUEAK_CLOUD_DEFER_MOVE: "on" })).toBe(true);
    fs.writeFileSync(path.join(dir, "cloud-defer-move"), "");
    expect(deferMoveRequested(dir, {})).toBe(true);
  });

  it("a move that did not finish is retried, with the key already saved", async () => {
    const dir = tmp();
    const r = relay();
    r.provision = okProvision(() => OLD_CHANNEL);
    let attempts = 0;
    const hosted = build({
      dir,
      relay: r,
      channelId: OLD_CHANNEL,
      current: () => FIREBASE,
      legacy: () => "firebase",
      moveTo: async () => {
        attempts += 1;
        if (attempts === 1) return { ok: false };
        writeCloudConfig(dir, { ...readCloudConfig(dir)!, active: "hosted" });
        return { ok: true };
      },
    });
    await hosted.signIn(TOKEN);
    await vi.waitFor(() => expect(hosted.view().state).toBe("ready"), { timeout: 3000 });
    expect(attempts).toBe(2);
    expect(r.calls.filter((c) => c.route === "/account/macs/provision")).toHaveLength(1);
  });

  it("pairing codes and move documents carry the hosted relay and the Mac key as ck", () => {
    const location: CloudLocation = { provider: "catalyst", relayUrl: URL_, relayKey: MAC_KEY, hosted: true };
    const made = makePairingCode(location, 1000);
    const body = JSON.parse(Buffer.from(made.code.slice(4), "base64url").toString("utf8")) as Record<string, string>;
    expect(body.cu).toBe(URL_);
    expect(body.ck).toBe(MAC_KEY);
    expect(readPairingCode(made.code)!.location).toMatchObject({ relayUrl: URL_, relayKey: MAC_KEY });
    expect(grantFields(location)).toEqual({ c: URL_, ck: MAC_KEY });
  });
});

describe("two origins: account (sign-in) and relay (device traffic)", () => {
  const FN = "https://squeak-60083782173.development.catalystserverless.in/server/squeak_relay";
  const APPSAIL = "https://squeak-relay-50047538056.development.catalystappsail.in";
  const held = (dir: string, extra: Record<string, unknown> = {}) =>
    writeCloudConfig(dir, {
      active: "hosted",
      hosted: {
        provider: "catalyst",
        url: URL_,
        macKey: MAC_KEY,
        macId: OLD_CHANNEL,
        hosted: true,
        ...extra,
      } as never,
    });

  it("pins the two hosts exactly and nothing else", async () => {
    const { pinnedRelayBase } = await import("./location.js");
    expect(pinnedRelayBase(FN)).toBe(FN);
    expect(pinnedRelayBase(`${FN}/`)).toBe(FN);
    expect(pinnedRelayBase(APPSAIL)).toBe(APPSAIL);
    expect(pinnedRelayBase(`${APPSAIL}/`)).toBe(APPSAIL);
    for (const bad of [
      "http://squeak-relay-50047538056.development.catalystappsail.in",
      "https://squeak-relay-50047538056.development.catalystappsail.in:8443",
      "https://squeak-relay-50047538056.development.catalystappsail.in.evil.com",
      "https://x.squeak-relay-50047538056.development.catalystappsail.in",
      "https://squeak-relay-50047538056.catalystappsail.in",
      "https://u:p@squeak-relay-50047538056.development.catalystappsail.in",
      "https://squeak-relay-50047538056.development.catalystappsail.in?a=1",
      "https://squeak-relay-50047538056.development.catalystappsail.in/server/squeak_relay",
      "https://squeak-60083782173.development.catalystserverless.in",
      "https://squeak-60083782173.development.catalystserverless.in/server/other",
      "https://evil.catalystappsail.in",
      42,
      null,
    ])
      expect(pinnedRelayBase(bad as never)).toBeNull();
  });

  it("defaults both origins to today's function", () => {
    const dir = tmp();
    held(dir);
    expect((hostedLocation(readCloudConfig(dir)!.hosted) as { relayUrl: string }).relayUrl).toBe(FN);
    const view = build({ dir, relay: relay() }).view();
    expect(view.accountUrl).toBe(FN);
    expect(view.relayUrl).toBe(FN);
  });

  it("a pinned relay in cloud.json routes device traffic; a bad one is dropped", () => {
    const dir = tmp();
    held(dir, { relay: APPSAIL });
    expect((hostedLocation(readCloudConfig(dir)!.hosted) as { relayUrl: string }).relayUrl).toBe(APPSAIL);
    const view = build({ dir, relay: relay() }).view();
    expect(view.accountUrl).toBe(FN);
    expect(view.relayUrl).toBe(APPSAIL);
    held(dir, { relay: "https://evil.catalystappsail.in" });
    expect((hostedLocation(readCloudConfig(dir)!.hosted) as { relayUrl: string }).relayUrl).toBe(FN);
  });

  it("a provision answer naming a pinned relay is kept; an unpinned one is ignored; sign-in stays on the account origin", async () => {
    for (const [named, expected] of [
      [APPSAIL, APPSAIL],
      ["https://evil.catalystappsail.in", undefined],
    ] as const) {
      const dir = tmp();
      const r = relay({ provision: () => Response.json({ macId: OLD_CHANNEL, key: MAC_KEY, relay: named }) });
      const cloud = build({ dir, relay: r, channelId: OLD_CHANNEL });
      expect((await cloud.signIn(TOKEN)).ok).toBe(true);
      await vi.waitFor(() => expect(readCloudConfig(dir)?.hosted?.macKey).toBe(MAC_KEY));
      expect(readCloudConfig(dir)?.hosted?.relay).toBe(expected);
      expect(r.calls.map((c) => c.route)).toEqual(["/me", "/account/macs/provision"]);
    }
  });

  it("setRelay moves like any move, saves only on success, and null puts it back", async () => {
    const dir = tmp();
    held(dir);
    const moves: string[] = [];
    let ok = true;
    const cloud = build({
      dir,
      relay: relay(),
      moveTo: async (t) => {
        moves.push((t as { relayUrl: string }).relayUrl);
        return { ok };
      },
    });
    expect(await cloud.setRelay("https://evil.catalystappsail.in")).toMatchObject({ ok: false });
    expect(moves).toEqual([]);
    ok = false;
    expect(await cloud.setRelay(APPSAIL)).toMatchObject({ ok: false });
    expect(readCloudConfig(dir)?.hosted?.relay).toBeUndefined();
    ok = true;
    expect(await cloud.setRelay(APPSAIL)).toEqual({ ok: true });
    expect(readCloudConfig(dir)?.hosted?.relay).toBe(APPSAIL);
    expect(await cloud.setRelay(null)).toEqual({ ok: true });
    expect(readCloudConfig(dir)?.hosted?.relay).toBeUndefined();
    expect(moves).toEqual([APPSAIL, APPSAIL, FN]);
  });
});
