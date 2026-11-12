import { describe, expect, it, vi } from "vitest";

import type { AddonContext, AddonHandle } from "../../src/addons.js";
import type { FleetSession } from "../../src/fleet/types.js";
import type { FleetSnapshot } from "../../src/fleet/fleet-monitor.js";
import addon from "./index.js";
import type { FilmService } from "./films.js";
import { filmCommand, phoneImages, phoneMedia, sessionFields, workflowCommand, workflowSession } from "./phone.js";
import type { RasanaiProvider } from "./provider.js";

const FILM = "film:0123456789abcdef";
const waiting = {
  key: "claude-transcript:d1",
  cwd: "/films/q",
  workflow: { provider: "rasanai", projectDir: "/films/q", title: "Q", revision: "look@1", since: "", prompt: "" },
} as unknown as FleetSession;
const call = (active: FleetSession[] = [waiting]) => ({
  deviceName: "iPhone",
  now: 0,
  snapshot: { sessions: active, active } as unknown as FleetSnapshot,
});

describe("the film command handler", () => {
  const films = () => ({ handle: vi.fn(async () => ({ ok: true as const, said: "Waking the director." })) });
  const run = (mock: ReturnType<typeof films>, overrides: Record<string, unknown>) =>
    filmCommand(mock as unknown as FilmService)({
      v: 1,
      kind: "film",
      filmId: FILM,
      op: "chat",
      text: "Hi",
      ...overrides,
    });

  it("refuses a malformed film command before the service sees it", async () => {
    const mock = films();
    const bad: Record<string, unknown>[] = [
      { filmId: "film:../../etc" },
      { filmId: "session:123" },
      { filmId: 7 },
      { op: "format" },
      { op: "answer", step: "brief", revision: "r" },
      { op: "answer", step: "brief", revision: "r", type: "Submit; rm" },
      { op: "answer", step: "", revision: "r", type: "decide" },
      { op: "answer", step: "brief", revision: "r", type: "submit", value: "x".repeat(25_000) },
      { op: "chat", text: "" },
      { op: "chat", text: "x".repeat(2_001) },
      { op: "chat", text: 5 },
      { op: "installTool", askId: "a1" },
      { op: "installTool", tool: "ffmpeg" },
      { v: 2 },
    ];
    for (const overrides of bad) {
      expect(await run(mock, overrides), JSON.stringify(overrides)).toMatchObject({ ok: false });
    }
    expect(mock.handle).not.toHaveBeenCalled();
  });

  it("hands a valid one to the service and says what it said", async () => {
    const mock = films();
    expect(await run(mock, {})).toEqual({ ok: true, said: "Waking the director.", log: "chat: Waking the director." });
    expect(await run(mock, { op: "resume", text: undefined })).toMatchObject({ ok: true });
    expect(await run(mock, { op: "installTool", text: undefined, askId: "a1", tool: "ffmpeg" })).toMatchObject({
      ok: true,
    });
    expect(mock.handle).toHaveBeenCalledTimes(3);
  });

  it("passes the service's no on, and hides an exception", async () => {
    const mock = films();
    mock.handle.mockResolvedValueOnce({ ok: false, reason: "That film isn't on this Mac any more." } as never);
    expect(await run(mock, {})).toEqual({ ok: false, reason: "That film isn't on this Mac any more." });
    mock.handle.mockRejectedValueOnce(new Error("/secret"));
    expect(await run(mock, {})).toEqual({ ok: false, reason: "Your Mac couldn't do that. Try again." });
  });
});

describe("the workflow command handler", () => {
  const provider = () => ({ act: vi.fn(() => ({ ok: true as const, actionId: "a", said: "Picked Wild" })) });
  const handler = (mock: ReturnType<typeof provider>) => workflowCommand(mock as unknown as RasanaiProvider);
  const base = { v: 1, kind: "workflow", sessionKey: waiting.key, step: "look", revision: "look@1", type: "choose" };

  it("answers only a session the Mac's own snapshot shows waiting, in that session's folder", () => {
    const mock = provider();
    expect(handler(mock)({ ...base, value: "wild", projectDir: "/etc" }, call())).toMatchObject({ ok: true });
    expect(mock.act).toHaveBeenCalledWith("/films/q", {
      step: "look",
      revision: "look@1",
      type: "choose",
      value: "wild",
    });
    expect(handler(mock)({ ...base, sessionKey: "claude-transcript:other" }, call())).toEqual({
      ok: false,
      reason: "That isn't waiting on you any more.",
    });
    expect(handler(mock)(base, call([]))).toMatchObject({ ok: false });
    expect(mock.act).toHaveBeenCalledTimes(1);
  });

  it("refuses a malformed answer", () => {
    const mock = provider();
    for (const bad of [
      { v: 2 },
      { type: "Choose; rm" },
      { type: 5 },
      { step: 1 },
      { revision: null },
      { note: 3 },
      { value: "x".repeat(9_000) },
    ]) {
      expect(handler(mock)({ ...base, ...bad }, call()), JSON.stringify(bad)).toEqual({
        ok: false,
        reason: "Not a request this Mac understands.",
      });
    }
    expect(mock.act).not.toHaveBeenCalled();
  });

  it("passes the provider's no on", () => {
    const mock = provider();
    mock.act.mockReturnValueOnce({ ok: false, reason: "That isn't one of the options." } as never);
    expect(handler(mock)(base, call())).toEqual({ ok: false, reason: "That isn't one of the options." });
  });

  it("finds a waiting session by key and nothing else", () => {
    expect(workflowSession(call(), waiting.key)).toBe(waiting);
    expect(workflowSession(call(), 7)).toBeNull();
    expect(workflowSession(call([{ key: waiting.key } as FleetSession]), waiting.key)).toBeNull();
  });
});

