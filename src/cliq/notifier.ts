import type { FleetMonitor } from "../fleet/fleet-monitor.js";
import { renderAttentionCard, renderQuotaAlert } from "../fleet/radar.js";
import type { AttentionItem } from "../fleet/types.js";
import { logCliqFailure, type CliqWebhook } from "./client.js";

/**
 * Sends the fleet's push cards to Cliq as well as Telegram.
 *
 * It listens to the same `onPush` and `onQuotaAlert` as the Telegram
 * controller, so what reaches Cliq is exactly what reaches Telegram: the
 * monitor has already applied `shouldPush`, snoozes and mutes. The cards
 * carry no buttons, because nothing tapped in Cliq can reach this Mac.
 */
export class CliqNotifier {
  private readonly webhook: Pick<CliqWebhook, "post">;
  private readonly monitor: Pick<FleetMonitor, "onPush" | "onQuotaAlert">;
  private readonly now: () => number;
  private unsubscribe: Array<() => void> = [];

  constructor(deps: {
    webhook: Pick<CliqWebhook, "post">;
    monitor: Pick<FleetMonitor, "onPush" | "onQuotaAlert">;
    now?: () => number;
  }) {
    this.webhook = deps.webhook;
    this.monitor = deps.monitor;
    this.now = deps.now ?? Date.now;
  }

  /** Subscribe before the monitor starts, or its first push is missed. */
  start(): void {
    this.unsubscribe.push(
      this.monitor.onPush((items) => {
        void this.pushAttention(items);
      }),
      this.monitor.onQuotaAlert((usage, window) => {
        void this.webhook
          .post(renderQuotaAlert(usage, window, this.now()))
          .catch((error) => logCliqFailure("cliq quota push failed", error));
      }),
    );
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribe) {
      unsubscribe();
    }
    this.unsubscribe = [];
  }

  private async pushAttention(items: AttentionItem[]): Promise<void> {
    for (const item of items) {
      try {
        await this.webhook.post(renderAttentionCard(item, this.now()));
      } catch (error) {
        // One failed card must not hold back the rest of the batch.
        logCliqFailure("cliq push failed", error);
      }
    }
  }
}
