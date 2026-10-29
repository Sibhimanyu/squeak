import { describe, expect, it, vi } from "vitest";

import { notifyNetworkChanged, networkSignature } from "./network-change.js";
import { readEvents, RtdbRest, toDoc } from "./rtdb-rest.js";

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const BASE = "https://squeak-test-default-rtdb.asia-southeast1.firebasedatabase.app";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("RtdbRest", () => {
  it("addresses documents as <path>.json under the instance root", async () => {
    const fetchImpl = vi.fn<FetchFn>(async () => json({ box: "b", sig: "s", device: "d", at: 5 }));
    const db = new RtdbRest(`${BASE}/`, fetchImpl);
    expect(await db.get("channels/abc/state/snapshot")).toEqual({ box: "b", sig: "s", device: "d", at: 5 });
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${BASE}/channels/abc/state/snapshot.json`);
  });

  it("reads a missing document (JSON null) as null, not an error", async () => {
    const db = new RtdbRest(BASE, async () => json(null));
    expect(await db.get("channels/abc/state/presence")).toBeNull();
  });

  it("writes with PUT, only the channel fields, and asks for no echo", async () => {
    const fetchImpl = vi.fn<FetchFn>(async () => new Response(null, { status: 204 }));
    const db = new RtdbRest(BASE, fetchImpl);
    await db.set("channels/abc/commands/c1", { box: "x", sig: "y", device: "phone", at: 12.7 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${BASE}/channels/abc/commands/c1.json?print=silent`);
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(String(init?.body))).toEqual({ box: "x", sig: "y", device: "phone", at: 12 });
  });

  it("lists a collection's children and skips anything not shaped like a channel doc", async () => {
    const db = new RtdbRest(BASE, async () =>
      json({ a: { box: "1" }, b: { nope: true }, c: "text", d: { box: "2", at: 3 } }),
    );
    expect(await db.list("channels/abc/commands")).toEqual([
      { id: "a", doc: { box: "1" } },
      { id: "d", doc: { box: "2", at: 3 } },
    ]);
  });

  it("lists an empty collection as empty", async () => {
    const db = new RtdbRest(BASE, async () => json(null));
    expect(await db.list("channels/abc/pairing")).toEqual([]);
  });

  it("deletes with DELETE", async () => {
    const fetchImpl = vi.fn<FetchFn>(async () => json(null));
    await new RtdbRest(BASE, fetchImpl).delete("channels/abc/commands/c1");
    expect(fetchImpl.mock.calls[0]![1]?.method).toBe("DELETE");
  });

  it("throws on a refused write, with the status", async () => {
    const db = new RtdbRest(BASE, async () => json({ error: "Permission denied" }, 401));
    await expect(db.set("channels/abc/other/x", { box: "x" })).rejects.toThrow(/401/);
  });

  it("keeps a query on the database URL (the emulator's ?ns=) on every request", async () => {
    const fetchImpl = vi.fn<FetchFn>(async () => json(null));
    const db = new RtdbRest("http://127.0.0.1:9000?ns=demo-squeak-default-rtdb", fetchImpl);
    await db.get("channels/abc/state/snapshot");
    await db.delete("channels/abc/commands/c1");
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:9000/channels/abc/state/snapshot.json?ns=demo-squeak-default-rtdb",
      "http://127.0.0.1:9000/channels/abc/commands/c1.json?ns=demo-squeak-default-rtdb&print=silent",
    ]);
  });

  it("escapes path segments so an id cannot climb out of its collection", async () => {
    const fetchImpl = vi.fn<FetchFn>(async () => json(null));
    await new RtdbRest(BASE, fetchImpl).get("channels/abc/commands/a?b#c");
    expect(fetchImpl.mock.calls[0]![0]).toBe(`${BASE}/channels/abc/commands/a%3Fb%23c.json`);
  });

  it("watch: signals each put and patch, ignores keep-alives, and stops when told", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1;
      expect(init?.headers).toEqual({ accept: "text/event-stream" });
      if (calls > 1) {
        // Hold the reconnect open until the watch is stopped.
        return await new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      }
      return new Response(
        stream([
          'event: put\ndata: {"path":"/","data":null}\n\n',
          "event: keep-alive\ndata: null\n\n",
          'event: patch\ndata: {"path":"/c1","data":{"box":"x"}}\n\n',
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const onChange = vi.fn();
    const onOpen = vi.fn();
    const onError = vi.fn();
    vi.useFakeTimers();
    try {
      const stop = new RtdbRest(BASE, fetchImpl).watch("channels/abc/commands", onChange, { onOpen, onError });
      await vi.advanceTimersByTimeAsync(0);
      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledTimes(2);
      // The stream ended on its own: reported, then retried after a second.
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "rtdb watch: stream ended" }));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("watch: a network change drops a silent stream and reconnects at once, not after the stall timer", async () => {
    let opens = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      opens += 1;
      // Every stream opens fine and then says nothing, like one left dead by switching to a hotspot.
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const onOpen = vi.fn();
    vi.useFakeTimers();
    try {
      const stop = new RtdbRest(BASE, fetchImpl).watch("channels/abc/state", () => undefined, { onOpen });
      await vi.advanceTimersByTimeAsync(0);
      expect(opens).toBe(1);
      // Well inside the 75 s stall timer: nothing reconnects by itself.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(opens).toBe(1);
      notifyNetworkChanged();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(opens).toBe(2);
      expect(onOpen).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the network by its non-internal IPv4 addresses only", () => {
    const info = (address: string, family: "IPv4" | "IPv6", internal = false) =>
      ({ address, family, internal }) as never;
    expect(
      networkSignature({
        lo0: [info("127.0.0.1", "IPv4", true)],
        en0: [info("172.20.10.6", "IPv4"), info("fe80::1", "IPv6")],
      }),
    ).toBe("en0=172.20.10.6");
    expect(networkSignature({ en0: [info("192.168.1.5", "IPv4")] })).not.toBe(
      networkSignature({ en0: [info("172.20.10.6", "IPv4")] }),
    );
  });

  it("watch: a cancel from the server (rules changed) counts as a failure and reconnects", async () => {
    const fetchImpl = vi.fn(async () => new Response(stream(['event: cancel\ndata: "Permission denied"\n\n'])));
    const onError = vi.fn();
    vi.useFakeTimers();
    try {
      const stop = new RtdbRest(BASE, fetchImpl).watch("channels/abc/commands", () => undefined, { onError });
      await vi.advanceTimersByTimeAsync(0);
      expect(onError.mock.calls[0]![0].message).toMatch(/cancel/);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("readEvents", () => {
  it("joins events split across chunks and CRLF line ends", async () => {
    const events = [];
    for await (const event of readEvents(
      stream(["event: pu", 't\r\ndata: {"a"', ":1}\r\n\r\nevent: keep-alive\ndata: null\n\n"]),
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { name: "put", data: '{"a":1}' },
      { name: "keep-alive", data: "null" },
    ]);
  });
});

describe("toDoc", () => {
  it("accepts only a string box and typed optional fields", () => {
    expect(toDoc({ box: "b", sig: 1, device: "d", at: "5" })).toEqual({ box: "b", device: "d" });
    expect(toDoc({ box: 1 })).toBeNull();
    expect(toDoc(null)).toBeNull();
  });
});