describe("pictures and media", () => {
  const provider = {
    allowsImage: (_status: unknown, source: string) => source === "w.png",
    allowsMedia: (_status: unknown, source: string) => source === "film.mp4",
  } as unknown as RasanaiProvider;
  const films = {
    imageProject: (id: string, source: string) => (id === FILM && source === "p.png" ? "/films/26keys" : null),
    mediaProject: (id: string, source: string) => (id === FILM && source === "film.mp4" ? "/films/26keys" : null),
  } as unknown as FilmService;

  it("names the folder a card's or a film's picture may be read from, and refuses the rest", () => {
    const images = phoneImages(provider, films);
    expect(images.fields).toEqual(["filmId", "sessionKey"]);
    expect(images.resolve({ sessionKey: waiting.key, source: "w.png" }, call())).toEqual({ projectDir: "/films/q" });
    expect(images.resolve({ sessionKey: waiting.key, source: "log" }, call())).toEqual({
      refuse: "That picture isn't on this card.",
    });
    expect(images.resolve({ sessionKey: "nope", source: "w.png" }, call())).toEqual({
      refuse: "That isn't waiting on you any more.",
    });
    expect(images.resolve({ filmId: FILM, source: "p.png" }, call())).toEqual({ projectDir: "/films/26keys" });
    expect(images.resolve({ filmId: FILM, source: "x.png" }, call())).toEqual({
      refuse: "That picture isn't on this film.",
    });
    expect(images.resolve({ filmId: "nope", source: "p.png" }, call())).toEqual({
      refuse: "Not a request this Mac understands.",
    });
  });

  it("does the same for film and soundtrack media", () => {
    const media = phoneMedia(provider, films, "/tmp/cache");
    expect(media.resolve({ sessionKey: waiting.key, source: "film.mp4" }, call())).toEqual({
      source: "film.mp4",
      projectDir: "/films/q",
    });
    expect(media.resolve({ sessionKey: waiting.key, source: "../x.mp4" }, call())).toEqual({
      refuse: "That isn't on this card.",
    });
    expect(media.resolve({ filmId: FILM, source: "film.mp4" }, call())).toEqual({
      source: "film.mp4",
      projectDir: "/films/26keys",
    });
    expect(media.resolve({ filmId: FILM, source: "other.mp4" }, call())).toEqual({
      refuse: "That isn't on this film.",
    });
    expect(media.resolve({ source: "film.mp4" }, call())).toEqual({ refuse: "Not a request this Mac understands." });
  });
});

describe("a session row", () => {
  it("carries the workflow's card and progress, and nothing for a plain session", () => {
    const provider = { view: () => ({ call: "look" }) } as unknown as RasanaiProvider;
    const progress = { provider: "rasanai", step: "look" };
    expect(sessionFields(provider, { ...waiting, workflowProgress: progress } as FleetSession)).toEqual({
      workflow: { call: "look" },
      workflowProgress: progress,
    });
    expect(sessionFields(provider, { key: "x" } as FleetSession)).toEqual({});
    const throwing = {
      view: () => {
        throw new Error("gone");
      },
    } as unknown as RasanaiProvider;
    expect(sessionFields(throwing, waiting)).toEqual({ workflow: null });
  });
});

describe("the add-on", () => {
  it("registers the film and workflow kinds, never a kind core owns, and lists films only for a phone that reads them", () => {
    const handle = addon.activate({
      snapshot: () => ({ sessions: [], active: [] }) as unknown as FleetSnapshot,
      supportDir: "/tmp/none",
    } as unknown as AddonContext) as AddonHandle;
    expect(Object.keys(handle.phoneCommands ?? {}).sort()).toEqual(["film", "workflow"]);
    expect(handle.sessionAnnotators).toHaveLength(1);
    const snapshot = { sessions: [], active: [] } as unknown as FleetSnapshot;
    expect(handle.phoneViewFields?.(snapshot, ["z"])).toEqual({});
    expect(handle.phoneViewFields?.(snapshot, ["films"])).toHaveProperty("films");
  });
});
