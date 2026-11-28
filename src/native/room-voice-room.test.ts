/* eslint-disable @typescript-eslint/no-explicit-any -- timeline events and JSON replies are built loosely in tests */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TOOLS } from "./agent-tools.js";
import { SessionHost } from "./host.js";
import { agentName, Room, RoomError } from "./room.js";
import { FINISH_SYSTEM, writeFinish } from "./room-finish.js";
import { SUMMARY_SYSTEM as HANDOFF_SUMMARY_SYSTEM } from "./room-handoff-summary.js";
import { SUMMARY_SYSTEM as WORKING_SUMMARY_SYSTEM } from "./room-summary.js";
import { askOfRequest } from "./room-turns.js";
import { RULE } from "./room-voice.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import { CODEX_SQUEAK_GUIDE, buildThreadContext } from "./thread-context.js";
import { TimelineLog } from "./timeline-log.js";
import type { Resolution, Runner, RunnerHooks, SessionRow } from "./types.js";
import { WorkspaceManager } from "./workspaces.js";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

// The two real posts a Duck made in the owner's Room.
const POST_ONE =
  "main moved to 831a4d9 with source-of-truth, small-fixes-mute-zoom-remove and meeting-audio-probe merged in; 1,859 tests pass. In CoordinatorController, the meeting-setup rewrite replaced resetPresenceBubbleToLayoutDefault with noteSetupMoment, and the R49.13 video flags now clear there. If your branch touches that code, rebase onto origin/main. Nothing has been released or tried in a live meeting yet.";
const POST_TWO =
  "main is now at a5027cf with two refactors that shouldn't change behaviour. CameraLook (App/Stage/CameraLook.swift) is now the one owner of background, picture, removal and mirror. 1,890 tests pass.";
const PLAIN_ONE =
  "The shared version now has the new meeting setup, the audio check and the small fixes. It is not released and nobody has tried it in a live meeting yet. If you were changing the meeting setup, tell me and I will help you catch up.";

function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "room-voice-"));
  const store = new NativeStore(":memory:");
  const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
  const hooks = new Map<string, RunnerHooks>();
  const sent: { session: string; text: string }[] = [];
  const host = new SessionHost({
    store,
    runnerFactory: (s: SessionRow, h: RunnerHooks): Runner => {
      hooks.set(s.id, h);
      return {
        canSteer: false,
        send: async (t) => {
          sent.push({ session: s.id, text: t });
          h.onStatus("working");
        },
        steer: async () => false,
        interrupt: async () => {},
        setPermissionMode: async () => {},
        close: async () => {},
      };
    },
  });
  const room = new Room({ store, members: () => 1 });
  const chat = (title: string, duckName?: string): SessionRow => {
    const s = store.createSession({ cwd: dir, agent: "claude", model: "m", permissionMode: "default", title });
    const duck = store.duckForSession(s.id, project.id)!;
    if (duckName) store.updateDuck(duck.id, { name: duckName });
    return s;
  };
  return { dir, store, project, host, room, hooks, sent, chat, log: new TimelineLog(store.db) };
}

