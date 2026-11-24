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

import { AddonHost } from "../src/addon-host.js";
import { filmsViewFields, sessionFields } from "../addons/rasanai/phone.js";
import type { FleetSnapshot } from "../src/fleet/fleet-monitor.js";
import type { FleetSession } from "../src/fleet/types.js";
import { RemoteBridge, type ChannelStore } from "../src/remote/remote-bridge.js";
import { seal } from "../src/remote/remote-crypto.js";
import { buildFlockThreadDoc, reduceFlockEvents } from "../src/remote/flock-thread.js";
import { buildPondThreads } from "../src/remote/pond-threads.js";
import { buildPondRoom } from "../src/remote/pond-room.js";
import { realDirectorDeps } from "../addons/rasanai/director.js";
import { FilmService } from "../addons/rasanai/films.js";
import { RasanaiProvider } from "../addons/rasanai/provider.js";

// The ordinary view is the flag off (it is on by default now); the ducks view below turns it on.
process.env.SQUEAK_DUCKS_OWN_BRANCH = "off";

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
const film = JSON.parse(fs.readFileSync("addons/rasanai/fixtures/quotidian-session.json", "utf8"));
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
const brief = JSON.parse(fs.readFileSync("addons/rasanai/fixtures/26keys-brief.json", "utf8"));
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
  // A Squeak (native) chat waiting on a tool approval, with the open request's fields (caps "native").
  session({
    key: "squeak-native:n1",
    source: "squeak-native",
    origin: "squeak",
    sourceId: "n1",
    agentSessionId: null,
    conductorSessionId: null,
    repoName: "orchard",
    branch: "native",
    title: "Native",
    state: "awaiting_approval",
    detail: "Bash: npm test",
    nativeRequest: { id: "r1", kind: "tool", summary: "Bash: npm test" },
  } as Partial<FleetSession>),
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

