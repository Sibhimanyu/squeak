/* eslint-disable @typescript-eslint/no-explicit-any -- JSON replies are read loosely in tests */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appendNotebook, NOTEBOOK_MAX, notebookLine } from "./duck-notebook.js";
import { SessionHost } from "./host.js";
import { Room } from "./room.js";
import { JobError, RoomJobs, type StartSpec } from "./room-jobs.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import { buildThreadContext } from "./thread-context.js";
import { TimelineLog } from "./timeline-log.js";
import type { SessionRow } from "./types.js";
import { WorkspaceManager } from "./workspaces.js";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

const iso = (minAgo: number): string => new Date(Date.now() - minAgo * 60_000).toISOString();

function gitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ducks-git-"));
  const run = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  run("init", "-b", "main");
  run("config", "user.email", "t@t");
  run("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "a");
  run("add", ".");
  run("commit", "-m", "init");
  return dir;
}

async function rig(kind: "git" | "folder" = "git") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ducks-pond-"));
  const store = new NativeStore(":memory:");
  const host = new SessionHost({ store } as any);
  const tokenPath = path.join(dir, "hook-token");
  const workspaces = new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") });
  const room = new Room({ store, ownerName: () => "Sam" });
  const started: StartSpec[] = [];
  const sent: Array<{ id: string; text: string }> = [];
  let srvRef: NativeServer | null = null;
  const jobs = new RoomJobs({
    store,
    room,
    send: async (id, text) => void sent.push({ id, text }),
    newThread: async () => {
      throw new Error("unused");
    },
    // The real stream creation, minus the agent: a session in the stream (or Main) mapped to the duck.
    start: async (spec) => {
      started.push(spec);
      const project = store.getProject(spec.projectId)!;
      let cwd = project.rootPath;
      let workspaceId: string | null = null;
      if (spec.place?.kind === "stream") {
        workspaceId = spec.place.workspaceId;
        cwd = store.getWorkspace(workspaceId)!.path;
      } else if (spec.place?.kind === "new") {
        const ws = workspaces.createWorkspace(project.id, undefined, undefined, spec.place.branch, spec.title);
        workspaceId = ws.id;
        cwd = ws.path;
      }
      const s = store.createSession({
        cwd,
        agent: "claude",
        model: "m",
        permissionMode: "default",
        title: spec.title,
        workspaceId,
      });
      store.attachSessionToDuck(spec.duck.id, s.id);
      return s;
    },
    newBranch: (p, t) => srvRef!.newStreamBranch(p, t),
    checkBranch: (p, b) => srvRef!.checkStreamBranch(p, b),
    call: async () => '{"job":false,"text":""}',
  });
  const srv = new NativeServer({ host, store, workspaces, tokenPath, port: 0, heartbeatMs: 40, room, jobs });
  srvRef = srv;
  const port = await srv.start();
  open.push(async () => {
    await srv.stop();
    await host.stop();
  });
  const root = kind === "git" ? gitRepo() : fs.mkdtempSync(path.join(os.tmpdir(), "ducks-folder-"));
  const project = store.createProject({ name: "app", rootPath: root, defaultBranch: "main", kind });
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  const call = (method: string, url: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { "x-squeak-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const stream = (name: string) => workspaces.createWorkspace(project.id, undefined, undefined, `sq/${name}`, name);
  const chatIn = (title: string, ws?: { id: string; path: string }): SessionRow =>
    store.createSession({
      cwd: ws?.path ?? root,
      agent: "claude",
      model: "m",
      permissionMode: "default",
      title,
      ...(ws ? { workspaceId: ws.id } : {}),
    });
  const log = new TimelineLog(store.db);
  const turn = (s: SessionRow, id: string, text: string, minAgo: number, reply?: string) => {
    log.append(s.id, {
      type: "turn.started",
      turnId: id,
      promptMessageId: "m",
      room: true,
      text,
      at: iso(minAgo),
    } as any);
    if (reply) {
      log.append(s.id, { type: "reply.done", turnId: id, messageId: `r-${id}`, text: reply, at: iso(minAgo) } as any);
      log.append(s.id, { type: "turn.ended", turnId: id, outcome: "done", at: iso(minAgo) } as any);
    }
  };
  const job = (text: string) => jobs.fromMessage(project.id, room.personPost(project.id, text).id);
  const act = (id: string, body: Record<string, unknown>) => jobs.act(project.id, id, body);
  const code = (p: Promise<unknown>) =>
    p.then(
      () => 0,
      (e) => (e instanceof JobError ? e.status : -1),
    );
  return { store, srv, room, jobs, project, call, stream, chatIn, turn, job, act, code, started, sent, log };
}

describe("duck migration", () => {
  it("makes one duck per session, keeps the colour seed and the old name, and is idempotent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ducks-mig-"));
    const store = new NativeStore(":memory:");
    const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
    const mk = (title: string) =>
      store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default", title });
    const a = mk("Layout builder");
    const b = mk("Other");
    store.duckOf(a.id); // creates the tables
    store.db
      .prepare("INSERT INTO session_ducks (session_id, name, role, duty) VALUES (?,?,?,?)")
      .run(a.id, "Pip", "layout", "off");
    new Room({ store });
    new Room({ store });
    const ducks = store.listDucks(project.id);
    expect(ducks).toHaveLength(2);
    const da = store.duckBySession(a.id)!;
    expect(da).toMatchObject({ name: "Pip", role: "layout", duty: "off", colourSeed: a.id, currentSessionId: a.id });
    expect(store.duckBySession(b.id)).toMatchObject({ name: null, colourSeed: b.id });
    expect(store.duckOf(a.id)).toEqual({ name: "Pip", role: "layout", duty: "off" });
    expect(store.offDutyIds().has(a.id)).toBe(true);
  });
});

