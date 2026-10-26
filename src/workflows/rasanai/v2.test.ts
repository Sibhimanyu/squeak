import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RasanaiProvider } from "./provider.js";
import { readRasanaiRun, viewImages, V2_ONLY_NOTE, waitingStatus, workflowView } from "./run.js";
import type { RasanaiSession } from "./run.js";

/** A trimmed real run (26keys), parked at its brief: fields, format, captures, findings and the format catalog. */
const BRIEF = JSON.parse(
  fs.readFileSync(new URL("./fixtures/26keys-brief.json", import.meta.url), "utf8"),
) as RasanaiSession;
const NOW = Date.parse("2026-10-26T08:00:00.000Z");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function project(edit: (session: RasanaiSession) => void = () => {}, externalActions: number | null = 2) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "rasanai-v2-"));
  dirs.push(projectDir);
  const runDir = path.join(projectDir, ".rasanai", "run-1");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".rasanai", "current"), "run-1\n");
  const session = structuredClone(BRIEF);
  edit(session);
  fs.writeFileSync(path.join(runDir, "session.json"), JSON.stringify(session));
  fs.writeFileSync(
    path.join(runDir, "console.json"),
    JSON.stringify({ headless: true, ...(externalActions === null ? {} : { external_actions: externalActions }) }),
  );
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
  return { projectDir, runDir, actions, consume };
}

const provider = () => new RasanaiProvider({ now: () => NOW });
const revision = (projectDir: string) => waitingStatus(readRasanaiRun(projectDir)!, NOW)!.revision;
const answer = (projectDir: string, type: string, value: unknown, extra: { note?: string; step?: string } = {}) =>
  provider().act(projectDir, {
    step: extra.step ?? "brief",
    revision: revision(projectDir),
    type,
    value,
    ...(extra.note !== undefined ? { note: extra.note } : {}),
  });

describe("a v2 run", () => {
  it("is answered as a v1 run is, and v1 and v2 both take answers while a newer contract does not", () => {
    for (const version of [1, 2]) {
      const { projectDir, actions } = project((s) => (s.current = "brief"), version);
      expect(answer(projectDir, "decide-rest", null).ok).toBe(version === 2);
      expect(actions()).toHaveLength(version === 2 ? 1 : 0);
    }
    const { projectDir } = project(() => {}, 3);
    expect(answer(projectDir, "note", null, { note: "hi" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/newer than Squeak/),
    });
  });
});

