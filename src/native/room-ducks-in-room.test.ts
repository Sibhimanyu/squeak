import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentTools, handleMcpMessage } from "./agent-tools.js";
import { Room, mentions, toRoomPost } from "./room.js";
import { RoomSummariser } from "./room-summary.js";
import { RoomTasks } from "./room-tasks.js";
import { NativeStore } from "./store.js";
import { TimelineLog } from "./timeline-log.js";
import type { SessionRow } from "./types.js";

/** Ducks in the Room: briefing on take, state-change posts, plan cards, solo silence, waking. */

function rig(opts: { members?: number; notebook?: string } = {}) {
  const store = new NativeStore(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ducks-room-"));
  const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
  const delivered: Array<{ id: string; text: string }> = [];
  let members = opts.members ?? 0;
  const room = new Room({
    store,
    ownerName: () => "Sam",
    members: () => members,
    deliver: async (id, text) => void delivered.push({ id, text }),
  });
  const chat = (title: string): SessionRow =>
    store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default", title });
  const duck = (name: string, working = false) => {
    const s = chat(name);
    const d = store.createDuck({ projectId: project.id, name });
    store.attachSessionToDuck(d.id, s.id);
    if (working) store.setStatus(s.id, "working");
    return { s, d: store.duckRow(d.id)! };
  };
  const sent: Array<{ id: string; text: string }> = [];
  const jobs = new RoomTasks({
    store,
    room,
    settings: () => ({ askBeforeStarting: true, maxWorkingDucks: 4 }),
    send: async (id, text) => void sent.push({ id, text }),
    newThread: async (_p, _t, title) => chat(title),
    ...(opts.notebook ? { notebook: () => opts.notebook } : {}),
  });
  return {
    store,
    project,
    room,
    jobs,
    chat,
    duck,
    delivered,
    sent,
    pid: project.id,
    setMembers: (n: number) => (members = n),
  };
}

const toolsOf = (r: ReturnType<typeof rig>): AgentTools =>
  new AgentTools({
    store: r.store,
    room: r.room,
    send: async () => ({ queued: false }),
    create: async () => {
      throw new Error("unused");
    },
    post: () => {},
  } as never);

describe("catch-up briefing", () => {
  it("carries the Task, its discussion, the previous Duck's hand-off note and the Notebook hook", () => {
    const r = rig({ members: 1, notebook: "Run npm run ci before pushing." });
    const pip = r.duck("Pip", true);
    const sage = r.duck("Sage");
    r.room.personPost(r.pid, "the settings page is ugly");
    const ask = r.room.personPost(r.pid, "please redo the settings page");
    r.room.agentPost(pip.s, {
      kind: "handoff",
      text: "@Sage settings layout is half done",
      detail: "Grid is in settings.tsx; the header still needs work.",
      toSessionId: sage.s.id,
    });
    const task = r.jobs.fromMessage(r.pid, ask.id);
    const text = r.jobs.briefingOf(r.pid, task, sage.d);
    expect(text.split("\n")[0]).toBe(task.text);
    expect(text).toContain("the settings page is ugly");
    expect(text).toContain("Hand-off note from Pip");
    expect(text).toContain("Grid is in settings.tsx");
    expect(text).toContain("Pond Notebook");
    expect(text).toContain("Run npm run ci before pushing.");
    expect(text).toMatch(/spec and plan card/);
    expect(text).toMatch(/never post once per turn/i);
  });

  it("has no hand-off or Notebook section when there is none, and tells a solo Duck to skip status lines", () => {
    const r = rig();
    const sage = r.duck("Sage");
    const ask = r.room.personPost(r.pid, "please redo the settings page");
    const task = r.jobs.fromMessage(r.pid, ask.id);
    const text = r.jobs.briefingOf(r.pid, task, sage.d);
    expect(text).not.toContain("Hand-off note");
    expect(text).not.toContain("Pond Notebook");
    expect(text).toMatch(/skip Room status lines/);
    r.setMembers(1);
    expect(r.jobs.briefingOf(r.pid, task, sage.d)).toMatch(/Post one short line/);
  });

  it("is what a Duck is sent when it takes the Task", async () => {
    const r = rig();
    const sage = r.duck("Sage");
    const ask = r.room.personPost(r.pid, "please redo the settings page");
    const task = r.jobs.fromMessage(r.pid, ask.id);
    await r.jobs.act(r.pid, task.id, { action: "go", duckId: sage.d.id });
    expect(r.sent[0]!.text).toContain("How to work this task:");
    expect(r.sent[0]!.text.startsWith(task.text)).toBe(true);
  });
});

describe("state-change lines", () => {
  it("keeps detail beside a one-line status and refuses it on a plain message", () => {
    const r = rig({ members: 1 });
    const a = r.duck("Pip").s;
    const row = r.room.agentPost(a, {
      kind: "done",
      text: "Settings redone",
      detail: "Moved to a grid.\nTests added.",
    })!;
    expect(toRoomPost(row)).toMatchObject({
      kind: "done",
      text: "Settings redone",
      detail: "Moved to a grid.\nTests added.",
    });
    expect(() => r.room.agentPost(a, { kind: "message", text: "hi", detail: "no" })).toThrow(/no detail/);
    expect(() => r.room.agentPost(a, { kind: "done", text: "x", detail: "y".repeat(4001) })).toThrow(/4000/);
  });

  it("posts a second working or done line in one turn once only", () => {
    const r = rig({ members: 1 });
    const a = r.duck("Pip", true).s;
    new TimelineLog(r.store.db).append(a.id, {
      type: "turn.started",
      turnId: "t1",
      promptMessageId: "m",
      text: "go",
      at: new Date().toISOString(),
    } as never);
    expect(r.room.agentPost(a, { kind: "working", text: "Taking it" })).not.toBeNull();
    expect(r.room.agentPost(a, { kind: "working", text: "Still on it" })).toBeNull();
    // A blocked line is a state change of its own and always goes through.
    expect(r.room.agentPost(a, { kind: "needs", text: "Need a key" })).not.toBeNull();
    expect(r.store.roomPosts(r.pid, { limit: 10 }).map((p) => p.text)).toEqual(["Taking it", "Need a key"]);
  });

  it("shows Duck-to-Duck copies on the agents level", async () => {
    const r = rig({ members: 1 });
    const a = r.duck("Pip").s;
    const b = r.duck("Sage").s;
    r.room.agentPost(a, { kind: "message", level: "agents", text: "ping", toSessionId: b.id });
    expect(r.store.roomPosts(r.pid, { limit: 5 })[0]).toMatchObject({ level: "agents", toSessionId: b.id });
  });
});

describe("spec+plan card and its comments", () => {
  it("is a plan post with the spec as detail; a comment reaches that Duck, and nobody else", async () => {
    const r = rig({ members: 1 });
    const pip = r.duck("Pip");
    const sage = r.duck("Sage");
    const card = r.room.agentPost(pip.s, { kind: "plan", text: "Redo settings", detail: "1. Grid\n2. Tests" })!;
    expect(card.kind).toBe("plan");
    const c = r.room.personPost(r.pid, "please keep the old header", "room", undefined, card.id);
    expect(c.replyTo).toBe(card.id);
    expect(toRoomPost(c).replyTo).toBe(card.id);
    expect(r.delivered).toHaveLength(1);
    expect(r.delivered[0]!.id).toBe(pip.s.id);
    expect(r.delivered[0]!.text).toContain("please keep the old header");
    expect(r.delivered.some((d) => d.id === sage.s.id)).toBe(false);
  });

  it("refuses a comment on something that is not a card, or from a Duck", () => {
    const r = rig({ members: 1 });
    const pip = r.duck("Pip");
    const done = r.room.agentPost(pip.s, { kind: "done", text: "Done" })!;
    expect(() => r.room.personPost(r.pid, "hm", "room", undefined, done.id)).toThrow(/card/);
    const card = r.room.agentPost(pip.s, { kind: "plan", text: "Plan" })!;
    expect(() =>
      r.room.post({
        projectId: r.pid,
        author: { kind: "agent", name: "x" },
        kind: "message",
        text: "y",
        replyTo: card.id,
      }),
    ).toThrow(/person/);
  });

  it("is posted through post_to_room with kind plan and detail", async () => {
    const r = rig({ members: 1 });
    const pip = r.duck("Pip").s;
    const out = await handleMcpMessage(toolsOf(r), pip.id, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "post_to_room", arguments: { kind: "plan", text: "Redo settings", detail: "Spec and plan" } },
    });
    expect(JSON.stringify(out)).toContain("Posted to the room");
    expect(r.store.roomPosts(r.pid, { limit: 5 })[0]).toMatchObject({ kind: "plan", detail: "Spec and plan" });
  });
});

