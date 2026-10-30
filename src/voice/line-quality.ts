/**
 * How a call's line was, from baresip's `callstat` block: jitter, loss and round trip as numbers, and one verdict a
 * person can read. No fleet imports: the add-on bundles this file.
 *
 * The thresholds follow what G.711 over RTP tolerates. Without packet-loss concealment a codec like this is
 * audibly damaged by about 1% loss and badly by 5%; adaptive jitter buffers absorb up to roughly 30 ms and
 * start to add delay or drop frames beyond 60 ms; ITU-T G.114 keeps conversation comfortable under ~150 ms one way
 * (a ~300 ms round trip) and degraded beyond ~400 ms.
 */

export type QualityVerdict = "good" | "fair" | "poor";

export interface CallQuality {
  verdict: QualityVerdict;
  jitterMs?: number;
  lossPct?: number;
  rttMs?: number;
}

export const QUALITY_FAIR = { jitterMs: 30, lossPct: 1, rttMs: 300 } as const;
export const QUALITY_POOR = { jitterMs: 60, lossPct: 5, rttMs: 400 } as const;

/** The second number on a line like `jitter:  0.0  9.4 (ms)`: the receive side, which is what the listener hears. */
function receiveColumn(data: string, label: RegExp): number | undefined {
  for (const line of data.split("\n")) {
    if (!label.test(line.trim())) continue;
    const numbers = line.replace(label, "").match(/-?\d+(?:\.\d+)?/g);
    if (numbers && numbers.length >= 2) return Number(numbers[1]);
    if (numbers && numbers.length === 1) return Number(numbers[0]);
  }
  return undefined;
}

export function parseCallStats(data: string): Omit<CallQuality, "verdict"> | null {
  const jitter = receiveColumn(data, /^jitter:?/i);
  const lost = receiveColumn(data, /^lost:?/i);
  const packets = receiveColumn(data, /^packets:?/i);
  const rttMatch = /\brtt\b[^\d-]*(-?\d+(?:\.\d+)?)/i.exec(data);
  const rtt = rttMatch ? Number(rttMatch[1]) : undefined;
  const out: Omit<CallQuality, "verdict"> = {};
  if (jitter !== undefined && Number.isFinite(jitter)) out.jitterMs = round(jitter);
  if (lost !== undefined && packets !== undefined && packets + lost > 0) {
    out.lossPct = round((Math.max(0, lost) / (packets + Math.max(0, lost))) * 100);
  }
  if (rtt !== undefined && Number.isFinite(rtt) && rtt >= 0) out.rttMs = round(rtt);
  return Object.keys(out).length ? out : null;
}

const round = (value: number): number => Math.round(value * 10) / 10;

/** Poor if any measure crosses its poor line, fair if any crosses its fair line, otherwise good. */
export function verdictOf(measures: Omit<CallQuality, "verdict">): QualityVerdict {
  const worst = (line: typeof QUALITY_FAIR | typeof QUALITY_POOR): boolean =>
    (measures.jitterMs ?? 0) > line.jitterMs ||
    (measures.lossPct ?? 0) > line.lossPct ||
    (measures.rttMs ?? 0) > line.rttMs;
  return worst(QUALITY_POOR) ? "poor" : worst(QUALITY_FAIR) ? "fair" : "good";
}

export function qualityOf(data: string): CallQuality | null {
  const measures = parseCallStats(data);
  return measures ? { verdict: verdictOf(measures), ...measures } : null;
}

/** A quality from an untrusted (sealed) document, or undefined: a verdict word and plain bounded numbers. */
export function readQuality(value: unknown): CallQuality | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (v.verdict !== "good" && v.verdict !== "fair" && v.verdict !== "poor") return undefined;
  const num = (x: unknown, max: number): number | undefined =>
    typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= max ? x : undefined;
  const jitterMs = num(v.jitterMs, 100_000);
  const lossPct = num(v.lossPct, 100);
  const rttMs = num(v.rttMs, 100_000);
  return {
    verdict: v.verdict,
    ...(jitterMs !== undefined ? { jitterMs } : {}),
    ...(lossPct !== undefined ? { lossPct } : {}),
    ...(rttMs !== undefined ? { rttMs } : {}),
  };
}
