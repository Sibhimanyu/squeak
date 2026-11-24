import { describe, expect, it } from "vitest";

import { buildPondRoom, POND_ROOM_ITEMS_MAX, pondRoomDoc } from "./pond-room.js";

const OWNER = { kind: "person", id: "owner", name: "Sam" };

const post = (seq: number, id: string, text: string, author: Record<string, unknown> = OWNER) => ({
  seq,
  id,
  author,
  kind: "message",
  level: "room",
  text,
  at: seq * 1000,
});

describe("buildPondRoom", () => {
  it("draws people's messages, mine on the right, a Duck's words by its chosen name", () => {
    const doc = buildPondRoom("p", {
      member: false,
      page: {
        threads: [{ sessionId: "s1", title: "icon work", name: "Pixel" }],
        posts: [
          post(1, "a", "fix the icon"),
          post(2, "b", "ok", { kind: "person", id: "m2", name: "Aarav" }),
          { ...post(3, "c", "on it", { kind: "agent", id: "s1", name: "icon work" }), sessionId: "s1" },
          { ...post(4, "d", "secret"), level: "agents" },
        ],
        tasks: [],
      },
    });
    expect(doc.items).toMatchObject([
      { t: "message", who: "You", mine: true, canTask: true },
      { t: "message", who: "Aarav", mine: false },
      { t: "message", who: "Pixel", duck: true },
    ]);
    expect(doc.items).toHaveLength(3);
    expect(doc).toMatchObject({ canPost: true, canTask: true });
  });

  it("collapses a Duck's state post to one line with the rest as detail", () => {
    const duck = { kind: "agent", id: "s1", name: "Pixel" };
    const doc = buildPondRoom("p", {
      member: false,
      page: {
        posts: [
          { ...post(1, "w", "Updating the icon set\nChecked 4 sizes, one is blurry", duck), kind: "working" },
          { ...post(2, "x", "Done", duck), kind: "done" },
        ],
      },
    });
    expect(doc.items).toMatchObject([
      {
        t: "duck",
        tone: "working",
        line: "Updating the icon set",
        detail: "Updating the icon set\nChecked 4 sizes, one is blurry",
      },
      { t: "duck", tone: "done", line: "Done" },
    ]);
    expect((doc.items[1] as { detail?: string }).detail).toBeUndefined();
  });

  it("draws a Task with its state and the routing line, and leaves dropped ones out", () => {
    const doc = buildPondRoom("p", {
      member: false,
      page: {
        posts: [post(1, "a", "make the icons crisp")],
        threads: [],
        tasks: [
          {
            id: "task:1",
            messageId: "a",
            title: "Make the icons crisp",
            text: "make the icons crisp",
            state: "working",
            suggestion: { sessionId: "s1", title: "Pixel", reason: "related to the icon work" },
            handedTo: { sessionId: "s1", title: "Pixel" },
            createdAt: 1500,
          },
          { id: "task:2", messageId: "zzz", title: "gone", state: "dropped", createdAt: 1600 },
          { id: "task:3", messageId: "b", title: "later", state: "waiting", proposed: true, createdAt: 1700 },
          {
            id: "task:4",
            messageId: "c",
            title: "shipped",
            state: "done",
            result: "Icons are crisp.",
            createdAt: 1800,
          },
        ],
      },
    });
    const tasks = doc.items.filter((i) => i.t === "task");
    expect(tasks).toMatchObject([
      {
        taskId: "task:1",
        state: "working",
        stateLabel: "Working",
        routing: "→ given to Pixel (related to the icon work)",
        canDrop: true,
      },
      { taskId: "task:3", stateLabel: "Suggested", routing: "→ a new duck", canDrop: true },
      { taskId: "task:4", state: "done", result: "Icons are crisp." },
    ]);
    expect((tasks[2] as { canDrop?: true }).canDrop).toBeUndefined();
    // The message that has a live Task is not offered Make task again.
    expect((doc.items[0] as { canTask?: true }).canTask).toBeUndefined();
  });

  it("uses the host's own routing line when it has one", () => {
    const doc = buildPondRoom("p", {
      member: false,
      page: {
        posts: [],
        tasks: [
          { id: "t", messageId: "a", title: "x", state: "waiting", routing: "→ hatched a new Duck", createdAt: 1 },
        ],
      },
    });
    expect(doc.items[0]).toMatchObject({ routing: "→ hatched a new Duck" });
  });

  it("a Member's Room is theirs by member id, read-only for Tasks, with the offline line and the reason", () => {
    const doc = buildPondRoom("p", {
      member: true,
      selfId: "m2",
      page: {
        posts: [
          post(1, "a", "hello", { kind: "person", id: "m1", name: "Sam" }),
          post(2, "b", "hi", { kind: "person", id: "m2", name: "Aarav" }),
        ],
        tasks: [{ id: "t", messageId: "a", title: "x", state: "working", createdAt: 3000 }],
        ownerOffline: { line: "Sam's Mac is offline; Ducks will pick this up when it's back" },
        canPost: false,
      },
    });
    expect(doc.items).toMatchObject([
      { t: "message", who: "Sam", mine: false },
      { t: "message", who: "You", mine: true },
      { t: "task" },
    ]);
    const flags = doc.items.map((i) => i as { canTask?: boolean; canDrop?: boolean });
    expect(flags.some((i) => i.canTask || i.canDrop)).toBe(false);
    expect(doc).toMatchObject({
      canPost: false,
      canTask: false,
      offline: "Sam's Mac is offline; Ducks will pick this up when it's back",
    });
    expect(doc.reason).toBeTruthy();
  });

  it("turns a Room-sent turn into the person's prompt and the Duck's outcome line with expandable detail", () => {
    const doc = buildPondRoom("p", {
      member: false,
      page: {
        threads: [{ sessionId: "s1", title: "icon work", name: "Pixel" }],
        posts: [],
        turns: [
          {
            id: "s1:t1",
            sessionId: "s1",
            threadTitle: "icon work",
            startedAt: 1000,
            endedAt: 66_000,
            outcome: "finished",
            prompt: "@Pixel try 2x",
            author: { kind: "person", name: "Sam", me: true },
            outcomeText: "Rendered 2x icons.",
            durationMs: 65_000,
            filesChanged: 3,
          },
        ],
      },
    });
    expect(doc.items).toMatchObject([
      { t: "message", who: "You", mine: true, text: "@Pixel try 2x" },
      {
        t: "duck",
        who: "Pixel",
        tone: "done",
        line: "Rendered 2x icons.",
        detail: "Asked: @Pixel try 2x\n1m 05s\n3 files",
      },
    ]);
  });

  it("keeps the newest rows and gives a stable document id per pond", () => {
    const posts = Array.from({ length: POND_ROOM_ITEMS_MAX + 10 }, (_, i) => post(i + 1, `p${i}`, `m${i}`));
    const doc = buildPondRoom("p", { member: false, page: { posts } });
    expect(doc.items).toHaveLength(POND_ROOM_ITEMS_MAX);
    expect(doc.items.at(-1)).toMatchObject({ id: `p${POND_ROOM_ITEMS_MAX + 9}` });
    expect(pondRoomDoc("p")).toBe(pondRoomDoc("p"));
    expect(pondRoomDoc("p")).not.toBe(pondRoomDoc("q"));
  });
});
