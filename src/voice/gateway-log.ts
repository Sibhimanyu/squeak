import type { RtdbRest } from "../remote/rtdb-rest.js";
import { GATEWAY_LOG_ID, readGatewayLog, type GatewayLogLine } from "./gateway-log-protocol.js";
import { resultPath } from "./relay-protocol.js";

const CACHE_MS = 5_000;

export interface GatewayLogView {
  at: number;
  lines: GatewayLogLine[];
}

export interface GatewayLogReaderOptions {
  store: Pick<RtdbRest, "get">;
  /** Read at each look, since pairing can change them while the daemon runs. */
  relay(): { channel: string; key: string } | null;
  now?: () => number;
}

/** The add-on's recent-events document, read on demand (at most once per 5 s). */
export class GatewayLogReader {
  private cache: { at: number; view: GatewayLogView | null } | null = null;
  private readonly now: () => number;

  constructor(private readonly options: GatewayLogReaderOptions) {
    this.now = options.now ?? Date.now;
  }

  async read(): Promise<GatewayLogView | null> {
    const now = this.now();
    if (this.cache && now - this.cache.at <= CACHE_MS) return this.cache.view;
    const relay = this.options.relay();
    let view: GatewayLogView | null = null;
    if (relay) {
      try {
        const doc = await this.options.store.get(resultPath(relay.channel, GATEWAY_LOG_ID));
        const log = doc ? readGatewayLog(relay.key, doc, now) : null;
        if (log) view = { at: log.at, lines: log.lines };
      } catch {
        if (this.cache) return this.cache.view;
      }
    }
    this.cache = { at: now, view };
    return view;
  }
}
