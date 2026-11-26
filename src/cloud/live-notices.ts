/**
 * The daemon's side of live notices (docs/cloud-layer.md, "Live notices"; relay `live/hub.js`; spec: Cloud, "How a change
 * travels"). One open Server-Sent Events stream to `squeak-live`, saying which Ponds this device watches. The service sends a
 * short notice `{pond, seq, kind}` after a stamped write; the device then reads `GET /changes` from its own cursor, the same
 * change feed `FeedMirror` reads. An idle device costs one open stream and no requests.
 *
 * The platform ends every response at about 45 s and never says when a client went away (docs/cloud-spike-2026-11.md), so the
 * service closes each stream itself at 40 s with `event: bye`, and this client opens the replacement at 35 s: for a few
 * seconds two streams are open, a notice is delivered on both and dropped once (by seq), and nothing falls between them. The
 * old stream is closed as soon as the new one says hello.
 *
 * When no stream is open the state is "reconnecting" (the UI says "Reconnecting...", issue #130), the feed is polled every 30 s,
 * and a new stream is tried with growing, jittered delays. The first hello after being down reads each Pond once, so anything
 * missed meanwhile is caught up.
 */
import type { FeedChange, FeedPage } from "./change-feed.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type LiveState = "live" | "reconnecting";

export interface LiveClientOptions {
  /** The live service's base URL (`squeak-live`), no trailing slash needed. */
  baseUrl: string;
  /** The device's credential: `x-squeak-account` (an account token) or `x-squeak-mac-key`. */
  headers: Record<string, string>;
  /** Stable per device (the service tells devices apart by it, for presence). */
  deviceId: string;
  /** The Ponds watched now; asked at every stream open, so a joined Pond is picked up at the next handover. */
  ponds(): string[];
  /** One change-feed read (`FeedMirrorOptions.changes`): null when the relay has no feed for this caller. */
  changes(pondId: string, since: number | "head"): Promise<FeedPage | null>;
  /** Changes the device has not seen, oldest first, once per page. */
  onChanges(pondId: string, changes: FeedChange[]): void;
  onState?(state: LiveState): void;
  /** Someone left or was removed from this Pond: the service closed its subscription. */
  onRemoved?(pondId: string): void;
  /** Another member is typing; shown briefly, never stored. */
  onTyping?(pondId: string, userId: string): void;
  /** Where each Pond's feed cursor already is (the caller's mirror); a Pond not named starts at its current end. */
  cursors?: Map<string, number>;
  fetch?: FetchLike;
  handoverMs?: number;
  pollMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  /** Silence longer than this on a stream (the service sends a heartbeat every 15 s) means it is dead. */
  stallMs?: number;
  random?: () => number;
}

export const HANDOVER_MS = 35_000;
export const POLL_MS = 30_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;
const STALL_MS = 45_000;
const MAX_PAGES = 200;

interface Stream {
  abort: AbortController;
  hello: boolean;
  retired: boolean;
  watchdog: ReturnType<typeof setTimeout> | null;
}

export class LiveClient {
  private readonly o: Required<
    Pick<LiveClientOptions, "handoverMs" | "pollMs" | "retryMinMs" | "retryMaxMs" | "stallMs">
  > &
    LiveClientOptions;
  private readonly fetchImpl: FetchLike;
  private readonly cursors: Map<string, number>;
  private readonly chains = new Map<string, Promise<unknown>>();
  private current: Stream | null = null;
  private pending: Stream | null = null;
  private running = false;
  private down = true;
  private everLive = false;
  private retryMs: number;
  private handover: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private current_state: LiveState = "reconnecting";

  constructor(options: LiveClientOptions) {
    this.o = {
      handoverMs: HANDOVER_MS,
      pollMs: POLL_MS,
      retryMinMs: RETRY_MIN_MS,
      retryMaxMs: RETRY_MAX_MS,
      stallMs: STALL_MS,
      ...options,
    };
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.cursors = options.cursors ?? new Map();
    this.retryMs = this.o.retryMinMs;
  }

  get state(): LiveState {
    return this.current_state;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.setState("reconnecting");
    this.startPoll();
    this.openStream();
  }

  stop(): void {
    this.running = false;
    for (const s of [this.current, this.pending]) this.close(s);
    this.current = this.pending = null;
    for (const t of [this.handover, this.retry]) if (t) clearTimeout(t);
    this.handover = this.retry = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  private setState(state: LiveState): void {
    if (state === this.current_state) return;
    this.current_state = state;
    this.o.onState?.(state);
  }

  private startPoll(): void {
    if (this.poll) return;
    this.poll = setInterval(() => {
      // The stream is the news while it is up; this is only the fallback, so a live device makes no request here.
      if (this.down) for (const p of this.o.ponds()) void this.drain(p);
    }, this.o.pollMs);
    this.poll.unref?.();
  }

  private close(s: Stream | null): void {
    if (!s) return;
    s.retired = true;
    if (s.watchdog) clearTimeout(s.watchdog);
    s.abort.abort();
  }

  private openStream(): void {
    if (!this.running || this.pending) return;
    const stream: Stream = { abort: new AbortController(), hello: false, retired: false, watchdog: null };
    this.pending = stream;
    const params = new URLSearchParams();
    for (const p of this.o.ponds()) params.append("pond", p);
    const url = `${this.o.baseUrl.replace(/\/+$/, "")}/live?${params}`;
    void this.run(stream, url);
  }

  private feed(stream: Stream): void {
    if (stream.watchdog) clearTimeout(stream.watchdog);
    stream.watchdog = setTimeout(() => {
      if (!stream.retired) this.ended(stream);
    }, this.o.stallMs);
    stream.watchdog.unref?.();
  }

  private async run(stream: Stream, url: string): Promise<void> {
    try {
      const res = await this.fetchImpl(url, {
        headers: { ...this.o.headers, "x-squeak-device": this.o.deviceId, accept: "text/event-stream" },
        signal: stream.abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`live ${res.status}`);
      this.feed(stream);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.feed(stream);
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const end = buffer.indexOf("\n\n");
          if (end < 0) break;
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          this.event(stream, block);
        }
      }
      this.ended(stream);
    } catch {
      this.ended(stream);
    }
  }

