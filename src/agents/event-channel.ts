import type { AgentEvent } from "../core/events.js";

/** Replays everything emitted so far, then follows live, until closed. Each stream() reads from the start. */
export class EventChannel {
  private readonly history: AgentEvent[] = [];
  private readonly seen = new Set<string>();
  private readonly wake = new Set<() => void>();
  private closed = false;

  /** Emitting an id twice is a no-op: translators may see the same streamed message more than once. */
  emit(event: AgentEvent): void {
    if (this.closed || this.seen.has(event.id)) return;
    this.seen.add(event.id);
    this.history.push(event);
    for (const w of [...this.wake]) w();
  }

  close(): void {
    this.closed = true;
    for (const w of [...this.wake]) w();
  }

  get events(): readonly AgentEvent[] {
    return this.history;
  }

  async *stream(): AsyncIterable<AgentEvent> {
    let i = 0;
    for (;;) {
      while (i < this.history.length) yield this.history[i++]!;
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        const w = (): void => {
          this.wake.delete(w);
          resolve();
        };
        this.wake.add(w);
      });
    }
  }
}
