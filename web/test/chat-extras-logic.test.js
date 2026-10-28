import { describe, expect, it } from "vitest";

import {
  addPhotos,
  answerInput,
  answerLine,
  answerSummary,
  buildAnswers,
  canAnswer,
  closeResult,
  earlierCursor,
  earlierRow,
  earlierRows,
  emptyEarlier,
  emptyForm,
  feedExplanation,
  fileCounts,
  imageFiles,
  isComplete,
  menuItems,
  mergeEarlier,
  messageImages,
  openOther,
  patchLines,
  patchPage,
  pendingSetupLine,
  planAnswer,
  readDiff,
  readFeed,
  readPage,
  readQuestion,
  setOther,
  setupInput,
  setupModels,
  shouldFetchEarlier,
  stripOpen,
  stuckLine,
  taskDuration,
  taskRow,
  taskSummary,
  togglePick,
} from "../js/chat-extras-logic.js";
import { shape } from "../js/command-shapes.js";
import { composeMessage } from "../js/images.js";
import { stalled, tasks } from "../js/view-model.js";

const session = (over = {}) => ({
  key: "claude-transcript:s1",
  conductorSessionId: "abc-123",
  state: "awaiting_input",
  agent: "claude",
  question: {
    toolUseId: "toolu_1",
    questions: [
      {
        question: "Which?",
        header: "Pick",
        multiSelect: false,
        options: [{ label: "A", description: "first" }, { label: "B" }],
      },
      { question: "Which more?", multiSelect: true, options: [{ label: "X" }, { label: "Y" }] },
    ],
  },
  ...over,
});

describe("answers", () => {
  it("reads the question defensively", () => {
    expect(readQuestion({})).toBeNull();
    expect(readQuestion({ question: { questions: [] } })).toBeNull();
    const q = readQuestion(session());
    expect(q.toolUseId).toBe("toolu_1");
    expect(q.prompts[0]).toMatchObject({ header: "Pick", multiSelect: false });
    expect(q.prompts[0].options[1]).toEqual({ label: "B", description: null });
    expect(readQuestion({ question: { plan: "Do it", toolUseId: "t" } }).plan).toBe("Do it");
  });

  it("can answer only with a tool use id and a Conductor id", () => {
    expect(canAnswer(session())).toBe(true);
    expect(canAnswer(session({ conductorSessionId: undefined }))).toBe(false);
    expect(canAnswer(session({ question: { questions: [{ question: "q", options: [] }] } }))).toBe(false);
  });

  it("single-select picks and lets go; typing words lets go of the pick, picking clears the words", () => {
    let form = emptyForm();
    form = togglePick(form, 0, "A", false);
    expect(form.picked[0]).toEqual(["A"]);
    form = togglePick(form, 0, "B", false);
    expect(form.picked[0]).toEqual(["B"]);
    form = togglePick(form, 0, "B", false);
    expect(form.picked[0]).toEqual([]);
    form = openOther(form, 0);
    form = setOther(togglePick(form, 0, "A", false), 0, "my own", false);
    expect(form.picked[0]).toEqual([]);
    expect(form.other[0]).toBe("my own");
    form = togglePick(form, 0, "A", false);
    expect(form.other[0]).toBeUndefined();
    expect(form.otherOpen[0]).toBeUndefined();
  });

  it("multi-select toggles and keeps the words beside the picks", () => {
    let form = togglePick(emptyForm(), 1, "X", true);
    form = togglePick(form, 1, "Y", true);
    form = setOther(form, 1, "and Z", true);
    expect(form.picked[1]).toEqual(["X", "Y"]);
    form = togglePick(form, 1, "X", true);
    expect(form.picked[1]).toEqual(["Y"]);
    expect(form.other[1]).toBe("and Z");
  });

  it("is complete when each question has a pick or words", () => {
    const { prompts } = readQuestion(session());
    let form = togglePick(emptyForm(), 0, "A", false);
    expect(isComplete(prompts, form)).toBe(false);
    form = setOther(form, 1, "   ", true);
    expect(isComplete(prompts, form)).toBe(false);
    form = setOther(form, 1, "words", true);
    expect(isComplete(prompts, form)).toBe(true);
  });

  it("builds the answers the Mac takes, sorted, with other only when typed", () => {
    const { prompts } = readQuestion(session());
    let form = togglePick(emptyForm(), 0, "B", false);
    form = togglePick(togglePick(form, 1, "Y", true), 1, "X", true);
    form = setOther(form, 1, "  more  ", true);
    const answers = buildAnswers(prompts, form);
    expect(answers).toEqual([
      { question: 0, picked: ["B"] },
      { question: 1, picked: ["X", "Y"], other: "more" },
    ]);
    // The same payload passes the exact shape check the Mac mirrors.
    const input = answerInput(session(), { answers });
    expect(shape("answer", input)).toEqual(input);
    expect(input).toEqual({ sessionId: "abc-123", toolUseId: "toolu_1", answers });
    expect(answerSummary(prompts, form)).toBe("B, X, Y, more");
  });

  it("plan answers: approve, or send back with a note", () => {
    const plan = { question: { toolUseId: "t1", plan: "Step 1" } };
    const s = session(plan);
    expect(planAnswer(true)).toEqual({ approve: true });
    expect(planAnswer(false, "  ")).toBeNull();
    expect(planAnswer(false, " fewer steps ")).toEqual({ approve: false, note: "fewer steps" });
    const approve = answerInput(s, { plan: planAnswer(true) });
    expect(shape("answer", approve)).toEqual({ sessionId: "abc-123", toolUseId: "t1", plan: { approve: true } });
    const back = answerInput(s, { plan: planAnswer(false, "fewer steps") });
    expect(shape("answer", back).plan).toEqual({ approve: false, note: "fewer steps" });
  });

  it("has no input when the Mac names no question", () => {
    expect(
      answerInput(session({ question: { questions: [{ question: "q", options: [] }] } }), { answers: [] }),
    ).toBeNull();
  });

  it("words the result as the iPhone does", () => {
    expect(answerLine({ ok: true, result: { status: "answered" } })).toBe("Answered");
    expect(answerLine({ ok: true, result: { status: "answered", via: "stopped-and-sent", note: "Done" } })).toBe(
      "Done · sent as a message after stopping the question",
    );
    expect(answerLine({ ok: false, reason: "That question is gone." })).toBe("That question is gone.");
  });
});

