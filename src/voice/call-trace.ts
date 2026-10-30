import fs from "node:fs";
import path from "node:path";

import { logger } from "../utils/logger.js";
import type { CallEntry, CallHistory } from "./call-history.js";
import { sentSummary } from "./call-summary.js";
import type { GatewayLogLine } from "./gateway-log-protocol.js";

/**
 * The step-by-step log behind each call on the Calls page. Two sources, both kept on this Mac only (0600, atomic
 * writes): what this Mac did (`voice-call-events.json`) and what the add-on wrote into its sealed event log
 * (`voice-gateway-events.json`). Unlike `voice-calls.json`, these may hold the words spoken or heard: the owner
 * asked to see them. Never a PIN digit, which no writer here receives.
 */

export type CallEventSource = "mac" | "add-on";
export type CallEventKind = "step" | "said" | "heard" | "key" | "warn";

export interface CallEvent {
  at: number;
  source: CallEventSource;
  kind: CallEventKind;
  text: string;
  ms?: number;
}

interface StoredEvent extends CallEvent {
  label?: string;
}

export const MAC_RING = 600;
export const GATEWAY_RING = 400;
export const MAX_EVENTS_PER_CALL = 80;
const MAX_TEXT = 320;
const BEFORE_MS = 3_000;
const AFTER_MS = 20_000;
/** An answered call-in with no "ended" line this long after is taken as over. */
const STALE_OPEN_MS = 10 * 60_000;

const KINDS: ReadonlySet<string> = new Set(["step", "said", "heard", "key", "warn"]);

function parseLine(line: GatewayLogLine): CallEvent | null {
  if (typeof line.text !== "string" || !Number.isFinite(line.at)) return null;
  const match = /^(step|said|heard|key):\s*(.*)$/s.exec(line.text);
  const kind = (match?.[1] ?? "step") as CallEventKind;
  const text = (match ? match[2]! : line.text).slice(0, MAX_TEXT);
  return { at: line.at, source: "add-on", kind: line.level === "warn" ? "warn" : kind, text };
}

function eventId(e: CallEvent): string {
  return `${e.at}|${e.kind}|${e.text}`;
}

function readRing(file: string, source: CallEventSource, max: number): StoredEvent[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { events?: unknown };
    if (!Array.isArray(raw.events)) return [];
    const out: StoredEvent[] = [];
    for (const item of raw.events) {
      const e = item as Partial<StoredEvent> | null;
      if (!e || typeof e.at !== "number" || !Number.isFinite(e.at) || typeof e.text !== "string") continue;
      if (typeof e.kind !== "string" || !KINDS.has(e.kind)) continue;
      const event: StoredEvent = { at: e.at, source, kind: e.kind as CallEventKind, text: e.text.slice(0, MAX_TEXT) };
      if (typeof e.ms === "number" && Number.isFinite(e.ms)) event.ms = e.ms;
      if (typeof e.label === "string" && e.label) event.label = e.label.slice(0, 80);
      out.push(event);
    }
    return out.sort((a, b) => a.at - b.at).slice(-max);
  } catch {
    return [];
  }
}