describe("solo Pond silence", () => {
  it("drops status lines while the pond is not shared and one Duck works, and says so to the Duck", async () => {
    const r = rig();
    const pip = r.duck("Pip", true).s;
    expect(r.room.quietFor(r.pid)).toBe(true);
    expect(r.room.agentPost(pip, { kind: "working", text: "Taking it" })).toBeNull();
    expect(r.room.agentPost(pip, { kind: "done", text: "Done" })).toBeNull();
    expect(r.store.roomPosts(r.pid, { limit: 5 })).toHaveLength(0);
    // Needing the person still posts.
    expect(r.room.agentPost(pip, { kind: "needs", text: "Stuck" })).not.toBeNull();
    const out = await handleMcpMessage(toolsOf(r), pip.id, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "post_to_room", arguments: { kind: "working", text: "Again" } },
    });
    expect(JSON.stringify(out)).toContain("Not posted");
  });

  it("speaks as soon as the pond is shared or a second Duck works", () => {
    const r = rig();
    const pip = r.duck("Pip", true).s;
    r.setMembers(1);
    expect(r.room.agentPost(pip, { kind: "working", text: "Shared now" })).not.toBeNull();
    r.setMembers(0);
    expect(r.room.quietFor(r.pid)).toBe(true);
    r.duck("Sage", true);
    expect(r.room.quietFor(r.pid)).toBe(false);
    expect(r.room.agentPost(pip, { kind: "done", text: "Two ducks" })).not.toBeNull();
  });
});

