import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";

import { logger } from "../utils/logger.js";
import type { ChannelDoc } from "./firestore-rest.js";
import {
  HEADER_MAC,
  HEADER_NONCE,
  HEADER_RESPONSE_MAC,
  HEADER_TS,
  NonceCache,
  deriveLocalKey,
  localTag,
  signResponse,
  verifyRequest,
} from "./local-auth.js";
import type { MirrorStore } from "./mirror-store.js";

/**
 * The direct same-Wi-Fi path (docs/remote-channel.md, "The direct path"): the
 * channel's documents, exactly as the Realtime Database holds them, served from
 * memory to a paired phone on the same network. It speaks the database's REST
 * dialect with the channel id left out of every path (a LAN observer must not
 * learn the capability that addresses the cloud channel):
 *
 *   GET    /state/snapshot.json            a sealed document, or `null`
 *   GET    /state.json  (event-stream)     "something changed" events; never data
 *   PUT    /state/presence.json            the phone's presence ping
 *   PUT    /commands/<id>.json             a signed, sealed command
 *   DELETE /commands/<id>.json             take a command back
 *   DELETE /results/<id>.json              clear a result the phone read
 *
 * Everything else is refused. Every request carries an HMAC (local-auth.ts);
 * a command still goes through RemoteBridge.handleCommand, because it lands in
 * the same inbox the bridge reads. This server holds no authority of its own.
 */

const MAX_BODY_BYTES = 1_000_000;
const MAX_STREAMS = 8;
const MAX_STREAMS_PER_IP = 4;
const MAX_CONCURRENT_REQUESTS = 32;
/**
 * Open sockets, before any authentication: a stranger on the Wi-Fi opening idle connections must not use up
 * the daemon's file descriptors (launchd's default soft limit is 256, shared with everything else Squeak does).
 */
const MAX_CONNECTIONS = 64;
const MAX_CONNECTIONS_PER_IP = 12;
/** Requests per IP per minute, and failed authentications per IP per minute before it is blocked. */
const RATE_LIMIT = 600;
const FAILURE_LIMIT = 20;
const WINDOW_MS = 60_000;
const KEEP_ALIVE_MS = 15_000;
/** The mirror's own sealed-document cap: a phone cannot fill the Mac's memory. */
const MAX_MIRROR_BYTES = 32_000_000;
const SYNC_MS = 5_000;
const PRUNE_MS = 60_000;
/** Same shape as the Realtime Database rules (firebase/database.rules.json). */
const SEGMENT = /^[A-Za-z0-9_-]{1,80}$/;
const READABLE_DOCS: Record<string, (id: string) => boolean> = {
  state: (id) => id === "snapshot" || id === "recent" || id === "alive",
  results: () => true,
  live: () => true,
};
const STREAMABLE_COLLECTIONS = new Set(["state", "results", "live"]);
const WRITABLE_DOCS: Record<string, (id: string) => boolean> = {
  state: (id) => id === "presence",
  commands: () => true,
};
const DELETABLE_DOCS = new Set(["commands", "results"]);

export interface LocalAccess {
  channelId: string;
  /** The channel key, base64. */
  key: string;
}

export interface LocalEndpoint {
  port: number;
  hosts: string[];
  tag: string;
}

export interface LocalChannelOptions {
  mirror: MirrorStore;
  /** The channel to serve, or null while there is no paired phone: then nothing is served or advertised. */
  access: () => LocalAccess | null;
  /** Bound to every IPv4 interface by default; tests pass 127.0.0.1. */
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  now?: () => number;
  /** Bonjour advertisement; null to skip it (tests). */
  advertiser?: LocalAdvertiser | null;
  /** The addresses a phone may try; defaults to this Mac's private IPv4 addresses on en* interfaces. */
  hosts?: () => string[];
}

export class LocalChannelServer {
  private server: http.Server | null = null;
  private readonly nonces = new NonceCache();
  private readonly limits = new Map<string, { windowStart: number; count: number; fails: number }>();
  private readonly streams = new Set<{ ip: string; close: () => void }>();
  private resolved: { channelId: string; key: string; localKey: Buffer; tag: string } | null = null;
  private advertisedTag: string | null = null;
  private active = 0;
  private stopped = false;
  private pending: Promise<void> = Promise.resolve();
  private timers: NodeJS.Timeout[] = [];
  private readonly now: () => number;