describe("RoomVoice at Room.post", () => {
  it("refuses a Duck's post that reads like a commit log, and says how to rewrite it", () => {
    const r = rig();
    const s = r.chat("Zoom setup", "Upma");
    for (const text of [POST_ONE, POST_TWO]) {
      for (const kind of ["message", "needs", "done", "working"] as const) {
        expect(() => r.room.agentPost(s, { kind, text })).toThrow(RoomError);
      }
      try {
        r.room.agentPost(s, { kind: "message", text });
      } catch (error) {
        expect((error as Error).message).toMatch(/^Not posted: rewrite this for a non-technical reader \(/);
      }
    }
    expect(r.store.roomPosts(r.project.id, { limit: 10 })).toHaveLength(0);
  });

  it("posts a plain rewrite", () => {
    const r = rig();
    const s = r.chat("Zoom setup", "Upma");
    expect(r.room.agentPost(s, { kind: "message", text: PLAIN_ONE })).toMatchObject({ authorName: "Upma" });
  });

  it("leaves alone what is not a Duck writing for the people: agents level, Duck to Duck, a person, Squeak", () => {
    const r = rig();
    const s = r.chat("Zoom setup", "Upma");
    const other = r.chat("Camera", "Tilly");
    expect(r.room.agentPost(s, { kind: "message", level: "agents", text: POST_ONE })).not.toBeNull();
    expect(
      r.room.agentPost(s, { kind: "handoff", level: "agents", toSessionId: other.id, text: POST_TWO }),
    ).not.toBeNull();
    expect(
      r.room.agentPost(s, { kind: "message", toSessionId: other.id, text: POST_TWO, noWake: true }),
    ).not.toBeNull();
    expect(r.room.personPost(r.project.id, POST_TWO)).toMatchObject({ authorKind: "person" });
    expect(
      r.room.post({
        projectId: r.project.id,
        author: { kind: "squeak", name: "Squeak" },
        kind: "message",
        text: POST_TWO,
      }),
    ).toMatchObject({ authorKind: "squeak" });
  });

  it("a model-written finish line that reads like a commit log is not posted: the next writer is tried, else none", async () => {
    const bad = { write: async () => POST_TWO };
    const good = { write: async () => "I tidied up the camera settings. Everything still works." };
    const input = { task: "t", reply: "r" };
    expect(await writeFinish([bad, good], input, 1000)).toBe(
      "I tidied up the camera settings. Everything still works.",
    );
    expect(await writeFinish([bad], input, 1000)).toBeNull();
  });

  it("every prompt that makes Room text includes the one rule", () => {
    const description = TOOLS.find((t) => t.name === "post_to_room")!.description;
    const context = buildThreadContext({ cwd: "/x", targetBranch: "main" } as any);
    for (const prompt of [
      description,
      context,
      CODEX_SQUEAK_GUIDE,
      FINISH_SYSTEM,
      HANDOFF_SUMMARY_SYSTEM,
      WORKING_SUMMARY_SYSTEM,
    ]) {
      expect(prompt).toContain(RULE);
    }
  });
});

describe("RoomVoice names", () => {
  it("a Duck with no name is never Claude, Codex or an email", () => {
    const r = rig();
    for (const title of ["Claude", "Codex", "", "someone@example.com"]) {
      const s = r.store.createSession({
        cwd: r.dir,
        agent: title === "Codex" ? "codex" : "claude",
        model: "m",
        permissionMode: "default",
        title,
      });
      expect(agentName(s)).not.toMatch(/claude|codex|@/i);
    }
    expect(agentName(r.chat("fix the zoom setup for the meeting flow"))).toBe("Fix the zoom setup");
  });

  it("a post by a Duck is attributed to its own name", () => {
    const r = rig();
    const s = r.chat("Zoom setup", "Upma");
    const row = r.room.agentPost(s, { kind: "message", text: PLAIN_ONE })!;
    expect(r.room.senderName(row)).toBe("Upma");
  });
});

describe("Questions reach the Room", () => {
  const QUESTION = {
    toolName: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "What next?",
          options: [
            { label: "Ship it (Recommended)", description: "Release now" },
            { label: "Try it first", description: "Test in a live meeting" },
          ],
          multiSelect: false,
        },
      ],
    },
  };

  it("a Duck waiting on its question tool is one Room ask with the options, and answering the request settles it", async () => {
    const r = rig();
    const s = r.chat("Zoom setup", "Upma");
    await r.host.send(s.id, "go");
    const resolution: Promise<Resolution> = r.hooks.get(s.id)!.onRequest("question", QUESTION as any);
    await new Promise((res) => setTimeout(res, 0));
    const ask = r.room.threadOf(r.store.getSession(s.id)!).ask!;
    expect(ask).toMatchObject({
      question: "What next?",
      options: [
        { letter: "A", text: "Ship it", recommended: true },
        { letter: "B", text: "Try it first", recommended: false },
      ],
    });
    expect(ask.requestId).toBeTruthy();
    // The Room answers exactly as the chat's card does: the option's words, keyed by the question, to that request.
    r.host.respond(ask.requestId!, { decision: "allow", answers: { [ask.question]: ask.options[0]!.text } });
    await expect(resolution).resolves.toMatchObject({ decision: "allow", answers: { "What next?": "Ship it" } });
    expect(r.room.threadOf(r.store.getSession(s.id)!).ask).toBeUndefined();
  });

  it("answering in the chat settles the Room item the same way (one request, either place)", async () => {
    const r = rig();
    const s = r.chat("Zoom setup", "Upma");
    await r.host.send(s.id, "go");
    void r.hooks.get(s.id)!.onRequest("question", QUESTION as any);
    await new Promise((res) => setTimeout(res, 0));
    const request = r.store.openRequests(s.id).find((q) => q.kind === "question")!;
    expect(r.room.threadOf(r.store.getSession(s.id)!).ask?.requestId).toBe(request.id);
    // The chat's card answers with the option's title through the same route.
    r.host.respond(request.id, { decision: "allow", answers: { "What next?": "Try it first" } });
    expect(r.room.threadOf(r.store.getSession(s.id)!).ask).toBeUndefined();
    // A second answer from the other place is refused, never applied twice.
    expect(() => r.host.respond(request.id, { decision: "allow", answers: { "What next?": "Ship it" } })).toThrow();
  });

  it("a question with several parts shows the first question and no options (answered in the chat)", () => {
    const two = {
      input: {
        questions: [
          { question: "Which?", options: [{ label: "a" }, { label: "b" }] },
          { question: "And when?", options: [{ label: "now" }, { label: "later" }] },
        ],
      },
    };
    expect(askOfRequest("r1", two)).toEqual({ question: "Which?", options: [] });
    expect(askOfRequest("r2", { input: { questions: [] } })).toBeNull();
    expect(
      askOfRequest("r3", {
        input: { questions: [{ question: "Pick", multiSelect: true, options: [{ label: "a" }, { label: "b" }] }] },
      }),
    ).toEqual({
      question: "Pick",
      options: [],
    });
  });

  it("a turn that ends on a question card in its reply (chat idle) is a Room ask until a newer turn starts", () => {
    const r = rig();
    const s = r.chat("Zoom setup", "Upma");
    const now = Date.now();
    const iso = (ago: number) => new Date(now - ago).toISOString();
    const turn = (id: string, text: string, reply?: string) => {
      r.log.append(s.id, {
        type: "turn.started",
        turnId: id,
        promptMessageId: `m${id}`,
        text,
        at: iso(60_000),
        room: true,
      } as any);
      if (reply) {
        r.log.append(s.id, {
          type: "reply.done",
          turnId: id,
          messageId: `r${id}`,
          text: reply,
          at: iso(30_000),
        } as any);
        r.log.append(s.id, { type: "turn.ended", turnId: id, outcome: "done", at: iso(30_000) } as any);
      }
    };
    r.store.setStatus(s.id, "idle", true);
    turn("t1", "set it up", "It works.\n\nWhat next?\n\nA) Ship it\nB) Try it first (recommended)");
    const ask = r.room.threadOf(r.store.getSession(s.id)!).ask!;
    expect(ask.question).toMatch(/What next/);
    expect(ask.options.map((o) => o.text)).toEqual(["Ship it", "Try it first"]);
    expect(ask.requestId).toBeUndefined();
    // Answering in the chat or in the Room is a new turn with the letter: the item is settled.
    turn("t2", "A");
    expect(r.room.threadOf(r.store.getSession(s.id)!).ask).toBeUndefined();
  });

  it("an idle Duck whose last reply is a plain summary has no ask", () => {
    const r = rig();
    const s = r.chat("Zoom setup", "Upma");
    const at = new Date(Date.now() - 30_000).toISOString();
    r.log.append(s.id, { type: "turn.started", turnId: "t1", promptMessageId: "m", text: "go", at, room: true } as any);
    r.log.append(s.id, {
      type: "reply.done",
      turnId: "t1",
      messageId: "r",
      text: "Done.\n\n1. Ran it\n2. Fixed it",
      at,
    } as any);
    r.log.append(s.id, { type: "turn.ended", turnId: "t1", outcome: "done", at } as any);
    expect(r.room.threadOf(r.store.getSession(s.id)!).ask).toBeUndefined();
  });
});

