/**
 * Regenerate the phone's fixture of everything the Mac makes
 * (ios/SqueakCore/Tests/SqueakCoreTests/Fixtures/mac-made.json), from the real
 * RemoteBridge.phoneView and remote-crypto, so the Swift tests decode exactly
 * what a Mac sends. Run after changing any shape the phone reads:
 *
 *   npx tsx scripts/make-mac-fixture.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FleetSnapshot } from "../src/fleet/fleet-monitor.js";
import type { FleetSession } from "../src/fleet/types.js";
import { RemoteBridge, type ChannelStore } from "../src/remote/remote-bridge.js";
import { seal } from "../src/remote/remote-crypto.js";

const out = path.resolve("ios/SqueakCore/Tests/SqueakCoreTests/Fixtures/mac-made.json");

function session(overrides: Partial<FleetSession>): FleetSession {
  return {
    key: "claude-transcript:s1",
    source: "claude-transcript",
    agent: "claude",
    origin: "conductor",
    sourceId: "s1",
    agentSessionId: "s1",
    conductorSessionId: "s1",
    cwd: "/w",
    repoName: "farm",
    branch: "arm",
    title: "Farm",
    state: "finished",
    detail: "D1?",
    lastActivityAt: "2026-09-25T02:59:00.000Z",
    transcriptPath: null,
    pid: null,
    alive: false,
    stateSource: "transcript",
    contextPercent: null,
    retired: false,
    baseRef: null,
    costUsd: null,
    git: null,
    ...overrides,
  } as FleetSession;
}

const sessions = [
  session({}),
  session({
    key: "claude-transcript:s2",
    sourceId: "s2",
    agentSessionId: "s2",
    conductorSessionId: "s2",
    branch: "timer",
    title: "Timer",
    state: "working",
    detail: "Run tests",
  }),
];
const codexUsage = {
  planType: "pro",
  primary: { usedPercent: 9, windowMinutes: 300, resetsAt: "2026-09-25T06:40:00.000Z" },
  secondary: { usedPercent: 31.4, windowMinutes: 10080, resetsAt: "2026-09-30T03:00:00.000Z" },
  hasCredits: false,
  creditBalance: null,
  observedAt: "2026-09-25T02:59:30.000Z",
};
const snapshot = { sessions, active: sessions, attention: [], generatedAt: "", codexUsage } as FleetSnapshot;
const noStore: ChannelStore = {
  get: async () => null,
  set: async () => {},
  list: async () => [],
  delete: async () => {},
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mac-fixture-"));

const bridge = new RemoteBridge({
  configPath: path.join(dir, "remote.json"),
  projectId: "squeak-5c9gvo",
  store: noStore,
  replier: {
    lastTurnText: (id) => (id === "s1" ? "D1 — Arm it?\n\nA) Arm it now (recommended)\nB) Leave it off" : null),
    lastTurnId: (id) => (id === "s1" ? "turn-1" : "turn-2"),
    send: async () => ({ status: "refused", reason: "fixture" }),
  },
  snapshot: () => snapshot,
  newChat: {
    workspaces: () => [
      {
        id: "w-arm",
        repoName: "farm",
        branch: "arm",
        lastActivityAt: "2026-09-25T02:59:00.000Z",
        defaultAgent: "claude",
      },
      {
        id: "w-timer",
        repoName: "farm",
        branch: "timer",
        lastActivityAt: "2026-09-24T02:59:00.000Z",
        defaultAgent: "codex",
      },
    ],
    start: async () => ({ ok: true, sessionId: "new-1" }),
  },
  claudeLimits: () => ({
    fiveHour: { utilization: 0.42, resetsAt: "2026-09-25T05:10:00.000Z" },
    sevenDay: { utilization: 0.18, resetsAt: "2026-09-29T08:00:00.000Z" },
    observedAt: "2026-09-25T00:00:00.000Z",
  }),
  activity: (target) =>
    target.state === "working"
      ? {
          total: 9,
          steps: [
            { kind: "thinking", text: "The retry loop races its own timer.", at: null },
            { kind: "note", text: "Clearing the old tick first.", at: null },
            { kind: "tool", text: "Edit timer.ts", at: null },
            { kind: "background", text: 'Agent "lint" finished', at: null },
          ],
        }
      : null,
  now: () => Date.parse("2026-09-25T03:00:00.000Z"),
  macName: "Test Mac",
});

const pairingURL = bridge.startPairing().url;
const key = JSON.parse(Buffer.from(new URL(pairingURL).searchParams.get("d")!, "base64url").toString()).k as string;
const view = bridge.phoneView();
const parts = bridge.phoneViewParts();
const z = { compress: true };
// Pairing starts the bridge's poll; a fixture has nothing to poll.
bridge.stop();

fs.writeFileSync(
  out,
  JSON.stringify(
    {
      pairingURL,
      snapshotBox: seal(key, view),
      resultBox: seal(key, { id: "c1", status: "sent", via: "conductor" }),
      queuedBox: seal(key, { id: "c3", status: "sent", via: "conductor", delivery: "queued" }),
      steeredBox: seal(key, { id: "c4", status: "sent", via: "conductor", delivery: "steered" }),
      steerFallbackBox: seal(key, {
        id: "c5",
        status: "sent",
        via: "conductor",
        delivery: "queued",
        note: "Steer needs Conductor's relay, so this was queued instead.",
      }),
      startedBox: seal(key, { id: "c6", status: "sent", sessionId: "new-1" }),
      refusedBox: seal(key, { id: "c2", status: "refused", reason: "That chat has moved on." }),
      pairAnswerBox: seal(key, { approved: true, mac: "Test Mac" }),
      // For a phone whose presence says caps ["z", "split"]: compressed, the recent list apart.
      splitSnapshotBox: seal(key, { ...parts.snapshot, seq: 1790305200002 }, z),
      recentBox: seal(key, { ...parts.recent, seq: 1790305200001 }, z),
      liveBox: seal(
        key,
        {
          v: 1,
          key: "claude-transcript:s2",
          working: true,
          state: "working",
          turnId: "turn-2",
          total: 2,
          steps: [{ kind: "note", text: "Clearing the old tick first.", at: null }],
          split: true,
          seq: 1790305200003,
        },
        z,
      ),
      liveHistoryBox: seal(
        key,
        {
          v: 1,
          key: "claude-transcript:s2",
          seq: 1790305200004,
          history: [{ role: "user", text: "Fix the timer", at: null }],
        },
        z,
      ),
    },
    null,
    2,
  ) + "\n",
);
fs.rmSync(dir, { recursive: true, force: true });
console.log(`wrote ${out}`);
console.log(
  JSON.stringify(
    view.sessions.map((s) => ({ label: s.label, state: s.state, activity: s.activity })),
    null,
    1,
  ).slice(0, 600),
);
