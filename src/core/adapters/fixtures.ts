import type { FleetSession } from "../../fleet/types.js";

export function fleetSession(over: Partial<FleetSession> = {}): FleetSession {
  return {
    key: "claude-transcript:abc",
    source: "claude-transcript",
    agent: "claude",
    origin: "terminal",
    sourceId: "abc",
    agentSessionId: "agent-abc",
    conductorSessionId: null,
    cwd: "/work/repo",
    repoName: "repo",
    branch: "main",
    title: "Fix it",
    state: "working",
    detail: null,
    lastActivityAt: "2026-11-09T10:00:00.000Z",
    transcriptPath: "/t/abc.jsonl",
    contextPercent: null,
    retired: false,
    baseRef: null,
    costUsd: null,
    pid: 1,
    alive: true,
    git: null,
    stateSource: "transcript",
    ...over,
  };
}
