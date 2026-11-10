import { beforeAll, describe, expect, it } from "vitest";

import { sealToMember } from "../../src/flotilla/crypto.js";
import { accountSection, accountStartScreen, linkedLine, requestScreen } from "../js/account-view.js";
import {
  AccountApi,
  accountSentence,
  AccountError,
  awaitDevice,
  deniedSentence,
  expiryMs,
  recordFromBox,
  requestDevice,
  SENTENCES,
} from "../js/account.js";
import { accountRelayBase } from "../js/catalyst-session.js";
import { generateDeviceKey, pairingCode } from "../js/channel-crypto.js";
import { shape } from "../js/command-shapes.js";
import { KeyStore } from "../js/key-store.js";
import { welcomeScreen } from "../js/pairing-view.js";
import { render as renderSettings } from "../js/settings-view.js";
import { account as viewAccount } from "../js/view-model.js";
import { all, click, installDom, text } from "./fake-dom.js";
import { KEY, RELAY_URL } from "./guest-helpers.js";
import { fakeIndexedDB } from "./helpers.js";

beforeAll(installDom);

const json = (status, body) => new Response(JSON.stringify(body), { status });
const CHANNEL = "p1pYhre8xC41Wr3hbYtgCg";
const SECRET = Buffer.alloc(32, 5).toString("base64");
const payload = { v: 1, c: CHANNEL, k: SECRET, n: "Sibhi's Mac", cu: RELAY_URL, ck: KEY };
const MAC = { macId: "mac1", name: "Sibhi's Mac", linkedAt: Date.UTC(2026, 10, 3) };

/** A relay that holds one device request and answers it as the test says. */
function fakeAccountRelay({ answer = "pending", expiresAt = Date.now() + 600_000, post = 200, postBody } = {}) {
  const state = { requests: [], polls: 0, answer, sealed: null };
  const fetch = async (url, init = {}) => {
    const u = new URL(url, "https://x.test");
    state.last = { url: u.pathname + u.search, credentials: init.credentials, method: init.method ?? "GET" };
    if (u.pathname.endsWith("/account/device-request") && init.method === "POST") {
      const body = JSON.parse(init.body);
      state.requests.push(body);
      if (post !== 200) return json(post, postBody ?? {});
      return json(200, { reqId: "req_" + "a".repeat(20), expiresAt });
    }
    if (u.pathname.endsWith("/account/device-request")) {
      state.polls += 1;
      if (state.answer === "pending") return json(202, {});
      if (state.answer === "gone") return json(410, { error: "gone" });
      if (state.answer === "denied") return json(200, { result: { denied: true } });
      const body = state.requests.at(-1);
      return json(200, { result: { box: sealToMember(body.boxKey, state.sealed ?? payload) } });
    }
    return json(404, {});
  };
  return { fetch, state };
}
const api = (fetch) => new AccountApi({ baseUrl: "/server/squeak_relay", fetch });
const visible = { hidden: () => false, onVisible: () => () => undefined };

