import { describe, expect, it } from "vitest";
import { LATEST_CONFIG_URL, type FetchLike } from "./addon-update.js";
import { AddonVersionCheck } from "./addon-version-check.js";

const config = (v: string) => `name: Squeak Voice\nversion: "${v}"\n`;

function setup(answers: Array<string | Error | { status: number }>) {
  const urls: string[] = [];
  let i = 0;
  const fetchFn: FetchLike = async (url) => {
    urls.push(url);
    const a = answers[Math.min(i++, answers.length - 1)]!;
    if (a instanceof Error) throw a;
    if (typeof a === "object") return { ok: false, status: a.status, text: async () => "" };
    return { ok: true, status: 200, text: async () => a };
  };
  let t = 1_000_000;
  const check = new AddonVersionCheck({ fetch: fetchFn, now: () => t });
  return { check, urls, advance: (ms: number) => (t += ms) };
}

describe("AddonVersionCheck", () => {
  it("reads the version from the fixed address and records when", async () => {
    const { check, urls } = setup([config("0.10.1")]);
    expect(await check.latest()).toBe("0.10.1");
    expect(urls).toEqual([LATEST_CONFIG_URL]);
    expect(check.checkedAt()).toBe(1_000_000);
    expect(check.lastOk()).toBe(true);
  });

  it("keeps the last good answer on failure or garbage", async () => {
    const { check, advance } = setup([config("0.10.1"), new Error("offline"), { status: 500 }, config("latest")]);
    await check.latest();
    for (let n = 0; n < 3; n += 1) {
      advance(61_000);
      expect(await check.latest()).toBe("0.10.1");
      expect(check.lastOk()).toBe(false);
    }
    expect(check.checkedAt()).toBe(1_000_000);
  });

  it("never reports a version before a good fetch", async () => {
    const { check } = setup([config("1.2")]);
    expect(await check.latest()).toBeNull();
    expect(check.checkedAt()).toBeUndefined();
  });

  it("waits 60 s between fetches unless forced, and picks up a newer one", async () => {
    const { check, urls, advance } = setup([config("0.10.1"), config("0.10.2"), config("0.10.3")]);
    await check.latest();
    advance(10_000);
    expect(await check.latest()).toBe("0.10.1");
    expect(urls).toHaveLength(1);
    expect(await check.latest(true)).toBe("0.10.2");
    expect(urls).toHaveLength(2);
    advance(61_000);
    expect(await check.latest()).toBe("0.10.3");
  });
});