describe("the brief call", () => {
  it("shows the real brief as a form: typed fields, the format, the catalog's offered options, findings and captures", () => {
    const { projectDir } = project();
    const run = readRasanaiRun(projectDir)!;
    const view = workflowView(run, waitingStatus(run, NOW)!);
    expect(view).toMatchObject({ call: "brief", step: "brief", canDecide: true });
    const brief = view.brief!;
    expect(brief.fields.map((field) => [field.key, field.kind, field.value])).toEqual([
      ["length_s", "number", 45],
      ["kind", "text", "launch film"],
      ["subject", "longtext", expect.stringMatching(/^26Keys/)],
      ["aspect", "choice", "16:9"],
      ["destination", "text", "website and social"],
      ["narration", "longtext", expect.stringMatching(/^none:/)],
      ["brand_name", "text", "26Keys"],
      ["use_brand", "bool", true],
    ]);
    expect(brief.fields[0]).toMatchObject({ min: 5, max: 600 });
    expect(brief.fields[3]!.options!.map((option) => option.id)).toEqual(["16:9", "9:16", "1:1"]);
    expect(brief.format).toEqual({ tile: "launch", option: "launch-film", label: "Launch film" });
    // ready and partial only: no `soon`, and a tile with nothing offered is left out.
    expect(brief.formats.map((tile) => [tile.tile, tile.options.map((option) => option.id)])).toEqual([
      ["launch", ["launch-film", "feature-reveal", "launch-teaser"]],
      ["explainer", ["explainer"]],
    ]);
    expect(brief.formats[0]!.options[0]).toEqual({
      id: "launch-film",
      label: "Launch film",
      lengthS: 45,
      aspect: "16:9",
    });
    expect(brief.findings).toHaveLength(3);
    expect(brief.findings[0]!.source).toBe("26keys.app");
    expect(brief.captures[0]).toEqual({
      image: "videos/26keys-launch/capture/screenshots/scroll-000.png",
      caption: expect.stringMatching(/^The hero line/),
    });
    expect(viewImages(view)).toEqual(brief.captures.map((capture) => capture.image));
  });

  it("keeps a field's own type, passes an unknown key through, and honours a narrowed menu", () => {
    const { projectDir } = project((s) => {
      const brief = s.steps!.brief!;
      (brief.fields as Record<string, unknown>).tempo = 120;
      (brief.fields as Record<string, unknown>).mood = "calm";
      (brief as Record<string, unknown>).choices = { kind: ["launch film", { value: "teaser", label: "Teaser" }] };
    });
    const run = readRasanaiRun(projectDir)!;
    const brief = workflowView(run, waitingStatus(run, NOW)!).brief!;
    expect(brief.fields.find((field) => field.key === "tempo")).toMatchObject({ kind: "number", value: 120 });
    expect(brief.fields.find((field) => field.key === "mood")).toMatchObject({ kind: "text", value: "calm" });
    expect(brief.fields.find((field) => field.key === "kind")).toMatchObject({
      kind: "choice",
      options: [
        { id: "launch film", label: "launch film" },
        { id: "teaser", label: "Teaser" },
      ],
    });
  });

  it("is only read on the Mac for a v1 run", () => {
    const { projectDir } = project(() => {}, 1);
    const run = readRasanaiRun(projectDir)!;
    const view = workflowView(run, waitingStatus(run, NOW)!);
    expect(view.macOnly).toBe(V2_ONLY_NOTE);
    expect(view.brief).toBeUndefined();
    expect(view.canDecide).toBeUndefined();
    expect(answer(projectDir, "submit", { fields: {} })).toMatchObject({ ok: false, reason: V2_ONLY_NOTE });
  });

  it("writes a submit as Studio does: every field, typed, and the format with its scope", () => {
    const { projectDir, actions } = project();
    const result = answer(projectDir, "submit", { fields: { length_s: 30, use_brand: false, subject: " A new one " } });
    expect(result).toMatchObject({ ok: true, said: "Sent the brief" });
    expect(actions()).toMatchObject([
      {
        step: "brief",
        type: "submit",
        source: "squeak-phone",
        value: {
          length_s: 30,
          kind: "launch film",
          subject: "A new one",
          aspect: "16:9",
          destination: "website and social",
          use_brand: false,
          brand_name: "26Keys",
          format: { tile: "launch", option: "launch-film", scope: "universal" },
        },
      },
    ]);
  });

  it("checks every field against its kind, and refuses a key the form doesn't show", () => {
    const { projectDir, actions, consume } = project();
    const refuse = (fields: Record<string, unknown>) => {
      const result = answer(projectDir, "submit", { fields });
      expect(result.ok).toBe(false);
      return result;
    };
    refuse({ length_s: 4 });
    refuse({ length_s: 601 });
    refuse({ length_s: 45.5 });
    refuse({ length_s: "45" });
    refuse({ aspect: "4:3" });
    refuse({ use_brand: "yes" });
    refuse({ subject: "" });
    refuse({ subject: "x".repeat(2_001) });
    refuse({ subject: 7 });
    expect(refuse({ launch_missiles: "now" })).toMatchObject({ reason: "That isn't a field of this brief." });
    expect(answer(projectDir, "submit", "nope")).toMatchObject({ ok: false });
    expect(answer(projectDir, "submit", { fields: [] })).toMatchObject({ ok: false });
    expect(actions()).toEqual([]);
    consume();
  });

  it("checks the format against the catalog: never a soon option, and a scope only its question offers", () => {
    const { projectDir, actions } = project();
    const format = (value: unknown) => answer(projectDir, "submit", { fields: {}, format: value });
    expect(format({ tile: "launch", option: "app-store-preview" })).toMatchObject({
      ok: false,
      reason: "That format isn't available.",
    });
    expect(format({ tile: "nope", option: "launch-film" }).ok).toBe(false);
    expect(format({ tile: "launch", option: "launch-film", scope: "single-task" }).ok).toBe(false);
    expect(format("launch-film").ok).toBe(false);
    expect(actions()).toEqual([]);
    expect(format({ tile: "launch", option: "feature-reveal", scope: "category" }).ok).toBe(true);
    // A new format brings its own noun, length and shape, since none of them was changed.
    expect(actions()[0]!.value).toMatchObject({
      kind: "feature launch",
      length_s: 30,
      aspect: "16:9",
      format: { tile: "launch", option: "feature-reveal", scope: "category" },
    });
  });

  it("keeps what the person changed when the format changes, and the old format when none is sent", () => {
    const changed = project();
    expect(
      answer(changed.projectDir, "submit", {
        fields: { kind: "my own", length_s: 20 },
        format: { tile: "launch", option: "launch-teaser" },
      }).ok,
    ).toBe(true);
    expect(changed.actions()[0]!.value).toMatchObject({ kind: "my own", length_s: 20, aspect: "9:16" });
    const same = project();
    expect(answer(same.projectDir, "submit", { fields: {} }).ok).toBe(true);
    expect(same.actions()[0]!.value).toMatchObject({
      format: { tile: "launch", option: "launch-film", scope: "universal" },
    });
  });

  it("asks what the video is about when the brief has no source", () => {
    const { projectDir, actions } = project((s) => {
      (s.steps!.brief as Record<string, unknown>).needs_source = true;
    });
    const run = readRasanaiRun(projectDir)!;
    const brief = workflowView(run, waitingStatus(run, NOW)!).brief!;
    expect(brief.fields[0]).toMatchObject({ key: "source", kind: "longtext", value: null });
    expect(answer(projectDir, "submit", { fields: {} }).ok).toBe(false);
    expect(answer(projectDir, "submit", { fields: { source: "https://26keys.app" } }).ok).toBe(true);
    expect(actions()[0]!.value).toMatchObject({ source: "https://26keys.app" });
  });

  it("is answered only once while the first is unread", () => {
    const { projectDir, actions, consume } = project();
    expect(answer(projectDir, "submit", { fields: {} }).ok).toBe(true);
    expect(answer(projectDir, "decide-rest", null)).toMatchObject({ ok: false });
    expect(actions()).toHaveLength(1);
    consume();
  });
});

