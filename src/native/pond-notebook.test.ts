import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentTools, ToolError } from "./agent-tools.js";
import { NativeServer } from "./server.js";
import { SessionHost } from "./host.js";
import { WorkspaceManager } from "./workspaces.js";
import {
  NOTEBOOK_MAX_CHARS,
  NOTEBOOK_MAX_ENTRIES,
  NOTEBOOK_PER_TASK,
  NotebookError,
  PondNotebook,
} from "./pond-notebook.js";
import { Room } from "./room.js";
import { RoomTasks } from "./room-tasks.js";
import { NativeStore } from "./store.js";

/** The Pond Notebook: caps and trimming, written at Task end only, in the briefing, owner edits, migration. */

function rig() {
  const store = new NativeStore(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pond-notebook-"));
  const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
  let t = 1000;
  const now = () => ++t;
  const notebook = new PondNotebook(store, now);
  const room = new Room({ store, ownerName: () => "Sam", members: () => 1, deliver: async () => undefined });
  const chat = (title: string) =>
    store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default", title });
  const duck = (name: string) => {
    const s = chat(name);
    const d = store.createDuck({ projectId: project.id, name });
    store.attachSessionToDuck(d.id, s.id);
    return { s, d: store.duckRow(d.id)! };
  };
  const jobs = new RoomTasks({
    store,
    room,
    settings: () => ({ askBeforeStarting: true, maxWorkingDucks: 4 }),
    send: async () => undefined,
    newThread: async (_p, _t, title) => chat(title),
    notebook: (id) => notebook.forBriefing(id),
  });
  const tools = new AgentTools({
    store,
    room,
    jobs,
    notebook,
    send: async () => ({ queued: false }),
    create: async () => {
      throw new Error("unused");
    },
    post: () => {},
  } as never);
  const pid = project.id;
  /** A Duck holding a working Task from the Room. */
  const working = async (name: string, text = "please redo the settings page") => {
    const d = duck(name);
    const ask = room.personPost(pid, text);
    const task = jobs.fromMessage(pid, ask.id);
    await jobs.act(pid, task.id, { action: "go", duckId: d.d.id });
    return { ...d, task };
  };
  return { store, project, pid, notebook, jobs, tools, duck, working, room, chat };
}

const note = (r: ReturnType<typeof rig>, sessionId: string, args: Record<string, unknown>) =>
  r.tools.call(sessionId, "note_to_notebook", args);

describe("Pond Notebook storage", () => {
  it("adds a lesson once, one line, and a repeat only counts as used", () => {
    const r = rig();
    expect(r.notebook.add(r.pid, "Run the\nfull suite before pushing.", "Pip")).toMatchObject({ added: true });
    expect(r.notebook.add(r.pid, "Run the full suite before pushing.", "Sage")).toMatchObject({ added: false });
    expect(r.notebook.view(r.pid).entries.map((e) => e.text)).toEqual(["Run the full suite before pushing."]);
    expect(() => r.notebook.add(r.pid, "   ", null)).toThrow(NotebookError);
  });

  it("keeps at most the entry cap, dropping the oldest unused first", () => {
    const r = rig();
    for (let i = 0; i < NOTEBOOK_MAX_ENTRIES + 5; i++) r.notebook.add(r.pid, `lesson ${i}`, null);
    const texts = r.notebook.view(r.pid).entries.map((e) => e.text);
    expect(texts).toHaveLength(NOTEBOOK_MAX_ENTRIES);
    expect(texts).not.toContain("lesson 0");
    expect(texts).toContain(`lesson ${NOTEBOOK_MAX_ENTRIES + 4}`);
  });

  it("keeps entries that Ducks were given in a briefing over ones nobody used", () => {
    const r = rig();
    r.notebook.add(r.pid, "old but read", null);
    for (let i = 0; i < NOTEBOOK_MAX_ENTRIES - 1; i++) r.notebook.add(r.pid, `filler ${i}`, null);
    r.notebook.forBriefing(r.pid); // everything read now...
    r.notebook.add(r.pid, "old but read", null); // ...and this one read again last
    r.notebook.add(r.pid, "brand new", null);
    const texts = r.notebook.view(r.pid).entries.map((e) => e.text);
    expect(texts).toHaveLength(NOTEBOOK_MAX_ENTRIES);
    expect(texts).toContain("old but read");
    expect(texts).toContain("brand new");
    expect(texts).not.toContain("filler 0");
  });

  it("keeps under the character cap too", () => {
    const r = rig();
    for (let i = 0; i < 30; i++) r.notebook.add(r.pid, `${i} ${"x".repeat(290)}`, null);
    const total = r.notebook.view(r.pid).entries.reduce((n, e) => n + e.text.length, 0);
    expect(total).toBeLessThanOrEqual(NOTEBOOK_MAX_CHARS);
    expect(r.notebook.view(r.pid).entries.at(-1)!.text.startsWith("29 ")).toBe(true);
  });

  it("is per pond", () => {
    const r = rig();
    const other = r.store.createProject({ name: "b", rootPath: "/b", defaultBranch: "main", kind: "folder" });
    r.notebook.add(r.pid, "mine", null);
    expect(r.notebook.view(other.id).entries).toEqual([]);
  });
});

describe("note_to_notebook: Task end only", () => {
  it("refuses a chat that holds no Task from the Room", async () => {
    const r = rig();
    const { s } = r.duck("Pip");
    await expect(note(r, s.id, { lesson: "x", taskDone: true })).rejects.toThrow(/end of a task/);
    expect(r.notebook.view(r.pid).entries).toEqual([]);
  });

  it("refuses mid-Task (taskDone not true) and accepts once the Duck says it is finishing", async () => {
    const r = rig();
    const pip = await r.working("Pip");
    await expect(note(r, pip.s.id, { lesson: "Mind the cache.", taskDone: false })).rejects.toBeInstanceOf(ToolError);
    await expect(note(r, pip.s.id, { lesson: "Mind the cache." })).rejects.toThrow(/finishing/);
    expect(r.notebook.view(r.pid).entries).toEqual([]);
    await expect(note(r, pip.s.id, { lesson: "Mind the cache.", taskDone: true })).resolves.toMatch(/Added/);
    expect(r.notebook.view(r.pid).entries[0]).toMatchObject({ text: "Mind the cache.", by: "Pip" });
  });

  it("allows a few lessons per Task, then says that is enough", async () => {
    const r = rig();
    const pip = await r.working("Pip");
    for (let i = 0; i < NOTEBOOK_PER_TASK; i++) {
      await note(r, pip.s.id, { lesson: `lesson ${i}`, taskDone: true });
    }
    await expect(note(r, pip.s.id, { lesson: "one more", taskDone: true })).rejects.toThrow(/enough/);
    expect(r.notebook.view(r.pid).entries).toHaveLength(NOTEBOOK_PER_TASK);
  });

  it("refuses after the Task has ended", async () => {
    const r = rig();
    const pip = await r.working("Pip");
    const row = r.store.roomJobRows(r.pid)[0]!;
    const task = JSON.parse(row.data);
    task.state = "done";
    r.store.saveRoomTask({
      id: task.id,
      projectId: r.pid,
      messageId: task.messageId,
      data: JSON.stringify(task),
      updatedAt: task.updatedAt + 1,
    });
    await expect(note(r, pip.s.id, { lesson: "late", taskDone: true })).rejects.toThrow(/end of a task/);
  });
});

describe("the briefing and the owner", () => {
  it("every new Duck's briefing carries the Notebook", async () => {
    const r = rig();
    r.notebook.add(r.pid, "Run npm run ci before pushing.", "Pip");
    const sage = r.duck("Sage");
    const ask = r.room.personPost(r.pid, "tidy the footer");
    const task = r.jobs.fromMessage(r.pid, ask.id);
    const text = r.jobs.briefingOf(r.pid, task, sage.d);
    expect(text).toContain("Pond Notebook");
    expect(text).toContain("- Run npm run ci before pushing.");
    expect(text).toMatch(/note_to_notebook/);
    expect(text).toMatch(/will last/);
  });

  it("the owner replaces the list: order kept, unchanged lines keep history, edits are the owner's", () => {
    const r = rig();
    r.notebook.add(r.pid, "keep me", "Pip");
    r.notebook.add(r.pid, "fix me", "Pip");
    const kept = r.notebook.view(r.pid).entries[0]!;
    const view = r.notebook.replace(r.pid, ["new first", "keep me", "fixed it"]);
    expect(view.entries.map((e) => e.text)).toEqual(["new first", "keep me", "fixed it"]);
    expect(view.entries[1]).toMatchObject({ id: kept.id, by: "Pip" });
    expect(view.entries[0]!.by).toBe("owner");
    expect(r.notebook.replace(r.pid, []).entries).toEqual([]);
  });

  it("refuses an edit over the caps instead of trimming it", () => {
    const r = rig();
    expect(() =>
      r.notebook.replace(
        r.pid,
        Array.from({ length: NOTEBOOK_MAX_ENTRIES + 1 }, (_, i) => `l${i}`),
      ),
    ).toThrow(/at most/);
    expect(() => r.notebook.replace(r.pid, "nope")).toThrow(NotebookError);
    expect(() =>
      r.notebook.replace(
        r.pid,
        Array.from({ length: 25 }, (_, i) => `${i}${"y".repeat(290)}`),
      ),
    ).toThrow(/characters/);
  });
});

describe("migration of per-duck notebooks", () => {
  it("moves each duck's lines into its pond's Notebook once and clears them", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pond-notebook-mig-"));
    const file = path.join(dir, "native.db");
    const old = new NativeStore(file);
    const p = old.createProject({ name: "a", rootPath: "/a", defaultBranch: "main", kind: "folder" });
    const q = old.createProject({ name: "b", rootPath: "/b", defaultBranch: "main", kind: "folder" });
    const d1 = old.createDuck({ projectId: p.id, name: "Pip" });
    const d2 = old.createDuck({ projectId: p.id, name: "Sage" });
    const d3 = old.createDuck({ projectId: q.id, name: "Wren" });
    old.updateDuck(d1.id, { notebook: "- 2026-11-01 fix bar -> Fixed it.\n- 2026-11-02 add tests -> Done." });
    old.updateDuck(d2.id, { notebook: "- 2026-11-01 fix bar -> Fixed it." });
    old.updateDuck(d3.id, { notebook: "- 2026-11-03 other" });
    old.close();
    for (let pass = 0; pass < 2; pass++) {
      const store = new NativeStore(file);
      expect(store.notebookEntries(p.id).map((e) => e.text)).toEqual([
        "2026-11-01 fix bar -> Fixed it.",
        "2026-11-02 add tests -> Done.",
      ]);
      expect(store.notebookEntries(q.id).map((e) => e.text)).toEqual(["2026-11-03 other"]);
      expect(store.duckRow(d1.id)!.notebook).toBe("");
      expect(store.duckRow(d3.id)!.notebook).toBe("");
      store.close();
    }
  });

  it("trims an over-long migrated notebook to the caps", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pond-notebook-mig-"));
    const file = path.join(dir, "native.db");
    const old = new NativeStore(file);
    const p = old.createProject({ name: "a", rootPath: "/a", defaultBranch: "main", kind: "folder" });
    const d = old.createDuck({ projectId: p.id, name: "Pip" });
    old.updateDuck(d.id, { notebook: Array.from({ length: 80 }, (_, i) => `- job ${i}`).join("\n") });
    old.close();
    const store = new NativeStore(file);
    const texts = store.notebookEntries(p.id).map((e) => e.text);
    expect(texts).toHaveLength(NOTEBOOK_MAX_ENTRIES);
    expect(texts).toContain("job 79");
    expect(texts).not.toContain("job 0");
    store.close();
  });
});

