import type { ChannelDoc } from "./firestore-rest.js";
import type { ChannelStore } from "./remote-bridge.js";
import { logger } from "../utils/logger.js";

/**
 * An in-memory copy of the channel's documents, with change notification: what
 * the direct same-Wi-Fi path (local-channel.ts) serves, and what a phone's
 * local writes land in. Paths are the full `channels/<id>/<kind>/<doc>`.
 */
export class DocTree {
  private readonly docs = new Map<string, { doc: ChannelDoc; touchedAt: number }>();
  private readonly subscribers = new Set<{ prefix: string; notify: (path: string) => void }>();
  private bytes = 0;

  constructor(private readonly now: () => number = Date.now) {}

  get(path: string): ChannelDoc | null {
    return this.docs.get(path)?.doc ?? null;
  }

  set(path: string, doc: ChannelDoc): void {
    const previous = this.docs.get(path);
    this.bytes += sizeOf(doc) - (previous ? sizeOf(previous.doc) : 0);
    this.docs.set(path, { doc, touchedAt: this.now() });
    this.emit(path);
  }

  delete(path: string): boolean {
    const previous = this.docs.get(path);
    if (!previous) {
      return false;
    }
    this.bytes -= sizeOf(previous.doc);
    this.docs.delete(path);
    this.emit(path);
    return true;
  }

  /** The documents directly under `collection`. */
  list(collection: string): Array<{ id: string; doc: ChannelDoc }> {
    const prefix = `${collection}/`;
    const found: Array<{ id: string; doc: ChannelDoc }> = [];
    for (const [path, entry] of this.docs) {
      if (path.startsWith(prefix) && !path.slice(prefix.length).includes("/")) {
        found.push({ id: path.slice(prefix.length), doc: entry.doc });
      }
    }
    return found;
  }

