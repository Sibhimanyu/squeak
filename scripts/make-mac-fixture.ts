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
const snapshot = { sessions, active: sessions, attention: [], generatedAt: "", codexUsage: null } as FleetSnapshot;
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
// Pairing starts the bridge's poll; a fixture has nothing to poll.
bridge.stop();

fs.writeFileSync(
  out,
  JSON.stringify(
    {
      pairingURL,
      snapshotBox: seal(key, view),
      resultBox: seal(key, { id: "c1", status: "sent", via: "conductor" }),
      refusedBox: seal(key, { id: "c2", status: "refused", reason: "That chat has moved on." }),
      pairAnswerBox: seal(key, { approved: true, mac: "Test Mac" }),
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
