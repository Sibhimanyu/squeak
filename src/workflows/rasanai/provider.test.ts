import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { FleetSession } from "../../fleet/types.js";
import { appendAction, pendingActions } from "./actions.js";
import { RasanaiProvider } from "./provider.js";
import { readRasanaiRun, STALE_WAIT_MS, viewImages, waitingStatus, workflowView } from "./run.js";
import type { RasanaiSession } from "./run.js";

/** A trimmed copy of a real Studio run's session.json (Quotidian Test 1), parked at the story call. */
const FIXTURE = JSON.parse(
  fs.readFileSync(new URL("./fixtures/quotidian-session.json", import.meta.url), "utf8"),
) as RasanaiSession & { _askWhenOpen: NonNullable<RasanaiSession["ask"]> };
const NOW = Date.parse("2026-10-14T16:45:00.000Z");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function project(
  edit: (session: RasanaiSession) => void = () => {},
  options: { headless?: boolean; console?: Record<string, unknown> } = {},
) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "rasanai-"));
  dirs.push(projectDir);
  const runDir = path.join(projectDir, ".rasanai", "run-1");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".rasanai", "current"), "run-1\n");
  const { _askWhenOpen, ...session } = structuredClone(FIXTURE);
  void _askWhenOpen;
  edit(session);
  fs.writeFileSync(path.join(runDir, "session.json"), JSON.stringify(session));
  if (options.console) {
    fs.writeFileSync(path.join(runDir, "console.json"), JSON.stringify(options.console));
  } else if (options.headless !== false) {
    fs.writeFileSync(path.join(runDir, "console.json"), JSON.stringify({ headless: true }));
  }
  const rewrite = (change: (session: RasanaiSession) => void) => {
    const current = JSON.parse(fs.readFileSync(path.join(runDir, "session.json"), "utf8")) as RasanaiSession;
    change(current);
    fs.writeFileSync(path.join(runDir, "session.json"), JSON.stringify(current));
  };
  const actions = () =>
    fs.existsSync(path.join(runDir, "actions.jsonl"))
      ? fs
          .readFileSync(path.join(runDir, "actions.jsonl"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  const consume = () =>
    fs.writeFileSync(path.join(runDir, "consumed.json"), JSON.stringify(actions().map((action) => action.id)));
  return { projectDir, runDir, rewrite, actions, consume };
}

function director(cwd: string, overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    key: `claude-transcript:${overrides.sourceId ?? "d1"}`,
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
    lastActivityAt: "2026-10-14T16:40:20.000Z",
    transcriptPath: null,
    contextPercent: null,
    retired: false,
    baseRef: null,
    costUsd: null,
    pid: null,
    alive: true,
    git: null,
    stateSource: "transcript",
    ...overrides,
  };
}

