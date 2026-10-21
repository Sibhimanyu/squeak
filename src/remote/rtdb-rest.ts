/**
 * The channel's documents in Firebase's Realtime Database, over REST: the same
 * four verbs as FirestoreRest, plus `watch`, which streams changes so neither
 * side has to poll.
 *
 * Why the Realtime Database and not Firestore: it bills for bytes stored and
 * downloaded, never per read or write, and its REST API streams changes as
 * Server-Sent Events, which plain `fetch` (and the phone's URLSession) can
 * read without an SDK. A phone that watches a working session is many small
 * writes a minute; on Firestore each is a billed write plus a billed read.
 *
 * Unauthenticated, exactly like the Firestore channel: the rules
 * (firebase/database.rules.json) allow only the channel shape under an
 * unguessable id, and every body is sealed (and, for commands, signed). See
 * docs/remote-channel.md.
 */

import type { ChannelDoc } from "./firestore-rest.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface WatchOptions {
  /** Called when the stream is (re)connected, so a caller can catch up on what it missed. */
  onOpen?: () => void;
  /** Called with each failure; the watch reconnects by itself. */
  onError?: (error: Error) => void;
}

/** First retry after this long, doubling to the cap. */
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 60_000;
/** Keep-alives arrive every 30s; silence for this long means the stream is dead. */
const STALL_MS = 75_000;

export class RtdbRest {
  private readonly base: string;
  /** Kept on every request: the emulator names its database with `?ns=`. */
  private readonly baseQuery: string;
  private readonly fetchImpl: FetchLike;

  /** `databaseUrl` is the instance root, e.g. `https://<project>-default-rtdb.<region>.firebasedatabase.app`. */
  constructor(databaseUrl: string, fetchImpl: FetchLike = fetch) {
    const [root = "", query = ""] = databaseUrl.split("?", 2);
    this.base = root.replace(/\/+$/, "");
    this.baseQuery = query;
    this.fetchImpl = fetchImpl;
  }

  async get(path: string): Promise<ChannelDoc | null> {
    const response = await this.fetchImpl(this.url(path), { signal: AbortSignal.timeout(10_000) });
    await ensureOk(response, "get");
    return toDoc(await response.json());
  }

  /** `timeoutMs` for a big write (a film's chunk), which a slow uplink needs far longer for. */
  async set(path: string, doc: ChannelDoc, options: { timeoutMs?: number } = {}): Promise<void> {
    const response = await this.fetchImpl(this.url(path, "print=silent"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fromDoc(doc)),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    await ensureOk(response, "set");
  }

  async list(collection: string): Promise<Array<{ id: string; doc: ChannelDoc }>> {
    const response = await this.fetchImpl(this.url(collection), { signal: AbortSignal.timeout(10_000) });
    await ensureOk(response, "list");
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== "object") {
      return [];
    }
    return Object.entries(body as Record<string, unknown>).flatMap(([id, value]) => {
      const doc = toDoc(value);
      return doc ? [{ id, doc }] : [];
    });
  }

  async delete(path: string): Promise<void> {
    const response = await this.fetchImpl(this.url(path, "print=silent"), {
      method: "DELETE",
      signal: AbortSignal.timeout(10_000),
    });
    await ensureOk(response, "delete");
  }

  /**
   * Calls `onChange` whenever anything at or under `path` changes, including
   * once on connect with the current value. It says only *that* something
   * changed: the caller reads what it needs, through the same verbs and the
   * same checks as a poll. Reconnects with backoff until the returned
   * function is called.
   */
  watch(path: string, onChange: () => void, options: WatchOptions = {}): () => void {
    let stopped = false;
    let controller: AbortController | null = null;
    let retryMs = RETRY_MIN_MS;
    let retryTimer: NodeJS.Timeout | null = null;

    const connect = async (): Promise<void> => {
      controller = new AbortController();
      const current = controller;
      let stall: NodeJS.Timeout | null = null;
      const feed = () => {
        if (stall) clearTimeout(stall);
        stall = setTimeout(() => current.abort(), STALL_MS);
        stall.unref?.();
      };
      try {
        const response = await this.fetchImpl(this.url(path), {
          headers: { accept: "text/event-stream" },
          signal: current.signal,
        });
        await ensureOk(response, "watch");
        if (!response.body) {
          throw new Error("rtdb watch: no stream");
        }
        retryMs = RETRY_MIN_MS;
        options.onOpen?.();
        feed();
        for await (const event of readEvents(response.body)) {
          feed();
          if (event.name === "put" || event.name === "patch") {
            onChange();
          } else if (event.name === "cancel" || event.name === "auth_revoked") {
            throw new Error(`rtdb watch: ${event.name} ${event.data.slice(0, 120)}`);
          }
        }
        if (!stopped) {
          throw new Error("rtdb watch: stream ended");
        }
      } catch (error) {
        if (!stopped) {
          options.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        if (stall) clearTimeout(stall);
      }
      if (!stopped) {
        retryTimer = setTimeout(() => void connect(), retryMs);
        retryTimer.unref?.();
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }
    };

    void connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      controller?.abort();
    };
  }

  private url(path: string, query?: string): string {
    const clean = path
      .split("/")
      .filter(Boolean)
      .map((part) => encodeURIComponent(part))
      .join("/");
    const search = [this.baseQuery, query].filter(Boolean).join("&");
    return `${this.base}/${clean}.json${search ? `?${search}` : ""}`;
  }
}

export interface ServerSentEvent {
  name: string;
  data: string;
}

/** Splits a text/event-stream body into events (only `event:` and `data:` lines matter here). */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerSentEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let name = "message";
  let data: string[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line === "") {
        if (data.length > 0 || name !== "message") {
          yield { name, data: data.join("\n") };
        }
        name = "message";
        data = [];
      } else if (line.startsWith("event:")) {
        name = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""));
      }
    }
  }
}

function fromDoc(doc: ChannelDoc): Record<string, unknown> {
  const body: Record<string, unknown> = { box: doc.box };
  if (doc.sig !== undefined) body.sig = doc.sig;
  if (doc.device !== undefined) body.device = doc.device;
  if (doc.at !== undefined) body.at = Math.trunc(doc.at);
  return body;
}

export function toDoc(value: unknown): ChannelDoc | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const fields = value as Record<string, unknown>;
  if (typeof fields.box !== "string") {
    return null;
  }
  const doc: ChannelDoc = { box: fields.box };
  if (typeof fields.sig === "string") doc.sig = fields.sig;
  if (typeof fields.device === "string") doc.device = fields.device;
  if (typeof fields.at === "number") doc.at = fields.at;
  return doc;
}

async function ensureOk(response: Response, verb: string): Promise<void> {
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`rtdb ${verb} failed: ${response.status} ${detail.slice(0, 200)}`);
  }
}
