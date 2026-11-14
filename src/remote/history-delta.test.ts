import { describe, expect, it } from "vitest";
import { HISTORY_DELTA_SCAN_MAX, readHistoryAfter, type TranscriptReader } from "./history-delta.js";
import type { TranscriptMessage } from "../fleet/transcript.js";

function chat(count: number, start = 1000): { rows: TranscriptMessage[]; read: TranscriptReader } {
  const rows: TranscriptMessage[] = Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    cursor: String(start + i * 3),
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: `t${i}`,
    at: null,
    turnId: null,
  }));
  const read: TranscriptReader = (limit, before) => {
    const eligible = rows.filter((m) => before === null || Number(m.cursor) < before);
    const page = eligible.slice(-limit);
    return { messages: page, nextBefore: eligible.length > limit ? page[0]!.cursor! : null };
  };
  return { rows, read };
}

describe("readHistoryAfter", () => {
  it("returns nothing new when the cursor is the newest message", () => {
    const { rows, read } = chat(20);
    const delta = readHistoryAfter(read, Number(rows.at(-1)!.cursor), 50);
    expect(delta).toEqual({ entries: [], nextAfter: null, reset: false });
  });

  it("stays correct across appends: each page continues exactly where the cursor was", () => {
    const { rows, read } = chat(200);
    const held = Number(rows[49]!.cursor);
    const first = readHistoryAfter(read, held, 50);
    expect(first.entries).toHaveLength(50);
    expect(first.entries[0]!.id).toBe(rows[50]!.cursor);
    expect(first.nextAfter).toBe(rows[99]!.cursor);
    rows.push({ id: "new", cursor: "99999", role: "user", text: "new", at: null, turnId: null });
    const ids: string[] = [];
    let after: string | null = String(held);
    while (after) {
      const page = readHistoryAfter(read, Number(after), 50);
      expect(page.reset).toBe(false);
      ids.push(...page.entries.map((e) => e.id!));
      after = page.nextAfter;
    }
    expect(ids).toEqual(rows.slice(50).map((m) => m.cursor));
  });

  it("resets with the newest page when the cursor is further back than the scan reaches", () => {
    const { rows, read } = chat(HISTORY_DELTA_SCAN_MAX + 200);
    const delta = readHistoryAfter(read, Number(rows[0]!.cursor), 10);
    expect(delta.reset).toBe(true);
    expect(delta.nextAfter).toBeNull();
    expect(delta.entries).toHaveLength(10);
    expect(delta.entries.at(-1)!.id).toBe(rows.at(-1)!.cursor);
  });

  it("treats the start of the chat as reached", () => {
    const { rows, read } = chat(5);
    const delta = readHistoryAfter(read, 1, 50);
    expect(delta.entries.map((e) => e.id)).toEqual(rows.map((m) => m.cursor));
    expect(delta.reset).toBe(false);
  });
});
