import fs from "node:fs";

import type { ChannelDoc } from "./firestore-rest.js";
import type { ChannelStore } from "./remote-bridge.js";
import { logger } from "../utils/logger.js";

/**
 * Shared server mode (SQUEAK_REMOTE_SHARED=1): the phone channel on the owner's free Spark project, whose rules
 * (firebase/shared/database.rules.json) allow only state/pairing/commands/results. These limits keep an honest
 * install far below Spark's 10 GB/month download, so about fifteen users fit.
 */
export const SHARED_ACTIVE_POLL_MS = 10_000;
export const SHARED_IDLE_POLL_MS = 60_000;
export const SHARED_ACTIVE_PUBLISH_MS = 10_000;
export const SHARED_IDLE_PUBLISH_MS = 5 * 60_000;
export const SHARED_CHANGE_PUBLISH_MIN_GAP_MS = 10_000;
/** The `recent` state document is written at most this often. */
export const SHARED_RECENT_MIN_GAP_MS = 5 * 60_000;
/** The sealed box of any shared document stays under this (the rules' own limit is 65536). */
export const SHARED_BOX_MAX_CHARS = 60_000;
/** The budget file is rewritten at most this often (and on stop). */
export const SHARED_BUDGET_SAVE_MS = 30_000;
export const SHARED_DAILY_BUDGET_BYTES = 20 * 1024 * 1024;

/** Bytes of box the bridge writes and reads in cloud traffic per local day; over it, cloud traffic pauses until midnight. */
export class CloudBudget {
  private day = "";
  private bytes = 0;
  private told = false;

  private savedAt = 0;

  /** `file`: where the day's count is kept (0600), so a restart or crash loop cannot reset it. */
  constructor(
    readonly budgetBytes: number = SHARED_DAILY_BUDGET_BYTES,
    private readonly now: () => number = Date.now,
    private readonly file: string | null = null,
  ) {
    this.load();
  }

  private today(): string {
    const date = new Date(this.now());
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  }

  private load(): void {
    if (!this.file) {
      return;
    }
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as { day?: unknown; usedBytes?: unknown };
      if (saved.day === this.today() && typeof saved.usedBytes === "number" && saved.usedBytes >= 0) {
        this.day = saved.day;
        this.bytes = saved.usedBytes;
      }
    } catch {
      // No file yet, or unreadable: start the day at zero.
    }
  }

  /** Writes the count now (also called on stop). */
  flush(): void {
    if (!this.file) {
      return;
    }
    this.savedAt = this.now();
    try {
      fs.writeFileSync(this.file, JSON.stringify({ day: this.day || this.today(), usedBytes: this.bytes }), {
        mode: 0o600,
      });
      fs.chmodSync(this.file, 0o600);
    } catch (error) {
      logger.debug("could not save the shared budget", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private roll(): void {
    const day = this.today();
    if (day !== this.day) {
      this.day = day;
      this.bytes = 0;
      this.told = false;
    }
  }

  add(bytes: number): void {
    this.roll();
    this.bytes += Math.max(0, bytes);
    if (this.file && this.now() - this.savedAt >= SHARED_BUDGET_SAVE_MS) {
      this.flush();
    }
  }

  get usedBytes(): number {
    this.roll();
    return this.bytes;
  }

  exceeded(): boolean {
    return this.usedBytes >= this.budgetBytes;
  }

  /** Local midnight (ms) while exceeded, else null. */
  get pausedUntil(): number | null {
    if (!this.exceeded()) {
      return null;
    }
    const date = new Date(this.now());
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  }

  /** True once per day, the first time it is asked after the budget ran out: the caller logs then. */
  announceOnce(): boolean {
    if (!this.exceeded() || this.told) {
      return false;
    }
    this.told = true;
    return true;
  }
}

const boxBytes = (doc: ChannelDoc | null | undefined): number => (typeof doc?.box === "string" ? doc.box.length : 0);

/**
 * The cloud store under a budget: counts the box bytes it reads and writes, and once the day's budget is gone
 * does nothing (reads find nothing, writes and deletes are skipped) until local midnight. Put it under the
 * `MirrorStore`, so the same-Wi-Fi path, which never reaches Firebase, keeps working.
 */
export class BudgetedStore implements ChannelStore {
  watch?: NonNullable<ChannelStore["watch"]>;

  constructor(
    private readonly inner: ChannelStore,
    private readonly budget: CloudBudget,
  ) {
    const innerWatch = inner.watch?.bind(inner);
    if (innerWatch) {
      this.watch = (path, onChange, options) => innerWatch(path, onChange, options);
    }
  }

  private paused(): boolean {
    if (!this.budget.exceeded()) {
      return false;
    }
    if (this.budget.announceOnce()) {
      logger.warn("shared server: today's cloud budget is used; the phone channel is paused until midnight", {
        usedBytes: this.budget.usedBytes,
        budgetBytes: this.budget.budgetBytes,
      });
    }
    return true;
  }

  async get(path: string): Promise<ChannelDoc | null> {
    if (this.paused()) {
      return null;
    }
    const doc = await this.inner.get(path);
    this.budget.add(boxBytes(doc));
    return doc;
  }

  async list(collection: string): Promise<Array<{ id: string; doc: ChannelDoc }>> {
    if (this.paused()) {
      return [];
    }
    const docs = await this.inner.list(collection);
    this.budget.add(docs.reduce((sum, { doc }) => sum + boxBytes(doc), 0));
    return docs;
  }

  async set(path: string, doc: ChannelDoc, options?: { timeoutMs?: number }): Promise<void> {
    if (this.paused()) {
      return;
    }
    this.budget.add(boxBytes(doc));
    await this.inner.set(path, doc, options);
  }

  async delete(path: string): Promise<void> {
    if (this.paused()) {
      return;
    }
    await this.inner.delete(path);
  }
}
