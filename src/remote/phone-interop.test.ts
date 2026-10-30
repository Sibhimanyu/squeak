import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { FleetSnapshot } from "../fleet/fleet-monitor.js";
import type { QueueAction, ReplyOptions } from "../fleet/session-reply.js";
import type { FleetSession } from "../fleet/types.js";
import { RemoteBridge, type RemoteConfig } from "./remote-bridge.js";

/**
 * A reply built and signed by the iPhone's own code (ios/SqueakCore,
 * `swift run squeak-fixtures`), fed to the Mac's real verifier. If the two
 * sides ever drift — encoding, signature format, field names — this fails.
 */
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "swift-command.json"), "utf8")) as {
  madeAt: number;
  key: string;
  channelId: string;
  deviceId: string;
  publicKey: string;
  commandId: string;
  command: { box: string; sig: string; device: string };
  steerCommandId: string;
  steerCommand: { box: string; sig: string; device: string };
  startCommandId: string;
  startCommand: { box: string; sig: string; device: string };
  splitStartCommandId: string;
  splitStartCommand: { box: string; sig: string; device: string };
  answerCommandId: string;
  answerCommand: { box: string; sig: string; device: string };
  queuedCommandId: string;
  queuedCommand: { box: string; sig: string; device: string };
  promoteCommandId: string;
  promoteCommand: { box: string; sig: string; device: string };
  stopCommandId: string;
  stopCommand: { box: string; sig: string; device: string };
  prCommandId: string;
  prCommand: { box: string; sig: string; device: string };
  setupCommandId: string;
  setupCommand: { box: string; sig: string; device: string };
  diffCommandId: string;
  diffCommand: { box: string; sig: string; device: string };
  imageCommandId: string;
  imageCommand: { box: string; sig: string; device: string };
  hotspotCommandId: string;
  hotspotCommand: { box: string; sig: string; device: string };
  lidActionsCommandId: string;
  lidActionsCommand: { box: string; sig: string; device: string };
  voicePauseCommandId: string;
  voicePauseCommand: { box: string; sig: string; device: string };
  voicePinPolicyCommandId: string;
  voicePinPolicyCommand: { box: string; sig: string; device: string };
  controlsCommandId: string;
  controlsCommand: { box: string; sig: string; device: string };
  tabCommandId: string;
  tabCommand: { box: string; sig: string; device: string };
  statsCommandId: string;
  statsCommand: { box: string; sig: string; device: string };
  workflowChooseCommandId: string;
  workflowChooseCommand: { box: string; sig: string; device: string };
  workflowMoreCommandId: string;
  workflowMoreCommand: { box: string; sig: string; device: string };
  workflowAnswerCommandId: string;
  workflowAnswerCommand: { box: string; sig: string; device: string };
  workflowNoteCommandId: string;
  workflowNoteCommand: { box: string; sig: string; device: string };
  workflowApplyCommandId: string;
  workflowApplyCommand: { box: string; sig: string; device: string };
  mediaCommandId: string;
  mediaCommand: { box: string; sig: string; device: string };
  workflowImageCommandId: string;
  workflowImageCommand: { box: string; sig: string; device: string };
};

const QUEUED_ID = "0f4c8a52-3c1e-4b9e-9a57-6f0e2d1c7b31";

