import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ClaudeCoworkObserver } from "./claude-cowork.js";

const now = Date.parse("2026-09-25T12:00:00.000Z");
const temporaryDirs: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeSessionsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-cowork-"));
  temporaryDirs.push(dir);
  return dir;
}

interface CoworkFixture {
  coworkId: string;
  metadata: Record<string, unknown>;
  transcripts: Record<string, { entries: unknown[]; mtimeMs?: number }>;
}

/** Lays a session out the way Claude Desktop does: `<account>/<org>/local_<id>{.json,/}`. */
function writeCowork(sessionsDir: string, fixture: CoworkFixture): void {
  const org = path.join(sessionsDir, "account", "org");
  const sessionDir = path.join(org, fixture.coworkId);
  const projectDir = path.join(sessionDir, ".claude", "projects", "-sandbox-outputs");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(`${sessionDir}.json`, JSON.stringify(fixture.metadata));
  for (const [sessionId, transcript] of Object.entries(fixture.transcripts)) {
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, transcript.entries.map((entry) => JSON.stringify(entry)).join("\n"));
    const mtime = new Date(transcript.mtimeMs ?? now - 60_000);
    fs.utimesSync(filePath, mtime, mtime);
  }
}

function finishedTurn(timestamp: string, text: string): unknown[] {
  const common = { cwd: "/sandbox/outputs", entrypoint: "local-agent", timestamp };
  return [
    { ...common, type: "user", message: { role: "user", content: [{ type: "text", text: "make a deck" }] } },
    {
      ...common,
      type: "assistant",
      message: { id: "msg_1", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] },
    },
  ];
}

describe("ClaudeCoworkObserver", () => {
  it("reads a Cowork session's transcript and names it from its metadata", () => {
    const sessionsDir = makeSessionsDir();
    writeCowork(sessionsDir, {
      coworkId: "local_abc",
      metadata: { title: "Design principles deck", cliSessionId: "cli-1", isArchived: false },
      transcripts: { "cli-1": { entries: finishedTurn("2026-09-25T11:59:00.000Z", "The deck is ready.") } },
    });

    const [session, ...rest] = new ClaudeCoworkObserver({ sessionsDir, now: () => now }).observe();

    expect(rest).toHaveLength(0);
    expect(session).toMatchObject({
      key: "claude-cowork:local_abc",
      source: "claude-cowork",
      origin: "cowork",
      agent: "claude",
      agentSessionId: "cli-1",
      title: "Design principles deck",
      state: "finished",
      detail: "The deck is ready.",
      retired: false,
    });
    // The sandbox's outputs folder names nothing; the title labels it instead.
    expect(session?.cwd).toBeNull();
  });

  it("follows the transcript the metadata names when a session holds several", () => {
    const sessionsDir = makeSessionsDir();
    writeCowork(sessionsDir, {
      coworkId: "local_two",
      metadata: { title: "Research", cliSessionId: "current" },
      transcripts: {
        // The older transcript was touched last, so newest-by-mtime would pick it.
        previous: { entries: finishedTurn("2026-09-25T11:00:00.000Z", "old answer"), mtimeMs: now - 1_000 },
        current: { entries: finishedTurn("2026-09-25T11:30:00.000Z", "new answer"), mtimeMs: now - 5_000 },
      },
    });

    const [session] = new ClaudeCoworkObserver({ sessionsDir, now: () => now }).observe();

    expect(session?.agentSessionId).toBe("current");
    expect(session?.detail).toBe("new answer");
  });

  it("marks an archived session retired", () => {
    const sessionsDir = makeSessionsDir();
    writeCowork(sessionsDir, {
      coworkId: "local_old",
      metadata: { title: "Done", cliSessionId: "cli-1", isArchived: true },
      transcripts: { "cli-1": { entries: finishedTurn("2026-09-25T11:59:00.000Z", "ok") } },
    });

    const [session] = new ClaudeCoworkObserver({ sessionsDir, now: () => now }).observe();

    expect(session?.retired).toBe(true);
  });

  it("skips sessions untouched for longer than the window", () => {
    const sessionsDir = makeSessionsDir();
    writeCowork(sessionsDir, {
      coworkId: "local_stale",
      metadata: { title: "Last month", cliSessionId: "cli-1" },
      transcripts: {
        "cli-1": { entries: finishedTurn("2026-08-25T11:59:00.000Z", "ok"), mtimeMs: now - 30 * 86_400_000 },
      },
    });

    expect(new ClaudeCoworkObserver({ sessionsDir, now: () => now }).observe()).toEqual([]);
  });

  it("still reports a session whose metadata cannot be parsed", () => {
    const sessionsDir = makeSessionsDir();
    writeCowork(sessionsDir, {
      coworkId: "local_torn",
      metadata: {},
      transcripts: { "cli-1": { entries: finishedTurn("2026-09-25T11:59:00.000Z", "ok") } },
    });
    fs.writeFileSync(path.join(sessionsDir, "account", "org", "local_torn.json"), "{ half-writ");

    const [session] = new ClaudeCoworkObserver({ sessionsDir, now: () => now }).observe();

    expect(session?.origin).toBe("cowork");
    expect(session?.title).toBe("make a deck");
  });

  it("is empty when Claude Desktop is not installed", () => {
    const observer = new ClaudeCoworkObserver({ sessionsDir: path.join(os.tmpdir(), "no-such-cowork-dir") });
    expect(observer.observe()).toEqual([]);
  });
});
