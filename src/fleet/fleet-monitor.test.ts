import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FleetMonitor, type FleetMonitorDependencies } from "./fleet-monitor.js";
import { FleetStore } from "./fleet-store.js";
import type { AttentionItem, HookEvent, ObservedSession } from "./types.js";

const stores: FleetStore[] = [];
const dirs: string[] = [];

function makeStore(): FleetStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-monitor-"));
  dirs.push(dir);
  const store = new FleetStore(path.join(dir, "bridge.db"));
  store.init();
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

function observed(overrides: Partial<ObservedSession> = {}): ObservedSession {
  return {
    key: "claude-transcript:abc",
    source: "claude-transcript",
    agent: "claude",
    origin: "terminal",
    sourceId: "abc",
    agentSessionId: "abc",
    conductorSessionId: null,
    cwd: "/Users/someone/repo",
    repoName: "repo",
    branch: "main",
    title: null,
    state: "working",
    detail: null,
    lastActivityAt: "2026-09-20T11:59:00.000Z",
    transcriptPath: null,
    ...overrides,
  };
}

interface Harness {
  monitor: FleetMonitor;
  store: FleetStore;
  setClaude: (sessions: ObservedSession[]) => void;
  setNow: (iso: string) => void;
  pushes: AttentionItem[][];
}

function makeMonitor(initial: ObservedSession[] = []): Harness {
  const store = makeStore();
  let claudeSessions = initial;
  let nowMs = Date.parse("2026-09-20T12:00:00.000Z");
  const pushes: AttentionItem[][] = [];

  const deps: FleetMonitorDependencies = {
    store,
    conductor: { observe: () => [] } as unknown as FleetMonitorDependencies["conductor"],
    claude: { observe: () => claudeSessions } as unknown as FleetMonitorDependencies["claude"],
    codex: { observe: () => [] } as unknown as FleetMonitorDependencies["codex"],
    liveness: { observe: async () => [] } as unknown as FleetMonitorDependencies["liveness"],
  };

  const monitor = new FleetMonitor(deps, { now: () => nowMs });
  monitor.onPush((items) => pushes.push(items));

  return {
    monitor,
    store,
    pushes,
    setClaude: (sessions) => {
      claudeSessions = sessions;
    },
    setNow: (iso) => {
      nowMs = Date.parse(iso);
    },
  };
}

function hookEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    agent: "claude",
    event: "Notification",
    sessionId: "abc",
    cwd: null,
    transcriptPath: null,
    message: "Claude needs your permission to use Bash",
    toolName: null,
    receivedAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
}

describe("FleetMonitor", () => {
  it("does not raise attention for a session that is simply working", async () => {
    const harness = makeMonitor([observed()]);

    const snapshot = await harness.monitor.refresh();

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.attention).toHaveLength(0);
    expect(harness.pushes).toHaveLength(0);
  });

  it("pushes once when a hook reports a blocked session, and not again while it stays blocked", async () => {
    const harness = makeMonitor([observed()]);
    harness.monitor.ingestHookEvent(hookEvent());

    await harness.monitor.refresh();
    harness.setNow("2026-09-20T12:00:30.000Z");
    await harness.monitor.refresh();

    expect(harness.pushes).toHaveLength(1);
    expect(harness.pushes[0]?.[0]?.kind).toBe("blocked_approval");
  });

  it("keeps a finished session on the radar but does not interrupt for it", async () => {
    const harness = makeMonitor([observed({ state: "finished", detail: "Done." })]);

    const snapshot = await harness.monitor.refresh();

    expect(snapshot.attention.map((entry) => entry.kind)).toEqual(["finished_unreviewed"]);
    expect(harness.pushes).toHaveLength(0);
  });

  it("stops surfacing a session once it is marked reviewed", async () => {
    const harness = makeMonitor([observed({ state: "finished" })]);
    const first = await harness.monitor.refresh();
    harness.store.markReviewed(first.sessions[0]?.key ?? "", "2026-09-20T12:00:01.000Z");

    const second = await harness.monitor.refresh();

    expect(second.attention).toHaveLength(0);
  });

  it("honours a snooze until it expires", async () => {
    const harness = makeMonitor([observed({ state: "finished" })]);
    const first = await harness.monitor.refresh();
    harness.store.snooze(first.sessions[0]?.key ?? "", "2026-09-20T13:00:00.000Z");

    expect((await harness.monitor.refresh()).attention).toHaveLength(0);

    harness.setNow("2026-09-20T13:30:00.000Z");
    expect((await harness.monitor.refresh()).attention).toHaveLength(1);
  });

  it("suppresses the push but keeps the radar row while muted", async () => {
    const harness = makeMonitor([observed()]);
    harness.store.setMute("repo", "2026-09-20T13:00:00.000Z");
    harness.monitor.ingestHookEvent(hookEvent());

    const snapshot = await harness.monitor.refresh();

    expect(snapshot.attention).toHaveLength(1);
    expect(harness.pushes).toHaveLength(0);
  });

  it("pushes again when a session leaves and re-enters the blocked state", async () => {
    const harness = makeMonitor([observed()]);
    harness.monitor.ingestHookEvent(hookEvent());
    await harness.monitor.refresh();

    // The human answered: the session goes back to work, then blocks again.
    harness.setNow("2026-09-20T12:01:00.000Z");
    harness.setClaude([observed({ lastActivityAt: "2026-09-20T12:01:00.000Z" })]);
    harness.monitor.ingestHookEvent(hookEvent({ event: "UserPromptSubmit", receivedAt: "2026-09-20T12:01:00.000Z" }));
    await harness.monitor.refresh();

    harness.setNow("2026-09-20T12:02:00.000Z");
    harness.monitor.ingestHookEvent(hookEvent({ receivedAt: "2026-09-20T12:02:00.000Z" }));
    await harness.monitor.refresh();

    expect(harness.pushes).toHaveLength(2);
  });

  it("survives an observer that throws", async () => {
    const store = makeStore();
    const monitor = new FleetMonitor({
      store,
      conductor: {
        observe: () => {
          throw new Error("conductor.db is locked");
        },
      } as unknown as FleetMonitorDependencies["conductor"],
      claude: { observe: () => [observed()] } as unknown as FleetMonitorDependencies["claude"],
      codex: { observe: () => [] } as unknown as FleetMonitorDependencies["codex"],
      liveness: { observe: async () => [] } as unknown as FleetMonitorDependencies["liveness"],
    });

    const snapshot = await monitor.refresh();

    // One broken source must not blind the others.
    expect(snapshot.sessions).toHaveLength(1);
  });

  it("drops a hook report when the session ends", async () => {
    const harness = makeMonitor([observed()]);
    harness.monitor.ingestHookEvent(hookEvent());
    harness.monitor.ingestHookEvent(hookEvent({ event: "SessionEnd", receivedAt: "2026-09-20T12:00:05.000Z" }));

    const snapshot = await harness.monitor.refresh();

    expect(snapshot.sessions[0]?.state).toBe("working");
  });
});