describe("the unpaired start", () => {
  const base = { macsError: null, error: null, pick() {}, signIn() {}, qr() {} };

  it("signed in lists the Macs as buttons with the link date, and offers the QR code", () => {
    const picked = [];
    const screen = accountStartScreen({
      ...base,
      state: "in",
      user: { email: "me@x.org" },
      macs: [MAC, { macId: "m2", name: "Studio", linkedAt: null }],
      pick: (mac) => picked.push(mac.macId),
    });
    const words = text(screen);
    expect(words).toContain("Your Macs");
    expect(words).toContain("Sibhi's Mac");
    expect(words).toContain("Linked 3 Nov 2026");
    expect(words).toContain("Pair with a QR code instead");
    const buttons = all(screen).filter((n) => n.tag === "button");
    expect(buttons).toHaveLength(3);
    click(buttons[1]);
    expect(picked).toEqual(["m2"]);
  });

  it("signed out says to sign in, signs in on the button, and still offers the QR code", () => {
    let signedIn = 0;
    let qr = 0;
    const screen = accountStartScreen({ ...base, state: "out", macs: null, signIn: () => signedIn++, qr: () => qr++ });
    expect(text(screen)).toContain("Sign in to see your Macs");
    const buttons = all(screen).filter((n) => n.tag === "button");
    expect(text(buttons[0])).toBe("Continue with Zoho, Google or email");
    click(buttons[0]);
    click(buttons[1]);
    expect([signedIn, qr]).toEqual([1, 1]);
  });

  it("says plainly when no Mac is linked, and when the list could not load", () => {
    const empty = accountStartScreen({ ...base, state: "in", user: {}, macs: [] });
    expect(text(empty)).toContain("No Mac is linked to this account yet");
    const failed = accountStartScreen({ ...base, state: "in", user: {}, macs: null, macsError: SENTENCES.network });
    expect(text(failed)).toContain("Could not reach Squeak's server");
  });

  it("is today's QR screen alone when there are no accounts, with a way back only when there are", () => {
    const plain = welcomeScreen({ error: null, pair() {}, scan: () => null });
    expect(text(plain)).not.toContain("Use my account instead");
    const withBack = welcomeScreen({ error: null, pair() {}, scan: () => null, back() {} });
    expect(text(withBack)).toContain("Use my account instead");
  });

  it("reads this page's relay from its own origin", () => {
    expect(accountRelayBase({ origin: "https://squeak.catalystserverless.in" })).toBe(
      "https://squeak.catalystserverless.in/server/squeak_relay",
    );
    expect(accountRelayBase({ origin: "null" })).toBeNull();
    expect(accountRelayBase(undefined)).toBeNull();
  });
});

