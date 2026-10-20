import { describe, expect, it, vi } from "vitest";

import {
  fetchClaudeUsage,
  parseRetryAfter,
  parseUsage,
  USAGE_MAX_BYTES,
  USAGE_URL,
  type ClaudeUsageOutcome,
} from "./claude-usage-api.js";

const SECRET = "sk-ant-oat01-SECRET-TOKEN";
const NOW = Date.parse("2026-10-19T09:00:00.000Z");
const OK_BODY = {
  five_hour: { utilization: 37.5, resets_at: "2026-10-19T12:00:00.000Z" },
  seven_day: { utilization: 5, resets_at: "2026-10-24T12:00:00+00:00" },
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, ...init });
}

function run(fetchImpl: (...args: Parameters<typeof fetch>) => Promise<Response>, timeoutMs = 10_000) {
  const spy = vi.fn(fetchImpl);
  const promise = fetchClaudeUsage({
    resolveCredentials: async () => ({ ok: true, accessToken: SECRET }),
    fetch: spy as unknown as typeof fetch,
    timeoutMs,
    now: () => NOW,
  });
  return { spy, promise };
}

function expectFailure(r: ClaudeUsageOutcome): asserts r is Extract<ClaudeUsageOutcome, { ok: false }> {
  expect(r.ok).toBe(false);
  expect(JSON.stringify(r)).not.toContain(SECRET);
}

