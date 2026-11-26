import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Room } from "../../src/native/room.js";
import { RoomTasks } from "../../src/native/room-tasks.js";
import { NativeStore } from "../../src/native/store.js";
import { RoomSync } from "../../src/flotilla/room-sync.js";
import { duckLine, ownerOfflineLine, roomBlock, roomRows, stillPending } from "../js/guest-room-model.js";
import { startGuest } from "../js/guest.js";
import { KeyStore } from "../js/key-store.js";
import { all, click, installDom, text } from "./fake-dom.js";
import { account, cleanup, fakeRelay, mac } from "./guest-helpers.js";
import { fakeIndexedDB } from "./helpers.js";

const dirs = [];
afterAll(() => {
  cleanup();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const post = (id, seq, author, text, kind = "message", at = seq * 1000) => ({
  id,
  seq,
  author,
  kind,
  text,
  at,
  level: "room",
  v: 1,
});
const duck = { kind: "agent", name: "Maple" };
const person = (id, name = "Sibhi") => ({ kind: "person", id, name });

describe("what the Room says", () => {
  it("draws a Duck's post as one collapsed line that can open, a person's as a bubble, Tasks under their message", () => {
    const room = {
      posts: [
        post("p1", 1, person("owner1"), "Shall we start with the footer?"),
        post("p2", 2, duck, "Footer is done. I changed three files and ran the tests.", "done"),
        post("p3", 3, person("me1", "Webby"), "Thanks"),
      ],
      tasks: [
        { id: "task:a", messageId: "p1", title: "Footer", text: "x", state: "working", createdAt: 1, updatedAt: 2 },
        { id: "task:b", messageId: "gone", title: "Old one", text: "x", state: "dropped", createdAt: 1, updatedAt: 2 },
      ],
    };
    const rows = roomRows(room, "me1");
    expect(rows.map((r) => [r.kind, r.id])).toEqual([
      ["person", "p1"],
      ["task", "task-task:a"],
      ["duck", "p2"],
      ["person", "p3"],
      ["task", "task-task:b"],
    ]);
    expect(rows[2]).toMatchObject({
      who: "Maple",
      label: "done",
      summary: "Footer is done.",
      more: true,
      text: "Footer is done. I changed three files and ran the tests.",
    });
    expect(rows[1].words).toBe("A duck is on it");
    expect(rows[3].mine).toBe(true);
    expect(rows[0].mine).toBe(false);
  });

  it("draws a plan card with its detail and a comment box, a done line's canvas cards view only, and a reply under its card", () => {
    const room = {
      canPost: true,
      posts: [
        { ...post("pl", 1, duck, "Plan: redo the footer", "plan"), detail: "Spec: links.\nPlan: 1. fix hrefs" },
        {
          ...post("dn", 2, duck, "Footer done", "done"),
          canvases: [{ id: "c1", title: "Footer deck", kind: "deck", artboards: 3 }],
        },
        { ...post("rp", 3, person("me1", "Webby"), "Keep the old logo"), replyTo: "pl" },
      ],
      tasks: [],
    };
    const rows = roomRows(room, "me1");
    expect(rows[0]).toMatchObject({
      label: "plan",
      plan: true,
      canComment: true,
      detail: "Spec: links.\nPlan: 1. fix hrefs",
      more: true,
    });
    expect(rows[1].canvases).toEqual([
      { id: "c1", title: "Footer deck", kind: "deck", artboards: 3, subtitle: "Deck \u00B7 3 artboards" },
    ]);
    expect(rows[2].replyLine).toBe("On the plan: Plan: redo the footer");
    // Messaging switched off (or a viewer): the card is read-only.
    expect(roomRows({ ...room, canPost: false }, "me1")[0].canComment).toBe(false);
  });

  it("cuts a long Duck line at 90 characters and says there is nothing more for a short one", () => {
    expect(duckLine("x".repeat(200)).summary).toHaveLength(90);
    expect(duckLine("Short.")).toEqual({ summary: "Short.", more: false });
  });

  it("keeps a message sent from here as a pending row until its post (m-<id>) arrives", () => {
    const room = { posts: [], tasks: [] };
    const pending = [{ id: "abc", text: "hello", at: 5, failed: false }];
    expect(roomRows(room, "me1", pending).map((r) => [r.id, r.pending ? "pending" : "real"])).toEqual([
      ["pending-abc", "pending"],
    ]);
    const landed = { posts: [post("m-abc", 1, person("me1", "Webby"), "hello")], tasks: [] };
    expect(roomRows(landed, "me1", pending).map((r) => r.id)).toEqual(["m-abc"]);
    expect(stillPending(pending, landed)).toEqual([]);
    expect(stillPending(pending, room)).toEqual(pending);
  });

  it("closes the composer with the reason, and words the owner-offline line as the Mac does", () => {
    expect(roomBlock({ canPost: true })).toBeNull();
    expect(roomBlock({ canPost: false, blockedLine: "Viewers can read but not send." })).toBe(
      "Viewers can read but not send.",
    );
    expect(ownerOfflineLine("Sibhi Mani")).toBe("Sibhi's Mac is offline; Ducks will pick this up when it's back");
  });
});

const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out; screen says: ${check.screen?.() ?? ""}`);
};

class FakeSocket {
  send() {}
  close() {}
}

describe("the Room in the guest page, end to end over the fake relay", () => {
  const ORIGIN = "https://squeak.catalystserverless.in";
  const relay = fakeRelay();
  const owner = mac(relay, "Sibhi", { owner: true });
  let pondId;
  let root;
  let host;
  const sockets = [];

  beforeAll(async () => {
    installDom();
    const store = new NativeStore(":memory:");
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "web-room-page-"));
    dirs.push(folder);
    const project = store.createProject({ name: "site", rootPath: folder, defaultBranch: "main", kind: "folder" });
    const room = new Room({ store, ownerName: () => "Sibhi" });
    const jobs = new RoomTasks({
      store,
      room,
      send: async () => undefined,
      newThread: async () => ({}),
      call: async () => '{"job":false,"text":""}',
      enabled: () => false,
    });
    const sync = new RoomSync({ service: owner, room, jobs, store, debounceMs: 1 });
    sync.start();
    host = { project, room, jobs, sync };
    pondId = (await owner.createPond({ name: "Site", projectId: project.id })).id;
    const link = (await owner.invite(pondId, "member")).link;
    root = document.createElement("div");
    const win = {
      location: { hash: link.slice(link.indexOf("#")), origin: ORIGIN, pathname: "/app/join.html", search: "" },
      history: { state: null, replaceState: () => undefined, pushState: () => undefined },
      addEventListener: () => undefined,
      document: { visibilityState: "visible", addEventListener: () => undefined },
    };
    const started = startGuest({
      root,
      win,
      vault: new KeyStore(fakeIndexedDB()),
      fetch: (url, init) => {
        const href = new URL(url, ORIGIN).href;
        if (href.endsWith("/me"))
          return Promise.resolve(new Response(JSON.stringify(account("Webby")), { status: 200 }));
        return relay.as(account("Webby")).fetch(href, init);
      },
      socket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      minGapMs: 0,
    });
    await started;
    click(buttons().find((b) => text(b).includes("Join")));
    await says("Waiting for Sibhi to let you in");
    const [request] = (await owner.view(pondId)).joins;
    await owner.decideJoin(pondId, request.requestId, { approve: true });
    await owner.setPresence(pondId, {});
    notice();
    await says("Webby (you)");
  });

  const says = (needle) => {
    const check = () => text(root).includes(needle);
    check.screen = () => text(root);
    return until(check);
  };
  const notice = () => {
    for (const s of sockets)
      s.onmessage?.({
        data: JSON.stringify({ mtype: "650", msg: { opr: "event", data: { streamingId: 1, data: "{}" } } }),
      });
  };
  const buttons = () => all(root).filter((n) => n.tag === "button");

  it("opens the Room from the pond: people, a collapsed Duck line that opens, a Task card", async () => {
    const first = host.room.personPost(host.project.id, "Shall we start with the footer?");
    host.room.post({
      projectId: host.project.id,
      author: { kind: "agent", id: "sess-1", name: "Maple" },
      sessionId: "sess-1",
      kind: "done",
      text: "Footer is done. Three files changed.",
    });
    host.jobs.fromMessage(host.project.id, first.id);
    await host.sync.idle();
    click(buttons().find((b) => text(b).includes("Room")));
    await says("Shall we start with the footer?");
    expect(all(root).some((n) => String(n.attrs?.class ?? "").includes("g-task"))).toBe(true);
    expect(text(root)).toContain("Maple");
    expect(text(root)).toContain("Footer is done.");
    const duckLines = all(root).filter((n) => n.tag === "details");
    expect(duckLines).toHaveLength(1);
    expect(duckLines[0].open).toBeFalsy();
  });

  it("posts a message: pending at first, then the owner's Mac applies it and it is theirs in the Room", async () => {
    const box = all(root).find((n) => n.tag === "textarea");
    box.value = "Footer is fine by me.";
    click(buttons().find((b) => text(b).trim() === "Send"));
    await says("Sent. It shows here once the owner's Mac has it.");
    await owner.pass(pondId);
    await host.sync.idle();
    notice();
    await until(() => !text(root).includes("Sent. It shows here"));
    expect(text(root)).toContain("Footer is fine by me.");
    expect(text(root)).toContain("You");
  });

  it("closes the composer with the reason once the owner makes the Member a viewer", async () => {
    const me = (await owner.view(pondId)).members.find((m) => m.name === "Webby");
    await owner.changeRole(pondId, me.id, "viewer");
    notice();
    await says("Viewers can read but not send.");
    const composer = all(root).find((n) => n.attrs?.class === "g-composer");
    expect(composer.hidden).toBe(true);
  });
});