describe("asking a Mac to let this browser in", () => {
  it("sends the device key and a fresh ECDH key, shows the QR pairing's code, and stores a paired device", async () => {
    const relay = fakeAccountRelay({ answer: "box" });
    const request = await requestDevice(api(relay.fetch), { mac: MAC, name: "Web · Chrome" });
    const sent = relay.state.requests[0];
    expect(sent).toEqual({
      macId: "mac1",
      name: "Web · Chrome",
      publicKey: request.publicKeyX963,
      boxKey: expect.any(String),
    });
    expect(Buffer.from(sent.boxKey, "base64")).toHaveLength(65);
    expect(sent.boxKey).not.toBe(sent.publicKey);
    expect(request.code).toBe(await pairingCode(sent.publicKey));
    expect(relay.state.last.credentials).toBe("include");
    // The ECDH private half cannot be read back out.
    await expect(globalThis.crypto.subtle.exportKey("pkcs8", request.ecdhKey)).rejects.toThrow();

    const answer = await awaitDevice(api(relay.fetch), { mac: MAC, request, intervalMs: 1, visibility: visible });
    expect(relay.state.last.url).toContain("macId=mac1&id=req_");
    const record = await recordFromBox(request, answer.box);
    expect(record).toMatchObject({
      state: "paired",
      deviceId: request.reqId,
      deviceName: "Web · Chrome",
      channelId: CHANNEL,
      provider: "catalyst",
      relayUrl: RELAY_URL,
      relayKey: KEY,
      macName: "Sibhi's Mac",
      publicKeyX963: request.publicKeyX963,
    });
    expect(record.channelKey.extractable).toBe(false);
    expect(record.signingKey).toBe(request.signingKey);
    const store = new KeyStore(fakeIndexedDB());
    await store.save(record);
    expect((await store.load()).relayKey).toBe(KEY);
  });

  it("keeps asking while the Mac is silent, and stops at the request's expiry", async () => {
    const relay = fakeAccountRelay({ answer: "pending" });
    const request = await requestDevice(api(relay.fetch), { mac: MAC, name: "Web · Chrome" });
    let clock = 1_000;
    request.expiresAt = 1_000 + 20;
    const answer = await awaitDevice(api(relay.fetch), {
      mac: MAC,
      request,
      intervalMs: 5,
      now: () => (clock += 5),
      visibility: visible,
    });
    expect(answer).toEqual({ expired: true });
    expect(relay.state.polls).toBeGreaterThan(1);
  });

  it("says denied, gone, and refused in plain sentences", async () => {
    const denied = fakeAccountRelay({ answer: "denied" });
    const r1 = await requestDevice(api(denied.fetch), { mac: MAC, name: "Web" });
    expect(await awaitDevice(api(denied.fetch), { mac: MAC, request: r1, intervalMs: 1, visibility: visible })).toEqual(
      {
        denied: true,
      },
    );
    expect(deniedSentence("Studio")).toBe("Studio said no.");
    const gone = fakeAccountRelay({ answer: "gone" });
    const r2 = await requestDevice(api(gone.fetch), { mac: MAC, name: "Web" });
    expect(await awaitDevice(api(gone.fetch), { mac: MAC, request: r2, intervalMs: 1, visibility: visible })).toEqual({
      gone: true,
    });
    const busy = fakeAccountRelay({ post: 429, postBody: { error: "busy" } });
    const refused = fakeAccountRelay({ post: 403, postBody: { error: "mac" } });
    const fail = (r) => requestDevice(api(r.fetch), { mac: MAC, name: "Web" }).catch((e) => accountSentence(e));
    expect(await fail(busy)).toBe(SENTENCES.busy);
    expect(await fail(refused)).toBe(SENTENCES.mac);
    expect(accountSentence(new Error("offline"))).toBe(SENTENCES.network);
    expect(accountSentence(new AccountError(401))).toBe(SENTENCES.signin);
  });

  it("does not ask while the tab is hidden, and resumes when it shows", async () => {
    const relay = fakeAccountRelay({ answer: "box" });
    const request = await requestDevice(api(relay.fetch), { mac: MAC, name: "Web" });
    let hidden = true;
    let show = () => undefined;
    const visibility = { hidden: () => hidden, onVisible: (fn) => ((show = fn), () => undefined) };
    const waiting = awaitDevice(api(relay.fetch), { mac: MAC, request, intervalMs: 1, visibility });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(relay.state.polls).toBe(0);
    hidden = false;
    show();
    expect((await waiting).box).toEqual(expect.any(String));
  });

  it("stops when cancelled", async () => {
    const relay = fakeAccountRelay({ answer: "pending" });
    const request = await requestDevice(api(relay.fetch), { mac: MAC, name: "Web" });
    const abort = new AbortController();
    const waiting = awaitDevice(api(relay.fetch), {
      mac: MAC,
      request,
      signal: abort.signal,
      intervalMs: 5,
      visibility: visible,
    });
    setTimeout(() => abort.abort(), 20);
    expect(await waiting).toEqual({ cancelled: true });
  });

  it("refuses a sealed answer that points at another server, one for another key, and a Firebase one", async () => {
    const relay = fakeAccountRelay({ answer: "box" });
    const request = await requestDevice(api(relay.fetch), { mac: MAC, name: "Web" });
    const seal = (value) => sealToMember(request.boxKey ?? relay.state.requests[0].boxKey, value);
    await expect(recordFromBox(request, seal({ ...payload, cu: "https://evil.example.com/x" }))).rejects.toThrow(
      /server Squeak will not talk to/,
    );
    await expect(recordFromBox(request, seal({ ...payload, ck: "short" }))).rejects.toThrow();
    await expect(
      recordFromBox(request, seal({ v: 1, c: CHANNEL, k: SECRET, n: "Mac", p: "proj", r: "https://a.firebaseio.com" })),
    ).rejects.toThrow(/cloud relay/);
    const other = await generateDeviceKey();
    await expect(recordFromBox(request, sealToMember(other.publicKeyX963, payload))).rejects.toThrow(
      /could not be read/,
    );
  });

  it("shows the code and the Mac's name on the waiting screen", () => {
    const screen = requestScreen({ macName: "Studio", deviceName: "Web · Safari", code: "123456", cancel() {} });
    expect(text(screen)).toContain("Adding this browser to Studio");
    expect(text(screen)).toContain("If your Mac asks, check it shows");
    expect(text(screen)).toContain("123456");
  });

  it("reads the expiry in seconds or milliseconds", () => {
    expect(expiryMs(1_800_000_000)).toBe(1_800_000_000_000);
    expect(expiryMs(1_800_000_000_000)).toBe(1_800_000_000_000);
    expect(expiryMs("x")).toBeNull();
  });
});

