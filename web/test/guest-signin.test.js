import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { accountName, joiningLine, parkedInviteUsable } from "../js/guest-model.js";
import { joinRefusal } from "../js/guest-pond.js";
import { fetchMe } from "../js/guest-relay.js";
import { PENDING, startGuest } from "../js/guest.js";
import { KeyStore } from "../js/key-store.js";
import { all, click, installDom, text } from "./fake-dom.js";
import { cleanup, fakeRelay, mac } from "./guest-helpers.js";
import { fakeIndexedDB } from "./helpers.js";

afterAll(cleanup);

const json = (status, body) => new Response(JSON.stringify(body), { status });

describe("sign-in sentences and /me", () => {
  it("joins as the account's name, else its email, capped at 100", () => {
    expect(accountName({ name: " Ada Lovelace ", email: "a@x.org" })).toBe("Ada Lovelace");
    expect(accountName({ name: "", email: "ada@x.org" })).toBe("ada@x.org");
    expect(accountName({ name: "n".repeat(300), email: "" })).toHaveLength(100);
    expect(joiningLine({ name: "Ada", email: "ada@x.org" })).toBe("You'll join as Ada (ada@x.org)");
    expect(joiningLine({ name: "", email: "ada@x.org" })).toBe("You'll join as ada@x.org");
  });

  it("says plainly what a refused join means", () => {
    expect(joinRefusal("email")).toBe("This invite is for a different email. Sign in with the email it was sent to.");
    expect(joinRefusal("signin")).toContain("sign in");
  });

  it("accepts a parked invite only if it is whole and unexpired", () => {
    const ok = { pondId: "p", secret: "s", relayUrl: "/server/x", joinToken: "t", expiresAt: 100 };
    expect(parkedInviteUsable(ok, 50)).toBe(true);
    expect(parkedInviteUsable(ok, 150)).toBe(false);
    expect(parkedInviteUsable({ ...ok, secret: undefined }, 50)).toBe(false);
    expect(parkedInviteUsable(null)).toBe(false);
  });

  it("reads /me with the session cookie: in, out, or unknown", async () => {
    let seen;
    const me = (fetch) => fetchMe({ baseUrl: "/server/squeak_relay/", fetch });
    const inFetch = async (url, init) => (
      (seen = [url, init.credentials]),
      json(200, { userId: "u", email: "e@x", name: "E" })
    );
    expect(await me(inFetch)).toEqual({ state: "in", user: { userId: "u", email: "e@x", name: "E" } });
    expect(seen).toEqual(["/server/squeak_relay/me", "include"]);
    expect(await me(async () => json(401, { error: "signin" }))).toEqual({ state: "out" });
    expect(await me(async () => new Response("", { status: 401 }))).toEqual({ state: "out" });
    expect(await me(async () => json(401, { error: "unauthorized" }))).toEqual({ state: "unknown" });
    expect(await me(async () => json(404, {}))).toEqual({ state: "unknown" });
    expect(await me(async () => json(200, { nope: 1 }))).toEqual({ state: "unknown" });
    expect(
      await me(async () => {
        throw new TypeError("network");
      }),
    ).toEqual({ state: "unknown" });
  });
});

