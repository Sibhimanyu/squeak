// The Pond's people documents as the browser reads them (twins of `readMember`, `readPresence` and the key grant in
// src/flotilla/types.ts and service.ts, which import Node modules): who is in the Pond and with which keys, who is online, and the
// grant the Owner's Mac seals to a device.

import type { PondRole } from "../../../src/shared/shapes.js";

const rec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export interface Member {
  id: string;
  name: string;
  role: PondRole;
  /** Every key whose signature counts as this member's: the first key and each device's. */
  keys: string[];
  /** The ids of the member's devices (the first key's id is the member id). */
  deviceIds: string[];
  accountId: string | null;
}

export function readMemberDoc(value: unknown): Member | null {
  if (!rec(value) || !str(value["id"], 64) || !str(value["name"], 100) || !str(value["publicKey"], 200)) return null;
  const role = value["role"];
  if (role !== "owner" && role !== "member" && role !== "viewer") return null;
  const retired = value["primaryRetired"] === true;
  const keys = retired ? [] : [value["publicKey"]];
  const deviceIds = retired ? [] : [value["id"]];
  if (Array.isArray(value["devices"])) {
    for (const d of value["devices"].slice(0, 8)) {
      if (rec(d) && str(d["id"], 64) && str(d["publicKey"], 200)) {
        keys.push(d["publicKey"]);
        deviceIds.push(d["id"]);
      }
    }
  }
  return {
    id: value["id"],
    name: value["name"],
    role,
    keys,
    deviceIds,
    accountId: str(value["accountId"], 100) ? value["accountId"] : null,
  };
}

/** What the Owner's Mac seals to a device (`keys/<deviceId>`): the Pond key (every version it keeps) and a Pond token. */
export interface Grant {
  /** Version to base64 key. */
  keys: Map<number, string>;
  current: number;
  token: { value: string; expiresAt: number } | null;
  removed: boolean;
}

const KEY_B64 = /^[A-Za-z0-9+/=_-]{43,}$/;

export function readGrant(value: unknown): Grant | null {
  if (!rec(value)) return null;
  if (value["removed"] === true) return { keys: new Map(), current: 0, token: null, removed: true };
  const keys = new Map<number, string>();
  // {version, key, versions: {"1": ...}}: every version the Pond has had (#122), so a new device opens old documents too.
  if (rec(value["versions"])) {
    for (const [v, k] of Object.entries(value["versions"])) {
      const version = Number(v);
      if (Number.isInteger(version) && version >= 0 && typeof k === "string" && KEY_B64.test(k)) keys.set(version, k);
    }
  }
  if (num(value["version"]) && typeof value["key"] === "string" && KEY_B64.test(value["key"])) {
    keys.set(value["version"], value["key"]);
  }
  if (keys.size === 0) return null;
  const t = value["token"];
  const token =
    rec(t) && typeof t["value"] === "string" && num(t["expiresAt"])
      ? { value: t["value"], expiresAt: t["expiresAt"] }
      : null;
  const current = num(value["version"]) ? value["version"] : Math.max(...keys.keys());
  return { keys, current, token, removed: false };
}