describe("linking this Mac to the account", () => {
  const calls = [];
  const acct = (over) => ({
    state: "in",
    me: { email: "me@x.org" },
    busy: null,
    note: null,
    link: () => calls.push("link"),
    unlink: () => calls.push("unlink"),
    signIn: () => calls.push("signIn"),
    signOut: () => calls.push("signOut"),
    ...over,
  });
  const ctx = (account, view = { mac: "Studio" }) => ({ account, view, record: { macName: "Studio" } });

  it("offers the link while the Mac's view has no account, and sends on the button", () => {
    calls.length = 0;
    const nodes = accountSection(ctx(acct()));
    const flat = nodes.flat(5).filter(Boolean);
    const link = flat.find((n) => n.tag === "button");
    expect(text(link)).toBe("Link Studio to your account (me@x.org)");
    click(link);
    expect(calls).toEqual(["link"]);
    const out = flat.filter((n) => n.tag === "button").at(-1);
    expect(text(out)).toBe("Sign out");
  });

  it("shows Linked to <email> with Unlink once the view says so", () => {
    calls.length = 0;
    const view = { mac: "Studio", account: { email: "me@x.org" } };
    expect(viewAccount(view)).toEqual({ email: "me@x.org" });
    expect(viewAccount({ mac: "x" })).toBeNull();
    const flat = accountSection(ctx(acct(), view)).flat(5).filter(Boolean);
    const words = flat.map((n) => text(n)).join("|");
    expect(words).toContain("Linked to me@x.org");
    const unlink = flat.find((n) => n.tag === "button" && text(n) === "Unlink");
    click(unlink);
    expect(calls).toEqual(["unlink"]);
  });

  it("asks to sign in when signed out, and draws nothing while it does not know", () => {
    const nodes = accountSection(ctx(acct({ state: "out", me: null }))).flat(5);
    expect(text(nodes.find((n) => n.tag === "button"))).toBe("Sign in to link this Mac");
    expect(accountSection(ctx(acct({ state: "unknown" })))).toBeNull();
    expect(accountSection(ctx(acct({ state: "loading" })))).toBeNull();
  });

  it("shows nothing on a Firebase-paired app (the screen context has no account)", () => {
    expect(accountSection(ctx(null))).toBeNull();
    const screen = renderSettings({
      ...ctx(null),
      prefs: { get: () => undefined, save() {} },
      settings: { verbose: true, setVerbose() {}, confirmForget: false, setConfirmForget() {}, forget() {} },
    });
    expect(all(screen[0]).some((n) => n.attrs?.["data-section"] === "account")).toBe(false);
  });

  it("builds the two commands the Mac knows, exactly", () => {
    expect(shape("accountLink", { ticket: "al.u.1.e.m" })).toEqual({ ticket: "al.u.1.e.m" });
    expect(() => shape("accountLink", { ticket: "t", extra: 1 })).toThrow();
    expect(() => shape("accountLink", {})).toThrow();
    expect(shape("accountUnlink", {})).toEqual({});
    expect(() => shape("accountUnlink", { x: 1 })).toThrow();
  });

  it("words the link date", () => {
    expect(linkedLine(Date.UTC(2026, 10, 3, 12))).toBe("Linked 3 Nov 2026");
    expect(linkedLine(null)).toBe("Linked");
  });
});
