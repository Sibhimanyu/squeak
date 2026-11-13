import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import { KeyStore } from "../js/key-store.js";
import { GuestPond } from "../js/guest-pond.js";
import { normalizeShortCode, readShortDetails } from "../js/guest-invite.js";
import { redeemShortCode } from "../js/guest-relay.js";
import { joinWords as nodeJoinWords } from "../../src/flotilla/join-words.js";
import { JOIN_WORDS, joinWords } from "../js/join-words.js";
import { account, cleanup, fakeRelay, mac, RELAY_URL } from "./guest-helpers.js";
import { fakeIndexedDB } from "./helpers.js";

afterAll(cleanup);

const ORIGIN = "https://squeak.catalystserverless.in";
const fixture = JSON.parse(
  fs.readFileSync(
    new URL("../../macos/Tests/SqueakMacCoreTests/Fixtures/ponds/join-words.json", import.meta.url),
    "utf8",
  ),
);

function browser(relay, who = "Webby") {
  const fetch = async (url, init = {}) => relay.as(account(who)).fetch(new URL(url, ORIGIN).href, init);
  return { vault: new KeyStore(fakeIndexedDB()), fetch };
}

describe("a web guest joins by short code", () => {
  it("shares the word list and code reading with the Mac, byte for byte", async () => {
    expect(JOIN_WORDS).toEqual(fixture.wordlist);
    for (const v of fixture.vectors) expect(await joinWords(v.ownerKey, v.joinerKey, v.pondId)).toEqual(v.words);
    for (const c of fixture.codes) expect(normalizeShortCode(c.input), c.input).toBe(c.normal);
    expect(await joinWords("a", "b", "c")).toEqual(nodeJoinWords("a", "b", "c"));
  });

  it("trades the code for details with no pond key, joins sealed to the owner, and gets the key only on approval", async () => {
    const relay = fakeRelay();
    const owner = mac(relay, "Sibhi", { owner: true });
    const pond = await owner.createPond({ name: "Site", projectId: "proj-site" });
    const made = await owner.invite(pond.id, "member", undefined, { short: true });
    expect(made.short).toMatch(/^[2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3}$/);

    const b = browser(relay);
    const got = await redeemShortCode({
      baseUrl: RELAY_URL,
      code: made.short.toLowerCase().replace("-", " "),
      fetch: b.fetch,
    });
    expect(got.ok).toBe(true);
    expect(Object.keys(got.details)).not.toContain("k");
    // used once
    expect((await redeemShortCode({ baseUrl: RELAY_URL, code: made.short, fetch: b.fetch })).status).toBe(404);

    const parsed = readShortDetails(got.details, Date.now(), ORIGIN);
    expect(parsed.ok).toBe(true);
    expect(parsed.invite.key).toBeNull();
    const guest = await GuestPond.join(parsed.invite, b);
    expect(guest.record.keys).toEqual({});
    expect(guest.record.current).toBe(0);
    expect(await guest.refresh()).toBe("pending");
    expect(Object.keys(guest.record.keys)).toEqual([]);

    // the owner can open the request (sealed to their key) and sees the same three words
    const [request] = (await owner.view(pond.id)).joins;
    expect(request).toMatchObject({ name: "Webby", client: "web", role: "member" });
    expect(request.words).toEqual(guest.record.words);

    await owner.decideJoin(pond.id, request.requestId, { approve: true });
    expect(await guest.refresh()).toBe("active");
    expect(Object.keys(guest.record.keys)).toEqual(["1"]);
    const view = await guest.view();
    expect(view.pond.name).toBe("Site");
    expect(view.members.map((m) => m.name).sort()).toEqual(["Sibhi", "Webby"]);
  });

  it("a signed-out browser cannot redeem, and wrong tries lock the account", async () => {
    const relay = fakeRelay();
    const out = await redeemShortCode({ baseUrl: RELAY_URL, code: "K7P-4QD", fetch: (u, i) => relay.fetch(u, i) });
    expect(out.status).toBe(401);
    const b = browser(relay);
    const results = [];
    for (let i = 0; i < 6; i++) {
      const code = `K7P-4Q${"ABCDEF"[i]}`;
      results.push((await redeemShortCode({ baseUrl: RELAY_URL, code, fetch: b.fetch })).status);
    }
    expect(results).toEqual([404, 404, 404, 404, 404, 429]);
  });
});