describe("fetchClaudeUsage", () => {
  it("sends the authenticated GET without following redirects and maps 0–100 to 0–1", async () => {
    const { spy, promise } = run(async () => json(OK_BODY));
    expect(await promise).toEqual({
      ok: true,
      fiveHour: { utilization: 0.375, resetsAt: "2026-10-19T12:00:00.000Z" },
      sevenDay: { utilization: 0.05, resetsAt: "2026-10-24T12:00:00.000Z" },
    });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(USAGE_URL);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({
      Authorization: `Bearer ${SECRET}`,
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
    });
    expect(init.body).toBeUndefined();
  });

  it("fails on a credential problem without making a request", async () => {
    const spy = vi.fn();
    const r = await fetchClaudeUsage({
      resolveCredentials: async () => ({ ok: false, error: "Claude Code is not signed in on this Mac." }),
      fetch: spy as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: false, error: "Claude Code is not signed in on this Mac." });
    expect(spy).not.toHaveBeenCalled();
  });

  it("survives a resolver that throws", async () => {
    const r = await fetchClaudeUsage({
      resolveCredentials: async () => {
        throw new Error(SECRET);
      },
    });
    expectFailure(r);
  });

  it.each([401, 403])("explains %i without quoting the body", async (status) => {
    const { promise } = run(async () => json(`{"error":"${SECRET}"}`, { status }));
    const r = await promise;
    expectFailure(r);
    expect(r.retryAfterMs).toBeUndefined();
  });

  it("reads Retry-After seconds on a 429, longer than a minute", async () => {
    const { promise } = run(async () => json("{}", { status: 429, headers: { "retry-after": "300" } }));
    const r = await promise;
    expectFailure(r);
    expect(r.retryAfterMs).toBe(300_000);
  });

  it("reads an HTTP-date Retry-After and treats a missing one as zero (the refresher floors it)", async () => {
    const date = new Date(NOW + 120_000).toUTCString();
    const dated = await run(async () => json("{}", { status: 429, headers: { "retry-after": date } })).promise;
    expectFailure(dated);
    expect(dated.retryAfterMs).toBe(120_000);
    const bare = await run(async () => json("{}", { status: 429 })).promise;
    expectFailure(bare);
    expect(bare.retryAfterMs).toBe(0);
  });

  it("does not report other statuses as success", async () => {
    const r = await run(async () => json("oops " + SECRET, { status: 500 })).promise;
    expectFailure(r);
    expect(r.error).toMatch(/HTTP 500/);
  });

  it.each([401, 403, 429, 500])("cancels the unread body of a %i", async (status) => {
    const cancel = vi.fn();
    const body = new ReadableStream({ pull: () => undefined, cancel });
    const { promise } = run(async () => new Response(body, { status }));
    expectFailure(await promise);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("fails a redirect, which fetch raises for redirect: error, without leaking", async () => {
    const r = await run(async () => {
      throw new TypeError(`fetch failed: redirect to https://evil.example/?t=${SECRET}`);
    }).promise;
    expectFailure(r);
    expect(r.error).toMatch(/could not reach/);
  });

  it("aborts at the timeout", async () => {
    const { promise } = run(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      20,
    );
    const r = await promise;
    expectFailure(r);
    expect(r.error).toMatch(/in time/);
  });

  it("refuses a response larger than the bound, declared or streamed", async () => {
    const big = "x".repeat(USAGE_MAX_BYTES + 1);
    const declared = await run(async () => json(big, { headers: { "content-length": String(big.length) } })).promise;
    expectFailure(declared);
    const streamed = await run(async () => {
      const res = json(big);
      res.headers.delete("content-length");
      return res;
    }).promise;
    expectFailure(streamed);
  });

  it("fails on a body that is not usage JSON", async () => {
    for (const body of ["<html>", "null", "[]", "{}", "42"]) {
      expectFailure(await run(async () => json(body)).promise);
    }
  });
});

describe("parseUsage", () => {
  it("keeps a null or absent window null instead of inventing zero", () => {
    expect(parseUsage(JSON.stringify({ five_hour: OK_BODY.five_hour, seven_day: null }))).toMatchObject({
      ok: true,
      sevenDay: null,
    });
    expect(parseUsage(JSON.stringify({ seven_day: OK_BODY.seven_day }))).toMatchObject({ ok: true, fiveHour: null });
  });

  it("fails when no window is reported at all", () => {
    expect(parseUsage(JSON.stringify({ five_hour: null, seven_day: null }))).toMatchObject({ ok: false });
  });

  it("clamps above 100% but rejects invalid numbers and dates", () => {
    const at = "2026-10-19T12:00:00Z";
    expect(parseUsage(JSON.stringify({ five_hour: { utilization: 130, resets_at: at } }))).toMatchObject({
      ok: true,
      fiveHour: { utilization: 1 },
    });
    for (const bad of [
      { utilization: "37", resets_at: at },
      { utilization: -1, resets_at: at },
      { utilization: 10, resets_at: "not a date" },
      { utilization: 10, resets_at: 1790689800 },
      { utilization: null, resets_at: "not a date" },
      "string",
      [],
    ]) {
      expect(parseUsage(JSON.stringify({ five_hour: bad, seven_day: OK_BODY.seven_day }))).toMatchObject({
        ok: false,
      });
    }
    expect(parseUsage('{"five_hour":{"utilization":1e999,"resets_at":"' + at + '"}}')).toMatchObject({ ok: false });
  });
});

describe("parseUsage with an unavailable window", () => {
  const five = OK_BODY.five_hour;
  const expected = { ok: true, fiveHour: { utilization: 0.375, resetsAt: "2026-10-19T12:00:00.000Z" }, sevenDay: null };

  it("keeps a good five_hour when seven_day is idle with a null reset time", () => {
    expect(parseUsage(JSON.stringify({ five_hour: five, seven_day: { utilization: 0, resets_at: null } }))).toEqual(
      expected,
    );
  });

  it("treats an absent reset time, or a null or absent utilization, as not reported", () => {
    for (const seven of [
      { utilization: 3 },
      { resets_at: null },
      { utilization: null, resets_at: five.resets_at },
      {},
    ]) {
      expect(parseUsage(JSON.stringify({ five_hour: five, seven_day: seven }))).toEqual(expected);
    }
  });

  it("reports no fresh reading when every window is unavailable", () => {
    const r = parseUsage(
      JSON.stringify({ five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: null } }),
    );
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).toMatch(/no fresh reading/);
  });

  it("still fails a supplied date that cannot be parsed, even beside a good window", () => {
    expect(
      parseUsage(JSON.stringify({ five_hour: five, seven_day: { utilization: 0, resets_at: "soon" } })),
    ).toMatchObject({ ok: false });
  });
});

describe("parseRetryAfter", () => {
  it("ignores garbage and caps absurd values", () => {
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
    expect(parseRetryAfter("soon", NOW)).toBeUndefined();
    expect(parseRetryAfter("99999999999", NOW)).toBe(24 * 60 * 60 * 1000);
  });
});
