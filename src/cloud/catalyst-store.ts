/**
 * The channel's documents in Zoho Catalyst, through the `squeak_relay` function (docs/cloud-layer.md,
 * cloud/catalyst-relay): the same five operations as `RtdbRest`.
 *
 * `watch` is one Data Streams subscriber per store, fanned out by path prefix. The wire protocol is the
 * spike's (spikes/catalyst/README.md, from `@zcatalyst/datastreams`): plain JSON text frames over a
 * WebSocket, so Node's own `WebSocket` is enough and no SDK is needed. A notice says only that a
 * collection changed (`{"p":"channels/<id>/<kind>"}`); the reader re-reads through the store.
 */

import { createHash } from "node:crypto";

import type { ChannelDoc } from "./store.js";
import { FeedMirror, type FeedPage } from "./change-feed.js";
import { LiveClient, type LiveState } from "./live-notices.js";
import { macClientHeaders, updateGate } from "./client-version.js";
import { onNetworkChange } from "../remote/network-change.js";
import { BlobRefused, type CloudStore, type CloudWatchOptions, type WatchSource } from "./store.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The slice of the WebSocket API used here (Node's global `WebSocket` satisfies it). */
export interface StreamSocket {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface CatalystStoreOptions {
  /** The relay's base URL, already checked (`relayBaseUrl`). */
  baseUrl: string;
  /** The store-wide key: an owner's. Exactly one of `relayKey` and `pondToken`. */
  relayKey?: string;
  /** Squeak's hosted relay: this Mac's own key (provisioned after sign-in), sent as `x-squeak-mac-key`. */
  macKey?: string;
  /** Called when the relay answers 401 to a request (a revoked Mac key). Never receives the response. */
  onUnauthorized?: () => void;
  /**
   * A pond-scoped token (docs/ponds.md, "Scoped tokens"): good for one pond's channel, sent as `x-squeak-pond-token`.
   * A member holds this and never the relay key; its live notices come from the pond's own
   * Data Streams channel (`/pond-stream`), not the store-wide `/token`.
   */
  pondToken?: string;
  /**
   * `squeak-live` (docs/cloud-layer.md, "Live notices"): one stream per Mac, a hosted Mac's own key only. Set, the live stream
   * replaces this store's Data Streams WebSocket and its notices drive the feed reads; unset, the old notice path runs
   * unchanged. `onState` hears "live" / "reconnecting" (the Mac's one connection state, issue #130).
   */
  live?: {
    url: string;
    deviceId: string;
    fetch?: FetchLike;
    onState?: (state: LiveState) => void;
    pollMs?: number;
    handoverMs?: number;
    retryMinMs?: number;
    retryMaxMs?: number;
  };
  fetch?: FetchLike;
  /** Opens a WebSocket; the default is Node's global one. */
  socket?: (url: string) => StreamSocket;
  /** The safety poll, 60 s as with the Realtime Database's callers. */
  pollMs?: number;
  /** The safety poll while the stream is healthy (default 5 min). */
  healthyPollMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
}

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const POLL_MS = 60_000;
/** While the stream is up and has said hello, a watcher's safety poll stretches to this: a notice carries the news. */
const HEALTHY_POLL_MS = 5 * 60_000;
const KEEPALIVE_MS = 15_000;
const PING_MS = 60_000;
/** Silence this long (the keepalive pongs come every 15 s) means the socket is dead. */
const STALL_MS = 75_000;

/** The hosts a token's `url` may name: Data Streams' own, as the SDK's allow-list. */
const STREAM_HOST = /^[a-z0-9-]+-dms\.zoho\.(com|eu|in|com\.au|jp|ca|sa)$/;

export class CatalystStore implements CloudStore {
  private readonly base: string;
  private readonly header: { name: "x-squeak-relay" | "x-squeak-mac-key" | "x-squeak-pond-token"; value: string };
  private readonly onUnauthorized: (() => void) | undefined;
  private readonly scoped: boolean;
  private readonly fetchImpl: FetchLike;
  private readonly hub: StreamHub;
  private readonly feed: FeedMirror;
  private liveClient: LiveClient | null = null;
  private readonly liveOptions: CatalystStoreOptions["live"] | undefined;

