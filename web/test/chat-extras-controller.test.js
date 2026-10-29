// The controller (chat-extras.js) with fakes: what is sent, in what order, and what is never sent again.

import { describe, expect, it } from "vitest";

import { importChannelKey, seal } from "../js/channel-crypto.js";
import { ChatExtras } from "../js/chat-extras.js";
import { toBase64 } from "../js/encoding.js";
import { liveHandle } from "../js/live.js";

const KEY = "claude-transcript:s1";
const ok = (result = { status: "sent" }) => ({
  ok: true,
  status: result.status,
  result,
  reason: null,
  retrySafe: false,
  unconfirmed: false,
});
const refused = (reason) => ({
  ok: false,
  status: "refused",
  result: null,
  reason,
  retrySafe: true,
  unconfirmed: false,
});
const unconfirmed = {
  ok: false,
  status: "unconfirmed",
  result: null,
  reason: "Couldn't confirm it arrived.",
  retrySafe: false,
  unconfirmed: true,
};

function session(over = {}) {
  return {
    key: KEY,
    conductorSessionId: "abc-123",
    workspaceId: "ws1",
    agent: "claude",
    state: "awaiting_input",
    turnId: "turn-9",
    question: { toolUseId: "toolu_1", questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] },
    ...over,
  };
}

async function world({ commands = {}, view = null } = {}) {
  const calls = [];
  const aes = await importChannelKey(toBase64(new Uint8Array(32).fill(7)));
  const docs = new Map();
  const state = { selected: KEY, prefs: {}, sent: [], touched: 0, history: [], waitMs: 0 };
  const make = (kind, reply) => async (input) => {
    calls.push({ kind, input });
    return typeof reply === "function" ? reply(input) : (reply ?? ok());
  };
  const fakeCommands = {
    waitMs: () => state.waitMs,
    answer: make("answer", commands.answer),
    close: make("close", commands.close),
    workspace: make("workspace", commands.workspace),
    history: make("history", commands.history),
    subagent: make("subagent", commands.subagent),
    diff: make("diff", commands.diff),
    setup: make("setup", commands.setup),
    attach: make("attach", commands.attach),
  };
  const channel = {
    key: aes,
    path: (kind, id) => `c/${kind}/${id}`,
    db: { get: async (path) => (docs.has(path) ? { box: docs.get(path) } : null) },
  };
  const timers = { setTimeout: (fn) => (state.later = fn) && 1, clearTimeout: () => {} };
  const x = new ChatExtras(
    {
      commands: () => fakeCommands,
      channel: () => channel,
      prefs: {
        get: (n) => state.prefs[n],
        save: async (c) => void Object.assign(state.prefs, c),
      },
      touch: () => void state.touched++,
      send: async (s, text, mode) => {
        state.sent.push({ text, mode });
        return true;
      },
      history: () => state.history,
      selected: () => state.selected,
      select: (k) => void (state.selected = k),
      view: () => view,
      verbose: () => true,
    },
    {
      timers,
      now: () => 1_000_000,
      prepareImage: async (file) =>
        file.bad
          ? { error: "That isn't an image this browser can read." }
          : { bytes: new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), width: 1, height: 1 },
      uploadPhoto: async (c, target, bytes) =>
        commands.uploadPhoto?.(c, target, bytes) ?? {
          ok: true,
          ref: `.context/attachments/ab12cd34/image-${calls.length + 1}.jpg`,
        },
      fetchImage: async () => ({ ok: true, uri: "data:image/png;base64,AAAA" }),
    },
  );
  const put = async (doc, value) => docs.set(`c/live/${doc}`, await seal(aes, value));
  return { x, calls, state, put };
}

