import fs from "node:fs";

import type { JoinBrief, PondBrief } from "../fleet/pond-invites.js";
import type { Resolution, SessionRow } from "./types.js";

export const NATIVE_HOST_DOWN = "Squeak's session host is not running.";

/** `down`: nothing was sent (connection refused). `timeout`: the host may or may not have acted. `http`: it answered no. */
export class NativeHostError extends Error {
  constructor(
    message: string,
    readonly kind: "down" | "timeout" | "http",
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export interface NativeHostClientOptions {
  baseUrl: string;
  /** The control token, or a function reading it (the file may appear after the daemon starts). */
  token: string | (() => string | null);
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Reads the control token file the ingress and the host share; null while it does not exist. */
export function tokenFromFile(tokenPath: string): () => string | null {
  return () => {
    try {
      return fs.readFileSync(tokenPath, "utf8").trim() || null;
    } catch {
      return null;
    }
  };
}

/** The daemon's side of the session host's HTTP API (src/native/server.ts). Every call is bounded to 5 s. */
export class NativeHostClient {
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: NativeHostClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.doFetch = options.fetch ?? fetch;
  }

  async listSessions(): Promise<SessionRow[]> {
    const body = await this.call("GET", "/native/sessions");
    return Array.isArray(body.sessions) ? (body.sessions as SessionRow[]) : [];
  }

  async send(id: string, text: string, mode: "queue" | "steer" = "queue"): Promise<{ queued: boolean }> {
    const body = await this.call("POST", `/native/sessions/${encodeURIComponent(id)}/messages`, { text, mode });
    return { queued: body.queued === true };
  }

  async interrupt(id: string): Promise<void> {
    await this.call("POST", `/native/sessions/${encodeURIComponent(id)}/interrupt`, {});
  }

  /** Archives or unarchives a chat. A waiting chat is archived at once; a working one is refused unless `stop`. */
  async archive(id: string, archived: boolean, stop = false): Promise<void> {
    await this.call(
      "POST",
      `/native/sessions/${encodeURIComponent(id)}/${archived ? "archive" : "unarchive"}`,
      archived && stop ? { stop: true } : {},
    );
  }

  /** Keeps (or starts) the chat's agent process warm while its window is open; safe to call again as a keep-alive. */
  async warm(id: string): Promise<{ warm: boolean; idleMs: number }> {
    const body = await this.call("POST", `/native/sessions/${encodeURIComponent(id)}/warm`, {});
    return { warm: body.warm === true, idleMs: typeof body.idleMs === "number" ? body.idleMs : 0 };
  }

  async respond(
    requestId: string,
    decision: Resolution["decision"] | "allowEditsForChat",
    message?: string,
  ): Promise<void> {
    await this.call("POST", `/native/requests/${encodeURIComponent(requestId)}`, {
      decision,
      ...(message ? { message } : {}),
    });
  }

  /** Ponds on this Mac (`/native/ponds`): what the invite cards watch. */
  async listPonds(): Promise<PondBrief[]> {
    const body = await this.call("GET", "/native/ponds");
    return Array.isArray(body.ponds) ? (body.ponds as PondBrief[]) : [];
  }

  /** An owned pond's pending join requests, from its view (the same `joins` the Mac app shows). */
  async pendingJoins(pondId: string): Promise<JoinBrief[]> {
    const body = await this.call("GET", `/native/ponds/${encodeURIComponent(pondId)}`);
    return Array.isArray(body.joins) ? (body.joins as JoinBrief[]) : [];
  }

  /** The host's `decideJoin`: owner only, the request must still be pending. */
  async decideJoin(pondId: string, requestId: string, approve: boolean): Promise<void> {
    await this.call("POST", `/native/ponds/${encodeURIComponent(pondId)}/joins/${encodeURIComponent(requestId)}`, {
      approve,
      wait: true,
    });
  }

  private async call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const token = typeof this.options.token === "function" ? this.options.token() : this.options.token;
    if (!token) throw new NativeHostError(NATIVE_HOST_DOWN, "down");
    let response: Response;
    try {
      response = await this.doFetch(`${this.options.baseUrl}${path}`, {
        method,
        headers: { "x-squeak-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      throw timedOut
        ? new NativeHostError("Squeak's session host did not answer in time.", "timeout")
        : new NativeHostError(NATIVE_HOST_DOWN, "down");
    }
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch {
      // an empty or non-JSON body: only the status matters
    }
    if (!response.ok) {
      const reason = typeof parsed.error === "string" ? parsed.error : `host answered ${response.status}`;
      throw new NativeHostError(reason, "http", response.status);
    }
    return parsed;
  }
}