function bridge(turn: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-interop-"));
  const configPath = path.join(dir, "remote.json");
  const config: RemoteConfig = {
    projectId: "squeak-test",
    channelId: fixture.channelId,
    key: fixture.key,
    devices: [{ id: fixture.deviceId, name: "iPhone", publicKey: fixture.publicKey, pairedAt: "2026-09-25T00:00:00Z" }],
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const sends: Array<[string, string, string | undefined]> = [];
  const sent: Array<ReplyOptions | undefined> = [];
  const queueActions: Array<[string, string, QueueAction]> = [];
  const stops: string[] = [];
  const setups: unknown[][] = [];
  const hotspotRequests: unknown[] = [];
  const awakeRequests: unknown[] = [];
  const controlChanges: unknown[] = [];
  const voiceApplied: unknown[] = [];
  const pinActions: unknown[] = [];
  const statsRanges: unknown[] = [];
  const starts: Array<{ workspaceId: string; agent: string; text: string; split?: unknown }> = [];
  const answers: Array<[string, unknown]> = [];
  const acts: Array<[string, unknown]> = [];
  const written: string[] = [];
  const mediaFile = path.join(dir, "copy.m4a");
  fs.writeFileSync(mediaFile, Buffer.alloc(1000, 7));
  const pictures: Array<[string, string]> = [];
  const remote = new RemoteBridge({
    configPath,
    projectId: "squeak-test",
    // A streaming store, as the Realtime Database is: films go only that way.
    store: {
      get: async () => null,
      set: async (doc: string) => {
        written.push(doc);
      },
      list: async () => [],
      delete: async () => {},
      watch: () => () => {},
    },
    replier: {
      // The chat's latest answer, which names the image the phone asks for.
      lastTurnText: () => "![Shot](/w/.context/shot.png)",
      lastTurnId: () => turn,
      send: async (sessionId, text, _onFailed, options) => {
        sends.push([sessionId, text, options?.mode]);
        sent.push(options);
        return { status: "started", via: "conductor", delivery: options?.mode === "steer" ? "steered" : "sent" };
      },
      queue: async () => [{ id: QUEUED_ID, text: "Then add tests", mode: "queue", position: 0 }],
      queueAction: async (sessionId, messageId, action) => {
        queueActions.push([sessionId, messageId, action]);
        return { ok: true };
      },
      stopTurn: async (sessionId) => {
        stops.push(sessionId);
        return { ok: true };
      },
      setSetup: async (sessionId, setup) => {
        setups.push([sessionId, setup]);
        return { ok: true };
      },
    },
    voice: {
      state: () => ({ mode: "gateway" }),
      apply: (change: unknown) => {
        voiceApplied.push(change);
        return { ok: true as const, state: {} };
      },
      test: () => ({ ok: true as const }),
      changePin: async () => ({ ok: true as const }),
      pinAction: async (action) => {
        pinActions.push(action);
        return { ok: true as const };
      },
    },
    image: async (source, cwd) => {
      pictures.push([source, cwd]);
      return { ok: true, image: { mime: "image/jpeg", data: "AAAA" } };
    },
    media: async (source, cwd) => {
      pictures.push([source, cwd]);
      return { ok: true, file: { path: mediaFile, mime: "audio/mp4", bytes: 1000 } };
    },
    // A RasanAI film; the provider's own checks are tested in workflows/rasanai.
    workflow: {
      view: () => null,
      allowsImage: (_status, source) => source === ".rasanai/run-1/design/Wild/specimen.png",
      allowsMedia: (_status, source) => source === ".rasanai/run-1/animatic-mix.wav",
      act: (projectDir, action) => {
        acts.push([projectDir, action]);
        return { ok: true, actionId: "sq1", said: "Sent" };
      },
    },
    stats: async (range: unknown, agent?: unknown) => {
      statsRanges.push([range, agent]);
      return { range } as never;
    },
    controls: {
      state: () => ({
        volume: 40,
        muted: false,
        brightness: null,
        screenAwake: false,
        fans: { mode: "auto" as const, choice: "auto" as const, available: true, rpm: [] },
      }),
      apply: async (change: unknown) => {
        controlChanges.push(change);
        return {
          ok: true as const,
          state: {
            volume: 40,
            muted: false,
            brightness: null,
            screenAwake: false,
            fans: { mode: "60" as const, choice: "60" as const, available: true, rpm: [] },
          },
        };
      },
    },
    hotspot: {
      state: () => ({ configured: true, ssid: "Sibhi's iPhone", enabled: true, onHotspot: false, last: null }),
      apply: async (request: unknown) => {
        hotspotRequests.push(request);
        return {
          ok: true,
          state: { configured: true, ssid: "Sibhi's iPhone", enabled: true, onHotspot: false, last: null },
        };
      },
    },
    awake: {
      state: () => null,
      lidActions: () => ({ displayOff: true, mute: true, lowPower: true, freezeApps: false }),
      apply: (request: unknown) => {
        awakeRequests.push(request);
        return { ok: true as const, state: null };
      },
    },
    diff: {
      readSummary: async () => ({
        baseRef: null,
        files: [{ path: "a.ts", insertions: 1, deletions: 0, binary: false, untracked: false }],
        insertions: 1,
        deletions: 0,
        truncated: false,
      }),
      readFilePatch: async () => "+b",
    },
    // The chat the phone's commands name, as the Mac's own snapshot shows it.
    snapshot: () =>
      ({
        sessions: [],
        active: [
          {
            key: "claude-transcript:s1",
            agent: "claude",
            state: "finished",
            conductorSessionId: "s1",
            conductorWorkspaceId: "w1",
            cwd: "/w",
            baseRef: null,
          } as FleetSession,
          {
            key: "claude-transcript:d1",
            conductorSessionId: null,
            cwd: "/films/q",
            baseRef: null,
            workflow: { projectDir: "/films/q", step: "look", revision: "look@2026-10-14T16:56:23.780Z" },
          } as FleetSession,
        ],
      }) as unknown as FleetSnapshot,
    newChat: {
      workspaces: () => [
        { id: "w1", repoName: "farm", branch: "arm", lastActivityAt: "", defaultAgent: "claude" as const },
      ],
      models: () => [
        {
          agent: "claude" as const,
          id: "opus-5-5-1m",
          label: "Opus 5.5 · 1M",
          levels: ["low", "high"],
          favorite: true,
        },
      ],
      start: async (args) => {
        starts.push(args);
        return { ok: true, sessionId: "new-1" };
      },
    },
    // Records what the phone's answer asks for; delivery itself is answer-command's business.
    answerer: {
      answer: async (sessionId: string, input: unknown) => {
        answers.push([sessionId, input]);
        return { status: "answered", via: "stopped-and-sent" } as const;
      },
    } as never,
    // As of when the phone made it, so the fixture never expires.
    now: () => fixture.madeAt + 1_000,
  });
  return {
    remote,
    config,
    sends,
    sent,
    starts,
    queueActions,
    answers,
    stops,
    setups,
    hotspotRequests,
    awakeRequests,
    voiceApplied,
    pinActions,
    controlChanges,
    statsRanges,
    acts,
    pictures,
    written,
  };
}

describe("a reply made on the iPhone", () => {
  it("is accepted by the Mac and sent exactly as typed", async () => {
    const { remote, config, sends } = bridge("turn-1");
    const verdict = await remote.handleCommand(config, fixture.commandId, fixture.command);
    expect(verdict.result).toMatchObject({ status: "sent" });
    expect(sends).toEqual([["s1", "B", "queue"]]);
  });

  it("carries a signed steer mode through to the replier and reports the delivery", async () => {
    const { remote, config, sends } = bridge("turn-1");
    const verdict = await remote.handleCommand(config, fixture.steerCommandId, fixture.steerCommand);
    expect(verdict.result).toMatchObject({ status: "sent", delivery: "steered" });
    expect(sends).toEqual([["s1", "Use the timer instead", "steer"]]);
  });

  it("delivers an answer the phone signed, picks and its own words as typed", async () => {
    const { remote, config, answers } = bridge("turn-9");
    const verdict = await remote.handleCommand(config, fixture.answerCommandId, fixture.answerCommand);
    expect(verdict.result).toMatchObject({ id: fixture.answerCommandId, status: "answered", via: "stopped-and-sent" });
    expect(answers).toHaveLength(1);
    expect(answers[0]![0]).toBe("s1");
    expect(JSON.stringify(answers[0]![1])).toContain("toolu_fixture");
    expect(JSON.stringify(answers[0]![1])).toContain("Red");
    expect(JSON.stringify(answers[0]![1])).toContain("and a bit of blue");
  });

  it("starts a new chat when the phone signs a start command", async () => {
    const { remote, config, sends, starts } = bridge("turn-9");
    const verdict = await remote.handleCommand(config, fixture.startCommandId, fixture.startCommand);
    expect(verdict.result).toEqual({ id: fixture.startCommandId, status: "sent", sessionId: "new-1" });
    expect(starts).toEqual([{ workspaceId: "w1", agent: "codex", text: "Add a timer" }]);
    expect(sends).toEqual([]);
  });

  it("starts a split chat exactly as the phone signed it", async () => {
    const { remote, config, starts } = bridge("turn-9");
    const verdict = await remote.handleCommand(config, fixture.splitStartCommandId, fixture.splitStartCommand);
    expect(verdict.result).toMatchObject({ status: "sent" });
    expect(starts).toEqual([
      {
        workspaceId: "w1",
        agent: "claude",
        text: "Add a timer",
        split: { code: "sonnet", run: "haiku", planFirst: true },
      },
    ]);
  });

  it("carries the phone's own message id for a queued reply", async () => {
    const { remote, config, sends, sent } = bridge("turn-1");
    const verdict = await remote.handleCommand(config, fixture.queuedCommandId, fixture.queuedCommand);
    expect(verdict.result).toMatchObject({ status: "sent" });
    expect(sends).toEqual([["s1", "Then add tests", "queue"]]);
    expect(sent).toEqual([{ mode: "queue", messageId: QUEUED_ID }]);
  });

  it("steers a queued message in when the phone signs a queue command", async () => {
    const { remote, config, sends, queueActions } = bridge("turn-1");
    const verdict = await remote.handleCommand(config, fixture.promoteCommandId, fixture.promoteCommand);
    expect(verdict.result).toEqual({ id: fixture.promoteCommandId, status: "sent" });
    expect(queueActions).toEqual([["s1", QUEUED_ID, "promote"]]);
    expect(sends).toEqual([]);
  });

  it("stops a working chat when the phone signs a stop for the turn it saw", async () => {
    const { remote, config, sends, stops } = bridge("turn-1");
    const verdict = await remote.handleCommand(config, fixture.stopCommandId, fixture.stopCommand);
    expect(verdict.result).toEqual({ id: fixture.stopCommandId, status: "sent" });
    expect(stops).toEqual(["s1"]);
    expect(sends).toEqual([]);
  });

  it("asks a chat for a PR when the phone signs a workspace createPr request", async () => {
    const { remote, config, sends } = bridge("turn-1");
    (remote as unknown as { deps: { workspaceActions: unknown } }).deps.workspaceActions = {
      repos: () => [],
      archive: async () => ({ ok: true }),
      create: async () => ({ ok: true }),
      prPrompt: (workspaceId: string) => `PR for ${workspaceId}`,
    };
    const verdict = await remote.handleCommand(config, fixture.prCommandId, fixture.prCommand);
    expect(verdict.result).toMatchObject({ id: fixture.prCommandId, status: "sent" });
    expect(sends.map((send) => send.slice(0, 2))).toEqual([["s1", "PR for w1"]]);
  });

  it("changes a chat's model when the phone signs a setup request", async () => {
    const { remote, config, setups } = bridge("turn-1");
    const verdict = await remote.handleCommand(config, fixture.setupCommandId, fixture.setupCommand);
    expect(verdict.result).toEqual({ id: fixture.setupCommandId, status: "sent" });
    expect(setups).toEqual([["s1", { model: "opus-5-5-1m", thinkingLevel: "high", fastMode: false }]]);
  });

  it("sets up hotspot failover when the phone signs a hotspot request", async () => {
    const { remote, config, hotspotRequests } = bridge("turn-1");
    const verdict = await remote.handleCommand(config, fixture.hotspotCommandId, fixture.hotspotCommand);
    expect(verdict.result).toEqual({ id: fixture.hotspotCommandId, status: "sent" });
    expect(hotspotRequests).toEqual([
      { action: "configure", ssid: "Sibhi's iPhone", password: "secret-pass", enabled: true },
    ]);
  });

  it("changes what a closed lid does when the phone signs a lidActions request", async () => {
    const { remote, config, awakeRequests } = bridge("turn-1");
    const verdict = await remote.handleCommand(config, fixture.lidActionsCommandId, fixture.lidActionsCommand);
    expect(verdict.result).toEqual({ id: fixture.lidActionsCommandId, status: "sent" });
    expect(awakeRequests).toEqual([
      { action: "lid-actions", mode: "closed", settings: { mute: false, freezeApps: true } },
    ]);
  });

  it("presses a tab when the phone signs a selectTab control", async () => {
    const { remote, config, controlChanges } = bridge("turn-1");
    const verdict = await remote.handleCommand(config, fixture.tabCommandId, fixture.tabCommand);
    expect(verdict.result).toMatchObject({ id: fixture.tabCommandId, status: "sent" });
    expect(controlChanges).toEqual([{ selectTab: { index: 1, title: "Heresay" } }]);
  });

  it("answers detailed usage when the phone signs a stats request", async () => {
    const { remote, config, statsRanges } = bridge("turn-1");
    const verdict = await remote.handleCommand(config, fixture.statsCommandId, fixture.statsCommand);
    expect(verdict.result).toEqual({ id: fixture.statsCommandId, status: "sent", stats: { range: "30d" } });
    expect(statsRanges).toEqual([["30d", "codex"]]);
  });

  it("pauses calls and sets when the PIN is asked when the phone signs those requests", async () => {
    const { remote, config, voiceApplied, pinActions } = bridge("turn-1");
    const pause = await remote.handleCommand(config, fixture.voicePauseCommandId, fixture.voicePauseCommand);
    expect(pause.result).toEqual({ id: fixture.voicePauseCommandId, status: "sent" });
    expect(voiceApplied).toEqual([{ pause: "4h" }]);
    const policy = await remote.handleCommand(config, fixture.voicePinPolicyCommandId, fixture.voicePinPolicyCommand);
    expect(policy.result).toEqual({ id: fixture.voicePinPolicyCommandId, status: "sent" });
    expect(pinActions).toEqual([{ action: "policy", outgoing: "skip", incoming: "ask" }]);
  });

  it("sets the fans when the phone signs a controls request", async () => {
    const { remote, config, controlChanges } = bridge("turn-1");
    const verdict = await remote.handleCommand(config, fixture.controlsCommandId, fixture.controlsCommand);
    expect(verdict.result).toEqual({ id: fixture.controlsCommandId, status: "sent" });
    expect(controlChanges).toEqual([{ fans: "60" }]);
  });

  it("sends an image the chat showed when the phone signs an image request", async () => {
    const { remote, config } = bridge("turn-1");
    const verdict = await remote.handleCommand(config, fixture.imageCommandId, fixture.imageCommand);
    expect(verdict.result).toEqual({
      id: fixture.imageCommandId,
      status: "sent",
      image: { mime: "image/jpeg", data: "AAAA" },
    });
  });

  it("answers what a chat changed when the phone signs a diff request", async () => {
    const { remote, config } = bridge("turn-1");
    const verdict = await remote.handleCommand(config, fixture.diffCommandId, fixture.diffCommand);
    expect(verdict.result).toMatchObject({ status: "sent", patch: { index: 0, path: "a.ts", text: "+b" } });
  });

  it("is refused once the chat has moved to another turn", async () => {
    const { remote, config, sends } = bridge("turn-2");
    const verdict = await remote.handleCommand(config, fixture.commandId, fixture.command);
    expect(verdict.result).toMatchObject({ status: "refused" });
    expect(sends).toEqual([]);
  });

  it("is ignored if a single byte of it is changed", async () => {
    const { remote, config, sends } = bridge("turn-1");
    const raw = Buffer.from(fixture.command.box, "base64");
    raw[20] = raw[20]! ^ 1;
    await remote.handleCommand(config, fixture.commandId, { ...fixture.command, box: raw.toString("base64") });
    expect(sends).toEqual([]);
  });
});

describe("a RasanAI call made on the iPhone", () => {
  const look = { step: "look", revision: "look@2026-10-14T16:56:23.780Z" };

  it("picks, asks for more, and answers in words, exactly as the phone signed them", async () => {
    const { remote, config, acts } = bridge("turn-1");
    for (const [id, doc] of [
      [fixture.workflowChooseCommandId, fixture.workflowChooseCommand],
      [fixture.workflowMoreCommandId, fixture.workflowMoreCommand],
      [fixture.workflowAnswerCommandId, fixture.workflowAnswerCommand],
    ] as const) {
      const verdict = await remote.handleCommand(config, id, doc);
      expect(verdict.result).toEqual({ id, status: "sent", said: "Sent" });
    }
    expect(acts).toEqual([
      ["/films/q", { ...look, type: "choose", value: "wild" }],
      ["/films/q", { ...look, type: "more", value: { near: "bold" } }],
      ["/films/q", { ...look, type: "answer", value: { choice: null, text: "Warmer, please" } }],
    ]);
  });

  it("fetches a look's poster from the film's folder", async () => {
    const { remote, config, pictures } = bridge("turn-1");
    const verdict = await remote.handleCommand(config, fixture.workflowImageCommandId, fixture.workflowImageCommand);
    expect(verdict.result).toMatchObject({ status: "sent", image: { mime: "image/jpeg" } });
    expect(pictures).toEqual([[".rasanai/run-1/design/Wild/specimen.png", "/films/q"]]);
  });
});

describe("a RasanAI review made on the iPhone", () => {
  it("pins a note to a moment and a spot, and applies the notes, as the phone signed them", async () => {
    const { remote, config, acts } = bridge("turn-1");
    for (const [id, doc] of [
      [fixture.workflowNoteCommandId, fixture.workflowNoteCommand],
      [fixture.workflowApplyCommandId, fixture.workflowApplyCommand],
    ] as const) {
      expect((await remote.handleCommand(config, id, doc)).result).toMatchObject({ status: "sent" });
    }
    expect(acts).toEqual([
      [
        "/films/q",
        {
          step: "animatic",
          revision: "animatic@1",
          type: "comment",
          value: { t: 3.5, scene: "b1", x: 0.25, y: 0.5, quick: "Slower" },
          note: "Hold the title longer",
        },
      ],
      ["/films/q", { step: "animatic", revision: "animatic@1", type: "apply", value: null }],
    ]);
  });

  it("sends the animatic's soundtrack in sealed chunks the phone is told how to find", async () => {
    const { remote, config, pictures, written } = bridge("turn-1");
    const verdict = await remote.handleCommand(config, fixture.mediaCommandId, fixture.mediaCommand);
    expect(verdict.result).toMatchObject({ status: "sent", media: { chunks: 1, bytes: 1000, mime: "audio/mp4" } });
    expect(pictures).toEqual([[".rasanai/run-1/animatic-mix.wav", "/films/q"]]);
    const media = (verdict.result as { media: { id: string } }).media;
    expect(written).toEqual([`channels/${fixture.channelId}/media/${media.id}-0`]);
  });
});
