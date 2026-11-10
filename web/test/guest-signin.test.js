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
  it("joins as the account's name, else the start of the email, capped at 100", () => {
    expect(accountName({ name: " Ada Lovelace ", email: "a@x.org" })).toBe("Ada Lovelace");
    expect(accountName({ name: "", email: "ada@x.org" })).toBe("ada");
    expect(accountName({ name: "n".repeat(300), email: "" })).toHaveLength(100);
    expect(joiningLine("Site", { name: "Ada", email: "ada@x.org" })).toBe("Joining Site as Ada (ada@x.org)");
    expect(joiningLine("Site", { name: "", email: "" })).toBe("Joining Site as ");
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
    pondId = (await owner.createPond({ name: "Site" })).id;
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
      return relay.fetch(new URL(url, ORIGIN).href, init);
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

  it("signed in: says who they join as, no name box, and sends the account name", async () => {
    const p = page({ account: { userId: "u1", email: "ada@x.org", name: "Ada Lovelace" } });
    await p.started;
    expect(text(p.root)).toContain("Joining Site as Ada Lovelace (ada@x.org)");
    expect(all(p.root).some((n) => n.tag === "input")).toBe(false);
    expect(p.buttons().map((b) => text(b).trim())).toEqual(["Join", "Not you? Sign out"]);
    p.press("Join");
    await until(() => text(p.root).includes("Waiting for"));
    const [request] = (await owner.view(pondId)).joins;
    expect(request.name).toBe("Ada Lovelace");
    expect(await p.vault.read(PENDING)).toBeNull();
    await (
      await import("../js/guest-pond.js")
    ).GuestPond.load({ vault: p.vault, fetch: relay.fetch }).then((g) => g.forget());
  });

  it("signed out: one primary button, the invite parked in IndexedDB (not the URL), and sign-in leaves", async () => {
    const p = page({ account: null });
    await p.started;
    expect(text(p.root)).toContain("Join Site");
    expect(p.buttons().map((b) => text(b).trim())).toEqual(["Continue with Zoho, Google or email", "Cancel"]);
    expect(all(p.root).some((n) => n.tag === "input")).toBe(false);
    const parked = await p.vault.read(PENDING);
    expect(parked.pondId).toBe(pondId);
    p.press("Continue with");
    expect(p.calls.signIn).toBe(1);
  });

  it("back from sign-in: the parked invite is restored with no fragment, then deleted once the request is sent", async () => {
    const vault = new KeyStore(fakeIndexedDB());
    await page({ account: null, vault }).started;
    const back = page({ account: { userId: "u2", email: "bo@x.org", name: "Bo" }, hash: "", vault });
    await back.started;
    expect(text(back.root)).toContain("Joining Site as Bo (bo@x.org)");
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
    expect(text(p.root)).toContain("Open an invite link");
    expect(await vault.read(PENDING)).toBeNull();
  });

  it("keeps the name screen when /me cannot answer", async () => {
    const p = page({ account: "network" });
    await p.started;
    expect(text(p.root)).toContain("Join Site");
    expect(all(p.root).some((n) => n.tag === "input")).toBe(true);
    expect(await p.vault.read(PENDING)).toBeNull();
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
    await until(() => text(p.root).includes("Continue with Zoho, Google or email"));
    expect(text(p.root)).toContain("You need to sign in to join");
    expect((await p.vault.read(PENDING)).pondId).toBe(pondId);
  });
});
