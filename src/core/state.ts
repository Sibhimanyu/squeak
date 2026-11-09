export type AgentState =
  | "idle"
  | "starting"
  | "thinking"
  | "working"
  | "waitingForInput"
  | "waitingForPermission"
  | "completed"
  | "failed"
  | "stopped";

export function isTerminalState(state: AgentState): boolean {
  return state === "completed" || state === "failed" || state === "stopped";
}

/** True when the agent is blocked on the person. */
export function needsHuman(state: AgentState): boolean {
  return state === "waitingForInput" || state === "waitingForPermission";
}