  constructor(private readonly options: LocalChannelOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Starts watching for a paired phone. The port is opened only while one exists (and closed when the last is
   * revoked), so a Mac with no phone has nothing listening at all.
   */
  async start(): Promise<void> {
    if (this.timers.length > 0) {
      return;
    }
    this.stopped = false;
    for (const [run, every] of [
      [() => void this.refresh(), SYNC_MS],
      [() => this.options.mirror.prune(), PRUNE_MS],
    ] as const) {
      const timer = setInterval(run, every);
      timer.unref();
      this.timers.push(timer);
    }
    await this.refresh();
  }

  /** Opens or closes the listener to match whether a phone is paired. Runs one at a time. */
  refresh(): Promise<void> {
    this.pending = this.pending
      .then(() => this.reconcile())
      .catch((error: unknown) => {
        logger.warn("local channel: could not change its listener", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return this.pending;
  }

  private async reconcile(): Promise<void> {
    const wanted = !this.stopped && this.options.access() !== null;
    if (wanted && !this.server) {
      await this.listen();
    } else if (!wanted && this.server) {
      await this.close();
    }
    this.sync();
  }

  private async listen(): Promise<void> {
    const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => void this.handle(req, res));
    server.headersTimeout = 10_000;
    server.requestTimeout = 20_000;
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 40;
    server.maxConnections = MAX_CONNECTIONS;
    const open = new Map<string, number>();
    server.on("connection", (socket) => {
      const ip = socket.remoteAddress ?? "unknown";
      const count = (open.get(ip) ?? 0) + 1;
      if (count > MAX_CONNECTIONS_PER_IP) {
        socket.destroy();
        return;
      }
      open.set(ip, count);
      socket.once("close", () => {
        const left = (open.get(ip) ?? 1) - 1;
        if (left <= 0) open.delete(ip);
        else open.set(ip, left);
      });
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port ?? 0, this.options.host ?? "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
  }

  private async close(): Promise<void> {
    this.options.advertiser?.stop();
    this.advertisedTag = null;
    this.dropStreams();
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    await this.refresh();
    await this.close();
  }

  get port(): number | null {
    const address = this.server?.address();
    return address && typeof address === "object" ? (address as AddressInfo).port : null;
  }

  /** What the phone's sealed view says about this path; null when nothing is being served. */
  endpoint(): LocalEndpoint | null {
    const resolved = this.sync();
    const port = this.port;
    if (!resolved || port === null) {
      return null;
    }
    return { port, hosts: (this.options.hosts ?? lanHosts)(), tag: resolved.tag };
  }

  /** Reads the channel afresh: a reset or a first/last phone changes what is served and advertised. */
  private sync(): { channelId: string; key: string; localKey: Buffer; tag: string } | null {
    const access = this.options.access();
    if (!access) {
      if (this.resolved) {
        this.resolved = null;
        this.dropStreams();
        this.options.mirror.tree.clear();
      }
      this.options.advertiser?.stop();
      this.advertisedTag = null;
      return null;
    }
    if (!this.resolved || this.resolved.channelId !== access.channelId || this.resolved.key !== access.key) {
      if (this.resolved) {
        // A new channel: nothing of the old one stays served.
        this.dropStreams();
        this.options.mirror.tree.clear();
      }
      this.resolved = {
        channelId: access.channelId,
        key: access.key,
        localKey: deriveLocalKey(access.key),
        tag: localTag(access.key),
      };
    }
    const port = this.port;
    if (port !== null && this.advertisedTag !== this.resolved.tag) {
      this.options.advertiser?.start(port, this.resolved.tag);
      this.advertisedTag = this.resolved.tag;
    }
    return this.resolved;
  }

  private dropStreams(): void {
    for (const stream of [...this.streams]) stream.close();
  }

  /* ---------- requests ---------- */

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const ip = req.socket.remoteAddress ?? "unknown";
    const now = this.now();
    if (!this.admit(ip, now)) {
      return end(res, 429);
    }
    if (this.active >= MAX_CONCURRENT_REQUESTS) {
      return end(res, 503);
    }
    this.active += 1;
    try {
      await this.serve(req, res, ip, now);
    } catch (error) {
      logger.debug("local channel request failed", { error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) end(res, 500);
      else res.destroy();
    } finally {
      this.active -= 1;
    }
  }

  private async serve(req: http.IncomingMessage, res: http.ServerResponse, ip: string, now: number): Promise<void> {
    const resolved = this.sync();
    const method = req.method ?? "";
    const target = req.url ?? "";
    if (!resolved || target.length > 300 || !["GET", "PUT", "DELETE"].includes(method)) {
      this.fail(ip, now);
      return end(res, 401);
    }
    const body = await readBody(req);
    if (body === null) {
      return end(res, 413);
    }
    const header = (name: string) => {
      const value = req.headers[name];
      return typeof value === "string" ? value : undefined;
    };
    const auth = verifyRequest({
      localKey: resolved.localKey,
      nonces: this.nonces,
      now,
      method,
      target,
      body,
      headers: { ts: header(HEADER_TS), nonce: header(HEADER_NONCE), mac: header(HEADER_MAC) },
    });
    if (auth.verdict !== "ok" || !auth.nonce) {
      this.fail(ip, now);
      // Always the same bare answer: a failed caller learns nothing about why.
      return end(res, 401);
    }
    const nonce = auth.nonce;
    const respond = (status: number, text = "") => send(res, resolved.localKey, nonce, status, text);

    const parsed = parseTarget(target);
    if (!parsed) {
      return respond(404);
    }
    const full = (suffix: string) => `channels/${resolved.channelId}/${suffix}`;
    const { kind, id } = parsed;
    const mirror = this.options.mirror;

    if (method === "GET") {
      const wantsStream = String(req.headers.accept ?? "").includes("text/event-stream");
      if (wantsStream) {
        const allowed = id ? READABLE_DOCS[kind]?.(id) === true : STREAMABLE_COLLECTIONS.has(kind);
        if (!allowed) return respond(404);
        return this.openStream(req, res, ip, resolved.localKey, nonce, full(id ? `${kind}/${id}` : kind));
      }
      if (!id || READABLE_DOCS[kind]?.(id) !== true) {
        return respond(404);
      }
      return respond(200, docJson(mirror.tree.get(full(`${kind}/${id}`))));
    }

    if (!id) {
      return respond(404);
    }
    if (method === "PUT") {
      if (WRITABLE_DOCS[kind]?.(id) !== true) {
        return respond(404);
      }
      const doc = parseDoc(body);
      if (!doc) {
        return respond(400);
      }
      if (mirror.tree.byteCount > MAX_MIRROR_BYTES) {
        return respond(507);
      }
      mirror.putFromPhone(full(`${kind}/${id}`), doc);
      return respond(204);
    }
    // DELETE
    if (!DELETABLE_DOCS.has(kind)) {
      return respond(404);
    }
    mirror.deleteFromPhone(full(`${kind}/${id}`));
    return respond(204);
  }

  private openStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ip: string,
    localKey: Buffer,
    nonce: string,
    prefix: string,
  ): void {
    const mine = [...this.streams].filter((stream) => stream.ip === ip).length;
    if (this.streams.size >= MAX_STREAMS || mine >= MAX_STREAMS_PER_IP) {
      return end(res, 429);
    }
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true, 30_000);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      [HEADER_RESPONSE_MAC]: signResponse(localKey, { nonce, status: 200, body: "" }),
    });
    // The connect event: "re-read what you care about". Never the data itself.
    const event = (path: string) => res.write(`event: put\ndata: ${JSON.stringify({ path, data: "changed" })}\n\n`);
    event("/");
    const stopWatching = this.options.mirror.tree.subscribe(prefix, (changed) => {
      const rest = changed.slice(prefix.length);
      event(rest === "" ? "/" : rest);
    });
    const keepAlive = setInterval(() => res.write("event: keep-alive\ndata: null\n\n"), KEEP_ALIVE_MS);
    keepAlive.unref();
    const entry = {
      ip,
      close: () => {
        cleanup();
        res.end();
      },
    };
    const cleanup = () => {
      clearInterval(keepAlive);
      stopWatching();
      this.streams.delete(entry);
    };
    this.streams.add(entry);
    res.on("close", cleanup);
    res.on("error", cleanup);
  }

  /* ---------- limits ---------- */

  private bucket(ip: string, now: number) {
    let bucket = this.limits.get(ip);
    if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
      bucket = { windowStart: now, count: 0, fails: 0 };
      this.limits.set(ip, bucket);
      if (this.limits.size > 5_000) {
        for (const [key, value] of this.limits) {
          if (now - value.windowStart >= WINDOW_MS) this.limits.delete(key);
        }
      }
    }
    return bucket;
  }