describe("the stuck notice and background tasks", () => {
  const now = Date.parse("2026-10-28T10:15:00Z");
  it("says what it waits on and for how long", () => {
    expect(stuckLine({ on: "model", since: "2026-10-28T10:01:00Z" }, now)).toBe(
      "No response from the model for 14 min",
    );
    expect(stuckLine({ on: "api", since: "2026-10-28T08:45:00Z" }, now)).toBe("Retrying API errors for 1 h 30 min");
    expect(stuckLine({ on: "model", since: "2026-10-28T10:14:59Z" }, now)).toBe("No response from the model for 1 min");
    expect(stuckLine({ on: "model", since: "garbage" }, now)).toBe("No response from the model for a while");
    expect(stuckLine(null)).toBe("");
    expect(stuckLine(stalled({ stalled: { on: "api", since: "2026-10-28T10:05:00Z" } }), now)).toBe(
      "Retrying API errors for 10 min",
    );
  });

  const list = tasks({
    background: [
      {
        id: "t1",
        kind: "agent",
        label: "Explore the repo",
        status: "running",
        startedAt: "2026-10-28T10:11:00Z",
        hasSteps: true,
        agentId: "a1",
      },
      {
        id: "t2",
        kind: "shell",
        label: "npm run dev",
        status: "done",
        startedAt: "2026-10-28T10:00:00Z",
        endedAt: "2026-10-28T10:02:30Z",
        summary: "exit 0",
      },
      { id: "t3", kind: "agent", label: "Review", status: "failed", summary: "Agent Review failed" },
    ],
  });

  it("summarises and times them", () => {
    expect(taskSummary(list)).toBe("2 subagents, 1 shell · 1 running");
    expect(taskSummary(list.filter((t) => t.status !== "running"))).toBe("1 subagent, 1 shell · all ended");
    expect(taskSummary([list[0]])).toBe("1 subagent · running");
    expect(taskDuration(list[0], now)).toBe("4 min");
    expect(taskDuration(list[1], now)).toBe("2 min");
    expect(taskDuration({ startedAt: "2026-10-28T10:14:30Z" }, now)).toBe("30 s");
    expect(taskDuration({}, now)).toBeNull();
  });

  it("opens by default with at most two, and a tap decides", () => {
    expect(stripOpen(list, undefined)).toBe(false);
    expect(stripOpen(list.slice(0, 2), undefined)).toBe(true);
    expect(stripOpen(list, true)).toBe(true);
  });

  it("rows: status word, summary only when it adds something, steps only for readable agents", () => {
    expect(taskRow(list[0], now)).toMatchObject({ word: "running", time: "4 min", canOpen: true, showSummary: false });
    expect(taskRow(list[1], now)).toMatchObject({ word: "done", showSummary: true, canOpen: false });
    expect(taskRow(list[2], now).showSummary).toBe(false);
    expect(taskRow(list[2], now).word).toBe("failed");
  });

  it("reads a subagent feed only for this chat and explains an empty one", () => {
    const doc = {
      v: 1,
      key: "k",
      taskId: "task-0001",
      label: "L",
      status: "running",
      available: true,
      total: 3,
      steps: [{ kind: "tool", text: "Read x" }, { nope: 1 }],
    };
    expect(readFeed(doc, "other")).toBeNull();
    const feed = readFeed(doc, "k");
    expect(feed.steps).toEqual([{ kind: "tool", text: "Read x" }]);
    expect(feedExplanation({ phase: "following", feed }, null)).toBeNull();
    expect(feedExplanation({ phase: "asking", feed: null })).toBe("Asking your Mac…");
    expect(feedExplanation({ phase: "following", feed: null })).toBe("Waiting for the first steps…");
    expect(feedExplanation({ phase: "following", feed: { ...feed, available: false } })).toMatch(/can't be read yet/);
    expect(feedExplanation({ phase: "following", feed: { ...feed, steps: [] } })).toMatch(/hasn't taken a step/);
    expect(feedExplanation({ phase: "refused", reason: "No." })).toBe("No.");
    expect(feedExplanation({ phase: "following", feed }, "Turn it on.")).toBe("Turn it on.");
  });
});

describe("photos and pictures", () => {
  it("holds at most four and counts what did not fit", () => {
    const held = [{}, {}, {}];
    expect(addPhotos(held, [{ a: 1 }, { a: 2 }])).toMatchObject({ dropped: 1 });
    expect(addPhotos(held, [{ a: 1 }, { a: 2 }]).list).toHaveLength(4);
    expect(addPhotos([], [])).toEqual({ list: [], dropped: 0 });
  });

  it("takes only image files from a drop or paste", () => {
    const files = [{ type: "image/png" }, { type: "text/plain" }, { type: "image/jpeg" }, { type: "application/pdf" }];
    expect(imageFiles(files)).toHaveLength(2);
    expect(imageFiles(null)).toEqual([]);
  });

  it("composes the message the way the iPhone does, naming each saved path", () => {
    const refs = [".context/attachments/ab12cd34/image-1.jpg", ".context/attachments/ab12cd34/image-2.png"];
    expect(composeMessage("  look  ", refs)).toBe(`look\n\n[Image: ${refs[0]}]\n[Image: ${refs[1]}]`);
    expect(composeMessage("", [refs[0]])).toBe(`See the attached image.\n\n[Image: ${refs[0]}]`);
    expect(composeMessage("hi", [])).toBe("hi");
  });

  it("finds the pictures a message names and takes them out of its words", () => {
    const sent = messageImages("look\n\n[Image: .context/attachments/ab12cd34/image-1.jpg]");
    expect(sent).toEqual({
      body: "look",
      images: [{ source: ".context/attachments/ab12cd34/image-1.jpg", alt: "", kind: "photo" }],
    });
    const agent = messageImages("Here:\n\n![the login page](/Users/me/shot.png)\n\nand ![web](https://x.test/a.png)");
    expect(agent.images).toEqual([{ source: "/Users/me/shot.png", alt: "the login page", kind: "agent" }]);
    expect(agent.body).toContain("![web](https://x.test/a.png)");
    expect(agent.body).not.toContain("shot.png");
    expect(messageImages("plain").images).toEqual([]);
  });
});

describe("earlier history", () => {
  const e = (id, text, role = "assistant", extra = {}) => ({
    id,
    role,
    text,
    at: `2026-10-28T0${id}:00:00Z`,
    ...extra,
  });
  it("merges an older page in front without repeating anything held", () => {
    const held = [e("5", "five")];
    const page = {
      entries: [e("3", "three"), e("4", "four", "user", { workBefore: 2 }), e("5", "five")],
      nextBefore: "3",
      complete: false,
    };
    const state = mergeEarlier(emptyEarlier(), page, held);
    expect(state.entries.map((x) => x.id)).toEqual(["3", "4"]);
    expect(state).toMatchObject({ nextBefore: "3", complete: false });
    const done = mergeEarlier(state, { entries: [e("2", "two")], nextBefore: null, complete: false }, held);
    expect(done.entries.map((x) => x.id)).toEqual(["2", "3", "4"]);
    expect(done.complete).toBe(true);
  });

  it("asks from the cursor the Mac gave, else the oldest held id, and nowhere once complete", () => {
    const held = [e("5", "five")];
    expect(earlierCursor(emptyEarlier(), held)).toBe("5");
    expect(earlierCursor({ ...emptyEarlier(), nextBefore: "3" }, held)).toBe("3");
    expect(earlierCursor({ ...emptyEarlier(), complete: true }, held)).toBeNull();
    expect(earlierCursor(emptyEarlier(), [{ role: "user", text: "x" }])).toBeNull();
    // The cursor passes the exact shape check the Mac mirrors, 12 to a page.
    expect(shape("history", { key: "k", before: "12", n: 12 })).toEqual({ key: "k", before: "12", n: 12 });
  });

  it("checks a page is for this chat and this cursor", () => {
    const doc = {
      v: 1,
      key: "k",
      before: "7",
      entries: [
        { role: "user", text: "a", at: null, id: "6" },
        { role: "x", text: "b" },
      ],
      nextBefore: "6",
      complete: false,
    };
    expect(readPage(doc, "k", "7").entries).toHaveLength(1);
    expect(readPage(doc, "other", "7")).toBeNull();
    expect(readPage(doc, "k", "8")).toBeNull();
    expect(readPage({ ...doc, before: undefined }, "k", null)).not.toBeNull();
  });

  it("chooses the row above the first message and when to fetch", () => {
    const state = emptyEarlier();
    const base = { available: true, hasHeld: true, state, load: "idle" };
    expect(earlierRow(base)).toBe("sentinel");
    expect(earlierRow({ ...base, load: "loading" })).toBe("loading");
    expect(earlierRow({ ...base, load: "failed" })).toBe("failed");
    expect(earlierRow({ ...base, state: { ...state, complete: true } })).toBe("start");
    expect(earlierRow({ ...base, hasHeld: false })).toBe("none");
    expect(earlierRow({ ...base, available: false })).toBe("none");
    expect(shouldFetchEarlier({ ...base, manual: false })).toBe(true);
    expect(shouldFetchEarlier({ ...base, load: "failed", manual: false })).toBe(false);
    expect(shouldFetchEarlier({ ...base, load: "failed", manual: true })).toBe(true);
    expect(shouldFetchEarlier({ ...base, load: "loading", manual: true })).toBe(false);
  });

  it("makes rows with a Worked count before a message and stable ids", () => {
    const rows = earlierRows(
      [e("3", "three", "user"), e("4", "four", "assistant", { workBefore: 3 })],
      [e("9", "nine")],
    );
    expect(rows.map((r) => r.kind)).toEqual(["history", "worked", "history"]);
    expect(rows[1].steps).toBe(3);
    expect(rows[0]).toMatchObject({ fromUser: true, id: "e-3" });
    expect(earlierRows([e("3", "three")], [e("3", "three")])).toEqual([]);
  });
});

describe("the chat menu", () => {
  const resting = { key: "k", conductorSessionId: "abc", workspaceId: "ws1", state: "finished", agent: "claude" };
  it("offers close, hide and the workspace section when the Mac does workspaces", () => {
    const ids = (s, o) => menuItems(s, o).map((i) => i.id);
    expect(ids(resting, { workspaceActions: true })).toEqual(["diff", "close", "hide", "createPr", "archive"]);
    expect(ids(resting, { workspaceActions: false })).toEqual(["diff", "close", "hide"]);
    expect(ids({ ...resting, conductorSessionId: undefined })).toEqual(["hide"]);
    expect(ids({ ...resting, open: false })).toEqual(["diff", "hide"]);
  });

  it("greys out the workspace actions mid-turn and offers no close then", () => {
    const working = { ...resting, state: "working" };
    const items = menuItems(working, { workspaceActions: true });
    expect(items.map((i) => i.id)).toEqual(["diff", "hide", "createPr", "archive"]);
    expect(items.filter((i) => i.section).every((i) => i.enabled === false && i.why)).toBe(true);
    expect(menuItems({ ...resting, state: "awaiting_input" }).some((i) => i.id === "close")).toBe(false);
  });

  it("states close, archive and PR results from the Mac's own words", () => {
    expect(closeResult({ ok: true })).toEqual({ ok: true, line: "Closed in Conductor." });
    expect(
      closeResult({ ok: false, reason: "That chat is running or waiting on you. Close it once it has finished." }).line,
    ).toMatch(/running/);
    expect(closeResult({ ok: false, reason: "" }).line).toBe("Conductor didn't close it.");
    expect(shape("close", { sessionId: "abc" })).toEqual({ sessionId: "abc" });
    expect(shape("workspace", { action: "archive", workspaceId: "ws1" })).toEqual({
      action: "archive",
      workspaceId: "ws1",
    });
    expect(shape("workspace", { action: "createPr", sessionId: "abc", answersTurn: null })).toEqual({
      action: "createPr",
      sessionId: "abc",
    });
  });
});

describe("model and thinking", () => {
  const models = [
    { id: "opus", agent: "claude", label: "Opus 5.5", levels: ["low", "medium", "high"], defaultLevel: "medium" },
    { id: "gpt", agent: "codex", label: "GPT", levels: [], defaultLevel: null },
  ];
  const s = { key: "k", conductorSessionId: "abc", agent: "claude", modelId: "opus", effortId: "high", fast: false };
  it("offers only the chat's own agent's models, and only for a chat that says its model", () => {
    expect(setupModels(s, models).map((m) => m.id)).toEqual(["opus"]);
    expect(setupModels({ ...s, modelId: undefined }, models)).toEqual([]);
    expect(setupModels(s, null)).toEqual([]);
  });
  it("sends only what was chosen", () => {
    expect(setupInput(s, { model: "opus", thinking: "low" })).toEqual({
      sessionId: "abc",
      model: "opus",
      thinking: "low",
    });
    expect(setupInput(s, { model: "opus", fast: true })).toEqual({ sessionId: "abc", model: "opus", fast: true });
    expect(shape("setup", setupInput(s, { model: "opus", thinking: "low", fast: true })).fast).toBe(true);
  });
  it("words the pending line", () => {
    expect(pendingSetupLine(s, models[0], {})).toBe("Opus 5.5 · High");
    expect(pendingSetupLine(s, models[0], { thinking: "low", fast: true })).toBe("Opus 5.5 · Low · Fast");
    expect(pendingSetupLine({ ...s, effortId: "ultra" }, models[0], {})).toBe("Opus 5.5 · Medium");
  });
});

describe("the diff", () => {
  const raw = {
    baseRef: "origin/main",
    insertions: 5,
    deletions: 2,
    truncated: true,
    files: [
      { path: "a/b.ts", insertions: 3, deletions: 2, binary: false, untracked: false },
      { path: "new.ts", insertions: 2, deletions: 0, binary: false, untracked: true },
      { path: "x.png", insertions: 0, deletions: 0, binary: true, untracked: false },
      { nope: true },
    ],
  };
  it("reads the file list and labels each file", () => {
    const diff = readDiff(raw);
    expect(diff.files).toHaveLength(3);
    expect(diff.truncated).toBe(true);
    expect(diff.files.map(fileCounts)).toEqual(["+3 −2", "new · +2", "binary"]);
    expect(readDiff({})).toBeNull();
    expect(shape("diff", { sessionId: "abc", file: 1 })).toEqual({ sessionId: "abc", file: 1 });
  });
  it("classes the lines of a patch", () => {
    const text = [
      "diff --git a/f b/f",
      "index 1..2 100644",
      "--- a/f",
      "+++ b/f",
      "@@ -1,2 +1,2 @@",
      " same",
      "-old",
      "+new",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(patchLines(text).map((l) => l.kind)).toEqual([
      "meta",
      "meta",
      "meta",
      "meta",
      "hunk",
      "ctx",
      "del",
      "add",
      "meta",
    ]);
  });
  it("falls back to the prefix when the patch has no hunk headers", () => {
    expect(patchLines("+a\n-b\n c").map((l) => l.kind)).toEqual(["add", "del", "ctx"]);
  });
  it("pages a long patch", () => {
    const lines = Array.from({ length: 950 }, (_, i) => ({ kind: "ctx", text: String(i) }));
    expect(patchPage(lines, 1)).toMatchObject({ more: 550 });
    expect(patchPage(lines, 3).more).toBe(0);
    expect(patchPage(lines, 3).shown).toHaveLength(950);
  });
});
