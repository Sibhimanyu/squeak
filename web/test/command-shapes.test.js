import { describe, expect, it } from "vitest";

import { parseAnswerInput } from "../../src/fleet/answer.js";
import { readHotspotRequest } from "../../src/fleet/hotspot.js";
import { readControlChange } from "../../src/fleet/mac-controls.js";
import { readNotifyRequest } from "../../src/fleet/notify-settings.js";
import { checkWorkSplit } from "../../src/fleet/work-split.js";
import { readLidActionsChange } from "../../src/remote/remote-bridge.js";
import { Channel } from "../js/channel.js";
import { generateDeviceKey, importChannelKey, open, verify } from "../js/channel-crypto.js";
import { COMMAND_KINDS, CommandInputError, shape } from "../js/command-shapes.js";

const FILM = "film:0123456789abcdef";
const bad = (kind, input, pattern) => {
  expect(() => shape(kind, input), `${kind} ${JSON.stringify(input)}`).toThrow(CommandInputError);
  if (pattern) expect(() => shape(kind, input)).toThrow(pattern);
};

describe("every command kind a browser sends", () => {
  it("knows all of them", () => {
    expect([...COMMAND_KINDS].sort()).toEqual(
      [
        "answer",
        "attach",
        "awake",
        "close",
        "controls",
        "diff",
        "film",
        "history",
        "hotspot",
        "image",
        "lidActions",
        "media",
        "notify",
        "setup",
        "start",
        "stats",
        "subagent",
        "telegramAvatar",
        "usage",
        "voice",
        "workflow",
        "workspace",
      ].sort(),
    );
    expect(() => shape("reply", {})).toThrow(/not a command/);
    expect(() => shape("constructor", {})).toThrow(/not a command/);
  });
});

describe("start", () => {
  it("carries exactly what was asked, trimmed of nothing and padded with nothing", () => {
    expect(shape("start", { workspaceId: "w1", agent: "claude", text: "Hello" })).toEqual({
      workspaceId: "w1",
      agent: "claude",
      text: "Hello",
    });
    const full = shape("start", {
      workspaceId: "w1",
      agent: "claude",
      text: "go",
      model: "opus-5",
      thinking: "high",
      split: { code: "sonnet", run: "haiku", planFirst: true },
    });
    expect(full.split).toEqual({ code: "sonnet", run: "haiku", planFirst: true });
    // The Mac's own split check agrees.
    expect(checkWorkSplit("claude", full.split)).toEqual({ ok: true, split: full.split });
  });
  it("leaves an empty split out, as the iPhone does", () => {
    expect(
      shape("start", { workspaceId: "w", agent: "codex", text: "x", split: { planFirst: false } }),
    ).not.toHaveProperty("split");
  });
  it("refuses what the Mac refuses", () => {
    bad("start", { workspaceId: "w", agent: "claude", text: "   " });
    bad("start", { workspaceId: "w", agent: "claude", text: "x".repeat(20_001) }, /too long/);
    bad("start", { workspaceId: "w", agent: "gemini", text: "x" });
    bad("start", { workspaceId: "", agent: "claude", text: "x" });
    bad("start", { workspaceId: "w", agent: "codex", text: "x", split: { code: "sonnet" } }, /Only a Claude chat/);
    bad("start", { workspaceId: "w", agent: "claude", text: "x", extra: 1 });
    bad("start", { workspaceId: "w", agent: "claude", text: "x", split: { planFirst: "yes" } });
    bad("start", null);
  });
});

describe("answer", () => {
  it("takes picks or a plan answer, which the Mac's parser accepts", () => {
    const picks = shape("answer", {
      sessionId: "s1",
      toolUseId: "toolu_1",
      answers: [{ question: 0, picked: ["A"], other: "x" }],
    });
    expect(parseAnswerInput({ toolUseId: picks.toolUseId, answers: picks.answers }).ok).toBe(true);
    const plan = shape("answer", { sessionId: "s1", toolUseId: "toolu_1", plan: { approve: false, note: "smaller" } });
    expect(parseAnswerInput({ toolUseId: plan.toolUseId, plan: plan.plan }).ok).toBe(true);
    expect(shape("answer", { sessionId: "s1", toolUseId: "t", plan: { approve: true } }).plan).toEqual({
      approve: true,
    });
  });
  it("refuses neither, both, and loose shapes", () => {
    bad("answer", { sessionId: "s1", toolUseId: "t" });
    bad("answer", { sessionId: "s1", toolUseId: "t", answers: [], plan: { approve: true } });
    bad("answer", { sessionId: "s 1", toolUseId: "t", plan: { approve: true } });
    bad("answer", { sessionId: "s1", toolUseId: "t", answers: [{ question: "0", picked: [] }] });
    bad("answer", { sessionId: "s1", toolUseId: "t", answers: [{ question: 0, picked: [], more: 1 }] });
    bad("answer", { sessionId: "s1", toolUseId: "t", plan: { approve: false } });
    bad("answer", { sessionId: "s1", toolUseId: "t", plan: { approve: false, note: " " } });
  });
});