describe("one-time stale duck cleanup", () => {
  it("puts ducks quiet for over a day off duty once, keeps recent and working ones on", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ducks-stale-"));
    const store = new NativeStore(":memory:");
    store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
    const mk = (title: string) =>
      store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default", title });
    const old = mk("Old");
    const recent = mk("Recent");
    const busy = mk("Busy");
    const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    store.db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(ago(30), old.id);
    store.db.prepare("UPDATE sessions SET updated_at=? WHERE id=?").run(ago(2), recent.id);
    store.db.prepare("UPDATE sessions SET updated_at=?, status='working' WHERE id=?").run(ago(48), busy.id);
    const room = new Room({ store });
    expect(room.retireStaleDucksOnce()).toBe(1);
    expect(store.duckBySession(old.id)!.duty).toBe("off");
    expect(store.duckBySession(recent.id)!.duty).toBe("on");
    expect(store.duckBySession(busy.id)!.duty).toBe("on");
    // Once only: a duck brought back stays on.
    store.updateDuck(store.duckBySession(old.id)!.id, { duty: "on" });
    expect(new Room({ store }).retireStaleDucksOnce()).toBe(0);
    expect(store.duckBySession(old.id)!.duty).toBe("on");
  });
});

describe("identity-only ducks and routes", () => {
  it("POST makes a duck with no session; GET lists it with no place; it shows in the room threads", async () => {
    const h = await rig("folder");
    const res = await h.call("POST", `/native/projects/${h.project.id}/ducks`, { name: "Pip", role: "layout" });
    expect(res.status).toBe(201);
    const { duck } = (await res.json()) as any;
    expect(duck).toMatchObject({ name: "Pip", role: "layout", state: "idle", sessions: 0, duty: "on", notebook: "" });
    expect(duck.currentSessionId).toBeUndefined();
    expect(duck.place).toBeUndefined();
    expect(duck.colourSeed).toBe(duck.id);
    const list = (await (await h.call("GET", `/native/projects/${h.project.id}/ducks`)).json()) as any;
    expect(list.ducks.map((d: any) => d.id)).toEqual([duck.id]);
    expect(h.room.threads(h.project.id)[0]).toMatchObject({
      duckId: duck.id,
      name: "Pip",
      sessionId: "",
      state: "idle",
    });
  });

  it("is strict: unknown keys, a missing or long name, bad types are 400; unknown ids 404", async () => {
    const h = await rig("folder");
    const url = `/native/projects/${h.project.id}/ducks`;
    expect((await h.call("POST", url, { name: "Pip", extra: 1 })).status).toBe(400);
    expect((await h.call("POST", url, { role: "x" })).status).toBe(400);
    expect((await h.call("POST", url, { name: "x".repeat(33) })).status).toBe(400);
    expect((await h.call("POST", url, { name: "Pip", role: 5 })).status).toBe(400);
    expect((await h.call("POST", "/native/projects/nope/ducks", { name: "Pip" })).status).toBe(404);
    const { duck } = (await (await h.call("POST", url, { name: "Pip" })).json()) as any;
    expect((await h.call("PATCH", `/native/ducks/${duck.id}`, {})).status).toBe(400);
    expect((await h.call("PATCH", `/native/ducks/${duck.id}`, { nope: 1 })).status).toBe(400);
    expect((await h.call("PATCH", `/native/ducks/nope`, { name: "x" })).status).toBe(404);
    const patched = (await (
      await h.call("PATCH", `/native/ducks/${duck.id}`, { name: "Quill", role: "tests" })
    ).json()) as any;
    expect(patched.duck).toMatchObject({ name: "Quill", role: "tests" });
    expect((await h.call("POST", `/native/ducks/${duck.id}/duty`, { on: "no" })).status).toBe(400);
    const off = (await (await h.call("POST", `/native/ducks/${duck.id}/duty`, { on: false })).json()) as any;
    expect(off).toMatchObject({ duty: "off", duck: { duty: "off" } });
  });

  it("the session routes resolve the session's duck", async () => {
    const h = await rig("folder");
    const s = h.chatIn("Layout builder");
    await h.call("PATCH", `/native/sessions/${s.id}/duck`, { name: "Pip" });
    await h.call("POST", `/native/sessions/${s.id}/duty`, { on: false });
    const duck = h.store.duckBySession(s.id)!;
    expect(duck).toMatchObject({ name: "Pip", duty: "off" });
    const list = (await (await h.call("GET", `/native/projects/${h.project.id}/ducks`)).json()) as any;
    expect(list.ducks[0]).toMatchObject({ id: duck.id, currentSessionId: s.id, sessions: 1, duty: "off" });
  });

  it("an off-duty duck is never a candidate, even with no session", async () => {
    const h = await rig("folder");
    const { duck } = (await (
      await h.call("POST", `/native/projects/${h.project.id}/ducks`, { name: "Pip", role: "webcam layout builder" })
    ).json()) as any;
    expect(h.jobs.rank(h.project.id, "fix webcam layout builder")).toHaveLength(1);
    h.room.setDutyById(duck.id, false);
    expect(h.jobs.rank(h.project.id, "fix webcam layout builder")).toEqual([]);
  });
});