describe("answering in place", () => {
  it("sends the picks as an exact answer command and says how it went", async () => {
    const w = await world({ commands: { answer: ok({ status: "answered", via: "conductor" }) } });
    const s = session();
    w.x.pick(s, 0, "B", false);
    await w.x.submitAnswers(s);
    expect(w.calls).toEqual([
      {
        kind: "answer",
        input: { sessionId: "abc-123", toolUseId: "toolu_1", answers: [{ question: 0, picked: ["B"] }] },
      },
    ]);
    expect(w.x.askState(s).result).toEqual({ delivered: true, line: "Answered" });
  });

  it("does not send an incomplete answer, and keeps the card on a refusal so it can be sent again", async () => {
    const w = await world({ commands: { answer: refused("That question is no longer waiting.") } });
    const s = session();
    await w.x.submitAnswers(s);
    expect(w.calls).toEqual([]);
    w.x.pick(s, 0, "A", false);
    await w.x.submitAnswers(s);
    expect(w.x.askState(s).result).toMatchObject({ delivered: false, line: "That question is no longer waiting." });
    expect(w.x.askState(s).locked).toBe(false);
    await w.x.submitAnswers(s);
    expect(w.calls).toHaveLength(2);
  });

  it("never sends an unconfirmed answer again", async () => {
    const w = await world({ commands: { answer: unconfirmed } });
    const s = session();
    w.x.pick(s, 0, "A", false);
    await w.x.submitAnswers(s);
    expect(w.x.askState(s).locked).toBe(true);
    await w.x.submitAnswers(s);
    await w.x.approvePlan(s);
    expect(w.calls).toHaveLength(1);
  });

  it("approves a plan and sends one back with a note, but not without one", async () => {
    const w = await world();
    const s = session({ question: { toolUseId: "t9", plan: "The plan" } });
    await w.x.sendPlanChanges(s);
    expect(w.calls).toEqual([]);
    w.x.typeNote(s, "  shorter ");
    await w.x.sendPlanChanges(s);
    expect(w.calls[0].input).toEqual({
      sessionId: "abc-123",
      toolUseId: "t9",
      plan: { approve: false, note: "shorter" },
    });
    const fresh = await world();
    await fresh.x.approvePlan(s);
    expect(fresh.calls[0].input.plan).toEqual({ approve: true });
    expect(fresh.x.askState(s).result).toEqual({ delivered: true, line: "Approved" });
  });

  it("holds back while the Mac's 15 s gap is running, and a new question resets the card", async () => {
    const w = await world();
    const s = session();
    w.state.waitMs = 8_200;
    w.x.pick(s, 0, "A", false);
    await w.x.submitAnswers(s);
    expect(w.calls).toEqual([]);
    expect(w.x.askState(s).result.line).toMatch(/Wait 9 s/);
    const next = session({
      question: { toolUseId: "toolu_2", questions: [{ question: "Again?", options: [{ label: "Z" }] }] },
    });
    expect(w.x.askState(next).form.picked).toEqual({});
  });

  it("will not send when the Mac names no question to answer", async () => {
    const w = await world();
    const s = session({ question: { questions: [{ question: "q", options: [{ label: "A" }] }] } });
    w.x.pick(s, 0, "A", false);
    await w.x.submitAnswers(s);
    expect(w.calls).toEqual([]);
    expect(w.x.askState(s).result.line).toMatch(/Update Squeak on your Mac/);
  });
});

