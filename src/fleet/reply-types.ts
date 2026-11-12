// Reply types shared by every replier (Conductor, terminal, native) and the surfaces over them.

/**
 * `conductor`: typed into Conductor's window, so it shows and streams there.
 * `terminal`: typed into the Terminal tab running the agent, likewise live.
 * `background`: run by the local CLI and mirrored, so Conductor shows it on
 * its next reload — `fallbackReason` says why the window was not used.
 */
export type ReplyOutcome =
  | ({ status: "started"; via: "conductor" } & DeliveryInfo)
  | ({ status: "started"; via: "terminal" } & DeliveryInfo)
  | ({ status: "started"; via: "native" } & DeliveryInfo)
  | ({ status: "started"; via: "background"; fallbackReason: string | null } & DeliveryInfo)
  | { status: "refused"; reason: string }
  /**
   * The message may or may not be in the chat: the route accepted it but nothing proved it arrived, and
   * sending it again another way could deliver it twice. Never reported as sent; the person checks the chat.
   */
  | { status: "unconfirmed"; reason: string };

/**
 * How a message was meant to meet a working agent. `queue` waits for the turn
 * to end; `steer` goes into the turn in progress. Only Conductor's own
 * composer (the relay) can steer.
 */
export type ReplyMode = "queue" | "steer";

/**
 * What happened to a message that went through: `queued` (the agent was
 * mid-turn and reads it after), `steered` (went into the current turn), or
 * `sent` (the agent was idle). `note` is set when the request could not be
 * honoured as asked, so the surface can say so.
 */
export type ReplyDelivery = "sent" | "queued" | "steered";
export interface DeliveryInfo {
  delivery?: ReplyDelivery;
  note?: string;
}

export const STEER_UNAVAILABLE_NOTE = "Steer needs Conductor's relay, so this was queued instead.";

export interface ReplyOptions {
  mode?: ReplyMode;
  /**
   * The caller's id for the message (a lowercase UUID), used only by the
   * relay route, so the sender can recognise it in Conductor's queue. The
   * window and the background CLI have no such id and ignore it.
   */
  messageId?: string;
}

/** A message waiting in a Conductor chat's queue, oldest first by `position`. */
export interface QueueItem {
  id: string;
  text: string;
  mode: ReplyMode;
  position: number;
}

export type QueueAction = "promote" | "cancel";

/** Conductor statuses in which an agent is mid-turn, so a message waits or steers. */
export function isInFlight(status: string): boolean {
  return status === "working" || status === "waiting" || status === "cancelling";
}

/** Called once if a turn this replier started ends in failure. */
export type ReplyFailureHandler = (message: string) => void;