describe("post_to_room refusal", () => {
  async function server() {
    const r = rig();
    const tokenPath = path.join(r.dir, "hook-token");
    const srv = new NativeServer({
      host: r.host,
      store: r.store,
      workspaces: new WorkspaceManager({ store: r.store, workspacesRoot: path.join(r.dir, "ws") }),
      room: r.room,
      tokenPath,
      port: 0,
    });
    await srv.start();
    open.push(async () => {
      await srv.stop();
      await r.host.stop();
    });
    const tool = async (sessionId: string, args: Record<string, unknown>) => {
      const endpoint = srv.mcpEndpoint(sessionId)!;
      const res = await fetch(endpoint.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "post_to_room", arguments: args },
        }),
      });
      return ((await res.json()) as any).result as { content: { text: string }[]; isError?: boolean };
    };
    return { ...r, tool };
  }

  it("returns 'Not posted: rewrite this for a non-technical reader (<reason>)' and stores nothing", async () => {
    const h = await server();
    const s = h.chat("Zoom setup", "Upma");
    const bad = await h.tool(s.id, { kind: "message", text: POST_TWO });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toMatch(/^Not posted: rewrite this for a non-technical reader \(.+\)/);
    expect(h.store.roomPosts(h.project.id, { limit: 10 })).toHaveLength(0);
    const good = await h.tool(s.id, { kind: "message", text: PLAIN_ONE });
    expect(good.isError).toBeFalsy();
    expect(h.store.roomPosts(h.project.id, { limit: 10 })).toHaveLength(1);
  });
});