// RasanAI is an add-on: the same view fields and session fields its handle gives, through the host, enabled.
const addonHost = new AddonHost(fs.mkdtempSync(path.join(os.tmpdir(), "mac-fixture-addons-")));
addonHost.register(
  { id: "rasanai", name: "RasanAI", blurb: "" },
  {
    phoneViewFields: (snapshot, caps) => filmsViewFields(films, snapshot.active, caps),
    phoneSessionFields: (candidate) => sessionFields(rasanai, candidate),
  },
);
addonHost.setEnabled("rasanai", true);
const rasanaiPhone = addonHost.remotePhone();

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
  native: {
    detail: (_id, summary) => ({
      id: summary.id,
      kind: summary.kind,
      summary: summary.summary,
      tool: "Bash",
      command: "npm test",
      chatRule: true,
    }),
    projects: () => [
      {
        id: "p1",
        name: "farm",
        rootPath: "/repo/farm",
        workspaces: [{ id: "w1", name: "arm", branch: "arm" }],
        paths: new Map([["w1", "/ws/arm"]]),
      },
    ],
    models: () => [
      { agent: "claude", id: "opus-5-5-1m", label: "Opus 5.5 · 1M", levels: ["low", "high"], favorite: true },
    ],
    allowBypass: () => false,
    // Ponds as the host reports them (ponds2): one hidden with a colour, labels and an archived stream.
    ponds: async () => [
      {
        id: "p-shop",
        name: "Shop",
        shared: true,
        members: [{ name: "Asha", online: true }],
        pondId: "p-shop",
        projectId: "p1",
        folder: "/repo/farm",
        colour: "teal",
        labels: ["web"],
        streams: [
          { id: "w1", name: "Arm", branch: "arm" },
          { id: "w2", name: "Timer", branch: "timer" },
        ],
        archivedStreams: 2,
      },
      {
        id: "p-docs",
        name: "Docs",
        shared: false,
        members: [],
        pondId: "p-docs",
        projectId: "proj-docs",
        hidden: true,
        streams: [],
        archivedStreams: 0,
      },
      {
        id: "p-theirs",
        name: "Theirs",
        shared: true,
        members: [],
        kind: "joined",
        access: "remote",
        pondId: "p-theirs",
      },
    ],
    pondOrder: async () => ({ mode: "manual" as const, ids: ["proj-docs", "p1"] }),
    pondDetail: async (id: string) => ({
      id,
      invites: [{ label: "editor invite", expiresAt: "2026-09-26T03:00:00.000Z" }],
      waiting: [{ name: "Ravi" }],
      ripples: [{ text: "started Timer", at: "2026-09-25T02:00:00.000Z", who: "Asha" }],
    }),
    currentRequest: async () => null,
    respond: async () => {},
    start: async () => ({ id: "n9" }),
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
  addonPhone: rasanaiPhone,
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
// The phone in front of this Mac reads films and Squeak chats' requests: its presence would say so.
(bridge as unknown as { phoneCaps: string[] }).phoneCaps = ["films", "native", "ponds2"];
// ... and has the pond "p-shop" open.
(bridge as unknown as { presencePond: string }).presencePond = "p-shop";
await (bridge as unknown as { refreshPonds(): Promise<void> }).refreshPonds();
await (bridge as unknown as { refreshPondDetail(): Promise<void> }).refreshPondDetail();
const view = bridge.phoneView();
const parts = bridge.phoneViewParts();
const z = { compress: true };
// Pairing starts the bridge's poll; a fixture has nothing to poll.
bridge.stop();

// Ducks own their branch (flag on): the same Mac with three Squeak chats in the farm pond, two ducks on a branch and
// one on main. Built last, with the flag on only for this view, so every box above is the flag-off one.
const duckChat = (key: string, over: Partial<FleetSession>) =>
  session({
    key: `squeak-native:${key}`,
    source: "squeak-native",
    origin: "squeak",
    sourceId: key,
    agentSessionId: null,
    conductorSessionId: null,
    repoName: "farm",
    projectId: "p1",
    state: "finished",
    ...over,
  } as Partial<FleetSession>);
const duckSessions = [
  duckChat("dk1", {
    cwd: "/repo/farm/ws/arm",
    branch: "arm",
    duckId: "duck-1",
    title: "Arm",
    lastActivityAt: "2026-09-25T02:58:00.000Z",
  }),
  duckChat("dk2", {
    cwd: "/repo/farm/ws/arm",
    branch: "arm",
    duckId: "duck-2",
    title: "Wire",
    lastActivityAt: "2026-09-25T02:50:00.000Z",
  }),
  duckChat("dk3", {
    cwd: "/repo/farm",
    branch: "master",
    duckId: "duck-3",
    title: "Plan",
    lastActivityAt: "2026-09-25T02:40:00.000Z",
  }),
];
sessions.push(...duckSessions);
process.env.SQUEAK_DUCKS_OWN_BRANCH = "on";
const ducksView = bridge.phoneView();
const ducksThreads = buildPondThreads(
  { id: "p-shop", name: "Shop", shared: true, members: [], folder: "/repo/farm", streams: [] },
  duckSessions,
  () => true,
  (s) => s.title ?? "Untitled",
  () => false,
  [],
  true,
);
delete process.env.SQUEAK_DUCKS_OWN_BRANCH;

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
      ducksSnapshotBox: seal(key, ducksView),
      ducksPondThreadsBox: seal(key, { ...ducksThreads, seq: 1790305200005 }),
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
      // A pond's whole thread list (the real builder): Main first, then streams, newest first.
      pondThreadsBox: seal(
        key,
        {
          ...buildPondThreads(
            { id: "p-green", name: "greenroom", shared: false, members: [], folder: "/r/green", streams: [] },
            [
              session({
                key: "squeak-native:a",
                cwd: "/r/green",
                branch: "main",
                title: "Plan",
                lastActivityAt: "2026-09-01T00:00:00.000Z",
              }),
              session({
                key: "squeak-native:b",
                cwd: "/r/green/ws/hk",
                branch: "hong-kong",
                title: "Menu",
                lastActivityAt: "2026-09-20T00:00:00.000Z",
              }),
              session({
                key: "squeak-native:c",
                cwd: "/r/green/ws/hk",
                branch: "hong-kong",
                title: "Old",
                lastActivityAt: "2026-08-01T00:00:00.000Z",
              }),
            ],
            () => true,
            (s) => s.title ?? "Untitled",
          ),
          // Other members' threads and this person's switches, as `NativePhone.pondFlock` answers them.
          flock: [
            {
              id: "t-aarav",
              title: "Add tests",
              state: "working",
              at: "2026-09-24T00:00:00.000Z",
              by: "Aarav",
              mode: "own",
              poweredBy: "Powered by Aarav-mac · Flotilla",
              locked: true,
            },
          ],
          access: { canMessage: false, reason: "The owner has turned off messaging for you in this pond." },
          seq: 1790305200005,
        },
        z,
      ),
      // A pond member's open thread (the real reducer and builder), read-only with the owner's reason.
      flockThreadBox: seal(
        key,
        {
          ...buildFlockThreadDoc(
            "p-green",
            {
              id: "t-aarav",
              title: "Add tests",
              state: "working",
              at: "2026-09-24T00:00:00.000Z",
              by: "Aarav",
              mode: "own",
              poweredBy: "Powered by Aarav-mac · Flotilla",
              locked: true,
            },
            { canMessage: false, reason: "The owner has turned off messaging for you in this pond." },
            reduceFlockEvents({ entries: [], state: null, lastSeq: 0 }, [
              { seq: 1, at: 1, type: "user", by: "m1", byName: "Aarav", text: "Add tests for the menu" },
              { seq: 2, at: 2, type: "tool", id: "t1", label: "Read menu.ts", state: "done" },
              { seq: 3, at: 3, type: "agent", text: "Writing them now." },
              { seq: 4, at: 4, type: "approval", requestId: "r1", label: "Run npm test" },
            ]),
          ),
          seq: 1790305200006,
        },
        z,
      ),
      // A pond's Room (the real builder, fed the host's page shape): a message, a Duck's state line with detail, a Task
      // with its routing line, a person's own words, and a Duck's reply.
      pondRoomBox: seal(
        key,
        {
          ...buildPondRoom("p-green", {
            member: false,
            page: {
              posts: [
                {
                  seq: 1,
                  id: "post-1",
                  author: { kind: "person", id: "owner", name: "Sam" },
                  kind: "message",
                  level: "room",
                  text: "Make the menu icons crisp on retina",
                  at: 1790305200000,
                },
                {
                  seq: 2,
                  id: "post-2",
                  author: { kind: "agent", id: "s-pixel", name: "icon work" },
                  sessionId: "s-pixel",
                  kind: "working",
                  level: "room",
                  text: "Re-rendering the menu icons at 2x\nChecked four sizes; the 16 px one is blurry.",
                  at: 1790305230000,
                },
                {
                  seq: 3,
                  id: "post-3",
                  author: { kind: "person", id: "m-aarav", name: "Aarav" },
                  kind: "message",
                  level: "room",
                  text: "Sounds good",
                  at: 1790305260000,
                },
                {
                  seq: 4,
                  id: "post-4",
                  author: { kind: "agent", id: "s-pixel", name: "icon work" },
                  sessionId: "s-pixel",
                  kind: "plan",
                  level: "room",
                  text: "Plan: crisp icons at 2x",
                  detail: "Spec: every menu icon at 2x.\nPlan: 1. re-render 2. check 16 px",
                  at: 1790305270000,
                },
                {
                  seq: 5,
                  id: "post-5",
                  author: { kind: "agent", id: "s-pixel", name: "icon work" },
                  sessionId: "s-pixel",
                  kind: "done",
                  level: "room",
                  text: "Done: icons re-rendered",
                  canvases: [{ id: "c0ffee", title: "Icon sheet", kind: "deck", artboards: 3 }],
                  at: 1790305280000,
                },
              ],
              latestSeq: 5,
              threads: [{ sessionId: "s-pixel", title: "icon work", name: "Pixel" }],
              turns: [],
              tasks: [
                {
                  id: "task:1",
                  messageId: "post-1",
                  title: "Make the menu icons crisp on retina",
                  text: "Make the menu icons crisp on retina",
                  state: "working",
                  suggestion: { sessionId: "s-pixel", title: "Pixel", reason: "related to the icon work" },
                  handedTo: { sessionId: "s-pixel", title: "Pixel", newThread: false },
                  createdAt: 1790305210000,
                  updatedAt: 1790305220000,
                },
              ],
            },
          }),
          seq: 1790305200007,
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
