/**
 * The `move` document (docs/cloud-layer.md, "Moving"): one sealed `state` document the Mac writes on the
 * store a channel lives in now, telling the devices on that channel where it lives next.
 *
 *   path   channels/<channelId>/state/move
 *   body   {"v":1,"provider":"firebase","r":"https://<db>","at":<ms>}
 *          {"v":1,"provider":"catalyst","c":"https://<app>/server/squeak_relay","ck":"<relay key>","at":<ms>}
 *
 * A phone's copy is sealed with the channel key (AES-256-GCM, `remote-crypto.ts`) and carries `at`, like every
 * Mac-written `state` document. The add-on's copy is also bound by the voice HMAC (`sealBody`, direction
 * `move`, id `move`). A device acts only on a body it opened, that names a location passing the host checks,
 * and whose `at` is newer than the last move it took.
 */

import { open, seal } from "../remote/remote-crypto.js";
import type { ChannelDoc } from "../remote/firestore-rest.js";
import { openBody, sealBody } from "../voice/relay-protocol.js";
import { grantFields, readLocation, type CloudLocation } from "./location.js";
import type { CloudStore } from "./store.js";

export const MOVE_DOC = "move";

export function movePath(channel: string): string {
  return `channels/${channel}/state/${MOVE_DOC}`;
}

export interface Move {
  location: CloudLocation;
  at: number;
}

function bodyOf(location: CloudLocation, at: number): Record<string, unknown> {
  return { v: 1, provider: location.provider, ...grantFields(location), at };
}

/** A phone channel's move: sealed with the channel key. */
export function sealPhoneMove(channelKey: string, location: CloudLocation, at: number): ChannelDoc {
  return { box: seal(channelKey, bodyOf(location, at)), at };
}

/** The add-on channel's move: sealed and bound to its direction and id. */
export function sealAddonMove(channelKey: string, location: CloudLocation, at: number): ChannelDoc {
  return sealBody(channelKey, "move", MOVE_DOC, bodyOf(location, at), at);
}

function parse(body: unknown): Move | null {
  if (!body || typeof body !== "object") return null;
  const r = body as Record<string, unknown>;
  if (r.v !== 1 || typeof r.at !== "number" || !Number.isFinite(r.at)) return null;
  const location = readLocation(r);
  return location ? { location, at: r.at } : null;
}

export function readPhoneMove(channelKey: string, doc: ChannelDoc): Move | null {
  try {
    return parse(open(channelKey, doc.box));
  } catch {
    return null;
  }
}

export function readAddonMove(channelKey: string, doc: ChannelDoc): Move | null {
  return parse(openBody(channelKey, "move", MOVE_DOC, doc));
}

/**
 * Watches an add-on channel's `move` on the store it is on and calls `onMove` for a verified one newer than
 * `lastAt` (kept by the caller across restarts). The returned function stops it.
 */
export function watchAddonMove(args: {
  store: Pick<CloudStore, "get" | "watch">;
  channel: string;
  key: string;
  lastAt: () => number;
  onMove: (move: Move) => void | Promise<void>;
  /** The safety net when no event arrives. */
  pollMs?: number;
}): () => void {
  let busy = false;
  const check = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const doc = await args.store.get(movePath(args.channel));
      const move = doc ? readAddonMove(args.key, doc) : null;
      if (move && move.at > args.lastAt()) await args.onMove(move);
    } catch {
      // Offline for a moment: the next wake or poll looks again.
    } finally {
      busy = false;
    }
  };
  const unwatch = args.store.watch(movePath(args.channel), () => void check());
  const timer = setInterval(() => void check(), args.pollMs ?? 60_000);
  timer.unref?.();
  return () => {
    unwatch();
    clearInterval(timer);
  };
}