  private event(stream: Stream, block: string): void {
    if (stream.retired) return;
    let name = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!name) return; // a heartbeat comment
    let body: Record<string, unknown>;
    try {
      body = data ? (JSON.parse(data) as Record<string, unknown>) : {};
    } catch {
      return;
    }
    switch (name) {
      case "hello":
        this.hello(stream);
        break;
      case "notice":
        if (typeof body.pond === "string" && Number.isInteger(body.seq))
          void this.notice(body.pond, body.seq as number);
        break;
      case "removed":
        if (typeof body.pond === "string") {
          this.o.onRemoved?.(body.pond);
          this.cursors.delete(body.pond);
        }
        break;
      case "typing":
        if (typeof body.pond === "string" && typeof body.user === "string") this.o.onTyping?.(body.pond, body.user);
        break;
      default:
        break; // "bye" is followed by the end of the stream
    }
  }

  /** This stream is subscribed: it becomes the current one and the one it replaces is closed. */
  private hello(stream: Stream): void {
    stream.hello = true;
    if (this.pending === stream) this.pending = null;
    const old = this.current;
    this.current = stream;
    if (old && old !== stream) this.close(old);
    const wasDown = this.down;
    this.down = false;
    this.retryMs = this.o.retryMinMs;
    this.setState("live");
    if (this.handover) clearTimeout(this.handover);
    this.handover = setTimeout(() => this.openStream(), this.o.handoverMs);
    this.handover.unref?.();
    // First hello, or the first after being down: what was missed is read once. A handover needs no read: the two streams overlapped.
    if (wasDown) for (const p of this.o.ponds()) void (this.everLive ? this.drain(p) : this.seed(p));
    this.everLive = true;
  }

  private ended(stream: Stream): void {
    if (stream.watchdog) clearTimeout(stream.watchdog);
    const wasRetired = stream.retired;
    stream.retired = true;
    stream.abort.abort();
    if (!this.running) return;
    if (this.pending === stream) {
      this.pending = null;
      // A replacement that failed while the old stream is still up: try again soon, the old one is the line meanwhile.
      if (!wasRetired && this.current) this.scheduleRetry(this.o.retryMinMs);
      else if (!wasRetired) this.lost();
      return;
    }
    if (wasRetired || this.current !== stream) return;
    this.current = null;
    // Its replacement may already be on the way (opened at the handover): it takes over when it says hello.
    if (this.pending) {
      this.down = true;
      this.setState("reconnecting");
      return;
    }
    this.lost();
  }

  private lost(): void {
    this.down = true;
    this.setState("reconnecting");
    if (this.handover) clearTimeout(this.handover);
    this.handover = null;
    this.scheduleRetry(this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, this.o.retryMaxMs);
  }

  private scheduleRetry(ms: number): void {
    if (this.retry || !this.running) return;
    const jitter = ms * (0.5 + (this.o.random ?? Math.random)() * 0.5);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.openStream();
    }, jitter);
    this.retry.unref?.();
  }

  /** A notice: read the feed unless it is already ours (the two overlapping streams both bring it). */
  private async notice(pondId: string, seq: number): Promise<void> {
    const have = this.cursors.get(pondId);
    if (have !== undefined && seq <= have) return;
    await this.drain(pondId);
  }

  /** The Pond's cursor starts at its current end (the caller lists the Pond by itself once). */
  private async seed(pondId: string): Promise<void> {
    await this.serial(pondId, async () => {
      if (this.cursors.has(pondId)) return;
      const head = await this.o.changes(pondId, "head").catch(() => null);
      if (head && !this.cursors.has(pondId)) this.cursors.set(pondId, head.next);
    });
  }

  /** Reads every change after the Pond's cursor, one page at a time. */
  private async drain(pondId: string): Promise<void> {
    await this.serial(pondId, async () => {
      if (!this.cursors.has(pondId)) {
        const head = await this.o.changes(pondId, "head").catch(() => null);
        if (!head) return;
        this.cursors.set(pondId, head.next);
        return;
      }
      for (let i = 0; i < MAX_PAGES; i++) {
        const since = this.cursors.get(pondId)!;
        const page = await this.o.changes(pondId, since).catch(() => null);
        if (!page) return;
        if (page.changes.length) this.o.onChanges(pondId, page.changes);
        this.cursors.set(pondId, Math.max(since, page.next));
        if (!page.more) return;
      }
    });
  }

  private serial(pondId: string, fn: () => Promise<void>): Promise<unknown> {
    const run = (this.chains.get(pondId) ?? Promise.resolve()).then(fn);
    this.chains.set(
      pondId,
      run.catch(() => undefined),
    );
    return run;
  }
}
