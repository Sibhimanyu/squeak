import { afterAll, describe, expect, it } from "vitest";

import { accountName, joiningLine, parkedInviteUsable } from "../js/guest-model.js";
import { joinRefusal } from "../js/guest-pond.js";
import { fetchMe } from "../js/guest-relay.js";
import { all, click, installDom, text } from "./fake-dom.js";
import { cleanup } from "./guest-helpers.js";

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
    expect(text(node)).toContain("Start ducks in Site: get Squeak for Mac");
    const link = all(node).find((n) => n.tag === "a");
    expect(link.attrs?.href ?? link.href).toBe(MAC_DOWNLOAD_URL);
    click(all(node).find((n) => n.tag === "button"));
    expect(dismissed).toBe(1);
  });
});