describe("you decide", () => {
  it("writes decide on the step, and decide-rest on step *, on a v2 run only", () => {
    const { projectDir, actions } = project();
    expect(answer(projectDir, "decide", null)).toMatchObject({ ok: true });
    expect(actions()).toMatchObject([{ step: "brief", type: "decide", value: null }]);
    const rest = project();
    expect(answer(rest.projectDir, "decide-rest", null).ok).toBe(true);
    expect(rest.actions()).toMatchObject([{ step: "*", type: "decide-rest", value: null }]);
    const old = project(() => {}, 1);
    expect(answer(old.projectDir, "decide", null)).toMatchObject({ ok: false, reason: V2_ONLY_NOTE });
    expect(old.actions()).toEqual([]);
  });

  it("takes a plain note on any waiting step, on either contract, and never an empty one", () => {
    for (const version of [1, 2]) {
      const { projectDir, actions } = project(() => {}, version);
      expect(answer(projectDir, "note", null, { note: "" })).toMatchObject({ ok: false });
      expect(answer(projectDir, "note", null, { note: "Keep it calm" }).ok).toBe(true);
      expect(actions()).toMatchObject([{ type: "note", note: "Keep it calm", value: null }]);
    }
  });
});

describe("the styleframes call", () => {
  const frames = (s: RasanaiSession) => {
    s.current = "styleframes";
    s.steps!.styleframes = {
      status: "awaiting",
      updated: "2026-10-26T07:40:00.000Z",
      sheet: "frames/sheet.png",
      frames: [
        {
          id: "f1",
          title: "Open",
          image: "frames/f1.png",
          ref: { image: "frames/ref1.png", why: "x" },
          shot: { size: "wide", angle: "low", hero: true, light: "soft" },
          verdict: "close",
        },
        { id: "f2", image: "frames/f2.png", ref: null, shot: null, verdict: null },
        { id: "bad", image: "notes.txt" },
      ],
    };
  };

  it("shows the frames with their reference, shot and the juror's verdict, and names every picture", () => {
    const { projectDir } = project(frames);
    const run = readRasanaiRun(projectDir)!;
    const view = workflowView(run, waitingStatus(run, NOW)!);
    expect(view.styleframes).toEqual({
      frames: [
        {
          id: "f1",
          image: "frames/f1.png",
          ref: "frames/ref1.png",
          shot: "wide · low · soft · hero",
          verdict: "close",
        },
        { id: "f2", image: "frames/f2.png", ref: null, shot: null, verdict: null },
      ],
      sheet: "frames/sheet.png",
    });
    expect(viewImages(view)).toEqual(["frames/f1.png", "frames/ref1.png", "frames/f2.png", "frames/sheet.png"]);
    expect(view.canDecide).toBe(true);
  });

  it("is only read on the Mac for a v1 run", () => {
    const { projectDir } = project(frames, 1);
    const run = readRasanaiRun(projectDir)!;
    expect(workflowView(run, waitingStatus(run, NOW)!)).toMatchObject({ macOnly: V2_ONLY_NOTE });
  });

  it("approves, comments on a frame, and redoes some, as RasanAI's own actions", () => {
    const a = project(frames);
    expect(answer(a.projectDir, "approve", null, { step: "styleframes" }).ok).toBe(true);
    expect(a.actions()).toMatchObject([{ step: "styleframes", type: "approve", value: null }]);

    const c = project(frames);
    expect(answer(c.projectDir, "comment", { frame: "f2", text: "More contrast" }, { step: "styleframes" }).ok).toBe(
      true,
    );
    expect(c.actions()).toMatchObject([
      {
        type: "comment",
        value: { scene: "f2", t: null, x: null, y: null, scope: "scene" },
        note: "More contrast",
      },
    ]);
    // Notes pile up; a note is not an answer.
    expect(answer(c.projectDir, "comment", { frame: "f1" }, { step: "styleframes", note: "Warmer" }).ok).toBe(true);
    expect(c.actions()).toHaveLength(2);

    const r = project(frames);
    expect(answer(r.projectDir, "redo", { ids: ["f1", "f2"], note: "Both darker" }, { step: "styleframes" }).ok).toBe(
      true,
    );
    expect(r.actions()).toMatchObject([
      { type: "redo", value: { ids: ["f1", "f2"], note: "Both darker" }, note: "Both darker" },
    ]);
  });

  it("refuses a frame that isn't there, a redo of nothing or twice, an empty note, and anything else", () => {
    const { projectDir, actions } = project(frames);
    const send = (type: string, value: unknown, note?: string) =>
      answer(projectDir, type, value, { step: "styleframes", ...(note !== undefined ? { note } : {}) });
    expect(send("comment", { frame: "zz", text: "x" }).ok).toBe(false);
    expect(send("comment", { frame: "f1", text: "" }).ok).toBe(false);
    expect(send("redo", { ids: [], note: "" }).ok).toBe(false);
    expect(send("redo", { ids: ["f1", "f1"] }).ok).toBe(false);
    expect(send("redo", { ids: ["f1", "nope"] }).ok).toBe(false);
    expect(send("redo", { ids: "f1" }).ok).toBe(false);
    expect(send("choose", "wild").ok).toBe(false);
    expect(actions()).toEqual([]);
  });
});