describe("reading a RasanAI run", () => {
  it("is waiting at the story call, with three stories and the recommended one", () => {
    const { projectDir } = project();
    const run = readRasanaiRun(projectDir)!;
    const status = waitingStatus(run, NOW)!;
    expect(status).toMatchObject({ call: "story", step: "story", prompt: "Pick a story", title: "Quotidian Test 1" });
    const view = workflowView(run, status);
    expect(view.options?.map((option) => option.id)).toEqual(["sure", "bold", "wild"]);
    expect(view.recommended).toBe("wild");
    expect(view.canAskMore).toBe(true);
    expect(view.options?.[0]).toMatchObject({ label: "Sure", title: "Lunchbox to glass dome" });
    expect(view.options?.[0]?.beats?.[0]?.line).toMatch(/^I came across/);
  });

  it("shows a look pick with each look's poster and frames", () => {
    const { projectDir } = project((s) => (s.current = "look"));
    const run = readRasanaiRun(projectDir)!;
    const view = workflowView(run, waitingStatus(run, NOW)!);
    expect(view.prompt).toBe("Pick a look");
    expect(view.options?.map((option) => option.image)).toEqual([
      ".rasanai/run-1/design/Sure/specimen.png",
      ".rasanai/run-1/design/Bold/specimen.png",
      ".rasanai/run-1/design/Wild/specimen.png",
    ]);
    expect(view.options?.[2]?.frames).toEqual([{ id: "peak", image: ".rasanai/run-1/design/Wild/peak.png" }]);
  });

  it("shows a story's picture, and the older films flow's frames given as plain paths", () => {
    const storied = project((s) => (s.steps!.story!.stories![1]!.image = "story/bold.png"));
    const run = readRasanaiRun(storied.projectDir)!;
    expect(workflowView(run, waitingStatus(run, NOW)!).options?.[1]?.image).toBe("story/bold.png");
    const films = project((s) => {
      s.current = "films";
      s.steps!.films = {
        status: "awaiting",
        updated: "2026-10-14T16:44:00.000Z",
        films: [{ id: "a", title: "Paper", frames: ["films/a/1.png", "films/a/2.png", "notes.txt"] }],
      };
    });
    const filmsRun = readRasanaiRun(films.projectDir)!;
    expect(workflowView(filmsRun, waitingStatus(filmsRun, NOW)!).options?.[0]?.frames).toEqual([
      { id: "1", image: "films/a/1.png" },
      { id: "2", image: "films/a/2.png" },
    ]);
  });

  it("is not waiting once the call is answered, while the director works, or on a film left for a day", () => {
    const answered = project((s) => (s.steps!.story!.sent = { type: "choose", value: "wild" }));
    expect(waitingStatus(readRasanaiRun(answered.projectDir)!, NOW)).toBeNull();
    const working = project((s) => (s.steps!.story!.status = "working"));
    expect(waitingStatus(readRasanaiRun(working.projectDir)!, NOW)).toBeNull();
    const old = project();
    expect(waitingStatus(readRasanaiRun(old.projectDir)!, NOW + STALE_WAIT_MS)).toBeNull();
  });

  it("puts an open question ahead of the step, and forgets it once answered", () => {
    const { projectDir, rewrite } = project((s) => (s.ask = { ...FIXTURE._askWhenOpen }));
    const status = waitingStatus(readRasanaiRun(projectDir)!, NOW)!;
    expect(status).toMatchObject({ call: "ask", revision: "ask:8658b936" });
    expect(workflowView(readRasanaiRun(projectDir)!, status).ask?.options).toEqual([
      { id: "added", label: "Done, it's in assets/sources", detail: expect.any(String) },
    ]);
    rewrite((s) => (s.ask!.answered = { choice: "added" }));
    expect(waitingStatus(readRasanaiRun(projectDir)!, NOW)?.call).toBe("story");
  });

  it("reviews the animatic: its stills timed one after another, its soundtrack, and the notes so far", () => {
    const { projectDir } = project((s) => {
      s.current = "animatic";
      (s.steps!.animatic as Record<string, unknown>).music = {
        title: "Currents",
        file: ".rasanai/run-1/animatic-mix.wav",
      };
      s.comments = [
        { id: "n1", step: "animatic", t: 3.5, scene: "b1", x: 0.2, y: 0.4, text: "Slower", state: "open" },
        { id: "n0", step: "story", t: 1, text: "elsewhere", state: "open" },
        {
          id: "n2",
          step: "animatic",
          t: 7,
          scene: "b2",
          text: "warmer",
          state: "resolved",
          resolution: "Graded warmer",
        },
      ];
    });
    const run = readRasanaiRun(projectDir)!;
    const view = workflowView(run, waitingStatus(run, NOW)!);
    expect(view.macOnly).toBeUndefined();
    const review = view.review!;
    expect(review.kind).toBe("animatic");
    expect(review.scenes.map((scene) => [scene.id, scene.start, scene.seconds])).toEqual([
      ["b1", 0, 6.12],
      ["b2", 6.12, expect.any(Number)],
    ]);
    expect(review.media).toEqual({ kind: "audio", source: ".rasanai/run-1/animatic-mix.wav", poster: null });
    expect(review.notes.map((note) => [note.id, note.state, note.resolution])).toEqual([
      ["n1", "open", null],
      ["n2", "resolved", "Graded warmer"],
    ]);
    expect(review.finish).toEqual(["approve"]);
    expect(viewImages(view)).toContain(review.scenes[0]!.thumb);
  });

  it("reviews the film: RasanAI's phone copy when there is one, else the film, with render and preview", () => {
    const render = (extra: Record<string, unknown>) =>
      project((s) => {
        s.current = "render";
        s.steps!.render = {
          status: "awaiting",
          updated: "2026-10-14T16:44:00.000Z",
          video: "exports/film.mp4",
          poster: "videos/film/renders/poster.jpg",
          scenes: [
            { id: "b1", title: "Moon", start: 0 },
            { id: "b2", title: "Chapel", start: 6.1 },
          ],
          ...extra,
        };
      });
    const plain = render({});
    const plainRun = readRasanaiRun(plain.projectDir)!;
    const view = workflowView(plainRun, waitingStatus(plainRun, NOW)!);
    expect(view.review?.media).toEqual({
      kind: "video",
      source: "exports/film.mp4",
      poster: "videos/film/renders/poster.jpg",
    });
    expect(view.review?.finish).toEqual(["render", "preview"]);
    expect(view.review?.scenes.map((scene) => scene.start)).toEqual([0, 6.1]);
    const proxied = render({ proxy: ".rasanai/run-1/phone/film.mp4" });
    const proxiedRun = readRasanaiRun(proxied.projectDir)!;
    expect(workflowView(proxiedRun, waitingStatus(proxiedRun, NOW)!).review?.media?.source).toBe(
      ".rasanai/run-1/phone/film.mp4",
    );
  });

  it("is not a project without .rasanai/current, or when current climbs out of it", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "plain-"));
    dirs.push(plain);
    expect(readRasanaiRun(plain)).toBeNull();
    const { projectDir } = project();
    fs.writeFileSync(path.join(projectDir, ".rasanai", "current"), "../../etc");
    expect(readRasanaiRun(projectDir)).toBeNull();
  });
});

