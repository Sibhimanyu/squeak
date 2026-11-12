import type { AnswerRelay } from "./answer.js";

/** The one thing needed from the relay's client: a tunnelled request to Conductor's API. */
export type RelayRequest = (args: {
  method: "POST";
  target: string;
  headers: Record<string, string>;
  body: unknown;
}) => Promise<{ status: number }>;

export interface AnswerRelaySource {
  isReady(): boolean;
  send: AnswerRelay["send"];
  /** `PhoneClient.request` of the authenticated connection, or null while there is none. */
  request(): RelayRequest | null;
}

/**
 * Builds the `AnswerRelay` the answer service wants from the relay service
 * without the service knowing about answers: sends go through its `send`, and
 * the control routes (`answer-question`, `respond-to-plan`, `stop`) through
 * the same connection's request function. A thrown request means nothing came
 * back, so the caller treats the outcome as unknown.
 */
export function answerRelayFrom(source: AnswerRelaySource): AnswerRelay {
  return {
    isReady: () => source.isReady(),
    send: (args) => source.send(args),
    async control(args) {
      const request = source.request();
      if (!request) {
        return { ok: false, reason: "Conductor's relay isn't connected" };
      }
      try {
        const res = await request({
          method: "POST",
          target: `/workspaces/${encodeURIComponent(args.workspaceId)}/sessions/${encodeURIComponent(args.sessionId)}/${args.route}`,
          headers: { "content-type": "application/json" },
          body: args.body ?? {},
        });
        return { ok: true, status: res.status };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