describe("attach", () => {
  const piece = { uploadId: "abcdef0123456789", index: 0, total: 2, data: "AAAA" };
  it("names a chat or a workspace, never both", () => {
    expect(shape("attach", { ...piece, sessionId: "s1" })).toEqual({ sessionId: "s1", ...piece });
    expect(shape("attach", { ...piece, workspaceId: "w1" })).toHaveProperty("workspaceId", "w1");
    bad("attach", { ...piece });
    bad("attach", { ...piece, sessionId: "s", workspaceId: "w" });
  });
  it("keeps to the Mac's limits", () => {
    const ok = { ...piece, sessionId: "s1" };
    bad("attach", { ...ok, uploadId: "short" });
    bad("attach", { ...ok, total: 5 });
    bad("attach", { ...ok, total: 0 });
    bad("attach", { ...ok, index: 2 });
    bad("attach", { ...ok, index: 0.5 });
    bad("attach", { ...ok, data: "" });
    bad("attach", { ...ok, data: "not base64!" });
    bad("attach", { ...ok, data: "A".repeat(400_100) });
  });
});

describe("history, subagent, diff, close", () => {
  it("history clamps its page and refuses a bad cursor", () => {
    expect(shape("history", { key: "k", n: 99 })).toEqual({ key: "k", n: 12 });
    expect(shape("history", { key: "k", before: "123" })).toEqual({ key: "k", before: "123" });
    bad("history", { key: "k", before: "0123" });
    bad("history", { key: "k", before: "12a" });
    bad("history", { key: "x".repeat(201) });
    bad("history", { key: "k", n: NaN });
  });
  it("subagent sends an explicit null to stop the feed", () => {
    expect(shape("subagent", { key: "k", taskId: null })).toEqual({ key: "k", taskId: null });
    expect(shape("subagent", { key: "k", taskId: "toolu_0123456" }).taskId).toBe("toolu_0123456");
    bad("subagent", { key: "k" });
    bad("subagent", { key: "k", taskId: "short" });
  });
  it("diff and close", () => {
    expect(shape("diff", { sessionId: "s", file: 0 })).toEqual({ sessionId: "s", file: 0 });
    expect(shape("diff", { sessionId: "s" })).toEqual({ sessionId: "s" });
    bad("diff", { sessionId: "s", file: -1 });
    expect(shape("close", { sessionId: "s" })).toEqual({ sessionId: "s" });
    bad("close", {});
  });
});

describe("workspace and setup", () => {
  it("each action carries only its own fields", () => {
    expect(shape("workspace", { action: "archive", workspaceId: "w" })).toEqual({
      action: "archive",
      workspaceId: "w",
    });
    expect(shape("workspace", { action: "create", repoId: "r" })).toEqual({ action: "create", repoId: "r" });
    expect(shape("workspace", { action: "createPr", sessionId: "s", answersTurn: "t" })).toEqual({
      action: "createPr",
      sessionId: "s",
      answersTurn: "t",
    });
    bad("workspace", { action: "archive" });
    bad("workspace", { action: "delete", workspaceId: "w" });
  });
  it("setup needs a model and a boolean fast", () => {
    expect(shape("setup", { sessionId: "s", model: "opus-5", thinking: "high", fast: true })).toEqual({
      sessionId: "s",
      model: "opus-5",
      thinking: "high",
      fast: true,
    });
    bad("setup", { sessionId: "s", model: "" });
    bad("setup", { sessionId: "s", model: "m", fast: "true" });
  });
});

describe("usage, stats, telegramAvatar", () => {
  it("carry nothing but the envelope, or one range", () => {
    expect(shape("usage", {})).toEqual({});
    expect(shape("telegramAvatar", {})).toEqual({});
    bad("usage", { force: true });
    expect(shape("stats", { range: "7d", agent: "claude" })).toEqual({ range: "7d", agent: "claude" });
    expect(shape("stats", { range: "all" })).toEqual({ range: "all" });
    bad("stats", { range: "1y" });
    bad("stats", { range: "7d", agent: "x" });
  });
});

