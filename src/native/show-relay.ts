import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

/** What the `show` tool asks the Mac to open: the chat that showed it, its pond, and the file. */
export interface ShowRequest {
  sessionId: string;
  projectId: string | null;
  path: string;
  relative: string;
  title: string | null;
}

/** The Mac's answer, or why there is none. */
export type ShowAck = { ok: true } | { ok: false; reason: "no-window" | "timeout" | "refused"; message: string };

/**
 * Asks a Squeak window to open a file a duck showed, and waits for its answer. Windows listen on one host-wide stream
 * (whatever chat or page they show) and answer each request with an ack, so `show` never says "opened" on a guess.
 */
export class ShowRelay extends EventEmitter {
  private readonly waiting = new Map<string, (ack: ShowAck) => void>();
  private connected = 0;

  constructor(private readonly timeoutMs = 4000) {
    super();
  }

  /** A window's stream connected (true) or went away (false). */
  setListening(on: boolean): void {
    this.connected = Math.max(0, this.connected + (on ? 1 : -1));
  }

  get windows(): number {
    return this.connected;
  }

  request(req: ShowRequest): Promise<ShowAck> {
    if (this.connected === 0) {
      return Promise.resolve({
        ok: false,
        reason: "no-window",
        message: "No Squeak window is connected to open it, so no tab is open.",
      });
    }
    const id = randomUUID();
    return new Promise<ShowAck>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({
          ok: false,
          reason: "timeout",
          message: "The Squeak window did not confirm within a few seconds, so the tab may not be open.",
        });
      }, this.timeoutMs);
      timer.unref();
      this.waiting.set(id, (ack) => {
        clearTimeout(timer);
        resolve(ack);
      });
      this.emit("open", { id, ...req });
    });
  }

  /** The window's answer. False for an id nobody waits on any more (late or unknown). */
  ack(id: string, ok: boolean, message?: string): boolean {
    const done = this.waiting.get(id);
    if (!done) return false;
    this.waiting.delete(id);
    done(
      ok
        ? { ok: true }
        : { ok: false, reason: "refused", message: message?.slice(0, 200) || "Squeak could not open that file." },
    );
    return true;
  }
}