describe("RasanaiProvider.annotate", () => {
  it("marks the film's newest session as waiting on you, and leaves the rest alone", () => {
    const { projectDir } = project();
    const provider = new RasanaiProvider({ now: () => NOW });
    const older = director(projectDir, {
      key: "claude-transcript:old",
      sourceId: "old",
      lastActivityAt: "2026-10-14T10:00:00.000Z",
    });
    const newest = director(projectDir);
    const elsewhere = director("/somewhere/else", { key: "claude-transcript:x", sourceId: "x" });
    const [a, b, c] = provider.annotate([older, newest, elsewhere]);
    expect(a).toBe(older);
    expect(c).toBe(elsewhere);
    expect(b).toMatchObject({
      state: "awaiting_input",
      detail: "RasanAI · Pick a story",
      title: "Quotidian Test 1",
      workflow: { call: "story", projectDir },
    });
  });

  it("keeps a real permission prompt as it is", () => {
    const { projectDir } = project();
    const provider = new RasanaiProvider({ now: () => NOW });
    const [marked] = provider.annotate([director(projectDir, { state: "awaiting_approval" })]);
    expect(marked?.state).toBe("awaiting_approval");
    expect(marked?.workflow?.call).toBe("story");
  });

  it("sees the call change as soon as session.json does", () => {
    const { projectDir, rewrite } = project();
    const provider = new RasanaiProvider({ now: () => NOW });
    expect(provider.annotate([director(projectDir)])[0]?.workflow?.call).toBe("story");
    rewrite((s) => {
      s.steps!.story!.status = "done";
      s.current = "look";
      s.steps!.look!.updated = "2026-10-14T16:44:00.000Z";
      s.updated = "2026-10-14T16:44:00.001Z";
    });
    expect(provider.annotate([director(projectDir)])[0]?.workflow?.call).toBe("look");
  });
});

