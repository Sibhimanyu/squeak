/**
 * The channel's cloud store, whichever provider holds it (docs/cloud-layer.md): exactly the public
 * surface of `RtdbRest`, which implements it unchanged, and `CatalystStore`, the second implementation.
 */

import type { ChannelDoc } from "../remote/firestore-rest.js";

/** Why a watch woke: a notice from the stream, the safety poll, a (re)connect, or the first call. */
export type WatchSource = "stream" | "poll" | "open" | "first";

export interface CloudWatchOptions {
  /** The safety poll's interval for this watch (a store that polls; default its own). */
  pollMs?: number;
  /** Called when the stream is (re)connected, so a caller can catch up on what it missed. */
  onOpen?: () => void;
  /** Called with each failure; the watch reconnects by itself. */
  onError?: (error: Error) => void;
}

export interface CloudStore {
  get(path: string): Promise<ChannelDoc | null>;
  /** `timeoutMs`: a big write's own limit (a film's chunk). */
  set(path: string, doc: ChannelDoc, options?: { timeoutMs?: number }): Promise<void>;
  list(collection: string): Promise<Array<{ id: string; doc: ChannelDoc }>>;
  delete(path: string): Promise<void>;
  /** A wake-up when anything at or under `path` may have changed; never carries data. Returns the unwatch. */
  watch(path: string, onChange: (source?: WatchSource) => void, options?: CloudWatchOptions): () => void;
}
