// The web's side of live notices (docs/cloud-layer.md, "Live notices"; the daemon's twin is src/cloud/live-notices.ts). One
// open Server-Sent Events stream to `squeak-live`, read with fetch because EventSource cannot send the `x-squeak-account`
// header. A notice carries no content: it only says "read again" (`onChange`). The platform ends a response at about 45 s, so
// the service closes at 40 s and the replacement opens at 35 s (two streams overlap for a moment; the old one closes when the
// new one says hello). While no stream is open the state is "reconnecting" and the lists are read every 30 s; a stream
// that comes back reads once, so nothing missed is lost. No live service configured: "polling", the same 30 s read.

import { ACCOUNT_HEADER, type FetchLike } from "./client.js";

export type Connection = "live" | "reconnecting" | "polling";

export const HANDOVER_MS = 35_000;
export const POLL_MS = 30_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const STALL_MS = 45_000;

export interface LiveOptions {
  /** The `squeak-live` base URL, or null when none is configured. */
  base: string | null;
  token: string;
  /** Stable per browser tab (the service tells devices apart by it). */
  deviceId: string;
  ponds(): string[];
  /** Something may have changed: read the lists again. */
  onChange(): void;
  onState(state: Connection): void;
  fetch?: FetchLike;
  random?: () => number;
}

export interface Live {
  start(): void;
  stop(): void;
}

interface Stream {
  abort: AbortController;
  handover: ReturnType<typeof setTimeout> | null;
  stall: ReturnType<typeof setTimeout> | null;
}

export function createLive(o: LiveOptions): Live {
  const fetchFn: FetchLike = o.fetch ?? ((url, init) => fetch(url, init));
  const random = o.random ?? Math.random;
  let running = false;
  let current: Stream | null = null;
  let pending: Stream | null = null;
  let state: Connection | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let retryMs = RETRY_MIN_MS;
  let wasDown = false;

  const setState = (next: Connection): void => {
    if (state === next) return;
    state = next;
    o.onState(next);
  };
  const startPoll = (): void => {
    if (!poll) poll = setInterval(o.onChange, POLL_MS);
  };
  const stopPoll = (): void => {
    if (poll) clearInterval(poll);
    poll = null;
  };
  const close = (s: Stream | null): void => {
    if (!s) return;
    if (s.handover) clearTimeout(s.handover);
    if (s.stall) clearTimeout(s.stall);
    s.abort.abort();
  };

  const down = (): void => {
    if (!running || current || pending) return;
    wasDown = true;
    setState("reconnecting");
    startPoll();
    if (retry) return;
    retry = setTimeout(
      () => {
        retry = null;
        open();
      },
      retryMs * (0.5 + random()),
    );
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  };

  const lost = (s: Stream): void => {
    close(s);
    if (pending === s) pending = null;
    if (current === s) current = null;
    down();
  };

  const handle = (s: Stream, name: string): void => {
    if (name === "hello") {
      if (current !== s) {
        close(current);
        current = s;
      }
      if (pending === s) pending = null;
      retryMs = RETRY_MIN_MS;
      stopPoll();
      setState("live");
      // The first hello after being down reads once: anything missed meanwhile is caught up.
      if (wasDown) o.onChange();
      wasDown = false;
    } else if (name === "notice" || name === "removed") {
      o.onChange();
    }
  };

  const open = (): void => {
    if (!running || !o.base) return;
    const stream: Stream = { abort: new AbortController(), handover: null, stall: null };
    pending = stream;
    const ponds = o.ponds().map((p) => `pond=${encodeURIComponent(p)}`);
    const url = `${o.base.replace(/\/+$/, "")}/live${ponds.length ? `?${ponds.join("&")}` : ""}`;
    // The replacement opens before this one ends, so nothing falls between the two.
    stream.handover = setTimeout(() => {
      if (current === stream && !pending) open();
    }, HANDOVER_MS);
    const watch = (): void => {
      if (stream.stall) clearTimeout(stream.stall);
      stream.stall = setTimeout(() => lost(stream), STALL_MS);
    };
    watch();
    void (async () => {
      try {
        const res = await fetchFn(url, {
          headers: { [ACCOUNT_HEADER]: o.token, "x-squeak-device": o.deviceId, accept: "text/event-stream" },
          credentials: "omit",
          signal: stream.abort.signal,
        });
        if (!res.ok || !res.body) return lost(stream);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          watch();
          buffer += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const name = /^event:\s*(.+)$/m.exec(block)?.[1]?.trim();
            if (name) handle(stream, name);
          }
        }
      } catch {
        // an aborted or failed stream is handled below
      }
      // The stream ended. A retired one is already closed; the current one, with no replacement, means we are down.
      if (current === stream || pending === stream) lost(stream);
    })();
  };

  return {
    start() {
      if (running) return;
      running = true;
      if (!o.base) {
        setState("polling");
        startPoll();
        return;
      }
      setState("reconnecting");
      startPoll();
      open();
    },
    stop() {
      running = false;
      close(current);
      close(pending);
      current = pending = null;
      stopPoll();
      if (retry) clearTimeout(retry);
      retry = null;
    },
  };
}