describe("the Notebook route", () => {
  it("serves and edits the Notebook, token-gated with no CORS header", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pond-notebook-srv-"));
    const store = new NativeStore(":memory:");
    const host = new SessionHost({ store } as never);
    const tokenPath = path.join(dir, "hook-token");
    const srv = new NativeServer({
      host,
      store,
      workspaces: new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") }),
      tokenPath,
      port: 0,
      heartbeatMs: 40,
    });
    const port = await srv.start();
    try {
      const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
      const url = `http://127.0.0.1:${port}/native/projects/${project.id}/notebook`;
      const token = fs.readFileSync(tokenPath, "utf8").trim();
      const headers = { "x-squeak-token": token, "content-type": "application/json" };
      expect((await fetch(url)).status).toBe(401);
      const empty = await fetch(url, { headers });
      expect(empty.headers.get("access-control-allow-origin")).toBeNull();
      expect(await empty.json()).toMatchObject({ entries: [], maxEntries: NOTEBOOK_MAX_ENTRIES });
      const put = await fetch(url, {
        method: "PUT",
        headers,
        body: JSON.stringify({ entries: ["a lesson", "another"] }),
      });
      expect(put.status).toBe(200);
      const got = (await (await fetch(url, { headers })).json()) as { entries: Array<{ text: string }> };
      expect(got.entries.map((e) => e.text)).toEqual(["a lesson", "another"]);
      const bad = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ entries: "nope" }) });
      expect(bad.status).toBe(400);
      expect((await fetch(url.replace(project.id, "nope"), { headers })).status).toBe(404);
    } finally {
      await srv.stop();
      await host.stop();
    }
  });
});