describe("awake and lidActions", () => {
  it("awake", () => {
    expect(shape("awake", { on: true, minutes: 60, lid: true })).toEqual({ on: true, minutes: 60, lid: true });
    expect(shape("awake", { on: false })).toEqual({ on: false });
    expect(shape("awake", { on: true })).toEqual({ on: true });
    bad("awake", { on: false, minutes: 5 });
    bad("awake", { on: true, minutes: 0 });
    bad("awake", { on: true, minutes: 1.5 });
    bad("awake", { on: true, lid: true });
    bad("awake", { on: "yes" });
  });
  it("lidActions checks its switches per mode, as the Mac's reader does", () => {
    const closed = shape("lidActions", { settings: { displayOff: false } });
    expect(closed).toEqual({ settings: { displayOff: false } });
    expect(readLidActionsChange(closed.settings, "closed")).toEqual({ displayOff: false });
    const open = shape("lidActions", { mode: "open", settings: { screenOn: true } });
    expect(open).toEqual({ mode: "open", settings: { screenOn: true } });
    expect(readLidActionsChange(open.settings, "open")).toEqual({ screenOn: true });
    bad("lidActions", { settings: { screenOn: true } });
    bad("lidActions", { mode: "open", settings: { displayOff: true } });
    bad("lidActions", { settings: {} });
    bad("lidActions", { settings: { mute: 1 } });
    bad("lidActions", { mode: "sideways", settings: { mute: true } });
  });
});

describe("controls, notify, voice, hotspot", () => {
  it("every control is one the Mac's reader accepts, and anything it refuses is refused here", () => {
    const good = [
      { volume: 40 },
      { brightness: 0 },
      { muted: true },
      { fans: "max" },
      { power: "low" },
      { displaySleep: true },
      { wakeScreen: true },
      { screenAwake: false },
      { open: "com.apple.Safari" },
      { quit: "com.apple.Safari" },
      { space: "left" },
      { media: "playPause" },
      { lock: true },
      { listApps: true },
      { listTabs: true },
      { appIcons: ["com.apple.Safari"] },
      { selectTab: { index: 2, title: "Docs" } },
      { showChat: { sessionId: "abcdef12-3456" } },
    ];
    for (const change of good) {
      expect(shape("controls", { change }).change, JSON.stringify(change)).toEqual(change);
      expect(readControlChange(change)).toEqual(change);
    }
    const refused = [
      { volume: 101 },
      { volume: 4.5 },
      { volume: "40" },
      { muted: "true" },
      { fans: "70" },
      { power: "turbo" },
      { displaySleep: false },
      { lock: false },
      { open: "bad id" },
      { space: "up" },
      { media: "stop" },
      { appIcons: [] },
      { selectTab: { index: 60, title: "x" } },
      { selectTab: { index: 1, title: "x", extra: 1 } },
      { showChat: { sessionId: "x" } },
      { volume: 1, muted: true },
      { nope: 1 },
      {},
    ];
    for (const change of refused) {
      expect(readControlChange(change), JSON.stringify(change)).toBeNull();
      bad("controls", { change });
    }
  });

  it("notify matches the Mac's request reader", () => {
    const requests = [
      { channel: "telegram", change: { muted: true } },
      { channel: "cliq", change: { finished: "all" } },
      { channel: "telegram", change: { quiet: { from: "22:00", to: "07:00" } } },
      { channel: "telegram", change: { quiet: null } },
    ];
    for (const request of requests) {
      expect(shape("notify", request)).toEqual(request);
      expect(readNotifyRequest(request)).toEqual(request);
    }
    for (const request of [
      { channel: "slack", change: { muted: true } },
      { channel: "telegram", change: { muted: 1 } },
      { channel: "telegram", change: { finished: "some" } },
      { channel: "telegram", change: { quiet: { from: "22:00", to: "22:00" } } },
      { channel: "telegram", change: { quiet: { from: "25:00", to: "07:00" } } },
      { channel: "telegram", change: { muted: true, quota: true } },
    ]) {
      expect(readNotifyRequest(request)).toBeNull();
      bad("notify", request);
    }
  });

  it("voice: an extension or null, a test, a pin", () => {
    expect(shape("voice", { change: { callee: "101" } })).toEqual({ change: { callee: "101" } });
    expect(shape("voice", { change: { callee: null } })).toEqual({ change: { callee: null } });
    expect(shape("voice", { change: { test: true } })).toEqual({ change: { test: true } });
    expect(shape("voice", { change: { pin: { current: "1234", next: "567890" } } })).toEqual({
      change: { pin: { current: "1234", next: "567890" } },
    });
    bad("voice", { change: { callee: "1" } });
    bad("voice", { change: { callee: "abc" } });
    bad("voice", { change: { test: false } });
    bad("voice", { change: { pin: { current: "12", next: "5678" } } });
    bad("voice", { change: { pin: { current: "1234" } } });
    bad("voice", { change: { callee: "101", test: true } });
  });

  it("hotspot matches the Mac's reader", () => {
    const configure = { action: "configure", ssid: "My iPhone", password: "hunter2hunter2", enabled: true };
    expect(shape("hotspot", configure)).toEqual(configure);
    expect(readHotspotRequest(configure)).toEqual(configure);
    expect(shape("hotspot", { action: "join" })).toEqual({ action: "join" });
    expect(shape("hotspot", { action: "clear" })).toEqual({ action: "clear" });
    bad("hotspot", { action: "join", ssid: "x" });
    bad("hotspot", { action: "configure", ssid: "x" });
    bad("hotspot", { action: "configure", ssid: "", enabled: true });
    bad("hotspot", { action: "configure", ssid: "x".repeat(33), enabled: true });
    bad("hotspot", { action: "configure", ssid: "ok", enabled: true, password: "short" });
    bad("hotspot", { action: "reboot" });
  });
});

