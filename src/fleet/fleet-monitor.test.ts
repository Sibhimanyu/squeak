import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    costUsd: null,
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
  it("pushes once when a working session stops hearing from the model, and again for a new stall", async () => {
    const harness = makeMonitor([
      observed({
        waitingOn: "model",
        waitingSince: "2026-09-20T11:48:00.000Z",
        lastActivityAt: "2026-09-20T11:48:00.000Z",
      }),
    ]);

    const first = await harness.monitor.refresh();
    await harness.monitor.refresh();

    expect(first.attention.map((item) => item.kind)).toEqual(["stalled"]);
    expect(harness.pushes.flat().map((item) => item.kind)).toEqual(["stalled"]);

    // It came back, then stalled again later: a new episode, a new card.
    harness.setClaude([
      observed({
        waitingOn: "model",
        waitingSince: "2026-09-20T12:10:00.000Z",
        lastActivityAt: "2026-09-20T12:10:00.000Z",
      }),
    ]);
    harness.setNow("2026-09-20T12:25:00.000Z");
    await harness.monitor.refresh();
    expect(harness.pushes.flat().map((item) => item.kind)).toEqual(["stalled", "stalled"]);
  });

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

  it("tells you when a Conductor session finishes", async () => {
    const harness = makeMonitor([observed({ state: "finished", detail: "Done.", conductorSessionId: "c1" })]);

    const snapshot = await harness.monitor.refresh();

    expect(snapshot.attention.map((entry) => entry.kind)).toEqual(["finished_unreviewed"]);
    expect(harness.pushes[0]?.[0]?.kind).toBe("finished_unreviewed");
  });

  describe("a finish that ends on a question", () => {
    const FINISHED = { state: "finished", detail: "Pushed the branch.", conductorSessionId: "c1" } as const;

    it("is an asked_question push in place of a quiet finish, carrying the question", async () => {
      const harness = makeMonitor([observed(FINISHED)]);
      harness.monitor.setLastMessageSource(() => "Pushed the branch.\n\nWant me to open a PR?");

      const snapshot = await harness.monitor.refresh();

      expect(snapshot.attention.map((entry) => entry.kind)).toEqual(["asked_question"]);
      expect(snapshot.active[0]?.asks).toBe("Want me to open a PR?");
      expect(harness.pushes.flat().map((entry) => entry.kind)).toEqual(["asked_question"]);
    });

    it("pushes once for the episode, not on every refresh", async () => {
      const harness = makeMonitor([observed(FINISHED)]);
      harness.monitor.setLastMessageSource(() => "Want me to open a PR?");

      await harness.monitor.refresh();
      await harness.monitor.refresh();
      await harness.monitor.refresh();

      expect(harness.pushes).toHaveLength(1);
    });

    it("reads the message once per change, not once per refresh", async () => {
      const harness = makeMonitor([observed(FINISHED)]);
      const read = vi.fn(() => "Want me to open a PR?");
      harness.monitor.setLastMessageSource(read);

      await harness.monitor.refresh();
      await harness.monitor.refresh();

      expect(read).toHaveBeenCalledTimes(1);
    });

    it("leaves a finish that ends on a statement as a quiet finish", async () => {
      const harness = makeMonitor([observed(FINISHED)]);
      harness.monitor.setLastMessageSource(() => "All done. Let me know if you want changes.");

      const snapshot = await harness.monitor.refresh();

      expect(snapshot.attention.map((entry) => entry.kind)).toEqual(["finished_unreviewed"]);
      expect(snapshot.active[0]?.asks).toBeUndefined();
    });

    it("stops asking once a new turn starts", async () => {
      const harness = makeMonitor([observed(FINISHED)]);
      harness.monitor.setLastMessageSource(() => "Want me to open a PR?");
      await harness.monitor.refresh();

      harness.setClaude([observed({ ...FINISHED, state: "working", lastActivityAt: "2026-09-20T11:59:50.000Z" })]);
      const snapshot = await harness.monitor.refresh();

      expect(snapshot.attention).toEqual([]);
      expect(snapshot.active[0]?.asks).toBeUndefined();
    });

    it("carries on when the message cannot be read", async () => {
      const harness = makeMonitor([observed(FINISHED)]);
      harness.monitor.setLastMessageSource(() => {
        throw new Error("database is locked");
      });

      const snapshot = await harness.monitor.refresh();

      expect(snapshot.attention.map((entry) => entry.kind)).toEqual(["finished_unreviewed"]);
    });

    it("does not read a session that is not finished or finished days ago", async () => {
      const harness = makeMonitor([
        observed({ ...FINISHED, state: "working" }),
        observed({
          key: "claude-transcript:old",
          sourceId: "old",
          agentSessionId: "old",
          ...FINISHED,
          lastActivityAt: "2026-09-18T09:00:00.000Z",
        }),
      ]);
      const read = vi.fn(() => "Want me to open a PR?");
      harness.monitor.setLastMessageSource(read);

      await harness.monitor.refresh();

      expect(read).not.toHaveBeenCalled();
    });
  });

  it("leaves a terminal session finishing on the radar rather than messaging about it", async () => {
    const harness = makeMonitor([observed({ state: "finished", detail: "Done." })]);

    const snapshot = await harness.monitor.refresh();

    expect(snapshot.attention.map((entry) => entry.kind)).toEqual(["finished_unreviewed"]);
    expect(harness.pushes).toHaveLength(0);
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
    const harness = makeMonitor([observed({ state: "finished", contextPercent: 92, conductorSessionId: "c1" })]);

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

describe("codex quota alerts", () => {
  function usageWith(primaryPercent: number, resetsAt = "2026-09-20T18:00:00.000Z") {
    return {
      planType: "team",
      primary: { usedPercent: primaryPercent, windowMinutes: 300, resetsAt },
      secondary: null,
      hasCredits: false,
      creditBalance: null,
      observedAt: "2026-09-20T12:00:00.000Z",
    };
  }

  function makeMonitorWithQuota(codexUsage: { read: () => ReturnType<typeof usageWith> | null }) {
    const store = makeStore();
    const alerts: Array<{ window: string }> = [];
    const monitor = new FleetMonitor(
      {
        store,
        conductor: { observe: () => [] } as unknown as FleetMonitorDependencies["conductor"],
        claude: { observe: () => [] } as unknown as FleetMonitorDependencies["claude"],
        codex: { observe: () => [] } as unknown as FleetMonitorDependencies["codex"],
        liveness: { observe: async () => [] } as unknown as FleetMonitorDependencies["liveness"],
        codexUsage: codexUsage as unknown as NonNullable<FleetMonitorDependencies["codexUsage"]>,
      },
      { now: () => Date.parse("2026-09-20T12:00:00.000Z") },
    );
    monitor.onQuotaAlert((_usage, window) => alerts.push({ window }));
    return { monitor, alerts };
  }

  it("does not alert below the threshold", async () => {
    const { monitor, alerts } = makeMonitorWithQuota({ read: () => usageWith(50) });
    const snapshot = await monitor.refresh();

    expect(alerts).toHaveLength(0);
    expect(snapshot.codexUsage?.primary?.usedPercent).toBe(50);
  });

  it("alerts once when a window crosses the threshold", async () => {
    const { monitor, alerts } = makeMonitorWithQuota({ read: () => usageWith(90) });

    await monitor.refresh();
    await monitor.refresh();

    expect(alerts).toEqual([{ window: "primary" }]);
  });

  it("alerts again after the window resets and climbs past threshold once more", async () => {
    let usage = usageWith(90, "2026-09-20T18:00:00.000Z");
    const { monitor, alerts } = makeMonitorWithQuota({ read: () => usage });

    await monitor.refresh();
    usage = usageWith(91, "2026-09-21T18:00:00.000Z"); // window has reset
    await monitor.refresh();

    expect(alerts).toEqual([{ window: "primary" }, { window: "primary" }]);
  });

  it("does not crash the refresh when the reader throws", async () => {
    const { monitor } = makeMonitorWithQuota({
      read: () => {
        throw new Error("codex home unreadable");
      },
    });

    const snapshot = await monitor.refresh();

    expect(snapshot.codexUsage).toBeNull();
  });

  it("has nothing to report when no reader is wired up", async () => {
    const store = makeStore();
    const monitor = new FleetMonitor({
      store,
      conductor: { observe: () => [] } as unknown as FleetMonitorDependencies["conductor"],
      claude: { observe: () => [] } as unknown as FleetMonitorDependencies["claude"],
      codex: { observe: () => [] } as unknown as FleetMonitorDependencies["codex"],
      liveness: { observe: async () => [] } as unknown as FleetMonitorDependencies["liveness"],
    });

    expect((await monitor.refresh()).codexUsage).toBeNull();
  });
});

describe("claude cost enrichment", () => {
  function makeMonitorWithClaudeCost(
    sessions: ObservedSession[],
    claudeCost: { read: (path: string, authoritative: number | null) => number | null },
  ) {
    const store = makeStore();
    const monitor = new FleetMonitor(
      {
        store,
        conductor: { observe: () => [] } as unknown as FleetMonitorDependencies["conductor"],
        claude: { observe: () => sessions } as unknown as FleetMonitorDependencies["claude"],
        codex: { observe: () => [] } as unknown as FleetMonitorDependencies["codex"],
        liveness: { observe: async () => [] } as unknown as FleetMonitorDependencies["liveness"],
        claudeCost: claudeCost as unknown as NonNullable<FleetMonitorDependencies["claudeCost"]>,
      },
      { now: () => Date.parse("2026-09-20T12:00:00.000Z") },
    );
    return monitor;
  }

  it("fills in a cost estimate for an active session with none", async () => {
    const monitor = makeMonitorWithClaudeCost([observed({ state: "working", transcriptPath: "/tmp/x.jsonl" })], {
      read: (_p, authoritative) => authoritative ?? 12.5,
    });

    const snapshot = await monitor.refresh();

    expect(snapshot.sessions[0]?.costUsd).toBe(12.5);
  });

  it("does not enrich a session that will not be shown", async () => {
    const seen: string[] = [];
    const monitor = makeMonitorWithClaudeCost([observed({ state: "idle", transcriptPath: "/tmp/x.jsonl" })], {
      read: (p) => {
        seen.push(p);
        return 99;
      },
    });

    await monitor.refresh();

    expect(seen).toHaveLength(0);
  });

  it("passes through Claude Code's own authoritative figure unchanged", async () => {
    let calledWith: number | null = -1;
    const monitor = makeMonitorWithClaudeCost(
      [observed({ state: "working", transcriptPath: "/tmp/x.jsonl", costUsd: 88.25 })],
      {
        read: (_p, authoritative) => {
          calledWith = authoritative;
          return authoritative;
        },
      },
    );

    const snapshot = await monitor.refresh();

    expect(calledWith).toBe(88.25);
    expect(snapshot.sessions[0]?.costUsd).toBe(88.25);
  });

  it("leaves a session with no transcript path alone", async () => {
    const monitor = makeMonitorWithClaudeCost([observed({ state: "working", transcriptPath: null })], {
      read: () => 99,
    });

    expect((await monitor.refresh()).sessions[0]?.costUsd).toBeNull();
  });

  it("survives the reader throwing", async () => {
    const monitor = makeMonitorWithClaudeCost([observed({ state: "working", transcriptPath: "/tmp/x.jsonl" })], {
      read: () => {
        throw new Error("boom");
      },
    });

    const snapshot = await monitor.refresh();

    expect(snapshot.sessions).toHaveLength(1);
  });
});

describe("event-driven refresh", () => {
  function conductorHarness() {
    const store = makeStore();
    let conductor: ObservedSession[] = [
      observed({
        key: "conductor:c1",
        source: "conductor",
        origin: "conductor",
        sourceId: "c1",
        agentSessionId: "abc",
        conductorSessionId: "c1",
        state: "working",
        lastActivityAt: "2026-09-20T11:59:50.000Z",
      }),
    ];
    const observe = vi.fn(() => conductor);
    const deps: FleetMonitorDependencies = {
      store,
      conductor: { observe } as unknown as FleetMonitorDependencies["conductor"],
      claude: { observe: () => [] } as unknown as FleetMonitorDependencies["claude"],
      codex: { observe: () => [] } as unknown as FleetMonitorDependencies["codex"],
      liveness: { observe: async () => [] } as unknown as FleetMonitorDependencies["liveness"],
    };
    return {
      deps,
      observe,
      setConductor: (next: ObservedSession[]) => {
        conductor = next;
      },
      current: () => conductor,
    };
  }

  it("keeps a Stop hook held while Conductor says working, then lands the finish on a follow-up read", async () => {
    vi.useFakeTimers();
    try {
      const h = conductorHarness();
      const monitor = new FleetMonitor(h.deps, {
        now: () => Date.parse("2026-09-20T12:00:00.000Z"),
        pollIntervalMs: 3_600_000,
      });
      await monitor.refresh();
      expect(monitor.snapshot.sessions[0]?.state).toBe("working");

      monitor.ingestHookEvent(hookEvent({ event: "Stop", message: null, receivedAt: "2026-09-20T12:00:00.000Z" }));
      await vi.advanceTimersByTimeAsync(450); // the 400 ms hook debounce re-read: still held
      expect(monitor.snapshot.sessions[0]?.state).toBe("working");

      // Conductor flips status a moment after the turn-end row.
      h.setConductor([{ ...h.current()[0]!, state: "finished", lastActivityAt: "2026-09-20T12:00:00.500Z" }]);
      await vi.advanceTimersByTimeAsync(1_100); // the 1.5 s follow-up
      expect(monitor.snapshot.sessions[0]?.state).toBe("finished");
      monitor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule follow-ups for a Stop on a session Conductor does not hold", async () => {
    vi.useFakeTimers();
    try {
      const h = conductorHarness();
      h.setConductor([]);
      const monitor = new FleetMonitor(h.deps, { now: () => Date.parse("2026-09-20T12:00:00.000Z") });
      await monitor.refresh();
      h.observe.mockClear();
      monitor.ingestHookEvent(hookEvent({ event: "Stop", message: null }));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.observe).toHaveBeenCalledTimes(1); // only the 400 ms hook debounce
      monitor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes shortly after a watched file changes, coalescing a burst", async () => {
    vi.useFakeTimers();
    try {
      const h = conductorHarness();
      let notify: (() => void) | null = null;
      const monitor = new FleetMonitor(h.deps, {
        now: () => Date.parse("2026-09-20T12:00:00.000Z"),
        pollIntervalMs: 3_600_000,
        watch: [{ dir: "/c", names: ["conductor.db"] }],
        watchDeps: {
          watch: (_dir, _opts, listener) => {
            notify = () => listener("change", "conductor.db");
            return { close: () => undefined, on: () => undefined };
          },
          stat: () => null,
        },
      });
      monitor.start();
      await vi.advanceTimersByTimeAsync(10);
      h.observe.mockClear();

      notify!();
      notify!();
      notify!();
      await vi.advanceTimersByTimeAsync(200);
      expect(h.observe).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(h.observe).toHaveBeenCalledTimes(1);
      monitor.stop();
      notify!();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.observe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("workflows", () => {
  it("pages once per call a film waits on, even when no refresh saw the director work in between", async () => {
    const store = makeStore();
    let call: { call: "story" | "look"; since: string } | null = { call: "story", since: "2026-09-20T11:58:00.000Z" };
    const pushes: AttentionItem[][] = [];
    const monitor = new FleetMonitor(
      {
        store,
        conductor: { observe: () => [] } as unknown as FleetMonitorDependencies["conductor"],
        claude: { observe: () => [observed({ state: "finished" })] } as unknown as FleetMonitorDependencies["claude"],
        codex: { observe: () => [] } as unknown as FleetMonitorDependencies["codex"],
        liveness: { observe: async () => [] } as unknown as FleetMonitorDependencies["liveness"],
        workflows: {
          annotate: (sessions) =>
            sessions.map((session) =>
              call
                ? {
                    ...session,
                    state: "awaiting_input" as const,
                    detail: `RasanAI · ${call.call}`,
                    workflow: {
                      provider: "rasanai" as const,
                      projectDir: "/f",
                      runDir: "/f/.rasanai/r",
                      title: "Film",
                      call: call.call,
                      step: call.call,
                      revision: `${call.call}@${call.since}`,
                      since: call.since,
                      prompt: call.call,
                    },
                  }
                : session,
            ),
        },
      },
      { now: () => Date.parse("2026-09-20T12:00:00.000Z") },
    );
    monitor.onPush((items) => pushes.push(items));

    await monitor.refresh();
    await monitor.refresh();
    call = { call: "look", since: "2026-09-20T11:59:30.000Z" };
    await monitor.refresh();

    expect(pushes.flat().map((item) => [item.kind, item.session.workflow?.call])).toEqual([
      ["blocked_question", "story"],
      ["blocked_question", "look"],
    ]);
  });

  it("carries on without workflows when reading them throws", async () => {
    const store = makeStore();
    const monitor = new FleetMonitor({
      store,
      conductor: { observe: () => [] } as unknown as FleetMonitorDependencies["conductor"],
      claude: { observe: () => [observed()] } as unknown as FleetMonitorDependencies["claude"],
      codex: { observe: () => [] } as unknown as FleetMonitorDependencies["codex"],
      liveness: { observe: async () => [] } as unknown as FleetMonitorDependencies["liveness"],
      workflows: {
        annotate: () => {
          throw new Error("disk gone");
        },
      },
    });
    expect((await monitor.refresh()).sessions.map((session) => session.state)).toEqual(["working"]);
  });
});
