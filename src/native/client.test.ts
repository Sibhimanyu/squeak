import { describe, expect, it } from "vitest";

import { NativeHostClient, NativeHostError } from "./client.js";

function client(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  token: string | null = "tok",
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { calls, host: new NativeHostClient({ baseUrl: "http://h", token: () => token, fetch: fakeFetch }) };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("NativeHostClient", () => {
  it("lists sessions with the token header", async () => {
    const { host, calls } = client(() => json(200, { sessions: [{ id: "a" }] }));
    expect(await host.listSessions()).toEqual([{ id: "a" }]);
    expect(calls[0]!.url).toBe("http://h/native/sessions");
    expect((calls[0]!.init.headers as Record<string, string>)["x-squeak-token"]).toBe("tok");
  });

  it("sends a message, an interrupt and an answer to the right routes", async () => {
    const { host, calls } = client(() => json(200, { queued: true, ok: true }));
    expect(await host.send("s1", "hi", "queue")).toEqual({ queued: true });
    await host.interrupt("s1");
    await host.respond("r1", "deny", "no");
    expect(calls.map((c) => c.url)).toEqual([
      "http://h/native/sessions/s1/messages",
      "http://h/native/sessions/s1/interrupt",
      "http://h/native/requests/r1",
    ]);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ text: "hi", mode: "queue" });
    expect(JSON.parse(calls[2]!.init.body as string)).toEqual({ decision: "deny", message: "no" });
  });

  it("reports a closed request as an http error with its status", async () => {
    const { host } = client(() => json(409, { error: "already resolved" }));
    await expect(host.respond("r1", "allow")).rejects.toMatchObject({ kind: "http", status: 409 });
  });

  it("says the host is down when the connection fails or there is no token", async () => {
    const refused = client(() => {
      throw new TypeError("fetch failed");
    });
    await expect(refused.host.listSessions()).rejects.toMatchObject({ kind: "down" });
    const noToken = client(() => json(200, {}), null);
    await expect(noToken.host.listSessions()).rejects.toBeInstanceOf(NativeHostError);
    expect(noToken.calls).toHaveLength(0);
  });

  it("times out instead of hanging", async () => {
    const slow = new NativeHostClient({
      baseUrl: "http://h",
      token: "t",
      timeoutMs: 20,
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        })) as unknown as typeof fetch,
    });
    await expect(slow.send("s", "x")).rejects.toMatchObject({ kind: "timeout" });
  });
});
