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
    contextPercent: null,
    retired: false,
    baseRef: null,
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

  it("tells you when a session finishes", async () => {
    const harness = makeMonitor([observed({ state: "finished", detail: "Done." })]);

    const snapshot = await harness.monitor.refresh();

    expect(snapshot.attention.map((entry) => entry.kind)).toEqual(["finished_unreviewed"]);
    expect(harness.pushes[0]?.[0]?.kind).toBe("finished_unreviewed");
  });

  it("says nothing about a session that finished long ago", async () => {
    // Only recently-finished work is active; the rest is an archive.
    const harness = makeMonitor([observed({ state: "finished", lastActivityAt: "2026-09-20T09:00:00.000Z" })]);

    const snapshot = await harness.monitor.refresh();

    expect(snapshot.active).toHaveLength(0);
    expect(snapshot.attention).toHaveLength(0);
    expect(harness.pushes).toHaveLength(0);
  });

  it("keeps tracking an inactive session even though it is not shown", async () => {
    const harness = makeMonitor([observed({ state: "idle" })]);

    const snapshot = await harness.monitor.refresh();

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.active).toHaveLength(0);
  });

  it("stops surfacing a session once it is marked reviewed", async () => {
    const harness = makeMonitor([observed({ state: "finished" })]);
    const first = await harness.monitor.refresh();
    harness.store.markReviewed(first.sessions[0]?.key ?? "", "2026-09-20T12:00:01.000Z");

    const second = await harness.monitor.refresh();

    expect(second.attention).toHaveLength(0);
  });

  it("honours a snooze until it expires", async () => {
    const harness = makeMonitor([observed({ state: "awaiting_input" })]);
    const first = await harness.monitor.refresh();
    harness.store.snooze(first.sessions[0]?.key ?? "", "2026-09-20T13:00:00.000Z");

    expect((await harness.monitor.refresh()).attention).toHaveLength(0);

    // A blocked session stays active however long it waits, so it comes back.
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

describe("context pressure", () => {
  it("raises it alongside the finished flag, but only finishing is worth a message", async () => {
    const harness = makeMonitor([observed({ state: "finished", contextPercent: 92 })]);

    const snapshot = await harness.monitor.refresh();

    expect(snapshot.attention.map((entry) => entry.kind)).toEqual(["finished_unreviewed", "context_pressure"]);
    expect(harness.pushes.flat().map((entry) => entry.kind)).toEqual(["finished_unreviewed"]);
  });

  it("says nothing about a workspace the user already marked done", async () => {
    const harness = makeMonitor([observed({ state: "finished", contextPercent: 92, retired: true })]);

    expect((await harness.monitor.refresh()).attention).toHaveLength(0);
  });

  it("still pushes a blocked session that is also low on context", async () => {
    const harness = makeMonitor([observed({ contextPercent: 92 })]);
    harness.monitor.ingestHookEvent(hookEvent());

    const snapshot = await harness.monitor.refresh();

    expect(snapshot.attention.map((entry) => entry.kind)).toEqual(["blocked_approval", "context_pressure"]);
    expect(harness.pushes).toHaveLength(1);
    expect(harness.pushes[0]?.[0]?.kind).toBe("blocked_approval");
  });
});

describe("git enrichment", () => {
  function makeGit(states: Record<string, Partial<import("./git-state.js").GitState>>, seen?: string[][]) {
    return {
      read: async (targets: { dir: string; baseRef?: string }[]) => {
        seen?.push(targets.map((target) => target.dir));
        const result = new Map<string, import("./git-state.js").GitState>();
        for (const target of targets) {
          const state = states[target.dir];
          if (state) {
            result.set(target.dir, {
              branch: "feature",
              filesChanged: 0,
              insertions: 0,
              deletions: 0,
              untracked: 0,
              ahead: 0,
              behind: 0,
              hasUpstream: true,
              aheadOfBase: null,
              ...state,
            });
          }
        }
        return result;
      },
    } as unknown as NonNullable<FleetMonitorDependencies["git"]>;
  }

  function makeMonitorWithGit(
    sessions: ObservedSession[],
    git: NonNullable<FleetMonitorDependencies["git"]>,
  ): { monitor: FleetMonitor; pushes: AttentionItem[][] } {
    const store = makeStore();
    const pushes: AttentionItem[][] = [];
    const monitor = new FleetMonitor(
      {
        store,
        conductor: { observe: () => [] } as unknown as FleetMonitorDependencies["conductor"],
        claude: { observe: () => sessions } as unknown as FleetMonitorDependencies["claude"],
        codex: { observe: () => [] } as unknown as FleetMonitorDependencies["codex"],
        liveness: { observe: async () => [] } as unknown as FleetMonitorDependencies["liveness"],
        git,
      },
      { now: () => Date.parse("2026-09-20T12:00:00.000Z") },
    );
    monitor.onPush((items) => pushes.push(items));
    return { monitor, pushes };
  }

  it("attaches working-tree state to a finished session", async () => {
    const { monitor } = makeMonitorWithGit(
      [observed({ state: "finished", cwd: "/repo" })],
      makeGit({ "/repo": { filesChanged: 8, insertions: 312, deletions: 40 } }),
    );

    const snapshot = await monitor.refresh();

    expect(snapshot.sessions[0]?.git?.insertions).toBe(312);
    // The attention item must carry the enriched session, not the original.
    expect(snapshot.attention[0]?.session.git?.insertions).toBe(312);
  });

  it("does not shell out for sessions nobody is going to look at", async () => {
    const seen: string[][] = [];
    const { monitor } = makeMonitorWithGit(
      [
        observed({ key: "a", agentSessionId: "a", state: "idle", cwd: "/quiet" }),
        observed({ key: "b", agentSessionId: "b", state: "finished", cwd: "/loud" }),
      ],
      makeGit({ "/loud": {} }, seen),
    );

    await monitor.refresh();

    expect(seen[0]).toEqual(["/loud"]);
  });

  it("reads a shared working tree once for two sessions in it", async () => {
    const seen: string[][] = [];
    const { monitor } = makeMonitorWithGit(
      [
        observed({ key: "a", agentSessionId: "a", state: "finished", cwd: "/repo" }),
        observed({ key: "b", agentSessionId: "b", state: "working", cwd: "/repo" }),
      ],
      makeGit({ "/repo": {} }, seen),
    );

    await monitor.refresh();

    expect(seen[0]).toEqual(["/repo"]);
  });

  it("puts the diffstat on the push card", async () => {
    const { monitor, pushes } = makeMonitorWithGit(
      [observed({ cwd: "/repo" })],
      makeGit({ "/repo": { filesChanged: 2, insertions: 9, deletions: 1 } }),
    );
    monitor.ingestHookEvent(hookEvent());

    await monitor.refresh();

    expect(pushes[0]?.[0]?.session.git?.insertions).toBe(9);
  });

  it("still produces a snapshot when git fails entirely", async () => {
    const { monitor } = makeMonitorWithGit([observed({ state: "finished", cwd: "/repo" })], {
      read: async () => {
        throw new Error("git is not installed");
      },
    } as unknown as NonNullable<FleetMonitorDependencies["git"]>);

    const snapshot = await monitor.refresh();

    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]?.git).toBeNull();
  });
});
