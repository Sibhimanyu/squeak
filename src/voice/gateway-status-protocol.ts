import type { ChannelDoc } from "../remote/firestore-rest.js";
import { openBody, sealBody } from "./relay-protocol.js";
import { cleanVersion } from "./addon-update.js";

/**
 * What the Home Assistant add-on tells the Mac about itself (docs: .context/gateway-pairing-contract.md): a sealed doc
 * at `voiceresult/gwstatus` on the paired channel. It never carries a secret, only whether the add-on is alive and
 * whether the PBX accepted its registration.
 */

export const GATEWAY_STATUS_ID = "gwstatus";

export interface GatewayStatusDoc {
  v: 1;
  id: "gwstatus";
  at: number;
  version: string;
  /** The newest add-on version the add-on itself found (x.y.z); absent from an older add-on or before its first look. */
  latestVersion?: string;
  sipRegistered: boolean;
  sipError?: string;
  paired: true;
  pin: "set" | "off" | "none";
}

export function sealGatewayStatus(key: string, body: GatewayStatusDoc): ChannelDoc {
  return sealBody(key, "res", GATEWAY_STATUS_ID, body, body.at);
}

/** The status, or null for a document that is not a valid one under this key. Age is the reader's call (`at`). */
export function readGatewayStatus(key: string, doc: ChannelDoc, now: number): GatewayStatusDoc | null {
  const body = openBody(key, "res", GATEWAY_STATUS_ID, doc);
  if (typeof body !== "object" || body === null) return null;
  const r = body as Record<string, unknown>;
  if (r.v !== 1 || r.id !== GATEWAY_STATUS_ID || r.paired !== true) return null;
  if (typeof r.at !== "number" || !Number.isFinite(r.at) || r.at > now + 5 * 60_000) return null;
  if (typeof r.version !== "string" || typeof r.sipRegistered !== "boolean") return null;
  if (r.pin !== "set" && r.pin !== "off" && r.pin !== "none") return null;
  if (r.sipError !== undefined && typeof r.sipError !== "string") return null;
  const latestVersion = cleanVersion(r.latestVersion);
  return {
    v: 1,
    id: GATEWAY_STATUS_ID,
    at: r.at,
    version: r.version.slice(0, 20),
    ...(latestVersion ? { latestVersion } : {}),
    sipRegistered: r.sipRegistered,
    ...(r.sipError ? { sipError: r.sipError.slice(0, 200) } : {}),
    paired: true,
    pin: r.pin,
  };
}