describe("photos in the composer", () => {
  const png = (name = "a.png", extra = {}) => ({ name, type: "image/png", ...extra });

  it("saves each photo first, then sends one message naming the saved paths", async () => {
    const uploads = [];
    const w = await world({
      commands: {
        uploadPhoto: async (c, target) => {
          uploads.push(target);
          return { ok: true, ref: `.context/attachments/ab12cd34/image-${uploads.length}.jpg` };
        },
      },
    });
    const s = session({ state: "finished" });
    await w.x.addFiles(s, [png("1.png"), png("2.png")]);
    expect(w.x.photoState(KEY).list.map((p) => p.state)).toEqual(["ready", "ready"]);
    expect(w.x.photoState(KEY).list[0].uri).toMatch(/^data:image\/jpeg;base64,/);
    expect(await w.x.sendWithPhotos(s, " look ", "queue")).toBe(true);
    expect(uploads).toEqual([{ sessionId: "abc-123" }, { sessionId: "abc-123" }]);
    expect(w.state.sent).toEqual([
      {
        text: "look\n\n@⟦image-1.jpg⟧(.context%2Fattachments%2Fab12cd34%2Fimage-1.jpg)\n@⟦image-2.jpg⟧(.context%2Fattachments%2Fab12cd34%2Fimage-2.jpg)",
        mode: "queue",
      },
    ]);
    expect(w.x.photoState(KEY).list).toEqual([]);
  });

  it("sends nothing when a photo fails, keeps the photos and gives the words back", async () => {
    const w = await world({
      commands: {
        uploadPhoto: async () => ({ ok: false, reason: "Your Mac refused that.", unconfirmed: false, retrySafe: true }),
      },
    });
    const s = session({ state: "finished" });
    await w.x.addFiles(s, [png()]);
    expect(await w.x.sendWithPhotos(s, "hi", "queue")).toBe(false);
    expect(w.state.sent).toEqual([]);
    expect(w.x.photoState(KEY).list).toHaveLength(1);
    expect(w.x.photoState(KEY).problem).toBe("Your Mac refused that.");
  });

  it("drops a photo whose upload could not be confirmed rather than sending it again", async () => {
    const w = await world({
      commands: {
        uploadPhoto: async () => ({
          ok: false,
          reason: "Couldn't confirm it arrived.",
          unconfirmed: true,
          retrySafe: false,
        }),
      },
    });
    const s = session({ state: "finished" });
    await w.x.addFiles(s, [png()]);
    expect(await w.x.sendWithPhotos(s, "hi", "queue")).toBe(false);
    expect(w.x.photoState(KEY).list).toEqual([]);
    expect(w.x.photoState(KEY).problem).toMatch(/not sent again/);
  });

  it("limits to four, refuses non-images, reports an unreadable one, and removes", async () => {
    const w = await world();
    const s = session({ state: "finished" });
    await w.x.addFiles(s, [png("1"), png("2"), png("3"), png("4"), png("5")]);
    expect(w.x.photoState(KEY).list).toHaveLength(4);
    expect(w.x.photoState(KEY).problem).toMatch(/At most 4/);
    w.x.removePhoto(s, w.x.photoState(KEY).list[0].id);
    expect(w.x.photoState(KEY).list).toHaveLength(3);
    const other = await world();
    await other.x.addFiles(s, [{ name: "x.txt", type: "text/plain" }]);
    expect(other.x.photoState(KEY).problem).toBe("Only photos can be attached.");
    await other.x.addFiles(s, [png("bad", { bad: true })]);
    expect(other.x.photoState(KEY).list[0]).toMatchObject({ state: "error" });
    // A bad photo is not sent: only ready ones count, and with none the words go alone.
    expect(await other.x.sendWithPhotos(s, "just words", "queue")).toBe(true);
    expect(other.state.sent).toEqual([{ text: "just words", mode: "queue" }]);
  });

  it("is a plain send with no photos", async () => {
    const w = await world();
    expect(await w.x.sendWithPhotos(session({ state: "finished" }), "hello", "steer")).toBe(true);
    expect(w.state.sent).toEqual([{ text: "hello", mode: "steer" }]);
  });
});

describe("pictures", () => {
  it("loads a picture only on a tap, then enlarges it, and Esc closes it", async () => {
    const w = await world();
    const s = session();
    const image = { source: "/Users/me/shot.png", alt: "shot", kind: "agent" };
    expect(w.x.imageState(s, image).phase).toBe("idle");
    await w.x.loadImage(s, image);
    expect(w.x.imageState(s, image)).toMatchObject({ phase: "loaded", uri: "data:image/png;base64,AAAA" });
    w.x.viewImage(s, image);
    expect(w.x.dialogFor(KEY)).toBe("viewer");
    expect(w.x.closeTop()).toBe(true);
    expect(w.x.dialogFor(KEY)).toBeNull();
    expect(w.x.closeTop()).toBe(false);
  });

  it("closes a dialog when the chat changes", async () => {
    const w = await world();
    const s = session();
    const image = { source: "/a.png", alt: "", kind: "agent" };
    await w.x.loadImage(s, image);
    w.x.viewImage(s, image);
    expect(w.x.dialogFor("another-chat")).toBeNull();
    expect(w.x.viewer).toBeNull();
  });
});

