import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ClaudeTranscriptObserver, originFromEntrypoint } from "./claude-transcript.js";

const temporaryDirs: string[] = [];

function makeProjectsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-claude-"));
  temporaryDirs.push(dir);
  return dir;
}

function writeTranscript(projectsDir: string, sessionId: string, entries: unknown[]): string {
  const projectDir = path.join(projectsDir, "-Users-someone-repo");
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  return filePath;
}

function userEntry(timestamp: string, text: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type: "user",
    timestamp,
    cwd: "/Users/someone/repo",
    gitBranch: "main",
    entrypoint: "cli",
    message: { role: "user", content: [{ type: "text", text }] },
    ...extra,
  };
}

function assistantEntry(timestamp: string, stopReason: string, content: unknown[]): unknown {
  return {
    type: "assistant",
    timestamp,
    cwd: "/Users/someone/repo",
    gitBranch: "main",
    entrypoint: "cli",
    message: { role: "assistant", stop_reason: stopReason, content },
  };
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    fs.rmSync(temporaryDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("ClaudeTranscriptObserver", () => {
  const now = Date.parse("2026-09-20T12:00:00.000Z");

  it("reports a completed turn as finished and previews the reply", () => {
    const projectsDir = makeProjectsDir();
    writeTranscript(projectsDir, "session-a", [
      userEntry("2026-09-20T11:58:00.000Z", "do the thing"),
      assistantEntry("2026-09-20T11:59:00.000Z", "end_turn", [{ type: "text", text: "Done, all tests pass." }]),
    ]);

    const [session] = new ClaudeTranscriptObserver({ projectsDir, now: () => now }).observe();

    expect(session?.state).toBe("finished");
    expect(session?.detail).toBe("Done, all tests pass.");
    expect(session?.agent).toBe("claude");
    expect(session?.cwd).toBe("/Users/someone/repo");
    expect(session?.branch).toBe("main");
    expect(session?.agentSessionId).toBe("session-a");
  });

  it("reports an in-flight tool call as working, naming the tool", () => {
    const projectsDir = makeProjectsDir();
    writeTranscript(projectsDir, "session-b", [
      userEntry("2026-09-20T11:59:00.000Z", "go"),
      assistantEntry("2026-09-20T11:59:40.000Z", "tool_use", [{ type: "tool_use", name: "Bash" }]),
    ]);

    const [session] = new ClaudeTranscriptObserver({ projectsDir, now: () => now }).observe();

    expect(session?.state).toBe("working");
    expect(session?.detail).toBe("Running Bash");
  });

  it("treats a turn that went quiet mid-tool as stalled rather than working", () => {
    const projectsDir = makeProjectsDir();
    writeTranscript(projectsDir, "session-c", [
      userEntry("2026-09-20T10:00:00.000Z", "go"),
      assistantEntry("2026-09-20T10:01:00.000Z", "tool_use", [{ type: "tool_use", name: "Bash" }]),
    ]);

    const [session] = new ClaudeTranscriptObserver({
      projectsDir,
      now: () => now,
      idleAfterMs: 10 * 60 * 1000,
    }).observe();

    expect(session?.state).toBe("idle");
  });

  it("ignores subagent entries when deciding state", () => {
    const projectsDir = makeProjectsDir();
    // A subagent finishing must not make the parent session look finished.
    writeTranscript(projectsDir, "session-d", [
      userEntry("2026-09-20T11:58:00.000Z", "go"),
      assistantEntry("2026-09-20T11:59:00.000Z", "tool_use", [{ type: "tool_use", name: "Agent" }]),
      {
        ...(assistantEntry("2026-09-20T11:59:30.000Z", "end_turn", [{ type: "text", text: "subagent done" }]) as Record<
          string,
          unknown
        >),
        isSidechain: true,
      },
    ]);

    const [session] = new ClaudeTranscriptObserver({ projectsDir, now: () => now }).observe();

    expect(session?.state).toBe("working");
  });

  it("surfaces an API error as an errored session", () => {
    const projectsDir = makeProjectsDir();
    writeTranscript(projectsDir, "session-e", [
      userEntry("2026-09-20T11:58:00.000Z", "go"),
      {
        type: "system",
        subtype: "api_error",
        timestamp: "2026-09-20T11:59:00.000Z",
        cwd: "/Users/someone/repo",
        entrypoint: "cli",
        error: "401 OAuth access token has been revoked.",
      },
    ]);

    const [session] = new ClaudeTranscriptObserver({ projectsDir, now: () => now }).observe();

    expect(session?.state).toBe("error");
    expect(session?.detail).toContain("revoked");
  });

  it("skips transcripts older than the active window", () => {
    const projectsDir = makeProjectsDir();
    const filePath = writeTranscript(projectsDir, "session-f", [userEntry("2026-09-19T00:00:00.000Z", "old")]);
    const old = new Date(now - 48 * 60 * 60 * 1000);
    fs.utimesSync(filePath, old, old);

    const sessions = new ClaudeTranscriptObserver({
      projectsDir,
      now: () => now,
      activeWithinMs: 60 * 60 * 1000,
    }).observe();

    expect(sessions).toHaveLength(0);
  });

  it("prefers the AI-assigned title over the first prompt", () => {
    const projectsDir = makeProjectsDir();
    writeTranscript(projectsDir, "session-g", [
      userEntry("2026-09-20T11:58:00.000Z", "please refactor the parser"),
      { type: "ai-title", aiTitle: "Refactor the parser", sessionId: "session-g" },
      assistantEntry("2026-09-20T11:59:00.000Z", "end_turn", [{ type: "text", text: "ok" }]),
    ]);

    const [session] = new ClaudeTranscriptObserver({ projectsDir, now: () => now }).observe();

    expect(session?.title).toBe("Refactor the parser");
  });
});

describe("cost-state parsing", () => {
  const now = Date.parse("2026-09-20T12:00:00.000Z");

  it("reads the running cost total Claude Code reports", () => {
    const projectsDir = makeProjectsDir();
    writeTranscript(projectsDir, "session-cost", [
      userEntry("2026-09-20T11:58:00.000Z", "go"),
      assistantEntry("2026-09-20T11:59:00.000Z", "end_turn", [{ type: "text", text: "done" }]),
      { type: "cost-state", sessionId: "session-cost", totalCostUSD: 0.564495, modelUsage: {} },
    ]);

    const [session] = new ClaudeTranscriptObserver({ projectsDir, now: () => now }).observe();

    expect(session?.costUsd).toBe(0.564495);
  });

  it("takes the most recent figure when cost-state appears more than once", () => {
    const projectsDir = makeProjectsDir();
    writeTranscript(projectsDir, "session-cost2", [
      { type: "cost-state", sessionId: "x", totalCostUSD: 0.5 },
      userEntry("2026-09-20T11:59:00.000Z", "go"),
      { type: "cost-state", sessionId: "x", totalCostUSD: 88.25 },
    ]);

    const [session] = new ClaudeTranscriptObserver({ projectsDir, now: () => now }).observe();

    expect(session?.costUsd).toBe(88.25);
  });

  it("is null for a session that never reported a cost", () => {
    const projectsDir = makeProjectsDir();
    writeTranscript(projectsDir, "session-nocost", [userEntry("2026-09-20T11:58:00.000Z", "go")]);

    const [session] = new ClaudeTranscriptObserver({ projectsDir, now: () => now }).observe();

    expect(session?.costUsd).toBeNull();
  });
});

describe("originFromEntrypoint", () => {
  it("separates SDK-driven sessions from hand-run ones", () => {
    // Not "conductor": every harness uses the SDK. Only a joined Conductor
    // row can say a session is Conductor's.
    expect(originFromEntrypoint("sdk-ts")).toBe("sdk");
    expect(originFromEntrypoint("sdk-cli")).toBe("sdk");
    expect(originFromEntrypoint("cli")).toBe("terminal");
  });

  it("recognises both Claude Desktop surfaces", () => {
    expect(originFromEntrypoint("claude-desktop")).toBe("desktop");
    expect(originFromEntrypoint("local-agent")).toBe("cowork");
    expect(originFromEntrypoint("claude-vscode")).toBe("ide");
    expect(originFromEntrypoint(null)).toBe("unknown");
  });
});