  constructor(options: CatalystStoreOptions) {
    this.base = options.baseUrl.replace(/\/+$/, "");
    if ([options.relayKey, options.macKey, options.pondToken].filter(Boolean).length !== 1) {
      throw new Error("A Catalyst store takes a relay key, a Mac key or a pond token, one of them.");
    }
    this.onUnauthorized = options.onUnauthorized;
    this.scoped = Boolean(options.pondToken);
    this.header = options.pondToken
      ? { name: "x-squeak-pond-token", value: options.pondToken }
      : options.macKey
        ? { name: "x-squeak-mac-key", value: options.macKey }
        : { name: "x-squeak-relay", value: options.relayKey! };
    this.fetchImpl = options.fetch ?? fetch;
    this.feed = new FeedMirror({
      changes: (pondId, since) => this.changes(pondId, since),
      listPlain: (collection) => this.listPlain(collection),
      getRaw: (path) => this.getRaw(path),
    });
    // Live notices are for the Mac's own key; a pond-scoped member store and the owner's key keep the old stream.
    this.liveOptions = options.macKey ? options.live : undefined;
    this.hub = new StreamHub({
      passive: this.liveOptions !== undefined,
      liveHealthy: () => this.liveClient?.state === "live",
      token: () => this.token(),
      socket: options.socket ?? ((url) => new WebSocket(url) as unknown as StreamSocket),
      retryMinMs: options.retryMinMs ?? RETRY_MIN_MS,
      retryMaxMs: options.retryMaxMs ?? RETRY_MAX_MS,
    });
    this.pollMs = options.pollMs ?? POLL_MS;
    this.healthyPollMs = options.healthyPollMs ?? HEALTHY_POLL_MS;
  }

  private readonly pollMs: number;
  private readonly healthyPollMs: number;

  async get(path: string): Promise<ChannelDoc | null> {
    const response = await this.call(`/doc?path=${encodeURIComponent(path)}`, { method: "GET" }, 10_000);
    if (response.status === 404) return null;
    await ensureOk(response, "get");
    const body = (await response.json()) as { doc?: unknown };
    return toDoc(body.doc);
  }

  /**
   * A document as the relay stores it, unparsed: for the relay's own plain-JSON documents, which have no
   * `box`. Null when absent or on any failure. Not part of `CloudStore`: a Firebase store has none of them.
   */
  async getRaw(path: string): Promise<unknown | null> {
    try {
      const response = await this.call(`/doc?path=${encodeURIComponent(path)}`, { method: "GET" }, 10_000);
      if (!response.ok) return null;
      return ((await response.json()) as { doc?: unknown }).doc ?? null;
    } catch {
      return null;
    }
  }

  /** A collection's documents as the relay stores them, unparsed: the relay-owned plain-JSON kinds (`devreqs`). Empty on any failure. */
  async listRaw(collection: string): Promise<Array<{ id: string; doc: unknown }>> {
    try {
      const response = await this.call(`/list?prefix=${encodeURIComponent(collection)}`, { method: "GET" }, 10_000);
      if (!response.ok) return [];
      const body = (await response.json()) as { items?: unknown };
      if (!Array.isArray(body.items)) return [];
      return body.items.flatMap((item: unknown) => {
        const { id, doc } = (item ?? {}) as { id?: unknown; doc?: unknown };
        return typeof id === "string" ? [{ id, doc }] : [];
      });
    } catch {
      return [];
    }
  }

