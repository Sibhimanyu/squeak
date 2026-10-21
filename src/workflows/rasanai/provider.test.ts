import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { FleetSession } from "../../fleet/types.js";
import { appendAction, pendingActions } from "./actions.js";
import { RasanaiProvider } from "./provider.js";
import { readRasanaiRun, STALE_WAIT_MS, waitingStatus, workflowView } from "./run.js";
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

function project(edit: (session: RasanaiSession) => void = () => {}, options: { headless?: boolean } = {}) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "rasanai-"));
  dirs.push(projectDir);
  const runDir = path.join(projectDir, ".rasanai", "run-1");
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".rasanai", "current"), "run-1\n");
  const { _askWhenOpen, ...session } = structuredClone(FIXTURE);
  void _askWhenOpen;
  edit(session);
  fs.writeFileSync(path.join(runDir, "session.json"), JSON.stringify(session));
  if (options.headless !== false) {
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

  it("leaves the animatic to the Mac for now", () => {
    const { projectDir } = project((s) => (s.current = "animatic"));
    const run = readRasanaiRun(projectDir)!;
    const view = workflowView(run, waitingStatus(run, NOW)!);
    expect(view.call).toBe("animatic");
    expect(view.options).toBeUndefined();
    expect(view.macOnly).toMatch(/on your Mac/);
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
        source: "squeak",
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
