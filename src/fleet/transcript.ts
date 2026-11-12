/** What a replier's readable history is made of, whichever host or agent it comes from. */
export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string | null;
  turnId: string | null;
  /** The row's rowid as a string: pass the oldest message's as `before` to read what precedes it. Absent on hand-built rows. */
  cursor?: string;
  /**
   * Tool calls the agent made since the message before this one: the work between two messages, which
   * has no text of its own. Absent when there was none.
   */
  workBefore?: number;
}

export interface TranscriptResult {
  messages: TranscriptMessage[];
  /** True only when the whole chat was read and every message is returned. */
  complete: boolean;
  /**
   * Where to resume for the messages before these (`before`), or null when there are none. Absent from
   * readers that cannot page (terminal agents).
   */
  nextBefore?: string | null;
}

/** A cursor is a positive integer in digits and nothing else. */
export function parseCursor(raw: string | null | undefined): number | null | "invalid" {
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  if (!/^[1-9]\d{0,15}$/.test(raw)) {
    return "invalid";
  }
  return Number(raw);
}
