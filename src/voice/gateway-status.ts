import type { RtdbRest } from "../remote/rtdb-rest.js";
import { readGatewayStatus } from "./gateway-status-protocol.js";
import { resultPath } from "./relay-protocol.js";

/** Newer than this is "alive": the add-on writes every 30 s. */
export const GATEWAY_FRESH_MS = 90_000;
const CACHE_MS = 5_000;

export interface GatewayStatusView {
  state: "none" | "stale" | "ok" | "sipDown";
  version?: string;
  latestVersion?: string;
  sipRegistered?: boolean;
  sipError?: string;
  at?: number;
}

export interface GatewayStatusReaderOptions {
  store: Pick<RtdbRest, "get">;
  /** Read at each look, since pairing can change them while the daemon runs. */
  relay(): { channel: string; key: string } | null;
  now?: () => number;
}

/** The add-on's last status doc, read on demand (at most once per 5 s) and told apart by age. */
export class GatewayStatusReader {
  private cache: { at: number; view: GatewayStatusView } | null = null;
  private readonly now: () => number;

  constructor(private readonly options: GatewayStatusReaderOptions) {
    this.now = options.now ?? Date.now;
  }

  /** The cached view now; refreshes in the background when older than 5 s. */
  peek(): GatewayStatusView {
    if (!this.cache || this.now() - this.cache.at > CACHE_MS) void this.read().catch(() => undefined);
    return this.cache?.view ?? { state: "none" };
  }

  async read(): Promise<GatewayStatusView> {
    const now = this.now();
    if (this.cache && now - this.cache.at <= CACHE_MS) return this.cache.view;
    const relay = this.options.relay();
    let view: GatewayStatusView = { state: "none" };
    if (relay) {
      try {
        const doc = await this.options.store.get(resultPath(relay.channel, "gwstatus"));
        const status = doc ? readGatewayStatus(relay.key, doc, now) : null;
        if (status) {
          const fresh = now - status.at <= GATEWAY_FRESH_MS;
          view = {
            state: !fresh ? "stale" : status.sipRegistered ? "ok" : "sipDown",
            version: status.version,
            ...(status.latestVersion ? { latestVersion: status.latestVersion } : {}),
            sipRegistered: status.sipRegistered,
            ...(status.sipError ? { sipError: status.sipError } : {}),
            at: status.at,
          };
        }
      } catch {
        if (this.cache) return this.cache.view;
      }
    }
    this.cache = { at: now, view };
    return view;
  }
}

/**
 * What `GET /control/voice/gateway` answers: the pairing window, the add-on's status, and the update fields at the top
 * level beside them (that is where the Mac app reads them). A missing top-level field here once left the app showing
 * "Add-on 0.10.0" for good while 0.11.0 was out, so the shape is pinned by a test.
 */
export function gatewayRouteView(
  pairing: unknown,
  status: unknown,
  update: { latestVersion?: string; updateAvailable: boolean; checkedAt?: number },
): Record<string, unknown> {
  return {
    pairing,
    status,
    ...(update.latestVersion !== undefined ? { latestVersion: update.latestVersion } : {}),
    updateAvailable: update.updateAvailable,
    ...(update.checkedAt !== undefined ? { checkedAt: update.checkedAt } : {}),
  };
}
