import type { ConductorRegistryAdapter } from "./conductor-registry.js";
import type { SessionStatus, SupportedAgentType } from "../types.js";
import { toClaudeCliModel } from "./claude-code.js";

/**
 * Conductor stores "opus-5-1m" in `sessions.model` but writes the resolved catalog
 * id ("claude-opus-5") into the message envelope. Mirror that.
 */
function toConductorDisplayModel(model: string | null): string | null {
  const cli = toClaudeCliModel(model);
  return cli ? cli.replace(/\[1m\]$/, "") : model;
}

/**
 * What the mirror needs to avoid writing a row twice. Squeak only mirrors the
 * turns it starts itself, so it keeps these in memory.
 */
export interface MirrorFingerprints {
  buildFingerprint(sessionId: string, turnId: string, role: string, content: string): string;
  hasFingerprint(fingerprint: string): boolean;
  addFingerprint(fingerprint: string, sessionId: string, turnId: string, role: string): void;
}

export class ConductorMirrorWriter {
  constructor(
    private readonly registry: ConductorRegistryAdapter,
    private readonly stateStore: MirrorFingerprints,
  ) {}

  appendUserMessage(params: { sessionId: string; turnId: string; text: string; sentAt: string }): "ok" | "duplicate" {
    const fingerprint = this.stateStore.buildFingerprint(params.sessionId, params.turnId, "user", params.text);
    if (this.stateStore.hasFingerprint(fingerprint)) {
      return "duplicate";
    }

    this.registry.appendSessionMessage({
      sessionId: params.sessionId,
      role: "user",
      content: params.text,
      turnId: params.turnId,
      model: null,
      sentAt: params.sentAt,
    });
    this.stateStore.addFingerprint(fingerprint, params.sessionId, params.turnId, "user");
    this.registry.updateSessionLastUserMessageAt(params.sessionId, params.sentAt);
    return "ok";
  }

  appendAssistantMessage(params: {
    agentType?: SupportedAgentType;
    sessionId: string;
    threadId: string;
    turnId: string;
    text: string;
    sentAt: string;
    model: string | null;
  }): "ok" | "duplicate" {
    const contents = this.buildAssistantContents(params);
    let inserted = false;

    for (const content of contents) {
      const fingerprint = this.stateStore.buildFingerprint(params.sessionId, params.turnId, "assistant", content);
      if (this.stateStore.hasFingerprint(fingerprint)) {
        continue;
      }

      this.registry.appendSessionMessage({
        sessionId: params.sessionId,
        role: "assistant",
        content,
        turnId: params.turnId,
        model: params.model,
        sentAt: params.sentAt,
      });
      this.stateStore.addFingerprint(fingerprint, params.sessionId, params.turnId, "assistant");
      inserted = true;
    }

    return inserted ? "ok" : "duplicate";
  }

  updateSessionStatus(sessionId: string, status: SessionStatus): void {
    this.registry.updateSessionStatus(sessionId, status);
  }

  private buildAssistantContents(params: {
    agentType?: SupportedAgentType;
    threadId: string;
    turnId: string;
    text: string;
    sentAt: string;
    model: string | null;
  }): string[] {
    if (params.agentType === "claude") {
      // Match the envelope Conductor writes itself, exactly. Its own rows carry only
      // role/model/content/usage under `message`; the extra null fields this used to
      // add (id, type, stop_reason, stop_sequence, stop_details, context_management)
      // and `usage: null` appear on no Conductor row, and its UI renders such rows as
      // "This message could not be displayed."
      return [
        JSON.stringify({
          type: "assistant",
          uuid: params.turnId,
          message: {
            role: "assistant",
            model: toConductorDisplayModel(params.model),
            content: [{ type: "text", text: params.text }],
            usage: {
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
              input_tokens: 0,
              output_tokens: 0,
              service_tier: "standard",
            },
          },
          session_id: params.threadId,
          timestamp: params.sentAt,
          parent_tool_use_id: null,
        }),
      ];
    }

    return [
      JSON.stringify({
        type: "assistant",
        session_id: params.threadId,
        message: {
          role: "assistant",
          content: [{ type: "text", text: params.text }],
        },
      }),
    ];
  }
}
