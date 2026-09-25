import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CodexRolloutObserver, originFromOriginator } from "./codex-rollout.js";

const temporaryDirs: string[] = [];

function makeCodexHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-codex-"));
  temporaryDirs.push(dir);
  return dir;
}

function writeRollout(codexHome: string, sessionId: string, entries: unknown[]): string {
  const dir = path.join(codexHome, "sessions", "2026", "09", "20");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-2026-09-20T11-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  return filePath;
}

function meta(sessionId: string, extra: Record<string, unknown> = {}): unknown {
  return {
    timestamp: "2026-09-20T11:00:00.000Z",
    type: "session_meta",
    payload: {
      session_id: sessionId,
      cwd: "/Users/someone/repo",
      originator: "codex_cli_rs",
      source: "cli",
      ...extra,
    },
  };
}

function event(timestamp: string, payload: Record<string, unknown>): unknown {
  return { timestamp, type: "event_msg", payload };
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    fs.rmSync(temporaryDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("CodexRolloutObserver", () => {
  const now = Date.parse("2026-09-20T12:00:00.000Z");

  it("reads a completed task and keeps the final message as the preview", () => {
    const codexHome = makeCodexHome();
    writeRollout(codexHome, "thread-a", [
      meta("thread-a"),
      event("2026-09-20T11:58:00.000Z", { type: "task_started" }),
      event("2026-09-20T11:59:00.000Z", { type: "task_complete", last_agent_message: "Shipped the fix." }),
    ]);

    const [session] = new CodexRolloutObserver({ codexHome, now: () => now }).observe();

    expect(session?.state).toBe("finished");
    expect(session?.detail).toBe("Shipped the fix.");
    expect(session?.agent).toBe("codex");
    expect(session?.origin).toBe("terminal");
    expect(session?.cwd).toBe("/Users/someone/repo");
  });

  it("reports a started-but-unfinished task as working", () => {
    const codexHome = makeCodexHome();
    writeRollout(codexHome, "thread-b", [
      meta("thread-b"),
      event("2026-09-20T11:59:30.000Z", { type: "task_started" }),
    ]);

    const [session] = new CodexRolloutObserver({ codexHome, now: () => now }).observe();

    expect(session?.state).toBe("working");
  });

  it("treats an aborted turn as idle rather than finished", () => {
    const codexHome = makeCodexHome();
    writeRollout(codexHome, "thread-c", [
      meta("thread-c"),
      event("2026-09-20T11:58:00.000Z", { type: "task_started" }),
      event("2026-09-20T11:59:00.000Z", { type: "turn_aborted" }),
    ]);

    const [session] = new CodexRolloutObserver({ codexHome, now: () => now }).observe();

    expect(session?.state).toBe("idle");
    expect(session?.detail).toBe("Turn aborted");
  });

  it("names the running command while a task is in flight", () => {
    const codexHome = makeCodexHome();
    writeRollout(codexHome, "thread-d", [
      meta("thread-d"),
      event("2026-09-20T11:59:00.000Z", { type: "task_started" }),
      event("2026-09-20T11:59:30.000Z", {
        type: "item_completed",
        item: { item_type: "command_execution", command: "npm test" },
      }),
    ]);

    const [session] = new CodexRolloutObserver({ codexHome, now: () => now }).observe();

    expect(session?.detail).toBe("Running npm test");
  });

  it("takes the thread name from the session index", () => {
    const codexHome = makeCodexHome();
    writeRollout(codexHome, "thread-e", [
      meta("thread-e"),
      event("2026-09-20T11:59:00.000Z", { type: "task_complete", last_agent_message: "ok" }),
    ]);
    fs.writeFileSync(
      path.join(codexHome, "session_index.jsonl"),
      `${JSON.stringify({ id: "thread-e", thread_name: "Fix the parser", updated_at: "2026-09-20T11:59:00Z" })}\n`,
    );

    const [session] = new CodexRolloutObserver({ codexHome, now: () => now }).observe();

    expect(session?.title).toBe("Fix the parser");
  });

  it("skips rollouts outside the active window", () => {
    const codexHome = makeCodexHome();
    const filePath = writeRollout(codexHome, "thread-f", [meta("thread-f")]);
    const old = new Date(now - 48 * 60 * 60 * 1000);
    fs.utimesSync(filePath, old, old);
    fs.utimesSync(path.dirname(filePath), old, old);

    const sessions = new CodexRolloutObserver({
      codexHome,
      now: () => now,
      activeWithinMs: 60 * 60 * 1000,
    }).observe();

    expect(sessions).toHaveLength(0);
  });
});

describe("originFromOriginator", () => {
  it("files an SDK-driven session under sdk even though it reports vscode", () => {
    // Conductor (and any other harness) drives Codex through the TS SDK but
    // leaves source as vscode. Which harness is only known by joining rows.
    expect(originFromOriginator("codex_sdk_ts", "vscode")).toBe("sdk");
  });

  it("recognises the Codex desktop app, which also reports vscode", () => {
    expect(originFromOriginator("codex_work_desktop", "vscode")).toBe("desktop");
    expect(originFromOriginator("codex_work_desktop", null)).toBe("desktop");
  });

  it("treats codex exec as driven by a program, not a person", () => {
    expect(originFromOriginator("codex_exec", "exec")).toBe("sdk");
  });

  it("separates the editor extension from a terminal run", () => {
    expect(originFromOriginator("codex_vscode", "vscode")).toBe("ide");
    expect(originFromOriginator("codex_cli_rs", "cli")).toBe("terminal");
    expect(originFromOriginator("codex-tui", "cli")).toBe("terminal");
    expect(originFromOriginator(null, null)).toBe("unknown");
  });
});