function writeRing(file: string, events: StoredEvent[]): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ v: 1, events })}\n`, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    logger.warn("call trace could not be saved", { error: error instanceof Error ? error.message : String(error) });
  }
}

export class CallTrace {
  private readonly macFile: string;
  private readonly gatewayFile: string;
  private macEvents: StoredEvent[];
  private gatewayEvents: StoredEvent[];
  private readonly seen = new Set<string>();

  constructor(
    location: string | { mac: string; gateway: string },
    private readonly now: () => number = Date.now,
  ) {
    this.macFile = typeof location === "string" ? path.join(location, "voice-call-events.json") : location.mac;
    this.gatewayFile =
      typeof location === "string" ? path.join(location, "voice-gateway-events.json") : location.gateway;
    this.macEvents = readRing(this.macFile, "mac", MAC_RING);
    this.gatewayEvents = readRing(this.gatewayFile, "add-on", GATEWAY_RING);
    for (const e of this.gatewayEvents) this.seen.add(eventId(e));
  }

  /** One thing this Mac did or heard. `label` (the chat) is kept to name an incoming call, never sent to the app. */
  mac(kind: CallEventKind, text: string, extra: { ms?: number; label?: string } = {}): void {
    if (!KINDS.has(kind) || typeof text !== "string" || !text) return;
    const event: StoredEvent = { at: this.now(), source: "mac", kind, text: text.slice(0, MAX_TEXT) };
    if (typeof extra.ms === "number" && Number.isFinite(extra.ms)) event.ms = Math.round(extra.ms);
    if (extra.label) event.label = extra.label.slice(0, 80);
    this.macEvents.push(event);
    if (this.macEvents.length > MAC_RING) this.macEvents = this.macEvents.slice(-MAC_RING);
    writeRing(this.macFile, this.macEvents);
  }

  /** Takes the add-on's log lines; repeats (same time and words) are ignored. Returns how many were new. */
  ingestGateway(lines: readonly GatewayLogLine[]): number {
    let added = 0;
    for (const line of lines) {
      const event = parseLine(line);
      if (!event) continue;
      const id = eventId(event);
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      this.gatewayEvents.push(event);
      added += 1;
    }
    if (added === 0) return 0;
    this.gatewayEvents.sort((a, b) => a.at - b.at);
    if (this.gatewayEvents.length > GATEWAY_RING) {
      this.gatewayEvents = this.gatewayEvents.slice(-GATEWAY_RING);
      this.seen.clear();
      for (const e of this.gatewayEvents) this.seen.add(eventId(e));
    }
    writeRing(this.gatewayFile, this.gatewayEvents);
    return added;
  }

  private window(from: number, to: number): StoredEvent[] {
    const inside = (e: StoredEvent): boolean => e.at >= from && e.at <= to;
    return [...this.macEvents.filter(inside), ...this.gatewayEvents.filter(inside)].sort((a, b) => a.at - b.at);
  }

  /** The events in a call's window, Mac and add-on merged, oldest first, at most 80. */
  eventsFor(entry: Pick<CallEntry, "at" | "durationMs">): CallEvent[] {
    return this.window(entry.at - BEFORE_MS, entry.at + entry.durationMs + AFTER_MS)
      .slice(0, MAX_EVENTS_PER_CALL)
      .map((e) => {
        const { label, ...event } = e;
        void label;
        return event;
      });
  }

  /** Whether anything was logged since `since`: callers use it to decide how often to look at the add-on. */
  activeSince(since: number): boolean {
    const last = Math.max(this.macEvents.at(-1)?.at ?? 0, this.gatewayEvents.at(-1)?.at ?? 0);
    return last >= since;
  }

  /**
   * Writes the calls people made to Squeak into the history, read off the add-on's lines. A call that was answered is
   * recorded once its window has closed (20 s after it ended), so the Mac's own lines about it (the chat, the send)
   * are in; one that was refused at once. The id comes from the time, so a second pass records nothing twice.
   * Returns how many were added.
   */
  deriveIncoming(history: Pick<CallHistory, "record" | "has">): number {
    const now = this.now();
    const lines = this.gatewayEvents.filter((e) => e.kind === "step" || e.kind === "warn");
    let added = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const refused = /^Call in(?: from extension .+?)? refused: ?(.*)$/.exec(line.text);
      if (refused) {
        const reason = refused[1] || "refused";
        added += history.record(
          { at: line.at, kind: "incoming", outcome: "failed", failure: reason, durationMs: 0 },
          `in-${line.at}`,
        )
          ? 1
          : 0;
        continue;
      }
      if (!/^Call in answered from extension /.test(line.text)) continue;
      const id = `in-${line.at}`;
      if (history.has(id)) continue;
      let ended: StoredEvent | null = null;
      let last = line;
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j]!;
        if (/^Call in answered from extension /.test(next.text)) break;
        last = next;
        if (/^Call in ended after /.test(next.text)) {
          ended = next;
          break;
        }
      }
      const closeAt = ended ? ended.at : last.at + STALE_OPEN_MS;
      if (now < closeAt + (ended ? AFTER_MS : 0)) continue;
      const seconds = ended ? Number(/after ([\d.]+) s/.exec(ended.text)?.[1]) : NaN;
      const durationMs = Number.isFinite(seconds) ? Math.round(seconds * 1000) : Math.max(0, closeAt - line.at);
      const inWindow = this.window(line.at - BEFORE_MS, line.at + durationMs + AFTER_MS);
      const failed = inWindow.find((e) => e.kind === "warn" || /^The call-in failed/.test(e.text));
      const heard = inWindow.some((e) => e.kind === "heard" || /^Recorded /.test(e.text));
      const sent = inWindow.some((e) => /^Message sent/.test(e.text));
      const label = this.macEvents.find(
        (e) => e.label && e.at >= line.at - BEFORE_MS && e.at <= line.at + durationMs + AFTER_MS,
      )?.label;
      const outcome = failed && !heard ? "failed" : heard ? "answered" : "unanswered";
      // The words that were sent: the last thing heard in the call's window (a re-recording replaces the first).
      const said = sent ? inWindow.filter((e) => e.kind === "heard").pop()?.text : undefined;
      const recorded = history.record(
        {
          at: line.at,
          kind: "incoming",
          outcome,
          durationMs,
          ...(label ? { label } : {}),
          ...(outcome === "answered" ? { sent } : {}),
          ...(sent && said ? { summary: sentSummary(label, said) } : {}),
          ...(outcome === "failed" && failed ? { failure: failed.text } : {}),
        },
        id,
      );
      if (recorded) added += 1;
    }
    return added;
  }
}