describe("place and go", () => {
  it("a strong match with the duck's stream continues there; anything else is a new stream off main", async () => {
    const h = await rig();
    const ws = h.stream("control-bar");
    const s = h.chatIn("Control bar", ws);
    h.turn(s, "t1", "tweak the control bar spacing", 30, "Adjusted the control bar spacing.");
    const strong = h.job("fix the control bar spacing");
    expect(strong.suggestion).toMatchObject({ sessionId: s.id });
    expect(strong.place).toEqual({ kind: "stream", workspaceId: ws.id, branch: ws.branch });
    // One shared word: suggested (title) but not strong enough to stay in that stream.
    const weak = h.job("add a control to export settings");
    expect(weak.place?.kind).toBe("new");
    expect((weak.place as any).branch).toMatch(/^[\w./-]*add-a-control-to-export-settings$/);
    // Nothing matches: a new stream, no suggestion.
    const none = h.job("translate the onboarding strings");
    expect(none.suggestion).toBeUndefined();
    expect(none.place).toMatchObject({ kind: "new" });
  });

  it("go on the same stream sends the next turn to the duck's session", async () => {
    const h = await rig();
    const ws = h.stream("control-bar");
    const s = h.chatIn("Control bar", ws);
    h.turn(s, "t1", "tweak the control bar spacing", 30, "Adjusted the control bar spacing.");
    const j = h.job("fix the control bar spacing");
    const done = await h.act(j.id, { action: "go" });
    expect(done.handedTo).toMatchObject({ sessionId: s.id, newThread: false });
    expect(h.sent).toEqual([{ id: s.id, text: "fix the control bar spacing" }]);
    expect(h.started).toHaveLength(0);
  });

  it("go with a place elsewhere starts a fresh session there; the old one stays as the duck's history", async () => {
    const h = await rig();
    const ws = h.stream("control-bar");
    const other = h.stream("settings");
    const s = h.chatIn("Control bar", ws);
    h.turn(s, "t1", "tweak the control bar spacing", 30, "Adjusted the control bar spacing.");
    const duck = h.room.duckOfSession(s)!;
    const j = h.job("fix the control bar spacing");
    const done = await h.act(j.id, {
      action: "go",
      place: { kind: "stream", workspaceId: other.id, branch: other.branch },
    });
    expect(done.handedTo).toMatchObject({ newThread: true, duckId: duck.id });
    const child = done.handedTo!.sessionId;
    expect(child).not.toBe(s.id);
    expect(h.started[0]).toMatchObject({ text: "fix the control bar spacing", duck: { id: duck.id } });
    expect(h.sent).toEqual([]);
    const now = h.store.duckRow(duck.id)!;
    expect(now.currentSessionId).toBe(child);
    expect(h.store.duckSessionIds(duck.id)).toEqual(expect.arrayContaining([s.id, child]));
    expect(h.store.getSession(child)!.workspaceId).toBe(other.id);
    // The older session's turns are still the duck's.
    const turns = h.room.turns(h.project.id, 0);
    expect(turns.find((t) => t.sessionId === s.id)?.duckId).toBe(duck.id);
    // One thread per duck, in its new place.
    const threads = h.room.threads(h.project.id).filter((t) => t.duckId === duck.id);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ sessionId: child, place: { workspaceId: other.id } });
  });

  it("go to a new place creates the stream (a worktree on the branch) and a session in it", async () => {
    const h = await rig();
    const s = h.chatIn("Layout builder");
    const j = h.job("polish the webcam overlay");
    expect(j.place).toMatchObject({ kind: "new" });
    const done = await h.act(j.id, {
      action: "go",
      sessionId: s.id,
      place: { kind: "new", branch: "sq/webcam-overlay" },
    });
    const child = h.store.getSession(done.handedTo!.sessionId)!;
    const ws = h.store.getWorkspace(child.workspaceId!)!;
    expect(ws.branch).toBe("sq/webcam-overlay");
    expect(fs.existsSync(ws.path)).toBe(true);
    expect(done.place).toEqual({ kind: "new", branch: "sq/webcam-overlay" });
  });

  it("validates a place override: bad shape 400, taken branch or other pond's stream 409", async () => {
    const h = await rig();
    const s = h.chatIn("Layout builder");
    const j = h.job("polish the webcam overlay");
    const go = (place: unknown) => h.code(h.act(j.id, { action: "go", sessionId: s.id, place }));
    expect(await go("x")).toBe(400);
    expect(await go({ kind: "moon" })).toBe(400);
    expect(await go({ kind: "new", branch: "sq/x", extra: 1 })).toBe(400);
    expect(await go({ kind: "new", branch: "main" })).toBe(409);
    expect(await go({ kind: "new", branch: "bad name" })).toBe(409);
    expect(await go({ kind: "stream", workspaceId: "nope", branch: "x" })).toBe(409);
    expect(await h.code(h.act(j.id, { action: "dismiss", place: { kind: "new", branch: "a" } }))).toBe(400);
    expect(await h.code(h.act(j.id, { action: "go", duckId: "a", sessionId: "b" }))).toBe(400);
  });

  it("go with a duckId, and new with no duck makes one named from the job; a busy duck cannot start elsewhere", async () => {
    const h = await rig();
    const ws = h.stream("control-bar");
    const s = h.chatIn("Control bar", ws);
    const duck = h.room.duckOfSession(s)!;
    const j1 = h.job("polish the webcam overlay");
    const fresh = await h.act(j1.id, { action: "new" });
    const made = h.store.duckBySession(fresh.handedTo!.sessionId)!;
    expect(made.id).not.toBe(duck.id);
    expect(made.name).toBeTruthy();
    expect(made.colourSeed).toBe(made.id);
    expect(fresh.handedTo!.newThread).toBe(true);
    expect(h.store.getSession(fresh.handedTo!.sessionId)!.workspaceId).toBeTruthy();
    // A working duck can't be sent to a stream other than its own.
    h.store.db.prepare("UPDATE sessions SET status='working' WHERE id=?").run(s.id);
    const j2 = h.job("rename the settings panel labels");
    expect(
      await h.code(h.act(j2.id, { action: "go", duckId: duck.id, place: { kind: "new", branch: "sq/labels" } })),
    ).toBe(409);
    // In its own stream it queues, as today.
    const ok = await h.act(j2.id, {
      action: "go",
      duckId: duck.id,
      place: { kind: "stream", workspaceId: ws.id, branch: ws.branch },
    });
    expect(ok.handedTo).toMatchObject({ sessionId: s.id, newThread: false });
  });

  it("a plain-folder pond has no places: the job carries none and a new duck runs in the folder", async () => {
    const h = await rig("folder");
    const j = h.job("polish the webcam overlay");
    expect(j.place).toBeUndefined();
    const done = await h.act(j.id, { action: "new" });
    expect(h.store.getSession(done.handedTo!.sessionId)!.workspaceId).toBeNull();
    expect(
      await h.code(h.act(h.job("tidy the footer links").id, { action: "go", place: { kind: "new", branch: "x" } })),
    ).toBe(409);
  });
});

