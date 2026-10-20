import { logger } from "../utils/logger.js";
import { splitMarkdown } from "../utils/tg-format.js";
import { canonicalMessageId } from "./inbox.js";

/** Cliq's own cap is higher; staying under it leaves room for the markup conversion. */
const CLIQ_MESSAGE_MAX = 4000;
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 2_000;
/** Cliq's data centres, spelled out: a looser pattern let `cliq.zoho.com.evil.io` through. */
const CLIQ_HOSTS = /^cliq\.(zoho\.(com|eu|in|com\.au|jp|sa|uk|com\.cn)|zohocloud\.ca)$/;

export class CliqWebhookError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "CliqWebhookError";
    this.status = status;
  }
}

/**
 * Checks the incoming-webhook URL before anything is posted to it. Session
 * content is private, and a typo that points it somewhere else would hand
 * every card to whoever owns that host. Cliq runs on one host per data
 * centre (`cliq.zoho.com`, `cliq.zoho.in`, `cliq.zoho.eu`, ...), and the
 * `zapikey` is what authorizes the post.
 */
export function parseCliqWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("SQUEAK_CLIQ_WEBHOOK_URL is not a URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("SQUEAK_CLIQ_WEBHOOK_URL must be https");
  }
  if (!CLIQ_HOSTS.test(url.hostname)) {
    throw new Error(`SQUEAK_CLIQ_WEBHOOK_URL must point at Zoho Cliq, not ${url.hostname}`);
  }
  if (!url.searchParams.get("zapikey")) {
    throw new Error("SQUEAK_CLIQ_WEBHOOK_URL has no zapikey");
  }
  return url;
}

/**
 * A card button. Tapping it runs the Cliq function `name` (owned by
 * `owner`) with this `key`; the function writes it to the inbox for the
 * Mac to act on.
 */
export interface CliqButton {
  label: string;
  key: string;
  function: { name: string; owner: string };
}

/**
 * The fleet's cards are written in the common markdown dialect Telegram's
 * renderer reads. Cliq bolds with a single asterisk, so `**x**` would arrive
 * as `*x*` wrapped in stray stars. Italics (`_x_`) and code already agree.
 */
export function markdownToCliq(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "*$1*");
}

/**
 * Posts to a bot's or a channel's `/message` endpoint. Not a bot's
 * `/incoming`: that runs the bot's own handler, and with none written it
 * answers 200 and shows nothing. Sending only: what comes back from Cliq
 * arrives through the inbox (`inbox.ts`).
 */
export class CliqWebhook {
  private readonly url: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly retryDelayMs: number;
  /** Posts go out one at a time, so a burst of cards keeps its order. */
  private queue: Promise<void> = Promise.resolve();

  constructor(url: string, options: { fetch?: typeof fetch; retryDelayMs?: number } = {}) {
    this.url = parseCliqWebhookUrl(url);
    this.fetchImpl = options.fetch ?? fetch;
    this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  }

  /**
   * Long text is split, never truncated; buttons go on the last part.
   * Resolves to that part's message id, so a tap or a reply on it can be
   * traced back to its card, or null when Cliq did not say.
   */
  post(markdown: string, options: { buttons?: CliqButton[] } = {}): Promise<string | null> {
    const parts = splitMarkdown(markdownToCliq(markdown), CLIQ_MESSAGE_MAX);
    const run = this.queue.then(async () => {
      let lastId: string | null = null;
      for (const [index, part] of parts.entries()) {
        const buttons = index === parts.length - 1 ? options.buttons : undefined;
        lastId = await this.postOnce(messagePayload(part, buttons));
      }
      return lastId;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async postOnce(payload: Record<string, unknown>): Promise<string | null> {
    try {
      return await this.request(payload);
    } catch (error) {
      // A 429 or a 5xx is worth one more try; a 4xx means the URL or key is wrong.
      if (error instanceof CliqWebhookError && (error.status === null || error.status === 429 || error.status >= 500)) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
        return this.request(payload);
      }
      throw error;
    }
  }

  private async request(payload: Record<string, unknown>): Promise<string | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // Never put the URL in the message: its zapikey is the credential.
      throw new CliqWebhookError(`Cliq unreachable: ${error instanceof Error ? error.name : "error"}`, null);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new CliqWebhookError(`Cliq returned ${response.status}: ${body.slice(0, 200)}`, response.status);
    }
    const body = (await response.json().catch(() => null)) as {
      message_details?: Record<string, { message_id?: string }>;
    } | null;
    // A personal bot has one subscriber, so there is one entry.
    const first = body?.message_details ? Object.values(body.message_details)[0] : undefined;
    return canonicalMessageId(first?.message_id);
  }
}

/** `sync_message` is what makes Cliq return the new message's id. */
function messagePayload(text: string, buttons: CliqButton[] | undefined): Record<string, unknown> {
  const payload: Record<string, unknown> = { text, sync_message: true };
  if (buttons && buttons.length > 0) {
    payload.buttons = buttons.map((button) => ({
      label: button.label,
      type: "+",
      key: button.key,
      // Cliq documents the key both on the button and as its argument; the
      // handler reads either.
      arguments: { key: button.key },
      action: { type: "invoke.function", data: { name: button.function.name, owner: button.function.owner } },
    }));
  }
  return payload;
}

export function logCliqFailure(what: string, error: unknown): void {
  logger.warn(what, { error: error instanceof Error ? error.message : String(error) });
}
