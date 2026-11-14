import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AddonHost } from "../addon-host.js";
import { FleetMonitor } from "./fleet-monitor.js";
import { FleetStore } from "./fleet-store.js";
import { ClaudeTranscriptObserver } from "./observers/claude-transcript.js";
import { CodexRolloutObserver } from "./observers/codex-rollout.js";
import type { ObservedSession } from "./types.js";

const dirs: string[] = [];
const stores: FleetStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (dirs.length > 0) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const NOW = Date.parse("2026-09-20T12:00:00.000Z");

function writeClaude(projectsDir: string, id: string, entrypoint: string): string {
  const dir = path.join(projectsDir, "-Users-someone-repo");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  // The last entry is the person's message: the agent is waiting on the model.
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      type: "user",
      timestamp: "2026-09-20T11:59:00.000Z",
      cwd: "/Users/someone/repo",
      gitBranch: "main",
      entrypoint,
      message: { role: "user", content: [{ type: "text", text: "go" }] },
    })}\n`,
  );
  return file;
}

function writeRollout(codexHome: string, id: string, originator: string): string {
  const dir = path.join(codexHome, "sessions", "2026", "09", "20");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-20T11-00-00-${id}.jsonl`);
  const lines = [
    {
      timestamp: "2026-09-20T11:00:00.000Z",
      type: "session_meta",
      payload: { session_id: id, cwd: "/Users/someone/repo", originator, source: "cli" },
    },
    { timestamp: "2026-09-20T11:59:00.000Z", type: "event_msg", payload: { type: "task_started" } },
  ];
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));
  return file;
}

function squeakRow(agent: "claude" | "codex", id: string): ObservedSession {
  return {
    key: `squeak-native:${id}`,
    source: "squeak-native",
    agent,
    origin: "squeak",
    sourceId: id,
    agentSessionId: id,
    conductorSessionId: null,
    cwd: "/Users/someone/repo",
    repoName: "repo",
    branch: "main",
    title: "A native chat",
    state: "working",
    detail: null,
    lastActivityAt: "2026-09-20T11:59:30.000Z",
    transcriptPath: null,
    contextPercent: null,
    retired: false,
    baseRef: null,
    costUsd: null,
  };
}

interface Rig {
  monitor: FleetMonitor;
  host: AddonHost;
  claudeFile: string;
  codexFile: string;
}

function rig(): Rig {
  const projectsDir = tmp("ext-claude-");
  const codexHome = tmp("ext-codex-");
  const supportDir = tmp("ext-support-");
  const store = new FleetStore(path.join(supportDir, "bridge.db"));
  store.init();
  stores.push(store);

  // A terminal `claude`, a native Claude chat's transcript, a terminal `codex` and a native Codex chat's rollout.
  writeClaude(projectsDir, "term-claude", "cli");
  const claudeFile = writeClaude(projectsDir, "native-claude", "squeak");
  writeRollout(codexHome, "11111111-1111-4111-8111-111111111111", "codex-tui");
  const codexFile = writeRollout(codexHome, "22222222-2222-4222-8222-222222222222", "squeak");

  const window = { activeWithinMs: 24 * 3600_000, idleAfterMs: 600_000, now: () => NOW };
  const claudeFull = new ClaudeTranscriptObserver({ projectsDir, ...window });
  const codexFull = new CodexRolloutObserver({ codexHome, ...window });

  const host = new AddonHost(supportDir);
  host.register(
    { id: "claude-external", name: "Claude Code (external)", blurb: "x", distributed: true },
    {
      observers: [
        {
          source: "claude-transcript",
          observe: () => claudeFull.observe(),
          watch: [{ dir: projectsDir, recursive: true }],
        },
      ],
    },
  );
  host.register(
    { id: "codex-external", name: "Codex (external)", blurb: "x", distributed: true },
    { observers: [{ source: "codex-rollout", observe: () => codexFull.observe() }] },
  );

  const native = [squeakRow("claude", "native-claude"), squeakRow("codex", "22222222-2222-4222-8222-222222222222")];
  const monitor = new FleetMonitor(
    {
      store,
      observers: () => [{ source: "squeak-native", observe: () => native }, ...host.observers()],
      claude: new ClaudeTranscriptObserver({ projectsDir, ...window }),
      codex: new CodexRolloutObserver({ codexHome, ...window }),
      liveness: host.liveness(),
    },
    { now: () => NOW },
  );
  return { monitor, host, claudeFile, codexFile };
}

const keysOf = (snapshot: { sessions: Array<{ agentSessionId: string | null }> }) =>
  snapshot.sessions.map((session) => session.agentSessionId).sort();

describe("external agents are add-ons", () => {
  it("shows no terminal Claude or Codex session on a fresh install, and still reads a native chat's transcript", async () => {
    const { monitor, claudeFile, codexFile } = rig();
    const snapshot = await monitor.refresh();

    expect(keysOf(snapshot)).toEqual(["22222222-2222-4222-8222-222222222222", "native-claude"]);
    const claude = snapshot.sessions.find((session) => session.agentSessionId === "native-claude");
    const codex = snapshot.sessions.find((session) => session.agentSessionId?.startsWith("2222"));
    // Path and the stall signal come from the claimed transcript, as before.
    expect(claude?.transcriptPath).toBe(claudeFile);
    expect(claude?.waitingOn).toBe("model");
    expect(codex?.transcriptPath).toBe(codexFile);
    expect(snapshot.active.map((session) => session.agentSessionId)).not.toContain("term-claude");
  });

  it("shows them on the next refresh once the add-ons are enabled", async () => {
    const { monitor, host } = rig();
    await monitor.refresh();

    expect(host.setEnabled("claude-external", true)).toEqual({ ok: true });
    const withClaude = await monitor.refresh();
    expect(keysOf(withClaude)).toContain("term-claude");
    expect(keysOf(withClaude)).not.toContain("11111111-1111-4111-8111-111111111111");

    expect(host.setEnabled("codex-external", true)).toEqual({ ok: true });
    const withBoth = await monitor.refresh();
    expect(keysOf(withBoth)).toContain("11111111-1111-4111-8111-111111111111");
    // A native chat is one row, never doubled by the claimed pass and the full scan.
    expect(withBoth.sessions.filter((session) => session.agentSessionId === "native-claude")).toHaveLength(1);

    host.setEnabled("claude-external", false);
    host.setEnabled("codex-external", false);
    expect(keysOf(await monitor.refresh())).toEqual(["22222222-2222-4222-8222-222222222222", "native-claude"]);
  });

  it("watches the transcript folders only while the add-on is on", () => {
    const { host } = rig();
    expect(host.watchSpecs()).toEqual([]);
    host.setEnabled("claude-external", true);
    expect(host.watchSpecs()).toHaveLength(1);
  });

  it("lists both add-ons off by default", () => {
    const { host } = rig();
    expect(host.catalogue().map((entry) => [entry.id, entry.enabled])).toEqual([
      ["claude-external", false],
      ["codex-external", false],
    ]);
  });
});
