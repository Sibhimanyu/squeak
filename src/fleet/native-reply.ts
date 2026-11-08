import { NATIVE_HOST_DOWN, NativeHostError, type NativeHostClient } from "../native/client.js";
import type { ReplyOptions, ReplyOutcome } from "./session-reply.js";
import type { FleetSession } from "./types.js";

export const NATIVE_KEY_PREFIX = "squeak-native:";

export function isNativeKey(key: string): boolean {
  return key.startsWith(NATIVE_KEY_PREFIX);
}

export function nativeSessionId(key: string): string {
  return key.slice(NATIVE_KEY_PREFIX.length);
}

/** The words a card or a press says when the host cannot be reached. */
export { NATIVE_HOST_DOWN };

export interface NativeReplierDependencies {
  client: Pick<NativeHostClient, "send">;
  /** The agent's last message in full (its transcript), for turn stamps, lettered options and asks. */
  lastMessage?: (session: FleetSession) => string | null;
}

/**
 * Answers a chat Squeak's own session host runs. Unlike Conductor's, the host queues a message while the chat
 * works and answers a blocked one, so every native session can be replied to, whatever it is doing.
 */
export class NativeReplier {
  constructor(private readonly deps: NativeReplierDependencies) {}

  canReply(session: FleetSession): boolean {
    return session.origin === "squeak" && isNativeKey(session.key);
  }

  lastTurnText(session: FleetSession): string | null {
    return this.deps.lastMessage?.(session) ?? null;
  }

  async send(session: FleetSession, text: string, options: ReplyOptions = {}): Promise<ReplyOutcome> {
    const input = text.trim();
    if (!input) {
      return { status: "refused", reason: "There is nothing to send." };
    }
    try {
      const { queued } = await this.deps.client.send(nativeSessionId(session.key), input, options.mode ?? "queue");
      return { status: "started", via: "native", delivery: queued ? "queued" : "sent" };
    } catch (error) {
      if (error instanceof NativeHostError) {
        if (error.kind === "timeout") {
          return {
            status: "unconfirmed",
            reason: "Squeak's session host did not answer, so the message may or may not be in the chat. Check it.",
          };
        }
        return { status: "refused", reason: error.kind === "down" ? NATIVE_HOST_DOWN : error.message };
      }
      return { status: "refused", reason: NATIVE_HOST_DOWN };
    }
  }
}