  /** Calls `notify(changedPath)` for a change at or under `prefix`. Returns the way to stop. */
  subscribe(prefix: string, notify: (path: string) => void): () => void {
    const subscriber = { prefix, notify };
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /** Forgets documents of one `kind` (`channels/<id>/<kind>/…`) untouched for `maxAgeMs`. */
  prune(kind: string, maxAgeMs: number): void {
    const cutoff = this.now() - maxAgeMs;
    for (const [path, entry] of [...this.docs]) {
      if (path.split("/")[2] === kind && entry.touchedAt < cutoff) {
        this.delete(path);
      }
    }
  }

  clear(): void {
    for (const path of [...this.docs.keys()]) {
      this.delete(path);
    }
  }

  get size(): number {
    return this.docs.size;
  }

  /** Approximate bytes held, for a cap on what a phone may write. */
  get byteCount(): number {
    return this.bytes;
  }

  private emit(path: string): void {
    for (const { prefix, notify } of [...this.subscribers]) {
      if (path === prefix || path.startsWith(`${prefix}/`)) {
        try {
          notify(path);
        } catch (error) {
          logger.debug("doc tree subscriber failed", { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }
}

function sizeOf(doc: ChannelDoc): number {
  return doc.box.length + (doc.sig?.length ?? 0) + (doc.device?.length ?? 0) + 16;
}

/** Collections whose documents the direct path serves. Pairing never goes local; media stays cloud-only. */
const MIRRORED_KINDS = new Set(["state", "results", "live", "commands"]);
const HANDLED_TTL_MS = 15 * 60_000;
const HANDLED_MAX = 2_000;

function kindOf(path: string): string | null {
  // channels/<id>/<kind>[/<doc>]
  const parts = path.split("/");
  return parts[0] === "channels" && parts.length >= 3 ? (parts[2] ?? null) : null;
}

function isMirrored(path: string): boolean {
  const kind = kindOf(path);
  return kind !== null && MIRRORED_KINDS.has(kind);
}

function commandId(path: string): string | null {
  const parts = path.split("/");
  return parts[2] === "commands" && parts.length === 4 ? (parts[3] ?? null) : null;
}

/**
 * The bridge's store with the direct path folded in: every write also lands in
 * the `DocTree` the local server serves (so there is one code path for what the
 * Mac says, and both transports show the same sealed documents); what a phone
 * writes locally (presence, commands) is merged into what the bridge reads, so
 * every existing check runs on it unchanged; and a stream on either side wakes
 * the bridge's pass.
 *
 * A command's id, once the bridge has handled and deleted it, is remembered for
 * a while and hidden from later reads: the same command arriving on the other
 * transport after the first ran must not run again, and must not make the Mac
 * write a "refused: already received" result over the real one.
 */
export class MirrorStore implements ChannelStore {
  readonly tree: DocTree;
  private readonly handled = new Map<string, number>();
  private readonly cloudPresence = new Map<string, { box: string; seenAt: number }>();
  watch?: NonNullable<ChannelStore["watch"]>;

  constructor(
    private readonly inner: ChannelStore,
    options: { tree?: DocTree; now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.tree = options.tree ?? new DocTree(this.now);
    const innerWatch = inner.watch?.bind(inner);
    if (innerWatch) {
      this.watch = (path, onChange, watchOptions) => {
        const stopCloud = innerWatch(path, onChange, watchOptions);
        const stopLocal = this.tree.subscribe(path, () => onChange());
        return () => {
          stopCloud();
          stopLocal();
        };
      };
    }
  }

  private readonly now: () => number;

  async get(path: string): Promise<ChannelDoc | null> {
    if (!isMirrored(path)) {
      return this.inner.get(path);
    }
    const local = this.tree.get(path);
    let cloud: ChannelDoc | null = null;
    try {
      cloud = await this.inner.get(path);
    } catch (error) {
      // The cloud being out of reach must not stop a phone on the same Wi-Fi.
      logger.debug("cloud read failed; using the direct path's copy", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (path.endsWith("/state/presence")) {
      return this.newerPresence(path, local, cloud);
    }
    return newer(local, cloud);
  }

  /**
   * A phone writes its presence ping on one transport at a time, with no stamp the Mac can compare
   * (the stamp is sealed). So the newest is the one the Mac received (local, stamped on arrival) or first
   * saw change (cloud) most recently: a phone that moved from the cloud to the same Wi-Fi, or back, is
   * never read from the old path's last ping.
   */
  private newerPresence(path: string, local: ChannelDoc | null, cloud: ChannelDoc | null): ChannelDoc | null {
    if (cloud) {
      const seen = this.cloudPresence.get(path);
      if (!seen || seen.box !== cloud.box) {
        this.cloudPresence.set(path, { box: cloud.box, seenAt: this.now() });
      }
    }
    if (!local || !cloud) {
      return local ?? cloud;
    }
    return (local.at ?? 0) >= (this.cloudPresence.get(path)?.seenAt ?? 0) ? local : cloud;
  }

  async list(collection: string): Promise<Array<{ id: string; doc: ChannelDoc }>> {
    if (!isMirrored(collection)) {
      return this.inner.list(collection);
    }
    let cloud: Array<{ id: string; doc: ChannelDoc }> = [];
    try {
      cloud = await this.inner.list(collection);
    } catch (error) {
      // The cloud being out of reach must not stop a phone on the same Wi-Fi.
      logger.debug("cloud list failed; using the direct path's copy", {
        collection,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const merged = new Map<string, ChannelDoc>();
    for (const { id, doc } of this.tree.list(collection)) {
      merged.set(id, doc);
    }
    for (const { id, doc } of cloud) {
      merged.set(id, newer(merged.get(id) ?? null, doc) ?? doc);
    }
    const isCommands = kindOf(`${collection}/x`) === "commands";
    this.forgetHandled();
    return [...merged].flatMap(([id, doc]) => (isCommands && this.handled.has(id) ? [] : [{ id, doc }]));
  }

  async set(path: string, doc: ChannelDoc, options?: { timeoutMs?: number }): Promise<void> {
    if (isMirrored(path)) {
      this.tree.set(path, doc);
    }
    await this.inner.set(path, doc, options);
  }

  async delete(path: string): Promise<void> {
    const id = commandId(path);
    if (id) {
      this.remember(id);
    }
    if (isMirrored(path)) {
      this.tree.delete(path);
    }
    await this.inner.delete(path);
  }

  /* ---------- what the local server does on a phone's behalf ---------- */

  /** A phone's local write of its presence ping or a command. False when the command was already handled. */
  putFromPhone(path: string, doc: ChannelDoc): boolean {
    const id = commandId(path);
    if (id) {
      this.forgetHandled();
      if (this.handled.has(id)) {
        return false;
      }
    }
    // Presence is stamped on arrival: see `newerPresence`.
    this.tree.set(path, path.endsWith("/state/presence") ? { ...doc, at: this.now() } : doc);
    return true;
  }

  /**
   * A phone's local delete (taking a command back, or clearing a result it
   * read). Only the local copy: the Mac's own delete after handling is what
   * is remembered, so a withdrawn command can still go out on the other path.
   */
  deleteFromPhone(path: string): void {
    this.tree.delete(path);
  }

  private remember(id: string): void {
    this.forgetHandled();
    this.handled.set(id, this.now() + HANDLED_TTL_MS);
    if (this.handled.size > HANDLED_MAX) {
      const oldest = this.handled.keys().next().value;
      if (oldest !== undefined) {
        this.handled.delete(oldest);
      }
    }
  }

  private forgetHandled(): void {
    const now = this.now();
    for (const [id, until] of this.handled) {
      if (until < now) {
        this.handled.delete(id);
      }
    }
  }

  /** Drops what nothing will ever delete: a command or result left behind, an old live turn. */
  prune(): void {
    this.tree.prune("commands", 15 * 60_000);
    this.tree.prune("results", 30 * 60_000);
    this.tree.prune("live", 30 * 60_000);
  }
}

function newer(a: ChannelDoc | null, b: ChannelDoc | null): ChannelDoc | null {
  if (!a || !b) {
    return a ?? b;
  }
  return (b.at ?? 0) > (a.at ?? 0) ? b : a;
}
