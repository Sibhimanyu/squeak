import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type Database from "better-sqlite3";
import { logger } from "../utils/logger.js";

/**
 * What a chat row keeps of a tool result. The agent's own transcript (`~/.claude/projects`) holds every byte the
 * agent saw, so a row only needs what a surface draws: text, clipped, and a note where an image was. Measured on
 * a real 2.8 GB native.db: 1.8 GB was base64 screenshots inside tool results (6.4k rows); nothing else mattered.
 */
export const TEXT_CLIP_CHARS = 100_000;
const TEXT_KEEP_CHARS = 50_000;
/** Base64 below this is an icon or a stub: leave it. */
export const IMAGE_KEEP_CHARS = 4_096;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function clipText(text: string): string {
  const cut = text.length - TEXT_KEEP_CHARS;
  return `${text.slice(0, TEXT_KEEP_CHARS)}\n… [${cut} more characters left out; the agent's own transcript has the full output]`;
}

function compactBlock(block: unknown): { block: unknown; changed: boolean } {
  if (!isObj(block)) return { block, changed: false };
  if (block.type === "image" && isObj(block.source) && typeof block.source.data === "string") {
    const data = block.source.data;
    if (data.length <= IMAGE_KEEP_CHARS) return { block, changed: false };
    const rest = { ...block.source };
    delete rest.data;
    return {
      block: { ...block, source: { ...rest, type: "omitted", bytes: Math.floor((data.length * 3) / 4) } },
      changed: true,
    };
  }
  if (block.type === "text" && typeof block.text === "string" && block.text.length > TEXT_CLIP_CHARS) {
    return { block: { ...block, text: clipText(block.text) }, changed: true };
  }
  if (block.type === "tool_result") {
    if (typeof block.content === "string" && block.content.length > TEXT_CLIP_CHARS)
      return { block: { ...block, content: clipText(block.content) }, changed: true };
    if (Array.isArray(block.content)) {
      const parts = block.content.map(compactBlock);
      if (parts.some((p) => p.changed))
        return { block: { ...block, content: parts.map((p) => p.block) }, changed: true };
    }
  }
  return { block, changed: false };
}

/** The payload of a Claude `user` row (tool results, pasted images) with bulk removed; null when nothing to remove. */
export function compactPayload(kind: string, payload: unknown): unknown {
  if (kind !== "user" || !isObj(payload) || !isObj(payload.message) || !Array.isArray(payload.message.content))
    return null;
  // Only tool results: an image or text block directly in the message is something the person sent, and is kept.
  const parts = payload.message.content.map((b) =>
    isObj(b) && b.type === "tool_result" ? compactBlock(b) : { block: b, changed: false },
  );
  if (!parts.some((p) => p.changed)) return null;
  return { ...payload, message: { ...payload.message, content: parts.map((p) => p.block) } };
}

export interface CompactJournal {
  cursor: number;
  done: boolean;
  rows: number;
  bytesSaved: number;
  startedAt: string;
  finishedAt?: string;
  backup?: string;
  skipped?: string;
}

export interface CompactOptions {
  db: InstanceType<typeof Database>;
  dbPath: string;
  supportDir: string;
  /** Longest synchronous stretch before yielding to the event loop. */
  sliceMs?: number;
  pauseMs?: number;
  freeBytes?: () => number;
  /** A chat is mid-turn: wait rather than add writes. */
  busy?: () => boolean;
  /** How often to look again while a chat works. */
  busyPollMs?: number;
  now?: () => number;
}

export const compactJournalPath = (supportDir: string) => path.join(supportDir, "native-compact.json");

export function readCompactJournal(supportDir: string): CompactJournal | null {
  try {
    return JSON.parse(fs.readFileSync(compactJournalPath(supportDir), "utf8")) as CompactJournal;
  } catch {
    return null;
  }
}

function writeJournal(supportDir: string, j: CompactJournal): void {
  const file = compactJournalPath(supportDir);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(j));
  fs.renameSync(`${file}.tmp`, file);
}