describe("waking", () => {
  it("wakes a Duck on its @mention only, not on chatting", () => {
    const r = rig({ members: 1 });
    r.duck("Pip");
    const sage = r.duck("Sage");
    r.room.personPost(r.pid, "morning everyone, anyone seen the build?");
    expect(r.delivered).toHaveLength(0);
    r.room.personPost(r.pid, "@Sage can you look at the build?");
    expect(r.delivered).toHaveLength(1);
    expect(r.delivered[0]).toMatchObject({ id: sage.s.id });
    expect(r.delivered[0]!.text).toContain("can you look at the build");
  });

  it("wakes on a Duck's @mention in the agents level, never itself, and never an off-duty Duck", () => {
    const r = rig({ members: 1 });
    const pip = r.duck("Pip");
    const sage = r.duck("Sage");
    const mina = r.duck("Mina");
    r.store.updateDuck(mina.d.id, { duty: "off" } as never);
    r.room.agentPost(pip.s, {
      kind: "message",
      level: "agents",
      text: "@Sage @Mina @Pip the API changed",
    });
    expect(r.delivered.map((d) => d.id)).toEqual([sage.s.id]);
  });

  it("matches whole names, case-insensitively", () => {
    expect(mentions("hi @pip!", "Pip")).toBe(true);
    expect(mentions("hi @Pipette", "Pip")).toBe(false);
    expect(mentions("mail a@pip.io", "Pip")).toBe(false);
    expect(mentions("@Duck 2 go", "Duck 2")).toBe(true);
  });

  it("wakes the Duck when its working Task is dropped", async () => {
    const r = rig();
    const sage = r.duck("Sage");
    const ask = r.room.personPost(r.pid, "please redo the settings page");
    const task = r.jobs.fromMessage(r.pid, ask.id);
    await r.jobs.act(r.pid, task.id, { action: "go", duckId: sage.d.id });
    r.sent.length = 0;
    await r.jobs.act(r.pid, task.id, { action: "drop" });
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.id).toBe(sage.s.id);
    expect(r.sent[0]!.text).toContain("was dropped");
  });
});

describe("working summaries", () => {
  it("post nothing in a solo pond", async () => {
    const r = rig();
    const s = r.duck("Uploader", true).s;
    const host = new EventEmitter();
    let calls = 0;
    const sum = new RoomSummariser({
      host: host as never,
      store: r.store,
      room: r.room,
      enabled: () => true,
      call: async () => {
        calls++;
        return "Wiring retry";
      },
    });
    sum.start();
    r.room.markViewed(r.pid);
    const ev = (event: unknown) => host.emit("event", { type: "timeline", sessionId: s.id, event });
    ev({ type: "turn.started", seq: 0, turnId: "t", promptMessageId: "m", text: "go", at: "" });
    for (let i = 0; i < 4; i++) {
      ev({
        type: "step.added",
        seq: i,
        turnId: "t",
        stepId: `s${i}`,
        kind: "tool",
        label: `step ${i}`,
        status: "done",
        at: "",
      });
    }
    await sum.idle();
    expect(calls).toBe(0);
    expect(r.store.roomPosts(r.pid, { limit: 5 })).toHaveLength(0);
    sum.stop();
  });
});
