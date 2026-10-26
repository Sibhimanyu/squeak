import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FleetSession } from "../../fleet/types.js";
import { realDirectorDeps } from "./director.js";
import { FilmService, filmIdOf, NO_RESUME_NOTE, STOPPED_PROMPT_CAN_RESUME, STOPPED_PROMPT_MAC } from "./films.js";
import type { FilmCommand } from "./films.js";
import { RasanaiProvider } from "./provider.js";
import type { RasanaiSession } from "./run.js";

const BRIEF = JSON.parse(
  fs.readFileSync(new URL("./fixtures/26keys-brief.json", import.meta.url), "utf8"),
) as RasanaiSession;
const NOW = Date.parse("2026-10-26T08:00:00.000Z");

let tmp: string;
let films: string;
let engines: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "films-"));
  films = path.join(tmp, "films");
  engines = path.join(tmp, "engines");
  fs.mkdirSync(films);
  fs.mkdirSync(engines);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A fake RasanAI engine: SKILL.md, and (when asked) a director.mjs that records what it was asked and answers. */
function engine(options: { director?: boolean; reply?: Record<string, unknown> } = {}): string {
  const dir = path.join(engines, `rasanai-${fs.readdirSync(engines).length}`);
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: rasanai\n---\n");
  if (options.director !== false) {
    const reply = JSON.stringify(options.reply ?? { ok: true, pid: 4242 });
    fs.writeFileSync(
      path.join(dir, "scripts", "director.mjs"),
      `import fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(path.join(dir, "calls.log"))}, process.argv.slice(2).join(" ") + "\\n");\nconsole.log(${JSON.stringify(reply)});\n`,
    );
  }
  return dir;
}

const calls = (dir: string): string[] => {
  try {
    return fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n");
  } catch {
    return [];
  }
};

interface FilmOptions {
  session?: (s: RasanaiSession) => void;
  events?: string[];
  externalActions?: number | null;
  skill?: string | null;
  updated?: string;
  name?: string;
}

