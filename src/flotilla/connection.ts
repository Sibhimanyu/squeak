/**
 * The one connection state every Mac surface draws (docs/spec.md, People and remote, "Live and honest"; docs/cloud-layer.md,
 * "Live notices"). Surfaces decide nothing: this is where "Live", "Reconnecting…" and "<Owner>'s Mac offline" are worked
 * out, per Pond and overall, from three facts only: whether the live stream to the cloud is up, whether the cloud could be
 * read at all, and (for someone else's Pond) whether the Owner's Mac is online.
 */

export type ConnectionState = "live" | "reconnecting" | "owner-offline";

export interface Connection {
  state: ConnectionState;
  /** The words, made here so no surface words them: "Live", "Reconnecting…" or "Sibhi's Mac offline". */
  line: string;
}

export interface ConnectionFacts {
  /** The device's live stream (`LiveClient.state`); null when `squeak-live` is not configured (the old notice path). */
  stream: "live" | "reconnecting" | null;
  /** The relay answered the last read of this Pond; false is the last good read being served. */
  reachable: boolean;
  /** This person owns the Pond: their own Mac is never "offline" to them. */
  owner: boolean;
  /** Whether the Owner's Mac is online, as far as the Pond's presence says; undefined when not known yet. */
  ownerOnline?: boolean | undefined;
  ownerName?: string;
}

export const LIVE_LINE = "Live";
export const RECONNECTING_LINE = "Reconnecting…";

/** "Sibhi's Mac offline": the first word of the Owner's name, "The owner's" when there is none. */
export function ownerOfflineWord(name: string | undefined): string {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return `${first || "The owner"}’s Mac offline`;
}

export function connectionOf(f: ConnectionFacts): Connection {
  // Without a connection nothing else can be known (not even the Owner's presence), so this word wins.
  if (!f.reachable || f.stream === "reconnecting") return { state: "reconnecting", line: RECONNECTING_LINE };
  if (!f.owner && f.ownerOnline === false) return { state: "owner-offline", line: ownerOfflineWord(f.ownerName) };
  return { state: "live", line: LIVE_LINE };
}

/**
 * The whole Mac in one word. Reconnecting when any Pond is; the Owner's Mac offline only when every Pond this person is
 * in but does not own has an offline Owner (one Owner away says nothing about the rest); otherwise Live. Local Ponds
 * (no connection of their own) are not counted.
 */
export function overallConnection(ponds: Array<{ connection?: Connection; owner: boolean }>): Connection {
  const shared = ponds.filter((p) => p.connection);
  if (shared.some((p) => p.connection!.state === "reconnecting")) {
    return { state: "reconnecting", line: RECONNECTING_LINE };
  }
  const others = shared.filter((p) => !p.owner);
  if (others.length > 0 && others.every((p) => p.connection!.state === "owner-offline")) {
    return others[0]!.connection!;
  }
  return { state: "live", line: LIVE_LINE };
}
