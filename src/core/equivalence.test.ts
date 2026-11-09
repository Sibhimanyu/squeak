import { describe, expect, it } from "vitest";
import { fleetSession } from "./adapters/fixtures.js";
import { classifyAttentions } from "../fleet/attention.js";
import { distinctTitles } from "../fleet/radar.js";
import { serializeState } from "../fleet/runtime.js";
import type { FleetMonitor, FleetSnapshot } from "../fleet/fleet-monitor.js";
import type { AttentionItem, FleetSession } from "../fleet/types.js";
import { AgentRegistry } from "./registry.js";
import { SqueakSessionStore } from "./session-store.js";

const nowMs = Date.now();
const minutesAgo = (m: number) => new Date(nowMs - m * 60_000).toISOString();

const sessions: FleetSession[] = [
  // two rows that collide on label (same repo and branch): titles must disambiguate
  fleetSession({
    key: "conductor:a",
    conductorSessionId: "a",
    origin: "conductor",
    title: "Add login",
    state: "working",
  }),
  fleetSession({
    key: "conductor:b",
    conductorSessionId: "b",
    origin: "conductor",
    title: "Fix tests",
    state: "working",
  }),
  fleetSession({
    key: "claude-transcript:stuck",
    repoName: "other",
    branch: "stuck",
    title: "Stuck one",
    state: "working",
    waitingOn: "model",
    waitingSince: minutesAgo(30),
    lastActivityAt: minutesAgo(30),
  }),
  fleetSession({
    key: "claude-transcript:approve",
    repoName: "third",
    branch: "appr",
    title: "Needs approval",
    state: "awaiting_approval",
  }),
  fleetSession({
    key: "claude-transcript:asked",
    repoName: "fourth",
    branch: "ask",
    title: "Asked",
    state: "finished",
    asks: "Open a PR?",
    contextPercent: 93,
  }),
];

function snapshot(): FleetSnapshot {
  const attention: AttentionItem[] = sessions.flatMap((session) =>
    classifyAttentions(session, 85, nowMs).map((kind) => ({ session, kind, score: 1, since: session.lastActivityAt })),
  );
  return { sessions, active: sessions, attention, generatedAt: new Date(nowMs).toISOString(), codexUsage: null };
}

describe("core sessions agree with radar and /state for one snapshot", () => {
  const snap = snapshot();
  const state = serializeState({ snapshot: snap } as unknown as FleetMonitor) as {
    active: {
      key: string;
      state: string;
      asks: string | null;
      stalled?: unknown;
      distinctTitle: string | null;
      title: string;
      contextPercent: number | null;
    }[];
    attention: { key: string; kind: string }[];
  };
  const store = new SqueakSessionStore({
    registry: new AgentRegistry(),
    source: { snapshot: snap, onSnapshot: () => () => {}, refresh: async () => {} },
    now: () => nowMs,
  });
  const core = new Map(store.sessions().map((s) => [s.id as string, s]));

  it("covers every active session", () => expect(core.size).toBe(sessions.length));

  it("displayTitle is radar's distinct title when rows collide, the plain title otherwise", () => {
    const titles = distinctTitles(sessions);
    expect(titles.get("conductor:a")).toBe("Add login");
    for (const row of state.active) {
      expect(core.get(row.key)?.attention?.displayTitle).toBe(row.distinctTitle ?? row.title);
    }
  });

  it("stalled matches /state's stalled flag and keeps state working", () => {
    for (const row of state.active) {
      expect(core.get(row.key)?.attention?.stalled).toBe(row.stalled !== undefined);
    }
    expect(core.get("claude-transcript:stuck")).toMatchObject({ state: "working", attention: { stalled: true } });
  });

  it("asks list the same attention kinds as /state, and the question matches", () => {
    for (const row of state.active) {
      const kinds = state.attention.filter((a) => a.key === row.key).map((a) => a.kind);
      expect(core.get(row.key)?.attention?.asks).toEqual(kinds);
      expect(core.get(row.key)?.attention?.question).toBe(row.asks ?? undefined);
    }
  });

  it("state: blocked approval, finished-with-asks, and context pressure", () => {
    expect(core.get("claude-transcript:approve")?.state).toBe("waitingForPermission");
    const asked = core.get("claude-transcript:asked");
    expect(asked?.state).toBe("waitingForInput");
    expect(asked?.attention?.asks).toContain("asked_question");
    expect(asked?.attention?.contextPercent).toBe(93);
  });
});
