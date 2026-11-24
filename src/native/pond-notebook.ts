import type { NativeStore, NotebookRow } from "./store.js";

/**
 * The Pond Notebook: one shared list of lasting lessons per pond, read by every Duck that takes a Task, edited by
 * the Owner. Small on purpose: at most NOTEBOOK_MAX_ENTRIES lessons and NOTEBOOK_MAX_CHARS characters in all; past
 * that the lessons given out in a briefing longest ago go first (least recently used, then oldest).
 */
export const NOTEBOOK_MAX_ENTRIES = 40;
export const NOTEBOOK_MAX_CHARS = 6000;
export const NOTEBOOK_ENTRY_MAX = 300;
/** Lessons one Task may add (the Duck's last act, not a diary). */
export const NOTEBOOK_PER_TASK = 3;

/** A lesson as one line: whitespace (and line breaks) folded, cut to NOTEBOOK_ENTRY_MAX. */
const oneLine = (text: string, max: number): string => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Ids to drop so the rest fit the caps: least recently used first, oldest first among equals. */
export function overCap(entries: NotebookRow[]): string[] {
  const drop: string[] = [];
  // Array sort is stable: entries equal on both times keep their insert order.
  const order = [...entries].sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.createdAt - b.createdAt);
  let chars = order.reduce((n, e) => n + e.text.length, 0);
  let count = order.length;
  for (const e of order) {
    if (count <= NOTEBOOK_MAX_ENTRIES && chars <= NOTEBOOK_MAX_CHARS) break;
    drop.push(e.id);
    count--;
    chars -= e.text.length;
  }
  return drop;
}

export class NotebookError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface NotebookView {
  entries: Array<{ id: string; text: string; by: string | null; createdAt: number; lastUsedAt: number }>;
  maxEntries: number;
  maxChars: number;
}

export class PondNotebook {
  constructor(
    private readonly store: NativeStore,
    private readonly now: () => number = Date.now,
  ) {}

  view(projectId: string): NotebookView {
    return {
      entries: this.store.notebookEntries(projectId).map(({ id, text, by, createdAt, lastUsedAt }) => ({
        id,
        text,
        by,
        createdAt,
        lastUsedAt,
      })),
      maxEntries: NOTEBOOK_MAX_ENTRIES,
      maxChars: NOTEBOOK_MAX_CHARS,
    };
  }

  /** A Duck's lesson (a repeat only counts as used). Trims past the caps. */
  add(projectId: string, lesson: string, by: string | null): { added: boolean; trimmed: number } {
    const text = oneLine(lesson, NOTEBOOK_ENTRY_MAX);
    if (!text) throw new NotebookError("A lesson can't be empty.");
    const same = this.store.notebookEntries(projectId).find((e) => e.text === text);
    if (same) {
      this.store.touchNotebookEntries([same.id], this.now());
      return { added: false, trimmed: 0 };
    }
    this.store.addNotebookEntry(projectId, text, by, this.now());
    const drop = overCap(this.store.notebookEntries(projectId));
    this.store.removeNotebookEntries(drop);
    return { added: true, trimmed: drop.length };
  }

  /**
   * The Owner's edit: the whole list as lines, in the order given. Unchanged lines keep their history; changed or
   * new ones are the Owner's. Refused (not trimmed) when over the caps, so an edit is never silently lost.
   */
  replace(projectId: string, lines: unknown): NotebookView {
    if (!Array.isArray(lines) || lines.some((l) => typeof l !== "string")) {
      throw new NotebookError("entries must be a list of text");
    }
    const texts = [...new Set((lines as string[]).map((l) => oneLine(l, NOTEBOOK_ENTRY_MAX)).filter(Boolean))];
    if (texts.length > NOTEBOOK_MAX_ENTRIES) {
      throw new NotebookError(`The Notebook holds at most ${NOTEBOOK_MAX_ENTRIES} lessons.`);
    }
    if (texts.reduce((n, t) => n + t.length, 0) > NOTEBOOK_MAX_CHARS) {
      throw new NotebookError(`The Notebook holds at most ${NOTEBOOK_MAX_CHARS} characters.`);
    }
    const have = this.store.notebookEntries(projectId);
    const byText = new Map(have.map((e) => [e.text, e]));
    this.store.removeNotebookEntries(have.map((e) => e.id));
    for (const t of texts) {
      const old = byText.get(t);
      if (old) this.store.restoreNotebookEntry(old);
      else this.store.addNotebookEntry(projectId, t, "owner", this.now());
    }
    return this.view(projectId);
  }

  /** The Notebook as briefing text (a line a lesson), marking each lesson as used now; null when empty. */
  forBriefing(projectId: string): string | null {
    const entries = this.store.notebookEntries(projectId);
    if (entries.length === 0) return null;
    this.store.touchNotebookEntries(
      entries.map((e) => e.id),
      this.now(),
    );
    return entries.map((e) => `- ${e.text}`).join("\n");
  }
}