describe("earlier history", () => {
  const held = [{ id: "20", role: "user", text: "held", at: "2026-10-28T10:00:00Z" }];

  it("asks for 12 before the oldest held message and shows what comes back above it", async () => {
    const doc = `${await liveHandle(KEY)}-h20`;
    const w = await world({ commands: { history: async () => ok({ status: "sent", doc }) } });
    w.state.history = held;
    await w.put(doc, {
      v: 1,
      key: KEY,
      before: "20",
      entries: [
        { id: "18", role: "assistant", text: "older", at: "2026-10-28T09:00:00Z" },
        { id: "19", role: "user", text: "older q", at: "2026-10-28T09:30:00Z" },
      ],
      nextBefore: "18",
      complete: false,
    });
    const s = session({ state: "finished" });
    expect(w.x.earlierRowKind(s)).toBe("sentinel");
    await w.x.loadEarlier(s, true);
    expect(w.calls).toEqual([{ kind: "history", input: { key: KEY, before: "20", n: 12 } }]);
    expect(w.x.earlierRows(s).map((r) => r.text)).toEqual(["older", "older q"]);
    expect(w.x.earlierRowKind(s)).toBe("sentinel");
  });

  it("fails quietly when the Mac names another page or none, and offers a retry", async () => {
    const w = await world({ commands: { history: async () => ok({ status: "sent", doc: "wrong" }) } });
    w.state.history = held;
    const s = session({ state: "finished" });
    await w.x.loadEarlier(s, true);
    expect(w.x.earlierRowKind(s)).toBe("failed");
    // Only a deliberate try goes again.
    await w.x.loadEarlier(s, false);
    expect(w.calls).toHaveLength(1);
    await w.x.loadEarlier(s, true);
    expect(w.calls).toHaveLength(2);
  });

  it("has nothing above a chat with no history held or no Conductor id", async () => {
    const w = await world();
    expect(w.x.earlierRowKind(session())).toBe("none");
    w.state.history = held;
    expect(w.x.earlierRowKind(session({ conductorSessionId: undefined }))).toBe("none");
  });
});

describe("a subagent's feed", () => {
  const task = { id: "task-0001", kind: "agent", label: "Explore", status: "running", canOpenSteps: true };

  it("asks the Mac to follow it, reads the feed, and tells the Mac to stop on close", async () => {
    const w = await world();
    const s = session({ state: "working" });
    const doc = `${await liveHandle(KEY)}-s`;
    await w.put(doc, {
      v: 1,
      key: KEY,
      taskId: "task-0001",
      label: "Explore",
      status: "running",
      available: true,
      total: 1,
      steps: [{ kind: "tool", text: "Read x" }],
    });
    await w.x.openSubagent(s, task);
    await new Promise((r) => setTimeout(r, 20));
    expect(w.calls[0]).toEqual({ kind: "subagent", input: { key: KEY, taskId: "task-0001" } });
    expect(w.x.sub.feed.steps).toEqual([{ kind: "tool", text: "Read x" }]);
    expect(w.x.dialogFor(KEY)).toBe("subagent");
    w.x.closeSubagent();
    expect(w.calls[1]).toEqual({ kind: "subagent", input: { key: KEY, taskId: null } });
    expect(w.x.dialogFor(KEY)).toBeNull();
  });

  it("says why when the Mac refuses, and never opens a task without readable steps", async () => {
    const w = await world({ commands: { subagent: refused("Turn on Show thinking live.") } });
    const s = session({ state: "working" });
    await w.x.openSubagent(s, task);
    expect(w.x.sub).toMatchObject({ phase: "refused", reason: "Turn on Show thinking live." });
    w.x.closeSubagent();
    expect(w.calls).toHaveLength(1);
    await w.x.openSubagent(s, { ...task, canOpenSteps: false });
    expect(w.x.sub).toBeNull();
  });

  it("closes itself when the chat is left", async () => {
    const w = await world();
    const s = session({ state: "working" });
    await w.x.openSubagent(s, task);
    await new Promise((r) => setTimeout(r, 20));
    w.state.selected = null;
    await w.state.later?.();
    expect(w.x.sub).toBeNull();
  });
});

