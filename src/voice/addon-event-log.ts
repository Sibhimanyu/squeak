import type { RtdbRest } from "../remote/rtdb-rest.js";
import {
  GATEWAY_LOG_ID,
  MAX_LOG_LINES,
  MAX_LOG_TEXT,
  sealGatewayLog,
  type GatewayLogDoc,
  type GatewayLogLine,
} from "./gateway-log-protocol.js";
import { resultPath } from "./relay-protocol.js";

/**
 * What the add-on has been doing, for the apps' Calls page: the last 50 notable events as plain sentences. Callers
 * pass only words they wrote themselves, never a secret, a PIN, a question or a key; the Home Assistant log stays
 * the full record.
 */
export class GatewayEventLog {
  private lines: GatewayLogLine[] = [];
  private changes = 0;

  constructor(private readonly now: () => number = Date.now) {}

  note(level: "info" | "warn", text: string): void {
    this.lines.push({ at: this.now(), level, text: text.slice(0, MAX_LOG_TEXT) });
    if (this.lines.length > MAX_LOG_LINES) this.lines.shift();
    this.changes += 1;
  }

  /** Bumps on every note, so a publisher can tell whether anything is new. */
  get version(): number {
    return this.changes;
  }

  doc(at: number): GatewayLogDoc {
    return { v: 1, id: GATEWAY_LOG_ID, at, lines: this.lines.map((l) => ({ ...l })) };
  }
}

/**
 * Publishes the log when it changed, at most once per 5 s, and once at start. A failed write is dropped: the next
 * change sends the whole log again, and a call must never wait on this.
 */
export function startLogPublisher(deps: {
  store: Pick<RtdbRest, "set">;
  channel: string;
  key: string;
  log: GatewayEventLog;
  now?: () => number;
  minGapMs?: number;
  checkMs?: number;
}): { stop(): void } {
  const now = deps.now ?? Date.now;
  const gap = deps.minGapMs ?? 5_000;
  let sentVersion = -1;
  let sentAt = Number.NEGATIVE_INFINITY;
  const send = (): void => {
    sentVersion = deps.log.version;
    sentAt = now();
    try {
      void deps.store
        .set(resultPath(deps.channel, GATEWAY_LOG_ID), sealGatewayLog(deps.key, deps.log.doc(sentAt)))
        .catch(() => undefined);
    } catch {
      // Sealing or a synchronous store failure: dropped like a failed write.
    }
  };
  send();
  const watcher = setInterval(() => {
    if (deps.log.version !== sentVersion && now() - sentAt >= gap) send();
  }, deps.checkMs ?? 1_000);
  watcher.unref?.();
  return { stop: () => clearInterval(watcher) };
}