describe("workflow progress", () => {
  it("shows a working film: brief now, with the director's line", () => {
    const { projectDir } = project((s) => {
      s.current = "brief";
      s.steps = { brief: { status: "working", updated: "2026-10-14T16:44:00.000Z" } };
      s.ask = null;
      s.updated = "2026-10-14T16:44:00.000Z";
      s.working = { msg: "Checking the tools:\u0007 ffmpeg", t: "2026-10-14T16:44:30.000Z" };
    });
    const [marked] = new RasanaiProvider({ now: () => NOW }).annotate([director(projectDir)]);
    expect(marked?.workflow).toBeUndefined();
    expect(marked?.state).toBe("finished");
    expect(marked?.workflowProgress).toMatchObject({
      step: "brief",
      call: "brief",
      waiting: false,
      activity: "Checking the tools: ffmpeg",
      activityAt: "2026-10-14T16:44:30.000Z",
    });
    expect(marked?.workflowProgress?.calls.map((c) => c.state)).toEqual(["now", "next", "next", "next", "next"]);
  });

  it("shows a waiting look run: brief and story done, look now, workflow still set", () => {
    const { projectDir } = project((s) => {
      s.current = "look";
      s.steps!.story!.status = "done";
      s.steps!.look = { status: "awaiting", updated: "2026-10-14T16:44:00.000Z", styles: [] };
      s.ask = null;
      s.updated = "2026-10-14T16:44:00.000Z";
      s.working = { msg: "stale line", t: "2026-10-14T16:44:00.000Z" };
    });
    const [marked] = new RasanaiProvider({ now: () => NOW }).annotate([director(projectDir)]);
    expect(marked?.workflow?.call).toBe("look");
    expect(marked?.workflowProgress).toMatchObject({ call: "look", waiting: true, activity: null, activityAt: null });
    expect(marked?.workflowProgress?.calls.map((c) => c.state)).toEqual(["done", "done", "now", "next", "next"]);
  });

  it("moves on to the story once the brief is done and the director works on", () => {
    const { projectDir } = project((s) => {
      s.current = "brief";
      s.steps = { brief: { status: "done", sent: { type: "submit" }, updated: "2026-10-14T16:44:00.000Z" } };
      s.ask = null;
      s.updated = "2026-10-14T16:44:00.000Z";
      s.working = { msg: "Script desk: writing three scripts", t: "2026-10-14T16:44:30.000Z" };
    });
    const [marked] = new RasanaiProvider({ now: () => NOW }).annotate([director(projectDir)]);
    expect(marked?.workflowProgress).toMatchObject({ call: "story", waiting: false });
    expect(marked?.workflowProgress?.calls.map((c) => c.state)).toEqual(["done", "now", "next", "next", "next"]);
  });

  it("gives a stale run none", () => {
    const { projectDir } = project((s) => {
      s.current = "brief";
      s.steps = { brief: { status: "working" } };
      s.ask = null;
      s.working = { msg: "x", t: "2026-10-01T00:00:00.000Z" };
      s.updated = "2026-10-01T00:00:00.000Z";
    });
    const provider = new RasanaiProvider({ now: () => NOW + STALE_WAIT_MS });
    expect(provider.annotate([director(projectDir)])[0]?.workflowProgress).toBeUndefined();
  });
});

