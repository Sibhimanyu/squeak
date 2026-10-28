import crypto from "node:crypto";

import type { RtdbRest } from "../remote/rtdb-rest.js";
import type { ReplyFailureHandler, ReplyOutcome } from "../fleet/session-reply.js";
import { logger } from "../utils/logger.js";
import {
  dirPath,
  downPath,
  MAX_CHOICES,
  readUp,
  sealDirectory,
  sealDown,
  UP_KIND,
  upPath,
  type DirectoryDoc,
  type DownMessage,
  type UpMessage,
} from "./memo-protocol.js";
import type { Transcriber } from "./transcribe.js";

export type MemoStore = Pick<RtdbRest, "list" | "set" | "delete" | "watch">;

/** A chat that can take a message right now. */
export interface MemoTarget {
  target: string;
  label: string;
}

export interface MemoInboxDependencies {
  store: MemoStore;
  channel: string;
  key: string;
  transcriber: Transcriber;
  /** Chats that can take a message now, most pressing first. Read each time the list is published. */
  targets: () => MemoTarget[];
  /** Whether this chat can still take one at the moment of sending (it may have started working). */
  canSend: (target: string) => boolean;
  send: (target: string, text: string, onFailed: ReplyFailureHandler) => Promise<ReplyOutcome>;
  /** The extension allowed to call in: the Mac's "who to ring" setting. */
  caller: () => string | null;
  /** A one-off note to Telegram and Cliq: what was sent by phone. */
  note: (text: string) => void;
  now?: () => number;
}

interface Pending {
  target: string;
  label: string;
  text: string;
  at: number;
}

const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 20;
const KEEP_VERSIONS = 8;
const REPUBLISH_MS = 30 * 60_000;
const REMEMBER = 200;
/** A phone is not a keyboard: this many sends an hour is a stuck loop, not a person. */
const MAX_SENDS_PER_HOUR = 20;

/**
 * The Mac's half of calling in. The gateway on Home Assistant answers the call and checks the PIN; this
 * publishes who can take a message (as numbers), transcribes a recorded memo with Whisper, reads it back, and,
 * only when the gateway says "send it" for that memo, sends the words it transcribed itself through the same
 * replier as every other surface. The gateway never supplies text or names a target.
 */
export class MemoInbox {
  private readonly now: () => number;
  private unwatch: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = false;
  private dirty = false;
  private readonly handled: string[] = [];
  private readonly pending = new Map<string, Pending>();
  /** Directory versions the gateway may still be reading from, each as the targets by number. */
  private readonly versions = new Map<string, string[]>();
  private published: { version: string; at: number } | null = null;
  private readonly sends: number[] = [];