describe("the guest page with accounts", () => {
  const ORIGIN = "https://squeak.catalystserverless.in";
  const relay = fakeRelay();
  const owner = mac(relay, "Sibhi", { owner: true });
  let pondId;
  let code;
  const until = async (check) => {
    for (let i = 0; i < 400; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("timed out");
  };

  beforeAll(async () => {
    installDom();
    pondId = (await owner.createPond({ name: "Site", projectId: "proj-site" })).id;
    const link = (await owner.invite(pondId, "member")).link;
    code = link.slice(link.indexOf("#"));
  });

  /** `account`: a /me answer; `puts`: statuses for the join PUT in turn (200 passes through to the relay). */
  const page = ({ account, hash = code, vault = new KeyStore(fakeIndexedDB()), putStatus = [] } = {}) => {
    const root = document.createElement("div");
    const calls = { signIn: 0, signOut: 0, requests: [] };
    const win = {
      location: { hash, origin: ORIGIN, pathname: "/app/index.html", search: "" },
      history: { state: null, replaceState: () => undefined, pushState: () => undefined },
      addEventListener: () => undefined,
      document: { visibilityState: "visible", addEventListener: () => undefined },
    };
    const fetch = async (url, init = {}) => {
      calls.requests.push([url, init.method ?? "GET"]);
      if (url.endsWith("/me")) {
        if (account === "network") throw new TypeError("network");
        return account ? json(200, account) : json(401, { error: "signin" });
      }
      const fail = init.method === "PUT" && url.includes("joins") ? putStatus.shift() : undefined;
      if (fail) return json(fail.status, { error: fail.error });
      // The relay sees the browser's session cookie as the signed-in account (none: an anonymous request).
      const session = account && account !== "network" ? { userId: account.userId, ...account } : null;
      return relay.as(session).fetch(new URL(url, ORIGIN).href, init);
    };
    const started = startGuest({
      root,
      win,
      vault,
      fetch,
      signIn: () => void calls.signIn++,
      signOut: async () => void calls.signOut++,
      socket: () => ({ send() {}, close() {} }),
      minGapMs: 0,
    });
    const buttons = () => all(root).filter((n) => n.tag === "button");
    const press = (label) => click(buttons().find((b) => text(b).includes(label)));
    return { root, calls, started, vault, press, buttons };
  };

  it("signed in: says who they join as, no name box, and the owner's Mac names them from the account", async () => {
    const p = page({ account: { userId: "u1", email: "ada@x.org", name: "Ada Lovelace" } });
    await p.started;
    expect(text(p.root)).toContain("You'll join as Ada Lovelace (ada@x.org)");
    expect(all(p.root).some((n) => n.tag === "input")).toBe(false);
    expect(p.buttons().map((b) => text(b).trim())).toEqual(["Join", "Not you? Sign out"]);
    p.press("Join");
    await until(() => text(p.root).includes("Waiting for"));
    const [request] = (await owner.view(pondId)).joins;
    expect(request.name).toBe("Ada Lovelace");
    // The relay, not the browser, said who this is: the owner's approval writes the member from that account.
    await owner.decideJoin(pondId, request.requestId, { approve: true });
    const member = (await owner.view(pondId)).members.find((m) => m.name === "Ada Lovelace");
    expect(member).toBeTruthy();
    expect(await p.vault.read(PENDING)).toBeNull();
    await (
      await import("../js/guest-pond.js")
    ).GuestPond.load({ vault: p.vault, fetch: relay.fetch }).then((g) => g.forget());
  });

  it("signed out: one primary button, the invite parked in IndexedDB (not the URL), and sign-in leaves", async () => {
    const p = page({ account: null });
    await p.started;
    expect(text(p.root)).toContain("Join Site");
    expect(p.buttons().map((b) => text(b).trim())).toEqual(["Sign in to join", "Cancel"]);
    expect(all(p.root).some((n) => n.tag === "input")).toBe(false);
    const parked = await p.vault.read(PENDING);
    expect(parked.pondId).toBe(pondId);
    p.press("Sign in to join");
    expect(p.calls.signIn).toBe(1);
  });

  it("back from sign-in: the parked invite is restored with no fragment, then deleted once the request is sent", async () => {
    const vault = new KeyStore(fakeIndexedDB());
    await page({ account: null, vault }).started;
    const back = page({ account: { userId: "u2", email: "bo@x.org", name: "Bo" }, hash: "", vault });
    await back.started;
    expect(text(back.root)).toContain("You'll join as Bo (bo@x.org)");
    back.press("Join");
    await until(() => text(back.root).includes("Waiting for"));
    expect(await vault.read(PENDING)).toBeNull();
  });

  it("Not you? Sign out parks the invite and signs out", async () => {
    const p = page({ account: { userId: "u3", email: "c@x.org", name: "Cy" } });
    await p.started;
    p.press("Not you?");
    await until(() => p.calls.signOut === 1);
    expect((await p.vault.read(PENDING)).pondId).toBe(pondId);
  });

  it("cancel deletes the parked invite", async () => {
    const p = page({ account: null });
    await p.started;
    p.press("Cancel");
    await until(() => text(p.root).includes("Invite set aside"));
    expect(await p.vault.read(PENDING)).toBeNull();
  });

  it("an expired parked invite is dropped, not used", async () => {
    const vault = new KeyStore(fakeIndexedDB());
    await vault.write(PENDING, { pondId: "p", secret: "s", relayUrl: "/r", joinToken: "t", expiresAt: 1 });
    const p = page({ account: null, hash: "", vault });
    await p.started;
    expect(text(p.root)).toContain("Join a pond");
    expect(await vault.read(PENDING)).toBeNull();
  });

  it("when /me cannot answer there is still no name box: it asks to sign in, with a sentence", async () => {
    const p = page({ account: "network" });
    await p.started;
    expect(text(p.root)).toContain("Join Site");
    expect(text(p.root)).toContain("I couldn't check your sign-in");
    expect(all(p.root).some((n) => n.tag === "input")).toBe(false);
    expect(p.buttons().map((b) => text(b).trim())).toEqual(["Sign in to join", "Cancel"]);
  });

  it("403 email: says the invite is for another email and keeps the invite for another account", async () => {
    const p = page({
      account: { userId: "u4", email: "d@x.org", name: "Di" },
      putStatus: [{ status: 403, error: "email" }],
    });
    await p.started;
    p.press("Join");
    await until(() => text(p.root).includes("This invite is for a different email"));
    expect(text(p.root)).toContain("Not you? Sign out");
    expect(await p.vault.read("guest")).toBeNull();
  });

  it("401 signin from the join: back to the sign-in screen with a plain sentence, invite parked", async () => {
    const p = page({
      account: { userId: "u5", email: "e@x.org", name: "Ed" },
      putStatus: [{ status: 401, error: "signin" }],
    });
    await p.started;
    p.press("Join");
    await until(() => text(p.root).includes("Sign in to join"));
    expect(text(p.root)).toContain("You need to sign in to join");
    expect((await p.vault.read(PENDING)).pondId).toBe(pondId);
  });
});

describe("an emailed invite (docs/ponds.md, 'Invite by email')", () => {
  const ORIGIN = "https://squeak.onslate.in";
  const relay = fakeRelay();
  let pondId;
  let hash;
  const until = async (check) => {
    for (let i = 0; i < 400; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("timed out");
  };
  const owner = mac(relay, "Sibhi", { owner: true });
  beforeAll(async () => {
    installDom();
    pondId = (await owner.createPond({ name: "Site", projectId: "proj-site" })).id;
    // As the daemon makes it: keyless, bound to one address, named in the code.
    const made = await owner.invite(pondId, "member", "bea@example.com", { keyless: true });
    hash = made.link.slice(made.link.indexOf("#"));
  });
  const page = ({ account, vault = new KeyStore(fakeIndexedDB()) } = {}) => {
    const root = document.createElement("div");
    const calls = { signOut: 0, signIn: 0 };
    const win = {
      location: { hash, origin: ORIGIN, pathname: "/join", search: "" },
      history: { state: null, replaceState: () => undefined, pushState: () => undefined },
      addEventListener: () => undefined,
      document: { visibilityState: "visible", addEventListener: () => undefined },
    };
    const fetch = async (url, init = {}) => {
      if (url.endsWith("/me")) return account ? json(200, account) : json(401, { error: "signin" });
      const session = account ? { userId: account.userId, ...account } : null;
      return relay.as(session).fetch(new URL(url, ORIGIN).href, init);
    };
    const started = startGuest({
      root,
      win,
      vault,
      fetch,
      signIn: () => void calls.signIn++,
      signOut: async () => void calls.signOut++,
      socket: () => ({ send() {}, close() {} }),
      minGapMs: 0,
    });
    const buttons = () => all(root).filter((n) => n.tag === "button");
    return { root, calls, started, buttons, press: (l) => click(buttons().find((b) => text(b).includes(l))) };
  };

  it("signed out: the pond, who invited you, what Squeak is, and one button", async () => {
    const p = page({ account: null });
    await p.started;
    expect(text(p.root)).toContain("Join Site");
    expect(text(p.root)).toContain("Sibhi invited you");
    expect(text(p.root)).toContain("Squeak lets a team watch, steer and talk to coding agents together.");
    expect(text(p.root)).toContain("Sign in with b***@e***.com");
    expect(p.buttons().map((b) => text(b).trim())).toEqual(["Sign in to join", "Cancel"]);
  });

  it("another account: says whose invite it is, masked, and offers to switch; never Join", async () => {
    const p = page({ account: { userId: "u-eve", email: "eve@example.com", name: "Eve" } });
    await p.started;
    expect(text(p.root)).toContain("This invite is for b***@e***.com. Sign in with that address.");
    expect(p.buttons().map((b) => text(b).trim())).toEqual(["Sign out and switch account"]);
    p.press("Sign out");
    await until(() => p.calls.signOut === 1);
  });

  it("the relay's own refusal (403 email, masked address) shows the same sentence when the link did not say", async () => {
    // an invite bound to an address at the relay whose code does not name it (an older Mac)
    const bound = await owner.invite(pondId, "member", "bea@example.com");
    const keep = hash;
    hash = bound.link.slice(bound.link.indexOf("#"));
    try {
      const p = page({ account: { userId: "u-eve", email: "eve@example.com", name: "Eve" } });
      await p.started;
      expect(p.buttons().map((b) => text(b).trim())).toEqual(["Join", "Not you? Sign out"]);
      p.press("Join");
      await until(() => text(p.root).includes("This invite is for b***@e***.com. Sign in with that address."));
      expect(p.buttons().map((b) => text(b).trim())).toEqual(["Sign out and switch account"]);
    } finally {
      hash = keep;
    }
  });

  it("the matching account (any case) is asked to join and the request reaches the owner, verified", async () => {
    const p = page({ account: { userId: "u-bea", email: "Bea@Example.com", name: "Bea Lee" } });
    await p.started;
    expect(p.buttons().map((b) => text(b).trim())).toEqual(["Join", "Not you? Sign out"]);
    p.press("Join");
    await until(() => text(p.root).includes("Waiting for"));
    const request = (await owner.view(pondId)).joins.find((j) => j.verifiedEmail === "Bea@Example.com");
    expect(request).toBeTruthy();
  });
});

describe("emailed-invite plumbing", () => {
  it("masks an address the way the relay does, and takes initials", async () => {
    const { maskEmail, initialsOf } = await import("../js/guest-model.js");
    expect(maskEmail(" Pat.Lee@Example.com ")).toBe("p***@e***.com");
    expect(maskEmail("nope")).toBe("***");
    expect(initialsOf("Sibhi R")).toBe("SR");
    expect(initialsOf("  ")).toBe("?");
  });

  it("the sign-in handoff returns to /join from the invite page and to / elsewhere", async () => {
    const cs = await import("../js/catalyst-session.js");
    const back = (path) => decodeURIComponent(cs.handoffUrl(path).split("return=")[1]);
    expect(back("/join")).toBe("https://squeak.onslate.in/join");
    expect(back("/")).toBe("https://squeak.onslate.in/");
    expect(back("/anything-else")).toBe("https://squeak.onslate.in/");
  });

  it("back from the handoff on /join opens the guest page, not the owner app", async () => {
    globalThis.__squeakNoEntry = true;
    document.getElementById ??= () => null;
    const { chooseEntry } = await import("../js/entry.js");
    const token = `#squeak-token=at.u1.${Date.now() + 1e7}.${"a".repeat(20)}.${"b".repeat(43)}&exp=${Date.now() + 1e7}`;
    const vault = { load: async () => false, read: async () => null };
    expect(await chooseEntry({ hash: token, pathname: "/join", vault })).toBe("guest");
    expect(await chooseEntry({ hash: token, pathname: "/", vault })).toBe("owner");
  });

  it("an emailed invite code names its address; a keyless code is accepted without a pond key", async () => {
    const { readInvite } = await import("../js/guest-invite.js");
    const body = {
      v: 1,
      p: "P".repeat(30),
      k: "",
      kv: 0,
      o: "owner",
      n: "Site",
      s: "secret",
      e: Date.now() + 1e6,
      r: "member",
      on: "Sibhi",
      em: "Bea@Example.com",
      l: { provider: "catalyst", relayUrl: "https://squeak.catalystserverless.in/server/squeak_relay" },
      jt: "pj.x",
    };
    const code = Buffer.from(JSON.stringify(body)).toString("base64url");
    const r = readInvite(code);
    expect(r.ok).toBe(true);
    expect(r.invite).toMatchObject({ key: null, email: "bea@example.com", ownerName: "Sibhi" });
  });

  it("the Mac card names the pond, links the download page, and can be dismissed", async () => {
    installDom();
    const { macCard, MAC_DOWNLOAD_URL } = await import("../js/guest-view.js");
    let dismissed = 0;
    const node = macCard({ pondName: "Site", onDismiss: () => dismissed++ });
    expect(text(node)).toContain("Run your own agents in Site: get Squeak for Mac");
    const link = all(node).find((n) => n.tag === "a");
    expect(link.attrs?.href ?? link.href).toBe(MAC_DOWNLOAD_URL);
    click(all(node).find((n) => n.tag === "button"));
    expect(dismissed).toBe(1);
  });
});