function film(options: FilmOptions = {}) {
  const projectDir = path.join(films, options.name ?? "26keys");
  const runDir = path.join(projectDir, ".rasanai", "run-1");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".rasanai", "current"), "run-1\n");
  const session = structuredClone(BRIEF);
  if (options.updated) session.updated = options.updated;
  if (options.name) session.title = options.name;
  options.session?.(session);
  fs.writeFileSync(path.join(runDir, "session.json"), JSON.stringify(session));
  // The file's own time is part of "touched": pin it to the run's own clock.
  const touched = new Date(Date.parse(session.updated!));
  fs.utimesSync(path.join(runDir, "session.json"), touched, touched);
  const consoleJson: Record<string, unknown> = { headless: true };
  if (options.externalActions !== null) consoleJson.external_actions = options.externalActions ?? 2;
  if (options.skill) consoleJson.skill = options.skill;
  fs.writeFileSync(path.join(runDir, "console.json"), JSON.stringify(consoleJson));
  if (options.events) {
    fs.writeFileSync(path.join(runDir, "director-events.jsonl"), options.events.join("\n") + "\n");
  }
  const actions = () =>
    fs.existsSync(path.join(runDir, "actions.jsonl"))
      ? fs
          .readFileSync(path.join(runDir, "actions.jsonl"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  return { projectDir, runDir, actions, id: filmIdOf(projectDir) };
}

const start = (pid = 4001, t = "2026-10-26T07:17:37.532Z") => JSON.stringify({ t, event: "start", pid });
const exit = (extra: Record<string, unknown> = {}, t = "2026-10-26T07:33:56.642Z") =>
  JSON.stringify({ t, event: "exit", code: 130, stopped: true, ...extra });

function service(
  options: { alive?: (pid: number) => boolean; procState?: (pid: number) => string | null; now?: () => number } = {},
) {
  const now = options.now ?? (() => NOW);
  const provider = new RasanaiProvider({ now });
  return new FilmService({
    provider,
    roots: [films],
    now,
    director: { engineRoots: [engines], run: realDirectorDeps.run },
    alive: options.alive ?? (() => false),
    procState: options.procState ?? (() => "S"),
  });
}

const command = (filmId: string, overrides: Partial<FilmCommand>): FilmCommand =>
  ({ v: 1, kind: "film", filmId, nonce: "n".repeat(16), expiresAt: NOW + 60_000, ...overrides }) as FilmCommand;

function director(cwd: string, overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    key: "claude-transcript:d1",
    source: "claude-transcript",
    agent: "claude",
    origin: "sdk",
    sourceId: "d1",
    agentSessionId: "d1",
    conductorSessionId: null,
    cwd,
    repoName: null,
    branch: null,
    title: null,
    state: "finished",
    detail: null,
    lastActivityAt: "2026-10-26T07:33:00.000Z",
    transcriptPath: null,
    contextPercent: null,
    retired: false,
    baseRef: null,
    costUsd: null,
    pid: null,
    alive: false,
    git: null,
    stateSource: "transcript",
    ...overrides,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
/** Waits for a background director call to have happened, up to a few seconds. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("listing films", () => {
  it("reads a film from its files: title, progress, poster, and the director it never ran with", () => {
    const { projectDir, id } = film();
    const [one] = service().list();
    expect(one).toMatchObject({
      id,
      title: "26keys",
      director: { state: "none", since: null, detail: null },
      pending: [],
      canChat: true,
      canResume: false,
      canStop: false,
      sessionKey: null,
      poster: "videos/26keys-launch/capture/screenshots/scroll-000.png",
      engineNote: null,
    });
    expect(one!.id).toMatch(/^film:[0-9a-f]{16}$/);
    expect(one!.id).toBe(filmIdOf(fs.realpathSync(projectDir)));
    expect(one!.updatedAt).toBe("2026-10-26T07:30:00.000Z");
    expect(one!.progress).toMatchObject({ step: "brief", waiting: true, call: "brief" });
    expect(one!.card).toMatchObject({ call: "brief", canDecide: true });
    expect(one!.card!.brief!.fields).toHaveLength(8);
  });

  it("lists the last week's films newest first, at most twelve, and ignores folders that aren't films", () => {
    fs.mkdirSync(path.join(films, "Brands"));
    fs.writeFileSync(path.join(films, ".DS_Store"), "");
    film({ name: "old", updated: "2026-10-10T00:00:00.000Z" });
    for (let i = 0; i < 13; i++) {
      film({ name: `f${String(i).padStart(2, "0")}`, updated: `2026-10-2${i % 6}T0${i % 9}:00:00.000Z` });
    }
    const list = service({ now: () => Date.parse("2026-10-26T12:00:00.000Z") }).list();
    expect(list).toHaveLength(12);
    expect(list.map((entry) => entry.updatedAt)).toEqual([...list.map((entry) => entry.updatedAt)].sort().reverse());
    expect(list.some((entry) => entry.title === "old")).toBe(false);
    expect(list[0]!.updatedAt >= list[11]!.updatedAt).toBe(true);
  });

  it("adds the folder of any agent session that has one, once, and a film's director session", () => {
    const outside = fs.mkdtempSync(path.join(tmp, "elsewhere-"));
    fs.mkdirSync(path.join(outside, ".rasanai", "run-1"), { recursive: true });
    fs.writeFileSync(path.join(outside, ".rasanai", "current"), "run-1");
    fs.writeFileSync(path.join(outside, ".rasanai", "run-1", "session.json"), JSON.stringify(BRIEF));
    const inside = film();
    const provider = new RasanaiProvider({ now: () => NOW });
    const films2 = new FilmService({
      provider,
      roots: [films],
      extraDirs: () => [outside, inside.projectDir, "/nowhere/at/all"],
      now: () => NOW,
      director: { engineRoots: [engines], run: realDirectorDeps.run },
    });
    const active = [
      director(inside.projectDir, { key: "claude-transcript:older", lastActivityAt: "2026-10-26T06:00:00.000Z" }),
      director(inside.projectDir),
    ];
    const list = films2.list(active);
    expect(list).toHaveLength(2);
    expect(list.find((entry) => entry.id === inside.id)!.sessionKey).toBe("claude-transcript:d1");
  });
});

describe("the director's liveness, from files and a pid", () => {
  const stateOf = (
    events: string[],
    deps: Parameters<typeof service>[0] = {},
    session?: (s: RasanaiSession) => void,
  ) => {
    film({ events, ...(session ? { session } : {}) });
    return service(deps).list()[0]!.director;
  };

  it("is running while the last start's pid lives, frozen when ps says it is stopped", () => {
    expect(stateOf([start()], { alive: () => true })).toEqual({
      state: "running",
      since: "2026-10-26T07:17:37.532Z",
      detail: null,
    });
    expect(stateOf([start()], { alive: () => true, procState: () => "TN" })).toMatchObject({
      state: "frozen",
      detail: "Paused.",
    });
  });

  it("is stopped after a stop or a clean exit, crashed after a bad exit or a vanished process", () => {
    expect(stateOf([start(), exit()])).toMatchObject({ state: "stopped", since: "2026-10-26T07:33:56.642Z" });
    expect(stateOf([start(), exit({ code: 0, stopped: false })])).toMatchObject({ state: "stopped" });
    expect(stateOf([start(), exit({ code: 1, stopped: false })])).toMatchObject({
      state: "crashed",
      detail: "The director exited with code 1.",
    });
    expect(stateOf([start()], { alive: () => false })).toMatchObject({ state: "crashed" });
  });

  it("is running again after a resume's new start, and the last events win", () => {
    expect(
      stateOf([start(1), exit(), start(2, "2026-10-26T07:40:00.000Z")], { alive: (pid) => pid === 2 }),
    ).toMatchObject({
      state: "running",
      since: "2026-10-26T07:40:00.000Z",
    });
  });

  it("does not run ps for a process that is gone, and asks once in a few seconds", () => {
    const asked: number[] = [];
    film({ events: [start()] });
    const svc = service({
      alive: () => true,
      procState: (pid) => {
        asked.push(pid);
        return "S";
      },
    });
    svc.list();
    svc.list();
    expect(asked).toEqual([4001]);
    fs.rmSync(films, { recursive: true });
    fs.mkdirSync(films);
    film({ events: [start()] });
    const gone = service({
      alive: () => false,
      procState: () => {
        asked.push(0);
        return null;
      },
    });
    gone.list();
    expect(asked).toEqual([4001]);
  });

  it("is finished when the Final call is closed, whatever its director did", () => {
    const director = stateOf([start(), exit({ code: 0, stopped: false })], {}, (s) => {
      s.current = "render";
      s.steps!.render = { status: "done", updated: "2026-10-26T07:50:00.000Z" };
    });
    expect(director.state).toBe("finished");
    const [entry] = service().list();
    expect(entry).toMatchObject({ canChat: false, canResume: false, canStop: false, card: null });
  });
});

describe("what the phone may do", () => {
  it("can resume a stopped director, and stop a running one, only when the engine has director.mjs", () => {
    const withIt = engine();
    film({ events: [start(), exit()], skill: withIt });
    expect(service().list()[0]).toMatchObject({ canResume: true, canStop: false, engineNote: null });
    fs.rmSync(films, { recursive: true });
    fs.mkdirSync(films);
    film({ events: [start()], skill: withIt });
    expect(service({ alive: () => true }).list()[0]).toMatchObject({ canResume: false, canStop: true });
  });

  it("degrades without it: nothing to press, and a note saying to update", () => {
    const old = engine({ director: false });
    film({ events: [start(), exit()], skill: old });
    expect(service().list()[0]).toMatchObject({ canResume: false, canStop: false, engineNote: NO_RESUME_NOTE });
  });

  it("will not run a script from an engine outside the installed roots, inside the film, or without SKILL.md", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "rogue-engine-"));
    fs.mkdirSync(path.join(outside, "scripts"));
    fs.writeFileSync(path.join(outside, "SKILL.md"), "x");
    fs.writeFileSync(path.join(outside, "scripts", "director.mjs"), "console.log('{}')");
    const bare = path.join(engines, "bare");
    fs.mkdirSync(path.join(bare, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(bare, "scripts", "director.mjs"), "console.log('{}')");
    try {
      for (const skill of [outside, bare, "relative/engine", null]) {
        fs.rmSync(films, { recursive: true, force: true });
        fs.mkdirSync(films);
        film({ events: [start(), exit()], skill });
        expect(service().list()[0]).toMatchObject({ canResume: false, engineNote: NO_RESUME_NOTE });
      }
      // An engine inside the film's own folder is the film's agent's to write: never run.
      fs.rmSync(films, { recursive: true, force: true });
      fs.mkdirSync(films);
      const inner = film({ events: [start(), exit()] });
      const own = path.join(inner.projectDir, "engine");
      fs.mkdirSync(path.join(own, "scripts"), { recursive: true });
      fs.writeFileSync(path.join(own, "SKILL.md"), "x");
      fs.writeFileSync(path.join(own, "scripts", "director.mjs"), "console.log('{}')");
      fs.writeFileSync(
        path.join(inner.runDir, "console.json"),
        JSON.stringify({ headless: true, external_actions: 2, skill: own }),
      );
      const rooted = new FilmService({
        provider: new RasanaiProvider({ now: () => NOW }),
        roots: [films],
        now: () => NOW,
        director: { engineRoots: [films, engines], run: realDirectorDeps.run },
      });
      expect(rooted.list()[0]).toMatchObject({ canResume: false });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("offers chat on a v2 run whether or not it waits, and on a v1 run only while it waits", () => {
    film({ session: (s) => (s.steps!.brief!.status = "working"), name: "a" });
    film({ externalActions: 1, session: (s) => (s.steps!.brief!.status = "working"), name: "b" });
    film({ externalActions: 1, name: "c" });
    film({ externalActions: null, name: "d" });
    const byName = Object.fromEntries(
      service()
        .list()
        .map((entry) => [entry.title, entry]),
    );
    expect(Object.values(byName)).toHaveLength(4);
    const canChat = service()
      .list()
      .map((entry) => entry.canChat);
    expect(canChat.filter(Boolean)).toHaveLength(3);
  });
});

describe("answers, messages and the thread", () => {
  it("shows an answer not yet read as pending, and a message as a pending bubble, until RasanAI consumes it", () => {
    const f = film();
    const svc = service();
    const status = svc.list()[0]!.card!;
    return svc
      .handle(command(f.id, { op: "answer", step: "brief", revision: status.revision, type: "decide", value: null }))
      .then(async (result) => {
        expect(result).toMatchObject({ ok: true });
        // A decide closes the call: one answer at a time. A message is not an answer, but waits its turn.
        const chat = await svc.handle(command(f.id, { op: "chat", text: "what happened?" }));
        expect(chat).toMatchObject({ ok: true, said: "Sent to Rasan" });
        const shown = svc.list()[0]!;
        expect(shown.pending).toEqual([
          { id: f.actions()[0]!.id as string, type: "decide", said: "Left this one to Rasan", t: expect.any(String) },
        ]);
        expect(shown.chat.at(-1)).toMatchObject({ who: "you", text: "what happened?", state: "pending" });
        // RasanAI reads both, and the director replies on the step's thread.
        fs.writeFileSync(path.join(f.runDir, "consumed.json"), JSON.stringify(f.actions().map((line) => line.id)));
        const session = JSON.parse(fs.readFileSync(path.join(f.runDir, "session.json"), "utf8")) as RasanaiSession;
        (session.steps!.brief!.thread as unknown[]).push(
          { who: "you", text: "what happened?", t: "2026-10-26T08:00:30.000Z" },
          { who: "claude", text: "I was waiting for your brief.", t: "2026-10-26T08:00:40.000Z" },
        );
        fs.writeFileSync(path.join(f.runDir, "session.json"), JSON.stringify(session));
        const after = svc.list()[0]!;
        expect(after.pending).toEqual([]);
        expect(after.chat.map((line) => [line.who, line.state, line.text])).toEqual([
          ["you", "sent", "Time's up for research: go with what you have, and move on to the brief."],
          [
            "rasan",
            null,
            "Research is done and the brief is ready above. Fix any word, then press Start (or Just make it).",
          ],
          ["you", "sent", "what happened?"],
          ["rasan", null, "I was waiting for your brief."],
        ]);
      });
  });

  it("does not show a rejected answer as pending, nor another app's", () => {
    const f = film();
    const svc = service();
    return svc.handle(command(f.id, { op: "chat", text: "hello" })).then(() => {
      fs.appendFileSync(
        path.join(f.runDir, "actions.jsonl"),
        JSON.stringify({
          id: "studio1",
          ts: "2026-10-26T08:00:00.000Z",
          step: "brief",
          type: "note",
          value: null,
          note: "from Studio",
          source: "studio",
        }) + "\n",
      );
      const id = f.actions()[0]!.id;
      fs.writeFileSync(path.join(f.runDir, "rejected.json"), JSON.stringify([{ id, error: "bad", ts: "x" }]));
      const shown = svc.list()[0]!;
      expect(shown.pending).toEqual([]);
      expect(shown.chat.every((line) => line.state !== "pending")).toBe(true);
    });
  });

  it("writes a v2 message as Studio's chat note, with its rules, limits and a small context", async () => {
    const f = film({
      session: (s) => {
        (s as Record<string, unknown>).activity = Array.from({ length: 8 }, (_, i) => ({
          msg: `event ${i}`,
          t: "2026-10-26T07:00:00.000Z",
        }));
      },
    });
    const result = await service().handle(command(f.id, { op: "chat", text: "  Why is it slow?  " }));
    expect(result).toMatchObject({ ok: true });
    const line = f.actions()[0]!;
    expect(line).toMatchObject({ step: "brief", type: "note", note: "Why is it slow?", source: "squeak-phone" });
    const chat = (line.value as { chat: Record<string, unknown> }).chat;
    expect(chat).toMatchObject({ max_sentences: 3, max_tool_calls: 3 });
    expect(chat.rules).toMatch(/console\.mjs reply on the same step/);
    expect(chat.context).toEqual({
      step: "brief",
      looking_at: "Confirm the brief",
      recent_events: ["event 3", "event 4", "event 5", "event 6", "event 7"],
    });
  });

  it("writes a v1 message as a plain note, and only while the film waits", async () => {
    const waiting = film({ externalActions: 1 });
    expect(await service().handle(command(waiting.id, { op: "chat", text: "hi" }))).toMatchObject({ ok: true });
    expect(waiting.actions()[0]).toMatchObject({ type: "note", value: null, note: "hi" });
    fs.rmSync(films, { recursive: true });
    fs.mkdirSync(films);
    const busy = film({ externalActions: 1, session: (s) => (s.steps!.brief!.status = "working") });
    expect(await service().handle(command(busy.id, { op: "chat", text: "hi" }))).toMatchObject({ ok: false });
    expect(busy.actions()).toEqual([]);
  });

  it("refuses a message on a finished film, an empty one, a sixth unread one, and a film it doesn't list", async () => {
    const f = film();
    const svc = service();
    expect(await svc.handle(command(f.id, { op: "chat", text: "   " }))).toMatchObject({ ok: false });
    for (let i = 0; i < 5; i++) {
      expect(await svc.handle(command(f.id, { op: "chat", text: `m${i}` }))).toMatchObject({ ok: true });
    }
    expect(await svc.handle(command(f.id, { op: "chat", text: "m5" }))).toMatchObject({
      ok: false,
      reason: "Rasan is still reading your earlier messages.",
    });
    expect(f.actions()).toHaveLength(5);
    expect(await svc.handle(command("film:0000000000000000", { op: "chat", text: "x" }))).toMatchObject({
      ok: false,
      reason: "That film isn't on this Mac any more.",
    });
    fs.rmSync(films, { recursive: true });
    fs.mkdirSync(films);
    const done = film({
      session: (s) => {
        s.current = "render";
        s.steps!.render = { status: "done", updated: "2026-10-26T07:50:00.000Z" };
      },
    });
    expect(await svc.handle(command(done.id, { op: "chat", text: "hi" }))).toMatchObject({
      ok: false,
      reason: "This film is finished.",
    });
  });

  it("checks an answer against the film as it is now: the step, the revision, the call", async () => {
    const f = film();
    const svc = service();
    const card = svc.list()[0]!.card!;
    expect(
      await svc.handle(command(f.id, { op: "answer", step: "story", revision: card.revision, type: "decide" })),
    ).toMatchObject({ ok: false });
    expect(
      await svc.handle(command(f.id, { op: "answer", step: "brief", revision: "brief@old", type: "decide" })),
    ).toMatchObject({ ok: false });
    expect(f.actions()).toEqual([]);
    expect(
      await svc.handle(command(f.id, { op: "answer", step: "brief", revision: card.revision, type: "decide-rest" })),
    ).toMatchObject({ ok: true });
    expect(f.actions()).toMatchObject([{ step: "*", type: "decide-rest" }]);
  });
});

describe("waking and stopping the director", () => {
  it("wakes a stopped director after an answer or a message, and says so", async () => {
    const eng = engine();
    const f = film({ events: [start(), exit()], skill: eng });
    const svc = service();
    const card = svc.list()[0]!.card!;
    const result = await svc.handle(
      command(f.id, { op: "answer", step: "brief", revision: card.revision, type: "decide" }),
    );
    expect(result).toEqual({ ok: true, said: "Left this one to Rasan. Waking the director." });
    await until(() => calls(eng).length > 0);
    expect(calls(eng)).toEqual([`resume ${f.projectDir} --source squeak-phone`]);
    // Not again within twenty seconds, even for a message.
    expect(await svc.handle(command(f.id, { op: "chat", text: "hello" }))).toEqual({ ok: true, said: "Sent to Rasan" });
    await settle();
    expect(calls(eng)).toHaveLength(1);
  });

  it("does not wake a running, paused or finished director, nor one whose engine can't", async () => {
    const eng = engine();
    for (const [events, alive, proc] of [
      [[start()], true, "S"],
      [[start()], true, "T"],
    ] as const) {
      fs.rmSync(films, { recursive: true, force: true });
      fs.mkdirSync(films);
      const f = film({ events: [...events], skill: eng });
      const svc = service({ alive: () => alive, procState: () => proc });
      expect(await svc.handle(command(f.id, { op: "chat", text: "hi" }))).toEqual({ ok: true, said: "Sent to Rasan" });
    }
    const old = engine({ director: false });
    fs.rmSync(films, { recursive: true, force: true });
    fs.mkdirSync(films);
    const f = film({ events: [start(), exit()], skill: old });
    expect(await service().handle(command(f.id, { op: "chat", text: "hi" }))).toEqual({
      ok: true,
      said: "Sent to Rasan",
    });
    await settle();
    expect(calls(eng)).toEqual([]);
  });

  it("resumes and stops through director.mjs, with the phone as its source, once per twenty seconds", async () => {
    const eng = engine();
    const f = film({ events: [start(), exit()], skill: eng });
    let now = NOW;
    const svc = service({ now: () => now });
    expect(await svc.handle(command(f.id, { op: "resume" }))).toEqual({ ok: true, said: "Waking the director." });
    expect(await svc.handle(command(f.id, { op: "resume" }))).toMatchObject({
      ok: false,
      reason: "Give the director a moment, then try again.",
    });
    now += 21_000;
    expect(await svc.handle(command(f.id, { op: "resume" }))).toMatchObject({ ok: true });
    expect(calls(eng)).toEqual([
      `resume ${f.projectDir} --source squeak-phone`,
      `resume ${f.projectDir} --source squeak-phone`,
    ]);

    fs.rmSync(films, { recursive: true });
    fs.mkdirSync(films);
    const g = film({ events: [start()], skill: eng });
    const live = service({ alive: () => true });
    expect(await live.handle(command(g.id, { op: "resume" }))).toMatchObject({
      ok: false,
      reason: "The director is already running.",
    });
    expect(await live.handle(command(g.id, { op: "stop" }))).toEqual({ ok: true, said: "Stopped the director." });
    expect(calls(eng).at(-1)).toBe(`stop ${g.projectDir} --source squeak-phone`);
  });

  it("refuses to resume or stop what isn't in that state, a finished film, and a Mac without director.mjs", async () => {
    const eng = engine();
    const stopped = film({ events: [start(), exit()], skill: eng });
    expect(await service().handle(command(stopped.id, { op: "stop" }))).toMatchObject({
      ok: false,
      reason: "The director isn't running.",
    });
    fs.rmSync(films, { recursive: true });
    fs.mkdirSync(films);
    const never = film({ skill: eng });
    expect(await service().handle(command(never.id, { op: "resume" }))).toMatchObject({ ok: false });
    fs.rmSync(films, { recursive: true });
    fs.mkdirSync(films);
    const old = film({ events: [start(), exit()], skill: engine({ director: false }) });
    expect(await service().handle(command(old.id, { op: "resume" }))).toEqual({ ok: false, reason: NO_RESUME_NOTE });
    expect(calls(eng)).toEqual([]);
  });

  it("returns RasanAI's own sentence for a refusal, and a generic one for anything else", async () => {
    const fixed = engine({ reply: { ok: false, reason: "The director is already running." } });
    const f = film({ events: [start(), exit()], skill: fixed });
    expect(await service().handle(command(f.id, { op: "resume" }))).toEqual({
      ok: false,
      reason: "The director is already running.",
    });
    for (const reason of [
      "Error: ENOENT /Users/me/secret at foo (bar.js:1:2)",
      "x".repeat(300),
      "lowercase and no stop",
    ]) {
      fs.rmSync(films, { recursive: true });
      fs.mkdirSync(films);
      const odd = film({ events: [start(), exit()], skill: engine({ reply: { ok: false, reason } }) });
      const outcome = await service().handle(command(odd.id, { op: "resume" }));
      expect(outcome).toEqual({ ok: false, reason: "RasanAI couldn't wake the director. Try from RasanAI Studio." });
    }
  });
});

describe("installing a missing tool", () => {
  const toolAsk = (s: RasanaiSession) => {
    s.ask = {
      id: "a1",
      step: "brief",
      question: "Rasan needs FFmpeg. Install it?",
      options: [
        { id: "install-tool:ffmpeg", label: "Install FFmpeg for me" },
        { id: "skip-tool:ffmpeg", label: "Skip" },
      ],
      t: "2026-10-26T07:50:00.000Z",
    };
  };

  it("runs the install in the background, then answers the ask with tool-ready and says so", async () => {
    const eng = engine();
    const f = film({ session: toolAsk, skill: eng });
    const svc = service();
    expect(svc.list()[0]!.card).toMatchObject({
      call: "ask",
      tool: { tool: "ffmpeg", label: "Install FFmpeg for me" },
    });
    const result = await svc.handle(command(f.id, { op: "installTool", askId: "a1", tool: "ffmpeg" }));
    expect(result).toEqual({ ok: true, said: "Installing ffmpeg…" });
    expect(svc.list()[0]!.engineNote).toBe("Installing ffmpeg…");
    await until(() => f.actions().length > 0);
    expect(calls(eng)).toEqual([`install-tool ${f.projectDir} ffmpeg`]);
    expect(f.actions()).toMatchObject([
      { type: "answer", value: { ask: "a1", choice: "tool-ready:ffmpeg" }, source: "squeak-phone" },
    ]);
    expect(svc.list()[0]!.engineNote).toBe("ffmpeg is installed.");
  });

  it("reports a failed install and answers nothing", async () => {
    const eng = engine({ reply: { ok: false, reason: "That tool couldn't be installed." } });
    const f = film({ session: toolAsk, skill: eng });
    const svc = service();
    await svc.handle(command(f.id, { op: "installTool", askId: "a1", tool: "ffmpeg" }));
    await until(() => calls(eng).length > 0);
    await settle();
    expect(f.actions()).toEqual([]);
    expect(svc.list()[0]!.engineNote).toBe("That tool couldn't be installed.");
  });

  it("refuses a tool the open ask isn't about, another ask, a v1 run, and an engine without the script", async () => {
    const eng = engine();
    const f = film({ session: toolAsk, skill: eng });
    const svc = service();
    for (const bad of [
      { askId: "a1", tool: "renderer" },
      { askId: "zzz", tool: "ffmpeg" },
      { askId: "a1", tool: "../../bin/sh" },
      { askId: "a1", tool: "ffmpeg; rm" },
    ]) {
      expect(await svc.handle(command(f.id, { op: "installTool", ...bad }))).toMatchObject({ ok: false });
    }
    fs.rmSync(films, { recursive: true });
    fs.mkdirSync(films);
    const old = film({ session: toolAsk, skill: eng, externalActions: 1 });
    expect(await service().handle(command(old.id, { op: "installTool", askId: "a1", tool: "ffmpeg" }))).toMatchObject({
      ok: false,
    });
    fs.rmSync(films, { recursive: true });
    fs.mkdirSync(films);
    const bare = film({ session: toolAsk, skill: engine({ director: false }) });
    expect(await service().handle(command(bare.id, { op: "installTool", askId: "a1", tool: "ffmpeg" }))).toMatchObject({
      ok: false,
    });
    expect(calls(eng)).toEqual([]);
  });
});

describe("pictures and the stopped-director page", () => {
  it("lets a phone fetch the card's pictures and the film's poster, and nothing else", () => {
    const f = film();
    const svc = service();
    expect(svc.imageProject(f.id, "videos/26keys-launch/capture/screenshots/scroll-010.png")).toBe(f.projectDir);
    expect(svc.imageProject(f.id, ".rasanai/run-1/director.log")).toBeNull();
    expect(svc.imageProject(f.id, "../../etc/passwd.png")).toBeNull();
    expect(
      svc.imageProject("film:0000000000000000", "videos/26keys-launch/capture/screenshots/scroll-010.png"),
    ).toBeNull();
    expect(svc.mediaProject(f.id, "exports/film.mp4")).toBeNull();
  });

  it("marks a director that stopped mid-film as asking for you, once per stop, offering resume only when it can", () => {
    const eng = engine();
    const f = film({ events: [start(), exit()], skill: eng, session: (s) => (s.steps!.brief!.status = "working") });
    const sessions = [director(f.projectDir)];
    const [marked] = service().annotate(sessions);
    expect(marked).toMatchObject({
      state: "awaiting_input",
      detail: `RasanAI · ${STOPPED_PROMPT_CAN_RESUME}`,
      workflow: { call: "other", since: "2026-10-26T07:33:56.642Z", revision: "stopped@2026-10-26T07:33:56.642Z" },
    });
    fs.rmSync(films, { recursive: true });
    fs.mkdirSync(films);
    const g = film({
      events: [start(), exit()],
      skill: engine({ director: false }),
      session: (s) => (s.steps!.brief!.status = "working"),
    });
    expect(service().annotate([director(g.projectDir)])[0]!.detail).toBe(`RasanAI · ${STOPPED_PROMPT_MAC}`);
  });

  it("leaves a running, finished or waiting film's director alone, and a stop the phone itself made", async () => {
    const eng = engine();
    const working = (s: RasanaiSession) => (s.steps!.brief!.status = "working");
    const running = film({ events: [start()], skill: eng, session: working });
    expect(service({ alive: () => true }).annotate([director(running.projectDir)])[0]!.state).toBe("finished");
    fs.rmSync(films, { recursive: true });
    fs.mkdirSync(films);
    const waiting = film({ events: [start(), exit()], skill: eng });
    const out = service().annotate([director(waiting.projectDir)])[0]!;
    expect(out.workflow).toMatchObject({ call: "brief" });
    fs.rmSync(films, { recursive: true });
    fs.mkdirSync(films);
    const mine = film({ events: [start()], skill: eng, session: working });
    const svc = service({ alive: () => true });
    expect(await svc.handle(command(mine.id, { op: "stop" }))).toMatchObject({ ok: true });
    fs.appendFileSync(
      path.join(mine.runDir, "director-events.jsonl"),
      exit({}, new Date(NOW + 2_000).toISOString()) + "\n",
    );
    // The same film again, now stopped by that very request: no page.
    expect(svc.annotate([director(mine.projectDir)])[0]!.state).toBe("finished");
  });

  it("does not page for a stop older than a day", () => {
    const f = film({
      events: [start(), exit({}, "2026-10-24T07:33:56.642Z")],
      skill: engine(),
      session: (s) => (s.steps!.brief!.status = "working"),
    });
    expect(service().annotate([director(f.projectDir)])[0]!.state).toBe("finished");
  });
});
