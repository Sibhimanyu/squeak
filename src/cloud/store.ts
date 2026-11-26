/**
 * The channel's cloud store, whichever provider holds it (docs/cloud-layer.md): exactly the public
 * surface of `RtdbRest`, which implements it unchanged, and `CatalystStore`, the second implementation.
 */

/** One sealed channel document: what every store keeps, whatever the provider. */
export interface ChannelDoc {
  box: string;
  sig?: string;
  device?: string;
  at?: number;
  /** The Pond's change-feed sequence number the relay stamped on a content write (docs/cloud-layer.md); never sent by a writer. */
  seq?: number;
}

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
  /**
   * Sealed pictures and files (docs/cloud-layer.md, "Pictures and files"): only a store with a blob bucket behind it has these (the
   * Catalyst relay); the Realtime Database has none. `ref` names the post document the blob belongs to, so the cloud can drop the
   * blob when that post goes. `getBlob` is null when the cloud no longer holds it. Both throw `BlobRefused` with a sentence to show.
   */
  putBlob?(pondId: string, id: string, sealed: Buffer, ref: { kind: "room" | "rposts"; doc: string }): Promise<void>;
  getBlob?(pondId: string, id: string): Promise<Buffer | null>;
}

/** The cloud would not keep or hand over a blob; `message` is a plain sentence a person can read. */
export class BlobRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
