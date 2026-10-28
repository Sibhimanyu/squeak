import type { AttentionItem, AttentionKind, FleetSession } from "../fleet/types.js";

/** A Conductor chat that can be answered, for the voice tests. */
export function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    key: "conductor:1",
    source: "conductor",
    agent: "claude",
    origin: "conductor",
    sourceId: "1",
    agentSessionId: "a1",
    conductorSessionId: "c1",
    cwd: null,
    repoName: "squeak",
    branch: "voice",
    title: null,
    state: "finished",
    detail: null,
    lastActivityAt: "2026-10-28T12:00:00.000Z",
    transcriptPath: null,
    pid: null,
    alive: true,
    stateSource: "transcript",
    contextPercent: null,
    retired: false,
    baseRef: null,
    costUsd: null,
    git: null,
    ...overrides,
  };
}

export function item(kind: AttentionKind = "asked_question", overrides: Partial<FleetSession> = {}): AttentionItem {
  return { session: session(overrides), kind, score: 1, since: "2026-10-28T12:00:00.000Z" };
}

export const QUESTION = [
  "I can ship it two ways. Which one?",
  "",
  "A) Merge now (recommended)",
  "B) Open a PR first",
].join("\n");