describe("a missing-tool ask", () => {
  const ask = (s: RasanaiSession) => {
    s.ask = {
      id: "a1",
      step: "brief",
      question: "Rasan needs FFmpeg to render. Install it?",
      options: [
        { id: "install-tool:ffmpeg", label: "Install FFmpeg for me" },
        { id: "skip-tool:ffmpeg", label: "Skip" },
      ],
      t: "2026-10-26T07:50:00.000Z",
    };
  };

  it("shows the tool, and answers tool-ready only for Squeak's own install", () => {
    const { projectDir, actions } = project(ask);
    const run = readRasanaiRun(projectDir)!;
    const view = workflowView(run, waitingStatus(run, NOW)!);
    expect(view.tool).toEqual({ tool: "ffmpeg", label: "Install FFmpeg for me" });
    expect(view.canDecide).toBeUndefined();
    const sendReady = (toolReady?: string) =>
      provider().act(
        projectDir,
        { step: "brief", revision: "ask:a1", type: "answer", value: { choice: "tool-ready:ffmpeg" } },
        toolReady ? { toolReady } : {},
      );
    expect(sendReady()).toMatchObject({ ok: false, reason: "That isn't one of the choices." });
    expect(sendReady("renderer")).toMatchObject({ ok: false });
    expect(actions()).toEqual([]);
    expect(sendReady("ffmpeg").ok).toBe(true);
    expect(actions()).toMatchObject([{ type: "answer", value: { ask: "a1", choice: "tool-ready:ffmpeg" } }]);
  });

  it("is not a tool ask when no option installs a tool, or on a v1 run's tool-ready", () => {
    const plain = project((s) => {
      ask(s);
      s.ask!.options = [{ id: "a", label: "A" }];
    });
    const run = readRasanaiRun(plain.projectDir)!;
    expect(workflowView(run, waitingStatus(run, NOW)!).tool).toBeUndefined();
    const old = project(ask, 1);
    expect(
      provider().act(
        old.projectDir,
        { step: "brief", revision: "ask:a1", type: "answer", value: { choice: "tool-ready:ffmpeg" } },
        { toolReady: "ffmpeg" },
      ).ok,
    ).toBe(false);
  });
});
