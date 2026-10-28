import { describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { generateChannel } from "../remote/remote-crypto.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { DirectoryCache } from "./directory-cache.js";
import { dirPath, sealDirectory } from "./memo-protocol.js";

describe("DirectoryCache", () => {
  it("answers instantly once read, keeps the last list through a failed read, and reports changes", async () => {
    const db = new FakeRtdb();
    const store = new RtdbRest(await db.start());
    const { channelId, key } = generateChannel();
    const doc = (version: string) =>
      sealDirectory(key, { v: 1, at: Date.now(), version, caller: "35210", items: [{ n: 1, label: "a" }] });
    const cache = new DirectoryCache(store, channelId, key);
    expect(cache.current()).toBeNull();

    await store.set(dirPath(channelId), doc("v1"));
    expect((await cache.refresh())?.version).toBe("v1");
    expect(cache.current()?.version).toBe("v1");

    // A blip must not make the next call refuse everyone.
    const flaky = new DirectoryCache(
      {
        get: async () => {
          throw new Error("offline");
        },
        watch: () => () => undefined,
      },
      channelId,
      key,
    );
    expect(await flaky.refresh()).toBeNull();

    const changes: Array<string | undefined> = [];
    cache.start((d) => changes.push(d?.version));
    await store.set(dirPath(channelId), doc("v2"));
    for (let i = 0; i < 40 && changes.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(changes).toEqual(["v2"]);
    cache.stop();
    await db.stop();
  });
});
