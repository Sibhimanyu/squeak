import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fn = new URL("../functions/squeak_relay/", import.meta.url).pathname;
const { createChannelsCache } = require(`${fn}channels-cache.js`);

describe("channels cache", () => {
  it("lists channels once for many lookups and re-asks only after the ttl", async () => {
    let t = 0;
    let calls = 0;
    const cache = createChannelsCache({
      list: async () => (calls++, [{ channel_name: "squeak_notice", channel_id: 7 }]),
      now: () => t,
    });
    for (let i = 0; i < 50; i++) expect(await cache.idOf("squeak_notice")).toBe("7");
    expect(calls).toBe(1);
    t = 5 * 60_000;
    await cache.idOf("squeak_notice");
    expect(calls).toBe(2);
  });

  it("a miss refreshes at most once per retry window", async () => {
    let t = 0;
    let calls = 0;
    let channels: Array<{ name: string; id: string }> = [];
    const cache = createChannelsCache({ list: async () => (calls++, channels), now: () => t });
    expect(await cache.idOf("pond_x")).toBeNull();
    for (let i = 0; i < 20; i++) expect(await cache.idOf("pond_x")).toBeNull();
    expect(calls).toBe(1);
    channels = [{ name: "pond_x", id: "9" }];
    t = 31_000;
    expect(await cache.idOf("pond_x")).toBe("9");
    expect(calls).toBe(2);
  });

  it("concurrent lookups share one refresh", async () => {
    let calls = 0;
    const cache = createChannelsCache({ list: async () => (calls++, [{ name: "a", id: "1" }]) });
    await Promise.all([cache.idOf("a"), cache.idOf("a"), cache.idOf("b")]);
    expect(calls).toBe(1);
  });
});