describe("workflow, film, media, image", () => {
  it("workflow", () => {
    const ok = { sessionKey: "k", step: "story", revision: "r1", type: "pick", value: "opt-1" };
    expect(shape("workflow", ok)).toEqual(ok);
    expect(shape("workflow", { ...ok, value: null })).not.toHaveProperty("value");
    bad("workflow", { ...ok, type: "Pick" });
    bad("workflow", { ...ok, value: "x".repeat(8_001) });
    bad("workflow", { ...ok, note: 3 });
  });
  it("film ops", () => {
    expect(shape("film", { filmId: FILM, op: "resume" })).toEqual({ filmId: FILM, op: "resume" });
    expect(shape("film", { filmId: FILM, op: "chat", text: "hello" })).toHaveProperty("text", "hello");
    expect(
      shape("film", { filmId: FILM, op: "answer", step: "s", revision: "r", type: "pick", value: { id: 1 } }),
    ).toHaveProperty("value");
    expect(shape("film", { filmId: FILM, op: "installTool", askId: "a", tool: "ffmpeg" })).toHaveProperty(
      "tool",
      "ffmpeg",
    );
    bad("film", { filmId: "film:xyz", op: "stop" });
    bad("film", { filmId: FILM, op: "explode" });
    bad("film", { filmId: FILM, op: "answer", step: "s" });
    bad("film", { filmId: FILM, op: "chat", text: " " });
    bad("film", { filmId: FILM, op: "chat", text: "x".repeat(2_001) });
    bad("film", { filmId: FILM, op: "installTool", askId: "a" });
    bad("film", { filmId: FILM, op: "stop", text: "hi" });
  });
  it("media and image name one thing", () => {
    expect(shape("media", { filmId: FILM, source: "out/film.mp4" })).toEqual({ filmId: FILM, source: "out/film.mp4" });
    expect(shape("media", { sessionKey: "k", source: "a.mp3" })).toEqual({ sessionKey: "k", source: "a.mp3" });
    bad("media", { source: "a" });
    bad("media", { filmId: FILM, sessionKey: "k", source: "a" });
    bad("media", { filmId: FILM, source: "x".repeat(2_001) });
    expect(shape("image", { sessionId: "s", source: "shot.png" })).toEqual({ sessionId: "s", source: "shot.png" });
    expect(shape("image", { filmId: FILM, source: "poster.png" })).toMatchObject({ filmId: FILM });
    expect(shape("image", { sessionKey: "k", source: "look.png" })).toMatchObject({ sessionKey: "k", sessionId: "" });
    bad("image", { source: "a" });
    bad("image", { sessionId: "s", source: "  " });
  });
});

describe("a signed command", () => {
  it("is sealed and signed like a reply, with the envelope the Mac checks", async () => {
    const key = await importChannelKey(Buffer.alloc(32, 7).toString("base64"));
    const device = await generateDeviceKey();
    const channel = new Channel({ channelId: "A".repeat(22), deviceId: "dev-1", key, db: {}, now: () => 1_000_000 });
    const { id, document } = await channel.controlsDocument({ change: { volume: 40 } }, device.privateKey);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(document.device).toBe("dev-1");
    expect(await verify(device.publicKeyX963, document.box, document.sig)).toBe(true);
    const body = await open(key, document.box);
    expect(body).toMatchObject({ v: 1, kind: "controls", change: { volume: 40 }, expiresAt: 1_000_000 + 5 * 60_000 });
    expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(Object.keys(body).sort()).toEqual(["change", "expiresAt", "kind", "nonce", "v"]);
    await expect(
      channel.startDocument({ workspaceId: "w", agent: "claude", text: "" }, device.privateKey),
    ).rejects.toThrow(CommandInputError);
    for (const kind of COMMAND_KINDS) expect(typeof channel[`${kind}Document`], kind).toBe("function");
  });
});
