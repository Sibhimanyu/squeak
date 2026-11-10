import { describe, expect, it } from "vitest";

import { HttpAccountRelay } from "./account.js";

const BASE = "https://app.catalystserverless.in/server/squeak_relay";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);

const relayWith = (answer: () => Response, seen: Array<{ url: string; key: unknown }> = []) =>
  new HttpAccountRelay(BASE, "k".repeat(32), async (url, init) => {
    seen.push({ url, key: (init?.headers as Record<string, string>)["x-squeak-relay"] });
    return answer();
  });

describe("HttpAccountRelay.fetchAvatar", () => {
  it("asks with the relay key and the user id, and returns the bytes", async () => {
    const seen: Array<{ url: string; key: unknown }> = [];
    const bytes = await relayWith(() => new Response(JPEG, { status: 200 }), seen).fetchAvatar("u 1");
    expect(bytes!.equals(JPEG)).toBe(true);
    expect(seen).toEqual([{ url: `${BASE}/account/avatar?userId=u%201`, key: "k".repeat(32) }]);
  });

  it("404 is no photo; other failures and non-JPEG or oversized answers throw", async () => {
    expect(await relayWith(() => new Response("", { status: 404 })).fetchAvatar("u1")).toBeNull();
    await expect(relayWith(() => new Response("", { status: 500 })).fetchAvatar("u1")).rejects.toThrow();
    await expect(relayWith(() => new Response("<html>", { status: 200 })).fetchAvatar("u1")).rejects.toThrow();
    const big = Buffer.concat([JPEG, Buffer.alloc(70_000)]);
    await expect(relayWith(() => new Response(big, { status: 200 })).fetchAvatar("u1")).rejects.toThrow();
  });
});
