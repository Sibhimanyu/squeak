import { logger } from "../utils/logger.js";
import { splitMarkdown } from "../utils/tg-format.js";

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
 * The fleet's cards are written in the common markdown dialect Telegram's
 * renderer reads. Cliq bolds with a single asterisk, so `**x**` would arrive
 * as `*x*` wrapped in stray stars. Italics (`_x_`) and code already agree.
 */
export function markdownToCliq(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "*$1*");
}

/**
 * Posts to a Cliq incoming webhook (a bot's or a channel's). One-way: Cliq
 * delivers button taps and replies to handlers on Zoho's servers, which
 * cannot reach this Mac, so nothing here reads anything back.
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

  /** Long text is split, never truncated. Resolves once every part is posted. */
  post(markdown: string): Promise<void> {
    const parts = splitMarkdown(markdownToCliq(markdown), CLIQ_MESSAGE_MAX);
    const run = this.queue.then(async () => {
      for (const part of parts) {
        await this.postOnce(part);
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async postOnce(text: string): Promise<void> {
    try {
      await this.request(text);
    } catch (error) {
      // A 429 or a 5xx is worth one more try; a 4xx means the URL or key is wrong.
      if (error instanceof CliqWebhookError && (error.status === null || error.status === 429 || error.status >= 500)) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
        await this.request(text);
        return;
      }
      throw error;
    }
  }

  private async request(text: string): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
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
  }
}

export function logCliqFailure(what: string, error: unknown): void {
  logger.warn(what, { error: error instanceof Error ? error.message : String(error) });
}