describe("RasanaiProvider.act", () => {
  const revisionOf = (projectDir: string) => waitingStatus(readRasanaiRun(projectDir)!, NOW)!.revision;

  it("writes a pick into actions.jsonl the way Studio does", () => {
    const { projectDir, runDir, actions } = project();
    const provider = new RasanaiProvider({ now: () => NOW });
    const result = provider.act(projectDir, {
      step: "story",
      revision: revisionOf(projectDir),
      type: "choose",
      value: "wild",
    });
    expect(result).toMatchObject({ ok: true, said: expect.stringMatching(/^Picked Wild: /) });
    expect(actions()).toEqual([
      {
        id: result.ok ? result.actionId : "",
        ts: new Date(NOW).toISOString(),
        step: "story",
        type: "choose",
        value: "wild",
        note: "",
        source: "squeak-phone",
      },
    ]);
    expect(fs.existsSync(path.join(runDir, "actions.lock"))).toBe(false);
  });

  it("refuses a pick that was never offered, a stale revision, and a second answer before the first is read", () => {
    const { projectDir, actions, consume } = project();
    const provider = new RasanaiProvider({ now: () => NOW });
    const revision = revisionOf(projectDir);
    expect(provider.act(projectDir, { step: "story", revision, type: "choose", value: "rm -rf" })).toEqual({
      ok: false,
      reason: "That isn't one of the options.",
    });
    expect(
      provider.act(projectDir, { step: "story", revision: "story@earlier", type: "choose", value: "wild" }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/moved on/),
    });
    expect(provider.act(projectDir, { step: "look", revision, type: "choose", value: "wild" })).toMatchObject({
      ok: false,
    });
    expect(provider.act(projectDir, { step: "story", revision, type: "approve", value: null })).toMatchObject({
      ok: false,
      reason: "Not something this card can send.",
    });
    expect(provider.act(projectDir, { step: "story", revision, type: "choose", value: "bold" }).ok).toBe(true);
    expect(provider.act(projectDir, { step: "story", revision, type: "choose", value: "wild" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/already on its way/),
    });
    consume();
    expect(actions()).toHaveLength(1);
  });

  it("refuses once the call is answered on the Mac", () => {
    const { projectDir, rewrite } = project();
    const provider = new RasanaiProvider({ now: () => NOW });
    const revision = revisionOf(projectDir);
    rewrite((s) => (s.steps!.story!.sent = { type: "choose", value: "sure" }));
    expect(provider.act(projectDir, { step: "story", revision, type: "choose", value: "wild" })).toEqual({
      ok: false,
      reason: "RasanAI isn't waiting on that any more.",
    });
  });

  it("refuses a run with a console server: its page is the one taking answers", () => {
    const { projectDir, actions } = project(() => {}, { headless: false });
    const provider = new RasanaiProvider({ now: () => NOW });
    expect(
      provider.act(projectDir, { step: "story", revision: revisionOf(projectDir), type: "choose", value: "wild" }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/console is open/),
    });
    expect(actions()).toEqual([]);
  });

  it("answers a browser-console run once RasanAI says its wait applies other apps' answers", () => {
    const served = project(() => {}, { console: { pid: 1, external_actions: 1 } });
    const provider = new RasanaiProvider({ now: () => NOW });
    expect(
      provider.act(served.projectDir, {
        step: "story",
        revision: revisionOf(served.projectDir),
        type: "choose",
        value: "wild",
      }).ok,
    ).toBe(true);
    const v2 = project(() => {}, { console: { headless: true, external_actions: 2 } });
    expect(
      provider.act(v2.projectDir, {
        step: "story",
        revision: revisionOf(v2.projectDir),
        type: "choose",
        value: "wild",
      }).ok,
    ).toBe(true);
    const newer = project(() => {}, { console: { headless: true, external_actions: 3 } });
    expect(
      provider.act(newer.projectDir, {
        step: "story",
        revision: revisionOf(newer.projectDir),
        type: "choose",
        value: "wild",
      }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/newer than Squeak/) });
    expect(newer.actions()).toEqual([]);
  });

  it("asks for three more excluding what is shown, at most once per half minute", () => {
    const { projectDir, consume, actions } = project();
    let now = NOW;
    const provider = new RasanaiProvider({ now: () => now });
    const revision = revisionOf(projectDir);
    expect(provider.act(projectDir, { step: "story", revision, type: "more", value: { near: "wild" } }).ok).toBe(true);
    expect(actions()[0]).toMatchObject({ type: "more", value: { near: "wild", exclude: ["sure", "bold", "wild"] } });
    consume();
    now += 5_000;
    expect(provider.act(projectDir, { step: "story", revision, type: "more", value: null })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/just asked/),
    });
  });

  it("answers an open question with a choice or words, never a choice it did not offer", () => {
    const { projectDir, actions } = project((s) => (s.ask = { ...FIXTURE._askWhenOpen }));
    const provider = new RasanaiProvider({ now: () => NOW });
    const revision = revisionOf(projectDir);
    expect(
      provider.act(projectDir, { step: "brief", revision, type: "answer", value: { choice: "nope" } }),
    ).toMatchObject({ ok: false });
    expect(provider.act(projectDir, { step: "brief", revision, type: "answer", value: {} })).toMatchObject({
      ok: false,
      reason: "Pick a choice or write an answer.",
    });
    expect(
      provider.act(projectDir, { step: "brief", revision, type: "answer", value: { choice: "added", text: " done " } })
        .ok,
    ).toBe(true);
    expect(actions()[0]).toMatchObject({
      step: "brief",
      type: "answer",
      value: { ask: "8658b936", choice: "added", text: "done" },
      note: "done",
    });
  });

  describe("on the animatic", () => {
    const animatic = () =>
      project((s) => {
        s.current = "animatic";
        (s.steps!.animatic as Record<string, unknown>).music = { file: ".rasanai/run-1/animatic-mix.wav" };
      });

    it("pins a note to a moment and a spot, many at once, as RasanAI's comment", () => {
      const { projectDir, actions } = animatic();
      const provider = new RasanaiProvider({ now: () => NOW });
      const revision = revisionOf(projectDir);
      const first = provider.act(projectDir, {
        step: "animatic",
        revision,
        type: "comment",
        value: { t: 3.456, scene: "b1", x: 0.25, y: 0.5 },
        note: "Hold this longer",
      });
      expect(first).toMatchObject({ ok: true, said: "Note at 0:03" });
      expect(
        provider.act(projectDir, {
          step: "animatic",
          revision,
          type: "comment",
          value: { t: 7, scene: null, quick: "Faster" },
        }).ok,
      ).toBe(true);
      expect(actions().map((action) => [action.type, action.value, action.note])).toEqual([
        ["comment", { scene: "b1", t: 3.46, x: 0.25, y: 0.5, scope: "scene", quick: null }, "Hold this longer"],
        ["comment", { scene: null, t: 7, scope: "film", quick: "Faster" }, ""],
      ]);
    });

    it("refuses a note off the film, off the frame, on a scene that isn't there, or with nothing in it", () => {
      const { projectDir, actions } = animatic();
      const provider = new RasanaiProvider({ now: () => NOW });
      const revision = revisionOf(projectDir);
      const note = (value: Record<string, unknown>, text = "x") =>
        provider.act(projectDir, { step: "animatic", revision, type: "comment", value, note: text });
      expect(note({ t: 999 })).toMatchObject({ ok: false, reason: "That moment isn't in the film." });
      expect(note({ t: -1 })).toMatchObject({ ok: false });
      expect(note({ t: 1, x: 2, y: 0 })).toMatchObject({ ok: false, reason: "That spot isn't on the frame." });
      expect(note({ t: 1, scene: "zz" })).toMatchObject({ ok: false, reason: "That scene isn't in the film." });
      expect(note({ t: 1, quick: "Delete everything" })).toMatchObject({ ok: false });
      expect(note({ t: 1 }, "")).toMatchObject({ ok: false, reason: "Write a note first." });
      expect(actions()).toEqual([]);
    });

    it("applies exactly the open notes RasanAI has, and only once they have all arrived", () => {
      const { projectDir, actions, consume, rewrite } = animatic();
      const provider = new RasanaiProvider({ now: () => NOW });
      const revision = revisionOf(projectDir);
      expect(provider.act(projectDir, { step: "animatic", revision, type: "apply", value: null })).toMatchObject({
        ok: false,
        reason: "There are no open notes to apply.",
      });
      provider.act(projectDir, { step: "animatic", revision, type: "comment", value: { t: 1 }, note: "a" });
      expect(provider.act(projectDir, { step: "animatic", revision, type: "apply", value: null })).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/notes are still on their way/),
      });
      const noteId = actions()[0]!.id as string;
      consume();
      rewrite((s) => {
        s.comments = [
          { id: noteId, step: "animatic", t: 1, text: "a", state: "open" },
          { id: "old", step: "animatic", t: 2, text: "b", state: "resolved" },
        ];
      });
      expect(
        provider.act(projectDir, { step: "animatic", revision, type: "apply", value: { ids: ["forged"] } }),
      ).toMatchObject({
        ok: true,
        said: "Applied 1 note",
      });
      expect(actions()[1]).toMatchObject({ type: "apply", value: { ids: [noteId] } });
    });

    it("approves the animatic, and offers render only on the film", () => {
      const { projectDir, actions } = animatic();
      const provider = new RasanaiProvider({ now: () => NOW });
      const revision = revisionOf(projectDir);
      expect(provider.act(projectDir, { step: "animatic", revision, type: "choose", value: "render" })).toMatchObject({
        ok: false,
      });
      expect(provider.act(projectDir, { step: "animatic", revision, type: "approve", value: null })).toMatchObject({
        ok: true,
        said: "Approved the animatic",
      });
      expect(actions()[0]).toMatchObject({ type: "approve", value: null });
    });

    it("lets a phone fetch only what the card plays", () => {
      const { projectDir } = animatic();
      const provider = new RasanaiProvider({ now: () => NOW });
      const status = waitingStatus(readRasanaiRun(projectDir)!, NOW)!;
      expect(provider.allowsMedia(status, ".rasanai/run-1/animatic-mix.wav")).toBe(true);
      expect(provider.allowsMedia(status, ".rasanai/run-1/music/other.wav")).toBe(false);
    });
  });

  it("lets a phone fetch only the pictures on the card waiting now", () => {
    const { projectDir } = project((s) => (s.current = "look"));
    const provider = new RasanaiProvider({ now: () => NOW });
    const status = waitingStatus(readRasanaiRun(projectDir)!, NOW)!;
    expect(provider.allowsImage(status, ".rasanai/run-1/design/Bold/specimen.png")).toBe(true);
    expect(provider.allowsImage(status, ".rasanai/run-1/design/Bold/peak.png")).toBe(true);
    expect(provider.allowsImage(status, ".rasanai/run-1/director.log")).toBe(false);
    expect(provider.allowsImage({ ...status, revision: "look@old" }, ".rasanai/run-1/design/Bold/specimen.png")).toBe(
      false,
    );
  });
});

describe("the actions lock", () => {
  it("takes over a lock whose owner is gone, and waits out one that is held, writing nothing", () => {
    const { runDir } = project();
    const lock = path.join(runDir, "actions.lock");
    const line = { id: "a1", ts: "", step: "story", type: "choose", value: "wild", note: "", source: "squeak" };
    fs.writeFileSync(lock, "999999 1\n");
    expect(appendAction(runDir, line, { now: () => Date.now(), pid: 42, alive: () => false, sleep: () => {} })).toBe(
      true,
    );
    expect(pendingActions(runDir, "story").map((action) => action.id)).toEqual(["a1"]);

    fs.writeFileSync(lock, "7 1\n");
    let clock = Date.now();
    const held = appendAction(
      runDir,
      { ...line, id: "a2" },
      {
        now: () => clock,
        pid: 42,
        alive: () => true,
        sleep: (ms) => {
          clock += ms * 100;
        },
      },
    );
    expect(held).toBe(false);
    expect(pendingActions(runDir, "story").map((action) => action.id)).toEqual(["a1"]);
    expect(fs.readFileSync(lock, "utf8")).toBe("7 1\n");
  });
});
