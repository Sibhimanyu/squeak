import type { ZohoOAuth } from "./oauth.js";

/** The Cliq database the bot's handlers write into. `squeak cliq-auth` creates it. */
export const CLIQ_INBOX_DATABASE = "squeakinbox";

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * One thing done in Cliq, written by one of the bot's Deluge handlers
 * (docs/cliq.md): a message typed to the bot, a button tapped, a reply form
 * sent. `msgid` is the card it acted on, when there is one.
 */
export interface CliqInboxRecord {
  id: string;
  kind: "message" | "button" | "reply" | "unknown";
  arg: string;
  msgid: string | null;
  body: string;
  userId: string;
  sentAt: number | null;
}

/** The fields `squeak cliq-auth` creates the database with; the handlers write exactly these. */
export const CLIQ_INBOX_FIELDS = [
  { field_name: "kind", type: "limited-text" },
  { field_name: "arg", type: "limited-text" },
  { field_name: "msgid", type: "limited-text" },
  { field_name: "userid", type: "limited-text" },
  { field_name: "sentat", type: "number" },
  { field_name: "body", type: "large-text" },
] as const;

/**
 * Cliq spells one message id three ways: `1790492118179%2033850494115` from
 * the post API, a space once that is decoded, and `1606715211110_614577765734`
 * in handler payloads. Keyed on the digits alone, all three are one card.
 */
export function canonicalMessageId(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Not percent-encoded after all.
  }
  const parts = decoded.split(/\D+/).filter(Boolean);
  return parts.length > 0 ? parts.join("_") : null;
}

export class CliqApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "CliqApiError";
    this.status = status;
  }
}

/**
 * The Mac's side of the database. Cliq cannot call the Mac, so the Mac
 * reads what the handlers wrote and deletes each record before acting on it:
 * a record is done at most once, even across a restart, and one that could
 * not be deleted waits for the next poll rather than running twice.
 */
export class CliqInbox {
  private readonly apiBase: string;
  private readonly oauth: Pick<ZohoOAuth, "accessToken" | "invalidate">;
  private readonly fetchImpl: typeof fetch;

  constructor(options: {
    cliqHost: string;
    oauth: Pick<ZohoOAuth, "accessToken" | "invalidate">;
    fetch?: typeof fetch;
  }) {
    this.apiBase = `https://${options.cliqHost}/api/v2/storages/${CLIQ_INBOX_DATABASE}/records`;
    this.oauth = options.oauth;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async list(): Promise<CliqInboxRecord[]> {
    const body = (await this.request("GET", `${this.apiBase}?limit=50`)) as { list?: unknown };
    const rows = Array.isArray(body?.list) ? body.list : [];
    return rows
      .map((row) => parseRecord(row))
      .filter((record): record is CliqInboxRecord => record !== null)
      .sort((a, b) => (a.sentAt ?? 0) - (b.sentAt ?? 0));
  }

  async delete(id: string): Promise<void> {
    await this.request("DELETE", `${this.apiBase}/${encodeURIComponent(id)}`);
  }

  private async request(method: string, url: string, retried = false): Promise<unknown> {
    const token = await this.oauth.accessToken();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: { authorization: `Zoho-oauthtoken ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new CliqApiError(`Cliq unreachable: ${error instanceof Error ? error.name : "error"}`, null);
    }
    if (response.status === 401 && !retried) {
      this.oauth.invalidate();
      return this.request(method, url, true);
    }
    if (response.status === 204) {
      return null;
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw new CliqApiError(`Cliq returned ${response.status}: ${text.slice(0, 200)}`, response.status);
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }
}

function parseRecord(row: unknown): CliqInboxRecord | null {
  if (!row || typeof row !== "object") {
    return null;
  }
  const value = row as Record<string, unknown>;
  const id = asString(value.id);
  if (!id) {
    return null;
  }
  const kind = asString(value.kind);
  const sentAt = Number(value.sentat);
  return {
    id,
    kind: kind === "message" || kind === "button" || kind === "reply" ? kind : "unknown",
    arg: asString(value.arg),
    msgid: canonicalMessageId(asString(value.msgid)),
    body: asString(value.body),
    userId: asString(value.userid),
    sentAt: Number.isFinite(sentAt) && sentAt > 0 ? sentAt : null,
  };
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}