  private admit(ip: string, now: number): boolean {
    const bucket = this.bucket(ip, now);
    bucket.count += 1;
    return bucket.count <= RATE_LIMIT && bucket.fails < FAILURE_LIMIT;
  }

  private fail(ip: string, now: number): void {
    this.bucket(ip, now).fails += 1;
  }
}

/* ---------- helpers ---------- */

function end(res: http.ServerResponse, status: number): void {
  res.writeHead(status, { "cache-control": "no-store", "content-length": "0", connection: "close" });
  res.end();
}

function send(res: http.ServerResponse, localKey: Buffer, nonce: string, status: number, text: string): void {
  const body = Buffer.from(text, "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": String(body.length),
    [HEADER_RESPONSE_MAC]: signResponse(localKey, { nonce, status, body }),
  });
  res.end(status === 204 ? undefined : body);
}

async function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) {
    req.resume();
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** `/<kind>[/<id>].json`, optionally with `?print=silent`; anything else is not ours. */
export function parseTarget(target: string): { kind: string; id: string | null } | null {
  const [path = "", query] = target.split("?", 2);
  if (query !== undefined && query !== "print=silent") {
    return null;
  }
  const match = /^\/([A-Za-z0-9_-]{1,80})(?:\/([A-Za-z0-9_-]{1,80}))?\.json$/.exec(path);
  if (!match || !SEGMENT.test(match[1]!)) {
    return null;
  }
  return { kind: match[1]!, id: match[2] ?? null };
}

function docJson(doc: ChannelDoc | null): string {
  if (!doc) {
    return "null";
  }
  const body: Record<string, unknown> = { box: doc.box };
  if (doc.sig !== undefined) body.sig = doc.sig;
  if (doc.device !== undefined) body.device = doc.device;
  if (doc.at !== undefined) body.at = Math.trunc(doc.at);
  return JSON.stringify(body);
}

/** The shape the database's own rules allow, and nothing else. */
export function parseDoc(body: Buffer): ChannelDoc | null {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !["box", "sig", "device", "at"].includes(key))) {
    return null;
  }
  if (typeof fields.box !== "string" || fields.box.length >= 900_000) {
    return null;
  }
  const doc: ChannelDoc = { box: fields.box };
  if (fields.sig !== undefined) {
    if (typeof fields.sig !== "string" || fields.sig.length >= 512) return null;
    doc.sig = fields.sig;
  }
  if (fields.device !== undefined) {
    if (typeof fields.device !== "string" || fields.device.length >= 64) return null;
    doc.device = fields.device;
  }
  if (fields.at !== undefined) {
    if (typeof fields.at !== "number" || !Number.isFinite(fields.at)) return null;
    doc.at = fields.at;
  }
  return doc;
}