export function freeDiskBytes(dir: string): number {
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/** One slice: compacts rows after the cursor for about `sliceMs`; returns false when the table is finished. */
export function compactSlice(
  db: InstanceType<typeof Database>,
  j: CompactJournal,
  sliceMs: number,
  now: () => number = Date.now,
): boolean {
  const start = now();
  const select = db.prepare(
    "SELECT seq, kind, payload FROM messages WHERE seq>? AND role='agent' AND kind='user' ORDER BY seq LIMIT 10",
  );
  const update = db.prepare("UPDATE messages SET payload=? WHERE seq=?");
  while (now() - start < sliceMs) {
    const rows = select.all(j.cursor) as { seq: number; kind: string; payload: string }[];
    if (rows.length === 0) return false;
    for (const r of rows) {
      j.cursor = r.seq;
      if (r.payload.length < IMAGE_KEEP_CHARS) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.payload);
      } catch {
        continue;
      }
      const next = compactPayload(r.kind, parsed);
      if (next === null) continue;
      const text = JSON.stringify(next);
      update.run(text, r.seq);
      j.rows++;
      j.bytesSaved += r.payload.length - text.length;
      if (now() - start >= sliceMs) break;
    }
  }
  return true;
}

/**
 * The one-time pass over old rows, resumable (cursor in `native-compact.json`), after a backup beside the database.
 * It never holds the event loop for more than about `sliceMs`. The file only shrinks after `squeak native-compact --vacuum`.
 */
export async function runCompaction(o: CompactOptions): Promise<CompactJournal> {
  const sliceMs = o.sliceMs ?? 40;
  const now = o.now ?? Date.now;
  let j = readCompactJournal(o.supportDir);
  if (j?.done) {
    logger.info("native.db compaction skipped: already done", { finishedAt: j.finishedAt, rows: j.rows });
    return { ...j, skipped: "already done" };
  }
  logger.info("native.db compaction starting", { resumeFrom: j?.cursor ?? 0, resumed: Boolean(j) });
  if (!j) {
    j = { cursor: 0, done: false, rows: 0, bytesSaved: 0, startedAt: new Date(now()).toISOString() };
    const size = fs.statSync(o.dbPath).size;
    const free = (o.freeBytes ?? (() => freeDiskBytes(o.supportDir)))();
    if (free < size * 2) {
      // no room for the backup: nothing is touched, and the next start tries again
      const skipped = `needs ${Math.ceil((size * 2) / 1e9)} GB free for the backup`;
      logger.warn(`native.db compaction skipped: ${skipped}`, { freeBytes: free, dbBytes: size });
      return { ...j, skipped };
    }
    logger.info("native.db compaction: backing up first", { dbBytes: size });
    const backup = `${o.dbPath}.before-compact-${new Date(now()).toISOString().replace(/\D/g, "").slice(0, 14)}`;
    await o.db.backup(backup);
    j.backup = backup;
    writeJournal(o.supportDir, j);
    logger.info("native.db compaction: backup done", { backup });
  }
  const last = (o.db.prepare("SELECT MAX(seq) AS m FROM messages").get() as { m: number | null }).m ?? 0;
  let nextPct = 5;
  let waitingLogged = false;
  for (;;) {
    while (o.busy?.()) {
      if (!waitingLogged) logger.info("native.db compaction waiting: a chat is working");
      waitingLogged = true;
      await sleep(o.busyPollMs ?? 5_000);
    }
    waitingLogged = false;
    const more = compactSlice(o.db, j, sliceMs, now);
    writeJournal(o.supportDir, j);
    const pct = last > 0 ? Math.floor((Math.min(j.cursor, last) / last) * 100) : 100;
    while (pct >= nextPct && nextPct <= 100) {
      logger.info(`native.db compaction ${nextPct}%`, { rows: j.rows, bytesSaved: j.bytesSaved });
      nextPct += 5;
    }
    if (!more) break;
    await sleep(o.pauseMs ?? 25);
  }
  j.done = true;
  j.finishedAt = new Date(now()).toISOString();
  writeJournal(o.supportDir, j);
  logger.info("native.db compacted", { rows: j.rows, bytesSaved: j.bytesSaved });
  return j;
}

/** `VACUUM` the file: refuses without room for the copy it makes. Returns bytes before and after. */
export function vacuumDatabase(
  db: InstanceType<typeof Database>,
  dbPath: string,
  freeBytes: number,
): { before: number; after: number } {
  const before = fs.statSync(dbPath).size;
  if (freeBytes < before * 2) throw new Error(`VACUUM needs ${Math.ceil((before * 2) / 1e9)} GB free beside the file`);
  db.pragma("busy_timeout = 60000");
  db.exec("VACUUM");
  db.pragma("wal_checkpoint(TRUNCATE)");
  return { before, after: fs.statSync(dbPath).size };
}
