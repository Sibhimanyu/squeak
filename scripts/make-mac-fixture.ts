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
import { realDirectorDeps } from "../src/workflows/rasanai/director.js";
import { FilmService } from "../src/workflows/rasanai/films.js";
import { RasanaiProvider } from "../src/workflows/rasanai/provider.js";

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

// A RasanAI film waiting at its look call, from a trimmed real run, through the real provider.
const filmDir = fs.mkdtempSync(path.join(os.tmpdir(), "mac-fixture-film-"));
const film = JSON.parse(fs.readFileSync("src/workflows/rasanai/fixtures/quotidian-session.json", "utf8"));
delete film._askWhenOpen;
film.current = "look";
fs.mkdirSync(path.join(filmDir, ".rasanai", "run-1"), { recursive: true });
fs.writeFileSync(path.join(filmDir, ".rasanai", "current"), "run-1");
fs.writeFileSync(path.join(filmDir, ".rasanai", "run-1", "session.json"), JSON.stringify(film));
// The same film again at its animatic, with a note on it, for the phone's review card.
const animaticDir = fs.mkdtempSync(path.join(os.tmpdir(), "mac-fixture-animatic-"));
const atAnimatic = { ...film, current: "animatic", steps: { ...film.steps } };
atAnimatic.steps.animatic = { ...film.steps.animatic, music: { file: ".rasanai/run-1/animatic-mix.wav" } };
atAnimatic.comments = [
  { id: "n1", step: "animatic", t: 3.5, scene: "b1", x: 0.25, y: 0.5, text: "Hold the title longer", state: "open" },
];
fs.mkdirSync(path.join(animaticDir, ".rasanai", "run-1"), { recursive: true });
fs.writeFileSync(path.join(animaticDir, ".rasanai", "current"), "run-1");
fs.writeFileSync(path.join(animaticDir, ".rasanai", "run-1", "session.json"), JSON.stringify(atAnimatic));
const rasanai = new RasanaiProvider({ now: () => Date.parse("2026-10-14T17:00:00.000Z") });
const [director, animaticDirector] = rasanai.annotate([
  session({
    key: "claude-transcript:d1",
    sourceId: "d1",
    agentSessionId: "d1",
    conductorSessionId: null,
    origin: "sdk",
    cwd: filmDir,
    repoName: null,
    branch: null,
    title: null,
  }),
  session({
    key: "claude-transcript:d2",
    sourceId: "d2",
    agentSessionId: "d2",
    conductorSessionId: null,
    origin: "sdk",
    cwd: animaticDir,
    repoName: null,
    branch: null,
    title: null,
  }),
]);

// A film, independent of any chat: its brief waiting (a v2 run, from a trimmed real run), its director stopped
// with an engine that can resume it, a message to Rasan waiting to be read, and the thread so far.
const filmsRoot = "/tmp/squeak-mac-fixture";
fs.rmSync(filmsRoot, { recursive: true, force: true });
const briefDir = path.join(filmsRoot, "films", "26keys");
const briefRun = path.join(briefDir, ".rasanai", "run-1");
const engineDir = path.join(filmsRoot, "engine");
fs.mkdirSync(briefRun, { recursive: true });
fs.mkdirSync(path.join(engineDir, "scripts"), { recursive: true });
fs.writeFileSync(path.join(engineDir, "SKILL.md"), "---\nname: rasanai\n---\n");
fs.writeFileSync(path.join(engineDir, "scripts", "director.mjs"), "console.log(JSON.stringify({ ok: true }));\n");
const brief = JSON.parse(fs.readFileSync("src/workflows/rasanai/fixtures/26keys-brief.json", "utf8"));
fs.writeFileSync(path.join(briefDir, ".rasanai", "current"), "run-1");
fs.writeFileSync(path.join(briefRun, "session.json"), JSON.stringify(brief));
fs.writeFileSync(
  path.join(briefRun, "console.json"),
  JSON.stringify({ headless: true, external_actions: 2, skill: engineDir }),
);
fs.writeFileSync(
  path.join(briefRun, "director-events.jsonl"),
  `${JSON.stringify({ t: "2026-10-26T07:17:37.532Z", event: "start", pid: 1341 })}\n${JSON.stringify({ t: "2026-10-26T07:33:56.642Z", event: "exit", code: 130, stopped: true })}\n`,
);
fs.writeFileSync(
  path.join(briefRun, "actions.jsonl"),
  `${JSON.stringify({ id: "sqfixture1", ts: "2026-10-26T07:40:00.000Z", step: "brief", type: "note", value: { chat: { rules: "r", max_sentences: 3, max_tool_calls: 3, context: { step: "brief" } } }, note: "What is it doing?", source: "squeak-phone" })}\n`,
);
const filmNow = () => Date.parse("2026-10-26T08:00:00.000Z");
const films = new FilmService({
  provider: new RasanaiProvider({ now: filmNow }),
  roots: [path.join(filmsRoot, "films")],
  now: filmNow,
  director: { engineRoots: [filmsRoot], run: realDirectorDeps.run },
});

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
  director!,
  animaticDirector!,
  // A finished chat that closes on a question for you: `asks`, which the phone counts as needing you.
  session({
    key: "claude-transcript:s3",
    sourceId: "s3",
    agentSessionId: "s3",
    conductorSessionId: "s3",
    branch: "pr",
    title: "PR",
    asks: "Want me to open a PR?",
    // What the chat runs, named on the Mac (Conductor's own row; absent for a terminal agent).
    model: "Opus 5.5 · 1M",
    effort: "Extra high",
    fast: true,
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
  workflow: rasanai,
  films,
  // The awake session as the daemon reports it, so the phone's tests decode the real fields.
  awake: {
    state: () => null,
    apply: () => ({ ok: true, state: null }),
    lidActions: () => ({ displayOff: true, mute: false, lowPower: true, freezeApps: true }),
    rules: () => ({ lowPowerPercent: 35, endPercent: 8, heat: true }),
    lastEnd: () => ({ reason: "battery", at: "2026-09-25T01:00:00.000Z", why: "Battery at 8%" }),
    sleepProblem: () => null,
  },
  now: () => Date.parse("2026-09-25T03:00:00.000Z"),
  macName: "Test Mac",
});

const pairingURL = bridge.startPairing().url;
const key = JSON.parse(Buffer.from(new URL(pairingURL).searchParams.get("d")!, "base64url").toString()).k as string;
// The phone in front of this Mac reads films: its presence would say so.
(bridge as unknown as { phoneCaps: string[] }).phoneCaps = ["films"];
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
      // A film's phone copy is sent as chunks like this one, named by a media result.
      mediaResultBox: seal(key, {
        id: "c7",
        status: "sent",
        media: {
          id: "abcdef0123456789",
          chunks: 1,
          bytes: 5,
          sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          mime: "audio/mp4",
        },
      }),
      mediaChunkBox: seal(key, { i: 0, n: 1, data: Buffer.from("hello").toString("base64") }),
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
fs.rmSync(filmDir, { recursive: true, force: true });
fs.rmSync(animaticDir, { recursive: true, force: true });
fs.rmSync(filmsRoot, { recursive: true, force: true });
console.log(`wrote ${out}`);
console.log(
  JSON.stringify(
    view.sessions.map((s) => ({ label: s.label, state: s.state, activity: s.activity })),
    null,
    1,
  ).slice(0, 600),
);