describe("notebook", () => {
  it("lines are compact and the notebook keeps its newest lines under the cap", () => {
    const line = notebookLine({
      at: Date.UTC(2026, 10, 17),
      job: "Fix the bar",
      outcome: "Fixed it.",
      branch: "sq/bar",
    });
    expect(line).toBe("- 2026-11-17 Fix the bar -> Fixed it. [sq/bar]");
    let nb = "";
    for (let i = 0; i < 80; i++)
      nb = appendNotebook(nb, notebookLine({ at: 0, job: `job ${i}`, outcome: "x".repeat(150) }));
    expect(nb.length).toBeLessThanOrEqual(NOTEBOOK_MAX);
    expect(nb).toContain("job 79");
    expect(nb).not.toContain("job 0 ");
    expect(appendNotebook("", "y".repeat(5000)).length).toBe(NOTEBOOK_MAX);
  });

  it("a turn ending writes the duck's notebook; the next agent note carries it", async () => {
    const h = await rig();
    const ws = h.stream("control-bar");
    const s = h.chatIn("Control bar", ws);
    h.room.setDuck(s.id, { name: "Pip", role: "control bar" });
    h.turn(s, "t1", "tweak the control bar spacing", 5, "Adjusted the control bar spacing. More detail follows.");
    h.room.noteTimeline(s.id, { type: "turn.ended", turnId: "t1" } as any);
    h.room.noteTimeline(s.id, { type: "turn.ended", turnId: "t1" } as any); // a replay writes nothing
    await h.room.notebookIdle();
    const duck = h.store.duckBySession(s.id)!;
    expect(duck.notebook.split("\n")).toHaveLength(1);
    expect(duck.notebook).toContain("tweak the control bar spacing -> Adjusted the control bar spacing.");
    expect(duck.notebook).toContain(`[${ws.branch}]`);
    const note = buildThreadContext({
      agent: "claude",
      pond: "app",
      cwd: "/x",
      duck: { name: "Pip", role: "control bar", notebook: duck.notebook },
    });
    expect(note).toContain("You are Pip, a duck in app; your role: control bar");
    expect(note).toContain("Your notebook");
    expect(note).toContain("Adjusted the control bar spacing.");
  });

  it("a failing or slow summary falls back to the plain line", async () => {
    const h = await rig();
    const room = new Room({
      store: h.store,
      notebookSummary: async () => {
        throw new Error("offline");
      },
    });
    const s = h.chatIn("Chat");
    const long = "Wired the retry path. " + "More words here. ".repeat(20);
    h.turn(s, "t1", "wire the retry path", 5, long);
    room.noteTimeline(s.id, { type: "turn.ended", turnId: "t1" } as any);
    await room.notebookIdle();
    expect(h.store.duckBySession(s.id)!.notebook).toContain("-> Wired the retry path.");
  });
});
