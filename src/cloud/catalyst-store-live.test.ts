// The daemon's store starts one LiveClient (issue #130): a notice reads the change feed and wakes the watchers of that Pond,
// its state is the Mac's one connection state, and without squeak-live the old notice path is unchanged.
import { afterEach, describe, expect, it } from "vitest";

import { CatalystStore, type StreamSocket } from "./catalyst-store.js";
import { liveServiceUrl } from "./config.js";

const POND = "p".repeat(22);
const enc = new TextEncoder();

/** A scripted `squeak-live` and relay in one fetch: the SSE stream is a controller the test writes events to. */
function world() {
  const calls: string[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  let liveUp = true;
  let seq = 0;
  const fetchLike = async (url: string): Promise<Response> => {
    const u = new URL(url);
    calls.push(`${u.pathname}${u.search}`);
    if (u.pathname.endsWith("/live")) {
      if (!liveUp) return new Response(null, { status: 503 });
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          stream = c;
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (u.pathname.endsWith("/changes")) {
      const since = u.searchParams.get("since");
      if (since === "head") return Response.json({ changes: [], next: seq, more: false });
      const fresh = Number(since) < seq ? [{ seq, kind: "room", id: "r1", doc: { box: "x" } }] : [];
      return Response.json({ changes: fresh, next: seq, more: false });
    }
    return new Response(null, { status: 404 });
  };
  return {
    calls,
    fetchLike,
    say: (event: string, data: unknown) =>
      stream?.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
    drop: () => stream?.close(),
    setUp: (up: boolean) => (liveUp = up),
    bump: () => ++seq,
  };
}

const stores: CatalystStore[] = [];
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function make(w: ReturnType<typeof world>, states: string[], live = true) {
  const store = new CatalystStore({
    baseUrl: "https://relay.test",
    macKey: "mac-key-mac-key-1234567",
    fetch: w.fetchLike,
    socket: () => {
      throw new Error("the old Data Streams socket must not open when squeak-live is configured");
    },
    ...(live
      ? {
          live: {
            url: "https://live.test",
            deviceId: "dev-1",
            fetch: w.fetchLike,
            onState: (s: string) => states.push(s),
            pollMs: 40,
            retryMinMs: 20,
            retryMaxMs: 40,
          },
        }
      : {}),
  });
  stores.push(store);
  return store;
}

describe("the store's one live stream", () => {
  it("is Live after the hello, wakes the Pond's watchers on a notice, and says Reconnecting when the stream drops", async () => {
    const w = world();
    const states: string[] = [];
    const store = make(w, states);
    expect(store.liveState()).toBe("reconnecting");
    let woke = 0;
    store.watch(`channels/${POND}/room`, (source) => {
      if (source === "stream") woke += 1;
    });
    await until(() => w.calls.some((c) => c.startsWith("/live?")));
    expect(w.calls.find((c) => c.startsWith("/live?"))).toContain(`pond=${POND}`);
    w.say("hello", { ponds: [POND], refused: [] });
    await until(() => store.liveState() === "live");
    expect(store.streamHealthy()).toBe(true);
    expect(states).toEqual(["live"]);

    // The first hello seeds the Pond's cursor at its end; a notice then reads the feed and wakes the watcher.
    await until(() => w.calls.some((c) => c.includes("since=head")));
    w.say("notice", { pond: POND, seq: w.bump(), kind: "room" });
    await until(() => woke > 0);
    expect(w.calls.some((c) => /\/changes\?pond=.*since=0/.test(c))).toBe(true);

    w.setUp(false);
    w.drop();
    await until(() => store.liveState() === "reconnecting");
    expect(store.streamHealthy()).toBe(false);
    expect(states).toEqual(["live", "reconnecting"]);

    // The fallback: with no stream, the poll still reads the feed and wakes the watcher, so nothing stays stale.
    const before = woke;
    w.bump();
    await until(() => woke > before);
  });

  it("without squeak-live there is no live state and the old path is untouched", () => {
    const w = world();
    const sockets: StreamSocket[] = [];
    const store = new CatalystStore({
      baseUrl: "https://relay.test",
      macKey: "mac-key-mac-key-1234567",
      fetch: w.fetchLike,
      socket: () => {
        const s = { send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null };
        sockets.push(s);
        return s;
      },
      retryMinMs: 1_000_000,
    });
    stores.push(store);
    expect(store.liveState()).toBeNull();
    store.watch(`channels/${POND}/room`, () => undefined);
    expect(w.calls.some((c) => c.startsWith("/live"))).toBe(false);
  });

  it("a pond token or the relay key never opens a live stream", () => {
    const w = world();
    const store = new CatalystStore({
      baseUrl: "https://relay.test",
      relayKey: "relay-key-relay-key-1234",
      fetch: w.fetchLike,
      socket: () => ({ send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
      live: { url: "https://live.test", deviceId: "d" },
    });
    stores.push(store);
    expect(store.liveState()).toBeNull();
  });

  it("the live service's URL is https, or plain http on this machine only", () => {
    expect(liveServiceUrl("https://squeak-live.example.in/")).toBe("https://squeak-live.example.in");
    expect(liveServiceUrl("http://127.0.0.1:9000")).toBe("http://127.0.0.1:9000");
    expect(liveServiceUrl("http://live.example.in")).toBeNull();
    expect(liveServiceUrl("https://u:p@live.example.in")).toBeNull();
    expect(liveServiceUrl(undefined)).toBeNull();
  });
});