  async set(path: string, doc: ChannelDoc, options: { timeoutMs?: number } = {}): Promise<void> {
    const response = await this.call(
      `/doc?path=${encodeURIComponent(path)}`,
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc: fromDoc(doc) }) },
      options.timeoutMs ?? 10_000,
    );
    await ensureOk(response, "set");
  }

  /**
   * A collection's documents. A Pond's content kinds go through the change feed (change-feed.ts): after the first read of a
   * Pond, listing it is one feed read, not a re-read of the whole kind. Every other collection, and any relay without a
   * feed, takes the plain list.
   */
  async list(collection: string): Promise<Array<{ id: string; doc: ChannelDoc }>> {
    return (await this.feed.list(collection)) ?? (await this.listPlain(collection));
  }

  /**
   * Several of a Pond's collections, and relay-owned plain documents by path, from one feed read (see `FeedMirror.listMany`).
   * Null when the caller should read them one by one.
   */
  async readMany(
    collections: string[],
    rawPaths: string[] = [],
  ): Promise<{ lists: Array<Array<{ id: string; doc: ChannelDoc }>>; raws: unknown[] } | null> {
    return this.feed.listMany(collections, rawPaths);
  }

  /** One `GET /changes` (relay feed.js): a page, or null when this relay or this caller has no feed (404, 400, 401, 403). */
  private async changes(pondId: string, since: number | "head"): Promise<FeedPage | null> {
    const response = await this.call(
      `/changes?pond=${encodeURIComponent(pondId)}&since=${since}`,
      { method: "GET" },
      10_000,
    );
    if ([400, 401, 403, 404].includes(response.status)) return null;
    await ensureOk(response, "changes");
    const body = (await response.json()) as Partial<FeedPage>;
    if (!Array.isArray(body.changes) || typeof body.next !== "number") return null;
    const changes = body.changes.flatMap((c) => {
      if (!c || typeof c.seq !== "number" || typeof c.kind !== "string" || typeof c.id !== "string") return [];
      const doc = c.doc === null ? null : toDoc(c.doc);
      // A relay-owned plain document (the page-out note) has no box: it travels as `raw`, never as a sealed document.
      if (c.doc !== null && !doc) {
        return c.kind === "roomnote" && typeof c.doc === "object"
          ? [{ seq: c.seq, kind: c.kind, id: c.id, doc: null, raw: c.doc }]
          : [];
      }
      return [{ seq: c.seq, kind: c.kind, id: c.id, doc }];
    });
    return { changes, next: body.next, more: body.more === true };
  }

  private async listPlain(collection: string): Promise<Array<{ id: string; doc: ChannelDoc }>> {
    const response = await this.call(`/list?prefix=${encodeURIComponent(collection)}`, { method: "GET" }, 10_000);
    await ensureOk(response, "list");
    const body = (await response.json()) as { items?: unknown };
    if (!Array.isArray(body.items)) return [];
    return body.items.flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return [];
      const { id, doc } = item as { id?: unknown; doc?: unknown };
      const parsed = toDoc(doc);
      return typeof id === "string" && parsed ? [{ id, doc: parsed }] : [];
    });
  }

  async delete(path: string): Promise<void> {
    const response = await this.call(`/doc?path=${encodeURIComponent(path)}`, { method: "DELETE" }, 10_000);
    await ensureOk(response, "delete");
  }

  /** Keeps one sealed blob (relay `PUT /blob`, blobs.js). The bytes are already sealed; the relay never sees plaintext. */
  async putBlob(
    pondId: string,
    id: string,
    sealed: Buffer,
    ref: { kind: "room" | "rposts"; doc: string },
  ): Promise<void> {
    const query = `pond=${encodeURIComponent(pondId)}&id=${encodeURIComponent(id)}&kind=${ref.kind}&doc=${encodeURIComponent(ref.doc)}`;
    const response = await this.call(
      `/blob?${query}`,
      { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(sealed) },
      60_000,
    );
    if (response.ok) return;
    const body = (await response.json().catch(() => ({}))) as { message?: unknown };
    throw new BlobRefused(
      response.status,
      typeof body.message === "string" && body.message
        ? body.message
        : response.status === 503
          ? "Pictures and files aren't available in the cloud yet."
          : "The cloud wouldn't keep that picture or file.",
    );
  }

  /** The sealed bytes of one blob (relay `GET /blob`), or null once the cloud has paged it out. */
  async getBlob(pondId: string, id: string): Promise<Buffer | null> {
    const response = await this.call(
      `/blob?pond=${encodeURIComponent(pondId)}&id=${encodeURIComponent(id)}`,
      { method: "GET" },
      60_000,
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new BlobRefused(response.status, "Couldn't load that picture or file from the cloud.");
    return Buffer.from(await response.arrayBuffer());
  }

  /** The relay's `/ping`, for setup and tests: its answer or null. */
  async ping(): Promise<unknown | null> {
    try {
      const response = await this.call("/ping", { method: "GET" }, 10_000);
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  }

  /**
   * Calls `onChange` once now, whenever a notice names this path's collection (or a parent of it), after every
   * (re)connect, and every `pollMs` as a safety net. Says only *that* something may have changed.
   */
  watch(path: string, onChange: (source?: WatchSource) => void, options: CloudWatchOptions = {}): () => void {
    let stopped = false;
    let lastWake = Date.now();
    const wake = (source: WatchSource = "stream"): void => {
      lastWake = Date.now();
      if (!stopped) onChange(source);
    };
    const release = this.hub.add({ path, wake, options });
    this.startLive();
    const first = setTimeout(() => wake("first"), 0);
    first.unref?.();
    const poll = setInterval(() => {
      // Stream healthy: a notice carries the news, so the safety poll waits out the slower interval since the last wake.
      if (this.hub.healthy() && Date.now() - lastWake < this.healthyPollMs) return;
      wake("poll");
    }, options.pollMs ?? this.pollMs);
    poll.unref?.();
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(poll);
      release();
    };
  }

  /** Whether the stream is up and subscribed: a caller may then poll far less (the bridge's own safety pass does). */
  streamHealthy(): boolean {
    return this.hub.healthy();
  }

  private readonly inviteWatchers = new Set<() => void>();

  /**
   * Hears "an invitation of this account changed" from the live stream, and holds the stream open for it even when no Pond is
   * watched yet (an invited person has none). Returns the way to stop. No-op without `squeak-live` (the daemon's own refresh stays).
   */
  watchInvites(onChange: () => void): () => void {
    this.inviteWatchers.add(onChange);
    this.startLive();
    return () => void this.inviteWatchers.delete(onChange);
  }

  /** The live stream's state ("live" / "reconnecting"); null when `squeak-live` is not configured (the old notice path). */
  liveState(): LiveState | null {
    return this.liveOptions ? (this.liveClient?.state ?? "reconnecting") : null;
  }

  /**
   * Starts the one live stream of this Mac (once; with the first watcher). A notice reads the change feed from the cursor
   * `FeedMirror` already holds and wakes the watchers of that Pond, which list through the mirror as before.
   */
  private startLive(): void {
    const live = this.liveOptions;
    if (!live || this.liveClient) return;
    const client = new LiveClient({
      baseUrl: live.url,
      headers: { [this.header.name]: this.header.value, ...macClientHeaders() },
      deviceId: live.deviceId,
      ponds: () => this.hub.channels(),
      changes: (pondId, since) => this.changes(pondId, since),
      onChanges: (pondId) => this.hub.wakeChannel(pondId),
      onRemoved: (pondId) => this.hub.wakeChannel(pondId),
      onInvites: () => this.inviteWatchers.forEach((watch) => watch()),
      onState: (state) => {
        // Down: the 30 s feed poll wakes the watchers; live again: everything missed was read once at the hello.
        live.onState?.(state);
      },
      cursors: this.feed.cursors,
      ...(live.fetch ? { fetch: live.fetch } : {}),
      ...(live.pollMs !== undefined ? { pollMs: live.pollMs } : {}),
      ...(live.handoverMs !== undefined ? { handoverMs: live.handoverMs } : {}),
      ...(live.retryMinMs !== undefined ? { retryMinMs: live.retryMinMs } : {}),
      ...(live.retryMaxMs !== undefined ? { retryMaxMs: live.retryMaxMs } : {}),
    });
    this.liveClient = client;
    client.start();
  }

  /** Stops the subscriber (a store that is being replaced); watchers still registered get no more notices. */
  close(): void {
    this.liveClient?.stop();
    this.liveClient = null;
    this.hub.shutdown();
  }

  private async call(route: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const response = await this.fetchImpl(`${this.base}${route}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        [this.header.name]: this.header.value,
        ...macClientHeaders(),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    updateGate.see(response);
    if (response.status === 401) this.onUnauthorized?.();
    return response;
  }

  private async token(): Promise<{ url: string; key: string; wssId: string }> {
    // A fresh connection name each time: one live session per name, and the old one is released separately.
    const name = `sq${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36).slice(-6)}`.slice(0, 20);
    // The channel being watched, when there is exactly one: the relay then gives a stream of its own to that channel (its
    // own writes only wake its own watchers) and falls back to the shared one when it has none or this field is absent.
    const channel = this.scoped ? undefined : this.hub.singleChannel();
    const response = await this.call(
      this.scoped ? "/pond-stream" : "/token",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, ...(channel ? { channel } : {}) }),
      },
      10_000,
    );
    await ensureOk(response, "token");
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.url !== "string" || typeof body.key !== "string" || typeof body.wssId !== "string") {
      throw new Error("catalyst token: unexpected answer");
    }
    return { url: body.url, key: body.key, wssId: body.wssId };
  }
}

interface Watcher {
  path: string;
  wake: (source?: WatchSource) => void;
  options: CloudWatchOptions;
}

interface HubOptions {
  /** `squeak-live` carries the notices: this hub keeps watchers and wakes them, and opens no Data Streams socket. */
  passive?: boolean;
  liveHealthy?: () => boolean;
  token: () => Promise<{ url: string; key: string; wssId: string }>;
  socket: (url: string) => StreamSocket;
  retryMinMs: number;
  retryMaxMs: number;
}

/**
 * The opaque tag a hosted relay publishes in place of a path: first 22 characters of
 * base64url(SHA-256("squeak-notice-v1:" + channelId)). Mirrors the relay's `noticeTag` (cloud/catalyst-relay/.../scoped.js).
 */
export function noticeTag(channelId: string): string {
  return createHash("sha256").update(`squeak-notice-v1:${channelId}`).digest("base64url").slice(0, 22);
}

/** The channel id inside a watched path ("channels/<id>/..."), or null. */
function channelOfPath(path: string): string | null {
  const parts = path.replace(/^\/+/, "").split("/");
  return parts[0] === "channels" && parts[1] ? parts[1] : null;
}

/**
 * Whether a notice naming the state document `kind` (`k`, optional) may concern a watch on `watched`: a watch on one
 * state document (`channels/<c>/state/presence`) is not woken by another's write (the Mac's own snapshot/alive/recent).
 * No `kind` is unchanged; a watch on a whole channel or on `state` itself is always woken.
 */
export function kindAllows(watched: string, kind: string | null): boolean {
  if (kind === null) return true;
  const parts = watched.replace(/^\/+|\/+$/g, "").split("/");
  if (parts[0] !== "channels" || !parts[2]) return true;
  // `k` is only ever set for a write under state/, so a watch on any other collection cannot be concerned.
  if (parts[2] !== "state") return false;
  return !parts[3] || parts[3] === kind;
}

/** True when a notice for `notice` (a collection path) may concern a watch on `watched` (a doc or a collection). */
export function noticeMatches(watched: string, notice: string): boolean {
  const a = watched.replace(/^\/+|\/+$/g, "");
  const b = notice.replace(/^\/+|\/+$/g, "");
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** The one Data Streams subscriber of a store: opened with the first watcher, closed with the last. */
class StreamHub {
  private readonly watchers = new Set<Watcher>();
  private socket: StreamSocket | null = null;
  private running = false;
  private generation = 0;
  private retryMs: number;
  private retryTimer: NodeJS.Timeout | null = null;
  private timers: NodeJS.Timeout[] = [];
  private stall: NodeJS.Timeout | null = null;
  private unsubscribeNetwork: (() => void) | null = null;
  /** True from the server's hello (authenticated, subscribed) until the socket is dropped. */
  private ready = false;
  /** Release of the previous session, awaited before a new token is asked for. */
  private released: Promise<void> = Promise.resolve();

  constructor(private readonly options: HubOptions) {
    this.retryMs = options.retryMinMs;
  }

  healthy(): boolean {
    if (this.options.passive) return this.running && (this.options.liveHealthy?.() ?? false);
    return this.running && this.ready && this.socket !== null;
  }

  /** The channel ids every watcher names: the Ponds this Mac watches. */
  channels(): string[] {
    const ids = new Set<string>();
    for (const watcher of this.watchers) {
      const id = channelOfPath(watcher.path);
      if (id) ids.add(id);
    }
    return [...ids];
  }

  /** A change in this Pond was read from the feed: its watchers list again (through the mirror). */
  wakeChannel(channel: string): void {
    for (const watcher of [...this.watchers]) if (channelOfPath(watcher.path) === channel) watcher.wake("stream");
  }

  /** The one channel id every watcher's path names, else undefined. */
  singleChannel(): string | undefined {
    const ids = new Set<string>();
    for (const watcher of this.watchers) {
      const id = /^channels\/([A-Za-z0-9_-]{22,64})(?:\/|$)/.exec(watcher.path)?.[1];
      if (!id) return undefined;
      ids.add(id);
    }
    return ids.size === 1 ? [...ids][0] : undefined;
  }

  add(watcher: Watcher): () => void {
    this.watchers.add(watcher);
    if (!this.running) this.start();
    return () => {
      this.watchers.delete(watcher);
      if (this.watchers.size === 0) this.shutdown();
    };
  }

  shutdown(): void {
    this.running = false;
    this.generation += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.unsubscribeNetwork?.();
    this.unsubscribeNetwork = null;
    this.drop(true);
  }

  private start(): void {
    this.running = true;
    this.retryMs = this.options.retryMinMs;
    if (this.options.passive) return;
    // A new network leaves the socket dead without a word: drop it and reconnect now.
    this.unsubscribeNetwork = onNetworkChange(() => {
      if (!this.running) return;
      this.retryMs = this.options.retryMinMs;
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        void this.connect();
      } else {
        this.drop(true);
        this.scheduleRetry(0);
      }
    });
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    const generation = ++this.generation;
    try {
      await this.released;
      const token = await this.options.token();
      if (generation !== this.generation) return;
      if (!STREAM_HOST.test(token.url)) throw new Error("catalyst stream: unexpected host");
      const url = `wss://${token.url}/wsconnect?prd=CY&zuid=${encodeURIComponent(token.wssId)}&key=${encodeURIComponent(token.key)}`;
      const socket = this.options.socket(url);
      this.socket = socket;
      socket.onopen = () => undefined;
      socket.onmessage = (event) => {
        if (generation !== this.generation) return;
        this.feed(generation);
        this.frame(socket, generation, event.data);
      };
      socket.onerror = () => undefined;
      socket.onclose = () => {
        if (generation !== this.generation || !this.running) return;
        this.fail(new Error("catalyst stream: closed"));
      };
      this.feed(generation);
    } catch (error) {
      if (generation === this.generation && this.running) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private frame(socket: StreamSocket, generation: number, data: unknown): void {
    if (typeof data !== "string") return;
    // An empty text frame is a pong.
    if (data.trim() === "") return;
    let frames: unknown;
    try {
      frames = JSON.parse(data);
    } catch {
      return;
    }
    for (const frame of Array.isArray(frames) ? frames : [frames]) {
      if (!frame || typeof frame !== "object") continue;
      const { mtype, msg } = frame as { mtype?: unknown; msg?: unknown };
      switch (String(mtype)) {
        case "0":
          // Authenticated: subscribe live ('0'), then keep the line alive.
          socket.send(JSON.stringify({ type: "con", value: "subscribe", streamingId: "0" }));
          this.keepAlive(socket, generation);
          this.ready = true;
          this.retryMs = this.options.retryMinMs;
          for (const watcher of this.watchers) watcher.options.onOpen?.();
          // What happened before the subscription is read through the store.
          for (const watcher of [...this.watchers]) watcher.wake("open");
          break;
        case "650":
          this.event(socket, msg);
          break;
        case "-1":
          // "Switch host": the server asks for a new connection now. Not a failure: no error, no growing backoff.
          this.drop(true);
          this.retryMs = this.options.retryMinMs;
          this.scheduleRetry(0);
          return;
        case "-5":
        case "-2":
        case "-11":
        case "660":
        case "670":
          this.fail(new Error(`catalyst stream: server said ${String(mtype)}`));
          return;
        default:
          break;
      }
    }
  }

  private event(socket: StreamSocket, msg: unknown): void {
    if (!msg || typeof msg !== "object") return;
    const { opr, data } = msg as { opr?: unknown; data?: { data?: unknown; streamingId?: unknown } };
    if (opr !== "event" || !data) return;
    // Every message is acknowledged, or the next one is never delivered.
    if (typeof data.streamingId === "string" || typeof data.streamingId === "number") {
      try {
        socket.send(JSON.stringify({ type: "ack", streamingId: String(data.streamingId) }));
      } catch {
        // A dead socket is noticed by its close.
      }
    }
    let notice: unknown = data.data;
    if (typeof notice === "string") {
      try {
        notice = JSON.parse(notice);
      } catch {
        notice = null;
      }
    }
    const body = notice && typeof notice === "object" ? (notice as { p?: unknown; t?: unknown; k?: unknown }) : {};
    const p = body.p;
    const kind = typeof body.k === "string" ? body.k : null;
    // A hosted relay sends {"t": tag} (no path): wake the watchers of the channel that tag names, ignore every other.
    const t = typeof body.t === "string" ? body.t : null;
    for (const watcher of [...this.watchers]) {
      if (t !== null && typeof p !== "string") {
        const channel = channelOfPath(watcher.path);
        if ((channel === null || noticeTag(channel) === t) && kindAllows(watcher.path, kind)) watcher.wake();
        continue;
      }
      // A notice that cannot be read wakes everyone: waking too much costs a read, missing one costs a message.
      if (typeof p !== "string" || (noticeMatches(watcher.path, p) && kindAllows(watcher.path, kind))) watcher.wake();
    }
  }

  private keepAlive(socket: StreamSocket, generation: number): void {
    this.clearTimers();
    const send = (text: string) => () => {
      if (generation !== this.generation) return;
      try {
        socket.send(text);
      } catch {
        // Noticed by the close.
      }
    };
    const a = setInterval(send("-"), KEEPALIVE_MS);
    const b = setInterval(send(JSON.stringify({ type: "con", value: "ping" })), PING_MS);
    a.unref?.();
    b.unref?.();
    this.timers = [a, b];
  }

  private feed(generation: number): void {
    if (this.stall) clearTimeout(this.stall);
    this.stall = setTimeout(() => {
      if (generation === this.generation && this.running) this.fail(new Error("catalyst stream: stalled"));
    }, STALL_MS);
    this.stall.unref?.();
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  /** Release the session (unsubscribe, then close) so a new token starts clean. */
  private drop(deliberate: boolean): void {
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.clearTimers();
    if (this.stall) clearTimeout(this.stall);
    this.stall = null;
    if (!socket) return;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = () => undefined;
    this.released = new Promise<void>((resolve) => {
      try {
        if (deliberate) socket.send(JSON.stringify({ type: "con", value: "unsubscribe" }));
      } catch {
        // Already dead.
      }
      // Give the unsubscribe a moment to leave before the socket closes.
      const timer = setTimeout(() => {
        try {
          socket.close();
        } catch {
          // Already closed.
        }
        resolve();
      }, 50);
      timer.unref?.();
    });
  }

  private fail(error: Error): void {
    for (const watcher of this.watchers) watcher.options.onError?.(error);
    this.drop(true);
    this.scheduleRetry(this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, this.options.retryMaxMs);
  }

  private scheduleRetry(ms: number): void {
    if (!this.running || this.retryTimer) return;
    this.generation += 1;
    // Jitter (50-100% of the wait) so a fleet of clients dropped together does not come back together.
    const wait = ms === 0 ? 0 : Math.round(ms * (0.5 + Math.random() * 0.5));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, wait);
    this.retryTimer.unref?.();
  }
}

function fromDoc(doc: ChannelDoc): Record<string, unknown> {
  const body: Record<string, unknown> = { box: doc.box };
  if (doc.sig !== undefined) body.sig = doc.sig;
  if (doc.device !== undefined) body.device = doc.device;
  if (doc.at !== undefined) body.at = Math.trunc(doc.at);
  return body;
}

function toDoc(value: unknown): ChannelDoc | null {
  if (!value || typeof value !== "object") return null;
  const fields = value as Record<string, unknown>;
  if (typeof fields.box !== "string") return null;
  const doc: ChannelDoc = { box: fields.box };
  if (typeof fields.sig === "string") doc.sig = fields.sig;
  if (typeof fields.device === "string") doc.device = fields.device;
  if (typeof fields.at === "number") doc.at = fields.at;
  if (typeof fields.seq === "number" && Number.isInteger(fields.seq) && fields.seq > 0) doc.seq = fields.seq;
  return doc;
}

async function ensureOk(response: Response, verb: string): Promise<void> {
  if (!response.ok) {
    // Never the body: the relay answers a wrong key with a bare 401, and a body could carry anything.
    throw new Error(`catalyst ${verb} failed: ${response.status}`);
  }
}
