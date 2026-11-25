import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentTools } from "./agent-tools.js";
import { Room } from "./room.js";
import { RoomTasks, stripMention } from "./room-tasks.js";
import { NativeStore } from "./store.js";
import type { SessionRow } from "./types.js";

/** @mention hand-offs: a person or a Duck gives work straight to a named Duck; an untagged Duck Task is decided. */

function rig(askBeforeStarting = false) {
  const store = new NativeStore(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-"));
  const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
  const woken: Array<{ id: string; text: string }> = [];
  const room = new Room({
    store,
    ownerName: () => "Sam",
    members: () => 1,
    deliver: async (id, text) => void woken.push({ id, text }),
  });
  const chat = (title: string): SessionRow =>
    store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default", title });
  const duck = (name: string) => {
    const s = chat(name);
    const d = store.createDuck({ projectId: project.id, name });
    store.attachSessionToDuck(d.id, s.id);
    return { s, d: store.duckRow(d.id)! };
  };
  const sent: Array<{ id: string; text: string }> = [];
  const hatched: string[] = [];
  const jobs = new RoomTasks({
    store,
    room,
    settings: () => ({ askBeforeStarting, maxWorkingDucks: 4 }),
    send: async (id, text) => void sent.push({ id, text }),
    newThread: async (_p, text, title) => {
      hatched.push(text.split("\n")[0]!);
      return chat(title);
    },
    call: async () => '{"job":false,"text":""}',
  });
  jobs.attach(room as never);
  const tools = new AgentTools({
    store,
    room,
    jobs,
    send: async () => ({ queued: false }),
    create: async () => {
      throw new Error("unused");
    },
    post: () => {},
  } as never);
  return { store, room, jobs, tools, pid: project.id, duck, woken, sent, hatched };
}

describe("a person's @mention gives work straight to that Duck", () => {
  it("makes a Task routed to it (no decider), starts it, and does not also wake it with a second nudge", async () => {
    const r = rig();
    r.duck("Sage");
    const pixel = r.duck("Pixel");
    const post = r.room.personPost(r.pid, "@Pixel fix the login page spacing");
    await r.jobs.idle();
    const [task] = r.jobs.list(r.pid);
    expect(task).toMatchObject({
      messageId: post.id,
      text: "fix the login page spacing",
      state: "working",
      routing: { kind: "duck", duckId: pixel.d.id, name: "Pixel", by: "person" },
      handedTo: { sessionId: pixel.s.id },
    });
    expect(r.sent.map((m) => m.id)).toEqual([pixel.s.id]);
    expect(r.woken).toEqual([]);
  });

  it("waits for Go when the Pond asks first, still routed to the mentioned Duck", async () => {
    const r = rig(true);
    const pixel = r.duck("Pixel");
    r.room.personPost(r.pid, "@Pixel fix the login page spacing");
    await r.jobs.idle();
    expect(r.jobs.list(r.pid)[0]).toMatchObject({ state: "waiting", suggestion: { duckId: pixel.d.id } });
    expect(r.sent).toEqual([]);
  });

  it("leaves a bare ping and a name that is no Duck's as ordinary chat", async () => {
    const r = rig();
    const pixel = r.duck("Pixel");
    r.room.personPost(r.pid, "@Pixel thanks");
    r.room.personPost(r.pid, "@Nobody fix the login page spacing");
    await r.jobs.idle();
    expect(r.jobs.list(r.pid)).toEqual([]);
    // The ping still wakes the Duck the way a mention always did.
    expect(r.woken.map((w) => w.id)).toEqual([pixel.s.id]);
  });

  it("strips the mention from the Task text", () => {
    expect(stripMention("Hey @Duck 2, redo it", "Duck 2")).toBe("Hey redo it");
    expect(stripMention("mail a@pip.io", "Pip")).toBe("mail a@pip.io");
  });
});

describe("a Duck hands work on with hand_off", () => {
  it("with toDuck: a sub-Task of its own Task, routed to that Duck, shown as an @mention in the Room", async () => {
    const r = rig();
    const pip = r.duck("Pip");
    const sage = r.duck("Sage");
    r.room.personPost(r.pid, "@Pip rebuild the settings page now");
    await r.jobs.idle();
    const parent = r.jobs.list(r.pid)[0]!;
    expect(r.jobs.get(parent.id)!.job).toMatchObject({ state: "working", handedTo: { sessionId: pip.s.id } });
    r.sent.length = 0;
    const out = await r.tools.call(pip.s.id, "hand_off", { text: "write the settings tests", toDuck: "sage" });
    expect(out).toContain("Sage");
    await r.jobs.idle();
    const sub = r.jobs.list(r.pid).find((t) => t.parentTaskId)!;
    expect(sub).toMatchObject({
      text: "write the settings tests",
      parentTaskId: parent.id,
      routing: { kind: "duck", duckId: sage.d.id },
      handedTo: { sessionId: sage.s.id },
    });
    const line = r.room.page(r.pid, {}).posts.find((p) => p.text.startsWith("@Sage"))!;
    expect(line).toMatchObject({ text: "@Sage write the settings tests", author: { kind: "agent", name: "Pip" } });
    expect(r.sent.filter((m) => m.id === sage.s.id)).toHaveLength(1);
    expect(r.woken).toEqual([]);
  });

  it("without toDuck: a sub-Task that goes through the decider, which hatches a new Duck for unrelated work", async () => {
    const r = rig();
    const pip = r.duck("Pip");
    const out = await r.tools.call(pip.s.id, "hand_off", { text: "translate the onboarding strings to french" });
    expect(out).toMatch(/Squeak is choosing/);
    await r.jobs.idle();
    const t = r.jobs.list(r.pid)[0]!;
    expect(t).toMatchObject({ routing: { kind: "hatch", by: "decider" }, state: "working" });
    expect(r.hatched).toEqual(["translate the onboarding strings to french"]);
  });

  it("refuses a name that is no Duck's, itself, an off-duty Duck and an empty text", async () => {
    const r = rig();
    const pip = r.duck("Pip");
    const sage = r.duck("Sage");
    r.store.setDuty(sage.s.id, false);
    const bad = (a: Record<string, unknown>) => r.tools.call(pip.s.id, "hand_off", a).catch((e: Error) => e.message);
    expect(await bad({ text: "do it", toDuck: "Ghost" })).toMatch(/No duck named Ghost/);
    expect(await bad({ text: "do it", toDuck: "Pip" })).toMatch(/That is you/);
    expect(await bad({ text: "do it", toDuck: "Sage" })).toMatch(/No duck named Sage/); // Off duty: the name is released
    expect(await bad({ text: " " })).toMatch(/text is required/);
    expect(r.jobs.list(r.pid)).toEqual([]);
  });
});

describe("a Member's @mention without the start permission", () => {
  it("is routed to the mentioned Duck, waits for approval, and does not wake the Duck", async () => {
    const r = rig();
    r.duck("Sage");
    const pixel = r.duck("Pixel");
    r.jobs.withMemberPost("m-1", { memberId: "dev-1", name: "Mira", canStart: false }, () =>
      r.room.post({
        projectId: r.pid,
        id: "m-1",
        author: { kind: "person", id: "dev-1", name: "Mira" },
        kind: "message",
        level: "room",
        text: "@Pixel fix the login page spacing",
      }),
    );
    await r.jobs.idle();
    const [task] = r.jobs.list(r.pid);
    expect(task).toMatchObject({
      state: "waiting",
      approval: { name: "Mira" },
      routing: { kind: "duck", duckId: pixel.d.id, by: "person" },
    });
    expect(r.sent).toEqual([]);
    expect(r.woken).toEqual([]);
    await r.jobs.act(r.pid, task!.id, { action: "approve" });
    await r.jobs.idle();
    expect(r.jobs.list(r.pid)[0]).toMatchObject({ state: "working", handedTo: { sessionId: pixel.s.id } });
  });
});
