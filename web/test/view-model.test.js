import { describe, expect, it } from "vitest";

import * as vm from "../js/view-model.js";

const GARBAGE = [undefined, null, 0, 7, "text", true, [], [1, "a", null], {}, { x: 1 }];
const READERS = [
  "chatModels",
  "chatWorkers",
  "repos",
  "workspaces",
  "usage",
  "usageStats",
  "macControls",
  "notify",
  "hotspot",
  "macHeat",
  "voice",
  "telegramAvatar",
  "awakeLidActions",
  "awakeOpenActions",
  "awakeRules",
  "films",
  "local",
];

describe("view readers", () => {
  it("never throw and say null for a missing or garbage field", () => {
    for (const name of READERS) {
      expect(vm[name](undefined), name).toBeNull();
      expect(vm[name](null), name).toBeNull();
      expect(vm[name]({}), name).toBeNull();
      for (const junk of GARBAGE) {
        expect(() => vm[name]({ [name]: junk }), `${name} ${JSON.stringify(junk)}`).not.toThrow();
        expect(() => vm[name](junk)).not.toThrow();
      }
    }
    expect(vm.stalled(undefined)).toBeNull();
    expect(vm.stalled({ stalled: "x" })).toBeNull();
    expect(vm.tasks(undefined)).toBeNull();
    expect(vm.tasks({ background: "x" })).toBeNull();
    expect(vm.tasks({ background: [] })).toBeNull();
    expect(vm.background).toBe(vm.tasks);
    expect(vm.statsResult(undefined)).toBeNull();
    expect(vm.statsResult({ stats: 3 })).toBeNull();
  });

  it("reads the lists and drops the entries that are not", () => {
    const view = {
      chatModels: [
        {
          id: "opus-5",
          agent: "claude",
          label: "Opus 5",
          levels: ["low", 3, "high"],
          defaultLevel: "low",
          favorite: true,
        },
        { id: "", agent: "claude", label: "x" },
        "junk",
        { id: "gpt", agent: "codex", label: "GPT" },
      ],
      chatWorkers: [{ id: "sonnet", label: "Sonnet" }, { id: 4 }],
      repos: [{ id: "r1", name: "squeak" }, null],
      workspaces: [
        { id: "w1", label: "squeak · main", defaultAgent: "codex" },
        { id: "w2", label: "b", defaultAgent: "weird" },
      ],
    };
    expect(vm.chatModels(view)).toEqual([
      { id: "opus-5", agent: "claude", label: "Opus 5", levels: ["low", "high"], defaultLevel: "low", favorite: true },
      { id: "gpt", agent: "codex", label: "GPT", levels: [], defaultLevel: null, favorite: false },
    ]);
    expect(vm.chatWorkers(view)).toEqual([{ id: "sonnet", label: "Sonnet" }]);
    expect(vm.repos(view)).toEqual([{ id: "r1", name: "squeak" }]);
    expect(vm.workspaces(view).map((w) => w.defaultAgent)).toEqual(["codex", "claude"]);
    expect(vm.chatModels({ chatModels: [] })).toEqual([]);
  });

  it("reads usage, controls, notify, hotspot, heat, voice", () => {
    expect(
      vm.usage({
        usage: {
          claude: { fiveHour: { usedPercent: 40, resetsAt: "t" }, sevenDay: { usedPercent: "x" }, observedAt: "o" },
          codex: null,
        },
      }),
    ).toEqual({
      claude: { fiveHour: { usedPercent: 40, resetsAt: "t" }, sevenDay: null, observedAt: "o" },
      codex: null,
    });
    expect(vm.usage({ usage: { claude: null, codex: null } })).toBeNull();
    expect(vm.usageStats({ usageStats: true })).toBe(true);
    expect(vm.usageStats({ usageStats: "yes" })).toBeNull();
    const controls = vm.macControls({
      macControls: {
        volume: 40,
        muted: "no",
        brightness: 1.5,
        fans: { mode: "auto", choice: "auto", available: true, rpm: [1200, "x"] },
        apps: [{ id: "a.b", name: "A", active: true }, { id: 1 }],
        media: { playing: true },
        power: { available: ["auto", 3], ready: true },
      },
    });
    expect(controls).toMatchObject({
      volume: 40,
      muted: null,
      brightness: null,
      fans: { rpm: [1200], available: true },
      apps: [{ id: "a.b", name: "A", active: true }],
      media: { playing: true },
      power: { available: ["auto"], ready: true },
    });
    const notify = vm.notify({
      notify: {
        telegram: { muted: true, finished: "nonsense", quiet: { from: "22:00", to: "7" } },
        channels: { cliq: false },
      },
    });
    expect(notify.telegram).toMatchObject({ muted: true, approval: true, finished: "conductor", quiet: null });
    expect(notify.cliq).toBeNull();
    expect(notify.configured).toEqual({ telegram: true, cliq: false });
    expect(
      vm.hotspot({
        hotspot: {
          configured: true,
          ssid: "Phone",
          enabled: true,
          onHotspot: false,
          last: { at: "t", to: "wifi", ok: true, note: "n", automatic: false },
        },
      }),
    ).toMatchObject({ ssid: "Phone", last: { to: "wifi" } });
    expect(vm.macHeat({ macHeat: { level: "warm", chip: 91, fansRpm: [2000], fansMax: true } })).toMatchObject({
      level: "warm",
      chip: 91,
      battery: null,
    });
    expect(vm.macHeat({ macHeat: { level: "scorching" } })).toBeNull();
    expect(
      vm.voice({ voice: { mode: "gateway", callee: "101", lastTest: { at: 5, status: "answered" } } }),
    ).toMatchObject({ isOn: true, callee: "101", lastTest: { status: "answered" } });
    expect(vm.voice({ voice: { mode: "off" } }).isOn).toBe(false);
    expect(vm.telegramAvatar({ telegramAvatar: true })).toBe(true);
  });

  it("reads awake settings with the iPhone's defaults for a switch the Mac omits", () => {
    expect(vm.awakeLidActions({ awakeLidActions: { mute: false } })).toEqual({
      displayOff: true,
      mute: false,
      lowPower: true,
      freezeApps: false,
    });
    expect(vm.awakeOpenActions({ awakeOpenActions: { screenOn: true } })).toEqual({
      screenOn: true,
      mute: false,
      lowPower: false,
      freezeApps: false,
    });
    expect(vm.awakeRules({ awakeRules: { lowPowerPercent: 40, endPercent: 10, heat: false } })).toEqual({
      lowPowerPercent: 40,
      endPercent: 10,
      heat: false,
    });
    expect(vm.awakeRules({ awakeRules: { lowPowerPercent: "40", endPercent: 10 } })).toBeNull();
  });

  it("reads films, a session's stall and its background tasks", () => {
    const [film] = vm.films({
      films: [
        {
          id: "film:0123456789abcdef",
          title: "Launch",
          director: { state: "exploded" },
          card: { step: "s" },
          pending: [{ id: "p", type: "pick", said: "Wild" }, {}],
          chat: [{ id: "c", who: "you", text: "hi", state: "sent" }, { who: "x" }],
        },
        { title: "no id" },
      ],
    });
    expect(film).toMatchObject({ id: "film:0123456789abcdef", director: { state: "none" }, card: { step: "s" } });
    expect(film.pending).toHaveLength(1);
    expect(film.chat).toEqual([{ id: "c", who: "you", text: "hi", t: null, state: "sent" }]);
    expect(vm.stalled({ stalled: { on: "api", since: "2026-01-01T00:00:00Z" } })).toEqual({
      on: "api",
      since: "2026-01-01T00:00:00Z",
    });
    expect(vm.stalled({ stalled: { on: "x", since: "t" } }).on).toBe("model");
    expect(
      vm.tasks({
        background: [
          { id: "t1", kind: "agent", label: "Worker", status: "weird", hasSteps: true, agentId: "a1" },
          { kind: "shell" },
        ],
      }),
    ).toEqual([
      {
        id: "t1",
        kind: "agent",
        label: "Worker",
        status: "running",
        background: false,
        startedAt: null,
        endedAt: null,
        summary: null,
        agentId: "a1",
        canOpenSteps: true,
      },
    ]);
  });

  it("reads a stats answer", () => {
    const stats = vm.statsResult({
      stats: {
        range: "7d",
        agent: "claude",
        totals: { tokens: 10, costUsd: 1.5 },
        models: [{ model: "m", tokens: 5, share: 0.5 }, { model: "n" }],
        daily: [{ date: "2026-01-01", tokens: 1 }],
        projects: [],
        longestSession: { minutes: 12 },
      },
    });
    expect(stats).toMatchObject({
      totals: { tokens: 10, costUsd: 1.5, input: 0 },
      models: [{ model: "m", tokens: 5, share: 0.5, costUsd: null }],
      longestSession: { minutes: 12, project: null },
      pending: 0,
    });
  });
});
