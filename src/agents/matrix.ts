import type { AgentCapabilities } from "../core/adapter.js";

/** What a provider's adapter really does. UI actions derive from this; a flag is true only when it is implemented. */
export interface CapabilityMatrix {
  launch: boolean;
  /** Provider-native continuation by the provider's own session id. */
  resume: boolean;
  /** Observe an already-running terminal session. Never types into it. */
  attach: boolean;
  messages: boolean;
  questions: boolean;
  permissions: boolean;
  toolEvents: boolean;
  fileEvents: boolean;
  structuredDiffs: boolean;
  steering: boolean;
  stop: boolean;
}

export const NO_CAPABILITIES: CapabilityMatrix = {
  launch: false,
  resume: false,
  attach: false,
  messages: false,
  questions: false,
  permissions: false,
  toolEvents: false,
  fileEvents: false,
  structuredDiffs: false,
  steering: false,
  stop: false,
};

/** The core contract's flags, derived from the matrix so the two cannot drift. */
export function toCoreCapabilities(m: CapabilityMatrix): AgentCapabilities {
  return {
    messaging: m.messages,
    questions: m.questions,
    approvals: m.permissions,
    steering: m.steering,
    startSession: m.launch,
    stopSession: m.stop,
    structuredTools: m.toolEvents,
  };
}