  constructor(private readonly deps: MemoInboxDependencies) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    this.unwatch = this.deps.store.watch(`channels/${this.deps.channel}/${UP_KIND}`, () => this.wake(), {
      onError: (error) => logger.warn("voice memo stream", { error: error.message }),
    });
    this.timer = setInterval(() => {
      this.wake();
      void this.publish().catch(() => undefined);
    }, 60_000);
    this.timer.unref?.();
    void this.publish().catch(() => undefined);
  }

  stop(): void {
    this.stopped = true;
    this.unwatch?.();
    this.unwatch = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Writes the list of who can take a message, when it changed (or is getting old). */
  async publish(): Promise<void> {
    const targets = this.deps.targets().slice(0, MAX_CHOICES);
    const caller = this.deps.caller();
    const items = targets.map((t, index) => ({ n: index + 1, label: t.label }));
    const version = crypto
      .createHash("sha256")
      .update(JSON.stringify({ items, caller, targets: targets.map((t) => t.target) }))
      .digest("hex")
      .slice(0, 12);
    const at = this.now();
    if (this.published?.version === version && at - this.published.at < REPUBLISH_MS) return;
    this.versions.set(
      version,
      targets.map((t) => t.target),
    );
    while (this.versions.size > KEEP_VERSIONS) this.versions.delete(this.versions.keys().next().value as string);
    const doc: DirectoryDoc = { v: 1, at, version, caller, items };
    await this.deps.store.set(dirPath(this.deps.channel), sealDirectory(this.deps.key, doc));
    this.published = { version, at };
  }

  private wake(): void {
    if (this.stopped) return;
    if (this.running) {
      this.dirty = true;
      return;
    }
    this.running = true;
    void this.pass()
      .catch((error: unknown) =>
        logger.warn("voice memo pass failed", { error: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => {
        this.running = false;
        if (this.dirty) {
          this.dirty = false;
          this.wake();
        }
      });
  }

  /** One pass over what the gateway sent; exposed for tests. */
  async pass(): Promise<void> {
    const { store, channel, key } = this.deps;
    for (const { id, doc } of await store.list(`channels/${channel}/${UP_KIND}`)) {
      if (this.stopped) return;
      if (this.handled.includes(id)) {
        await store.delete(upPath(channel, id)).catch(() => undefined);
        continue;
      }
      const read = readUp(key, id, doc, this.now());
      // Remember first, then claim: a second pass must see it as taken, and an undeletable one is not run twice.
      this.handled.push(id);
      if (this.handled.length > REMEMBER) this.handled.shift();
      try {
        await store.delete(upPath(channel, id));
      } catch {
        this.handled.splice(this.handled.indexOf(id), 1);
        continue;
      }
      if (!read.ok) {
        logger.info("voice memo dropped", { reason: read.reason });
        continue;
      }
      const answer = await this.handle(read.message).catch((error: unknown): DownMessage => {
        logger.warn("voice memo failed", { error: error instanceof Error ? error.message : String(error) });
        return { v: 1, id, at: this.now(), status: "refused", reason: "Something went wrong on the Mac." };
      });
      await store.set(downPath(channel, id), sealDown(key, answer));
    }
  }

  private refuse(id: string, reason: string): DownMessage {
    return { v: 1, id, at: this.now(), status: "refused", reason };
  }

  private async handle(message: UpMessage): Promise<DownMessage> {
    const now = this.now();
    for (const [memoId, pending] of this.pending) if (now - pending.at > PENDING_TTL_MS) this.pending.delete(memoId);

    if (message.kind === "memo") {
      const targets = this.versions.get(message.dirVersion);
      const target = targets?.[message.choice - 1];
      if (!target) return this.refuse(message.id, "That list is out of date. Call again.");
      const label = this.deps.targets().find((t) => t.target === target)?.label ?? `chat ${message.choice}`;
      let text: string;
      try {
        text = await this.deps.transcriber.transcribe(Buffer.from(message.audio, "base64"));
      } catch (error) {
        logger.warn("voice memo could not be transcribed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return this.refuse(message.id, "I could not make that out.");
      }
      if (!text) return this.refuse(message.id, "I did not hear anything.");
      this.pending.set(message.id, { target, label, text, at: this.now() });
      while (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value as string);
      return { v: 1, id: message.id, at: this.now(), status: "transcript", text, label };
    }

    const pending = this.pending.get(message.memoId);
    if (!pending) return this.refuse(message.id, "That message is no longer waiting.");
    this.pending.delete(message.memoId);
    while (this.sends.length > 0 && now - this.sends[0]! > 60 * 60_000) this.sends.shift();
    if (this.sends.length >= MAX_SENDS_PER_HOUR)
      return this.refuse(message.id, "Too many messages by phone this hour.");
    if (!this.deps.canSend(pending.target)) {
      return this.refuse(message.id, `${pending.label} is busy right now. Send it from the app.`);
    }
    this.sends.push(now);
    const outcome = await this.deps.send(pending.target, pending.text, (reason) => {
      this.deps.note(`The message you phoned in for ${pending.label} did not go through: ${reason}`);
    });
    if (outcome.status === "refused" || outcome.status === "unconfirmed") {
      return this.refuse(message.id, outcome.reason.slice(0, 200));
    }
    const shown = pending.text.length > 200 ? `${pending.text.slice(0, 200)}…` : pending.text;
    this.deps.note(`Sent by phone to ${pending.label}: “${shown}”`);
    return { v: 1, id: message.id, at: this.now(), status: "sent" };
  }
}