/** This Mac's private IPv4 addresses on Ethernet/Wi-Fi interfaces: where a phone on the same network can reach it. */
export function lanHosts(): string[] {
  const found: string[] = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (!/^en\d+$/.test(name)) continue;
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal && isPrivate(address.address)) {
        found.push(address.address);
      }
    }
  }
  return found.slice(0, 4);
}

function isPrivate(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Advertises `_squeak._tcp` through macOS's own `dns-sd` (no dependency),
 * with one TXT field: the non-identifying tag. Restarted if it dies; stopped
 * with the server.
 */
export class LocalAdvertiser {
  private child: ChildProcess | null = null;
  private wanted: { port: number; tag: string } | null = null;
  private retry: NodeJS.Timeout | null = null;
  private failures = 0;

  constructor(private readonly spawnImpl: typeof spawn = spawn) {}

  start(port: number, tag: string): void {
    this.wanted = { port, tag };
    this.launch();
  }

  stop(): void {
    this.wanted = null;
    this.failures = 0;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    this.kill();
  }

  get running(): boolean {
    return this.child !== null;
  }

  private kill(): void {
    const child = this.child;
    this.child = null;
    child?.removeAllListeners("exit");
    child?.kill();
  }

  private launch(): void {
    const wanted = this.wanted;
    if (!wanted) {
      return;
    }
    this.kill();
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    let child: ChildProcess;
    try {
      child = this.spawnImpl(
        "dns-sd",
        ["-R", "Squeak", "_squeak._tcp", "local", String(wanted.port), `t=${wanted.tag}`, "v=1"],
        {
          stdio: "ignore",
        },
      );
    } catch (error) {
      logger.warn("local channel: could not advertise", {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.again();
    }
    this.child = child;
    child.on("error", (error) => {
      logger.debug("local channel: dns-sd failed", { error: error.message });
      if (this.child === child) {
        this.child = null;
        this.again();
      }
    });
    child.on("exit", () => {
      if (this.child === child) {
        this.child = null;
        this.again();
      }
    });
    child.unref();
  }

  private again(): void {
    if (!this.wanted || this.retry) {
      return;
    }
    this.failures += 1;
    const delay = Math.min(1_000 * 2 ** Math.min(this.failures - 1, 5), 30_000);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.launch();
    }, delay);
    this.retry.unref();
  }
}