describe("the menu", () => {
  it("hides the chat on this device (a preference) and leaves it", async () => {
    const w = await world();
    const s = session({ state: "finished", lastActivityAt: "2026-10-28T10:00:00Z" });
    await w.x.runMenu(s, "hide");
    expect(w.state.prefs.hiddenChats).toEqual({ [KEY]: 1_000_000 });
    expect(w.state.selected).toBeNull();
  });

  it("closes in Conductor only after a confirmation, and explains a refusal", async () => {
    const w = await world({
      commands: { close: refused("That chat is running or waiting on you. Close it once it has finished.") },
    });
    const s = session({ state: "finished" });
    await w.x.runMenu(s, "close");
    expect(w.calls).toEqual([]);
    expect(w.x.dialogFor(KEY)).toBe("confirm");
    await w.x.confirmAction(s);
    expect(w.calls).toEqual([{ kind: "close", input: { sessionId: "abc-123" } }]);
    expect(w.x.notice(KEY)).toMatchObject({ bad: true, line: expect.stringMatching(/running or waiting/) });
    w.x.dismissNotice(KEY);
    expect(w.x.notice(KEY)).toBeNull();
  });

  it("archives after a confirmation and asks for a pull request at once, naming the turn", async () => {
    const w = await world({ view: { repos: [{ id: "r1", name: "farm" }] } });
    const s = session({ state: "finished" });
    expect(w.x.menu(s).map((i) => i.id)).toContain("archive");
    await w.x.runMenu(s, "archive");
    await w.x.confirmAction(s);
    await w.x.runMenu(s, "createPr");
    expect(w.calls.map((c) => c.input)).toEqual([
      { action: "archive", workspaceId: "ws1" },
      { action: "createPr", sessionId: "abc-123", answersTurn: "turn-9" },
    ]);
    expect(w.x.notice(KEY)).toMatchObject({ bad: false, line: "Asked for a pull request." });
  });

  it("changes the model and shows the pending line", async () => {
    const view = {
      chatModels: [{ id: "opus", agent: "claude", label: "Opus 5.5", levels: ["low", "high"], defaultLevel: "low" }],
    };
    const w = await world({ view });
    const s = session({ state: "finished", modelId: "opus", effortId: "high" });
    const [model] = w.x.setupChoices(s);
    await w.x.changeSetup(s, model, { thinking: "low" });
    expect(w.calls[0].input).toEqual({ sessionId: "abc-123", model: "opus", thinking: "low" });
    expect(w.x.pendingSetup(KEY)).toBe("Opus 5.5 · Low");
    // Mid-turn the Mac refuses: nothing is sent.
    await w.x.changeSetup(session({ state: "working", modelId: "opus" }), model, {});
    expect(w.calls).toHaveLength(1);
  });
});

describe("the diff", () => {
  const diff = {
    baseRef: "origin/main",
    insertions: 1,
    deletions: 0,
    truncated: false,
    files: [{ path: "a.ts", insertions: 1, deletions: 0, binary: false, untracked: false }],
  };

  it("lists the files, then one file's patch, and Esc steps back before it closes", async () => {
    const w = await world({
      commands: {
        diff: async (input) =>
          ok(
            input.file === undefined
              ? { status: "sent", diff }
              : { status: "sent", patch: { index: 0, path: "a.ts", text: "@@ -1 +1 @@\n+x\n" } },
          ),
      },
    });
    const s = session({ state: "finished" });
    await w.x.openDiff(s);
    expect(w.x.diff.phase).toBe("list");
    await w.x.openFile(0);
    expect(w.calls.map((c) => c.input)).toEqual([{ sessionId: "abc-123" }, { sessionId: "abc-123", file: 0 }]);
    expect(w.x.diff.patch.lines.map((l) => l.kind)).toEqual(["hunk", "add"]);
    expect(w.x.closeTop()).toBe(true);
    expect(w.x.diff.file).toBeNull();
    expect(w.x.closeTop()).toBe(true);
    expect(w.x.diff).toBeNull();
  });

  it("explains a refusal and rejects a patch for a file that moved", async () => {
    const w = await world({ commands: { diff: refused("The workspace is gone.") } });
    await w.x.openDiff(session());
    expect(w.x.diff).toMatchObject({ phase: "problem", problem: "The workspace is gone." });
    const moved = await world({
      commands: {
        diff: async (input) =>
          ok(
            input.file === undefined
              ? { status: "sent", diff }
              : { status: "sent", patch: { index: 0, path: "other.ts", text: "x" } },
          ),
      },
    });
    await moved.x.openDiff(session());
    await moved.x.openFile(0);
    expect(moved.x.diff.patch.phase).toBe("problem");
  });
});
