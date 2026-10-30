import type { ChannelDoc } from "../remote/firestore-rest.js";
import { openBody, sealBody } from "./relay-protocol.js";

/**
 * The add-on's recent notable events, for the apps' Calls page (docs: .context/calls-page-contract.md): a sealed doc
 * at `voiceresult/gwlog` on the paired channel, replaced whole each time. Short plain sentences only: never a secret,
 * a PIN, a question's text or a key. The Home Assistant log stays the full record.
 */

export const GATEWAY_LOG_ID = "gwlog";
export const MAX_LOG_LINES = 200;
export const MAX_LOG_TEXT = 320;

export interface GatewayLogLine {
  at: number;
  level: "info" | "warn";
  text: string;
}

export interface GatewayLogDoc {
  v: 1;
  id: "gwlog";
  at: number;
  lines: GatewayLogLine[];
}

export function sealGatewayLog(key: string, body: GatewayLogDoc): ChannelDoc {
  return sealBody(key, "res", GATEWAY_LOG_ID, body, body.at);
}

/** The log, or null for a document that is not a valid one under this key. Lines are clipped, never trusted. */
export function readGatewayLog(key: string, doc: ChannelDoc, now: number): GatewayLogDoc | null {
  const body = openBody(key, "res", GATEWAY_LOG_ID, doc);
  if (typeof body !== "object" || body === null) return null;
  const r = body as Record<string, unknown>;
  if (r.v !== 1 || r.id !== GATEWAY_LOG_ID || !Array.isArray(r.lines)) return null;
  if (typeof r.at !== "number" || !Number.isFinite(r.at) || r.at > now + 5 * 60_000) return null;
  const lines: GatewayLogLine[] = [];
  for (const raw of r.lines.slice(-MAX_LOG_LINES)) {
    if (typeof raw !== "object" || raw === null) continue;
    const l = raw as Record<string, unknown>;
    if (typeof l.at !== "number" || !Number.isFinite(l.at) || typeof l.text !== "string") continue;
    lines.push({ at: l.at, level: l.level === "warn" ? "warn" : "info", text: l.text.slice(0, MAX_LOG_TEXT) });
  }
  return { v: 1, id: GATEWAY_LOG_ID, at: r.at, lines };
}
