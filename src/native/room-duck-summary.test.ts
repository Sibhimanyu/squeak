import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentTools, TOOLS } from "./agent-tools.js";
import { Room } from "./room.js";
import {
  backfillSummaries,
  BACKFILL_MIGRATION,
  cleanSummary,
  clipAtWord,
  localSummary,
  type SummaryWriterPort,
} from "./room-handoff-summary.js";
import { RoomTasks } from "./room-tasks.js";
import { NativeStore } from "./store.js";
import type { SessionRow } from "./types.js";

/** Duck-to-Duck messages in the Room: a summary line, the whole message kept, never a numbered name. */

function rig(writers: SummaryWriterPort[] = []) {
  const store = new NativeStore(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-summary-"));
  const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
  const room = new Room({ store, ownerName: () => "Sam", summaryWriters: writers });
  const duck = (name: string) => {
    const s: SessionRow = store.createSession({
      cwd: dir,
      agent: "claude",
      model: "m",
      permissionMode: "default",
      title: name,
    });
    const d = store.createDuck({ projectId: project.id, name });
    store.attachSessionToDuck(d.id, s.id);
    return { s, d: store.duckRow(d.id)! };
  };
  const jobs = new RoomTasks({
    store,
    room,
    settings: () => ({ askBeforeStarting: false, maxWorkingDucks: 4 }),
    send: async () => {},
    newThread: async () => {
      throw new Error("unused");
    },
    call: async () => '{"job":false,"text":""}',
  });
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
  const wire = () => room.page(project.id, { all: true }).posts;
  return { store, room, tools, duck, pid: project.id, wire };
}

const LONG =
  "The global shortcuts moved to Control Option Command, so fold them into the site rebuild. " +
  "Also update every screenshot. ".repeat(30) +
  "Lines still wrap wrong in the category a";

describe("Duck-to-Duck posts carry a summary and the whole message", () => {
  it("send_to_chat stores the sender's summary and the full message; the row text is clipped at a word end", async () => {
    const r = rig();
    const quill = r.duck("Quill");
    const dot = r.duck("Dot");
    await r.tools.call(quill.s.id, "send_to_chat", {
      chatId: dot.s.id,
      message: LONG,
      summary: "Heads-up: the global shortcuts moved to Control Option Command; fold them into the site rebuild.",
    });
    const post = r.wire().find((p) => p.toSessionId === dot.s.id)!;
    expect(post.summary).toBe(
      "Heads-up: the global shortcuts moved to Control Option Command; fold them into the site rebuild.",
    );
    expect(post.fullBody).toBe(LONG);
    expect(post.toName).toBe("Dot");
    // The stored text is cut at a word end, never mid-word.
    expect(post.text.length).toBeLessThanOrEqual(500);
    expect(post.text.endsWith("…")).toBe(true);
    expect(LONG.startsWith(post.text.slice(0, -1).trimEnd())).toBe(true);
    expect(LONG.charAt(post.text.slice(0, -1).trimEnd().length)).toBe(" ");
  });

  it("hand_off stores its summary and body and points at the receiving chat", async () => {
    const r = rig();
    const quill = r.duck("Quill");
    const dot = r.duck("Dot");
    await r.tools.call(quill.s.id, "hand_off", {
      text: "write the settings tests",
      toDuck: "Dot",
      summary: "Asked Dot to write the settings tests.",
    });
    const post = r.wire().find((p) => p.text.startsWith("@Dot"))!;
    expect(post).toMatchObject({
      summary: "Asked Dot to write the settings tests.",
      fullBody: "write the settings tests",
      toSessionId: dot.s.id,
    });
  });

  it("asks the sending Duck for a summary in plain, neutral words", () => {
    for (const name of ["send_to_chat", "hand_off"]) {
      const t = TOOLS.find((x) => x.name === name)!;
      expect((t.inputSchema as { required: string[] }).required).toContain("summary");
      const ask = /summary: [^.]*\./.exec(t.description)![0];
      expect(ask).not.toMatch(/duck|squeak/i);
    }
  });

  it("writes a missing summary in the background with the first writer that answers, then announces it", async () => {
    const asked: string[] = [];
    const failing: SummaryWriterPort = { write: async () => null };
    const haiku: SummaryWriterPort = {
      write: async (m) => {
        asked.push(m);
        return "Fold the new shortcuts into the site rebuild. Then update the screenshots. And more words after.";
      },
    };
    const r = rig([failing, haiku]);
    const quill = r.duck("Quill");
    const dot = r.duck("Dot");
    const updated: string[] = [];
    r.room.on("post-updated", (row: { id: string }) => updated.push(row.id));
    await r.tools.call(quill.s.id, "send_to_chat", { chatId: dot.s.id, message: "move the shortcuts please" });
    expect(r.wire().find((p) => p.toSessionId === dot.s.id)!.summary).toBeUndefined();
    await new Promise((res) => setTimeout(res, 20));
    const post = r.wire().find((p) => p.toSessionId === dot.s.id)!;
    expect(asked).toEqual(["move the shortcuts please"]);
    expect(post.summary).toBe("Fold the new shortcuts into the site rebuild. Then update the screenshots.");
    expect(updated).toEqual([post.id]);
  });

  it("falls back to the message's first sentences when no model answers", async () => {
    const r = rig([{ write: async () => null }]);
    const quill = r.duck("Quill");
    const dot = r.duck("Dot");
    await r.tools.call(quill.s.id, "send_to_chat", { chatId: dot.s.id, message: "Rename the tabs. Then ship it." });
    await new Promise((res) => setTimeout(res, 20));
    expect(r.wire().find((p) => p.toSessionId === dot.s.id)!.summary).toBe("Rename the tabs. Then ship it.");
  });
});

describe("summary text rules", () => {
  it("keeps two sentences, strips markdown, never cuts mid-word", () => {
    expect(cleanSummary("**Tell** Dot to `fix` it. Then rest. And then more.")).toBe("Tell Dot to fix it. Then rest.");
    const clipped = clipAtWord("alpha beta gamma delta", 14);
    expect(clipped).toBe("alpha beta…");
    expect(localSummary("@Dot 2 please rebuild the index")).toBe("please rebuild the index");
  });
});

describe("backfilling old hand-off posts", () => {
  function seed(r: ReturnType<typeof rig>, n: number) {
    const a = r.duck("Quill");
    const b = r.duck("Dot");
    for (let i = 0; i < n; i++) {
      r.store.addRoomPost({
        projectId: r.pid,
        authorKind: "agent",
        authorId: a.s.id,
        authorName: "Quill",
        sessionId: a.s.id,
        kind: "message",
        level: "agents",
        text: `Old message ${i}. It goes on.`,
        toSessionId: b.s.id,
        at: i + 1,
      });
    }
  }

  it("is capped, idempotent, and recorded once nothing is left", async () => {
    const r = rig();
    seed(r, 5);
    const writer: SummaryWriterPort = { write: async (m) => `About: ${m.split(".")[0]}.` };
    expect(await backfillSummaries({ store: r.store, writers: [writer], cap: 3 })).toBe(3);
    expect(r.store.migrationDone(BACKFILL_MIGRATION)).toBe(false);
    expect(await backfillSummaries({ store: r.store, writers: [writer], cap: 3 })).toBe(2);
    expect(r.store.migrationDone(BACKFILL_MIGRATION)).toBe(true);
    expect(await backfillSummaries({ store: r.store, writers: [writer], cap: 3 })).toBe(0);
    const posts = r.store.roomPosts(r.pid, { limit: 10 });
    expect(posts.every((p) => p.summary?.startsWith("About: Old message"))).toBe(true);
  });

  it("uses the clipped first sentences when no model answers, so it never retries forever", async () => {
    const r = rig();
    seed(r, 1);
    await backfillSummaries({ store: r.store, writers: [{ write: async () => null }] });
    expect(r.store.roomPosts(r.pid, { limit: 1 })[0]!.summary).toBe("Old message 0. It goes on.");
    expect(r.store.migrationDone(BACKFILL_MIGRATION)).toBe(true);
  });
});

describe("a Duck name never shows a digit", () => {
  function numbered() {
    const r = rig();
    const quill = r.duck("Quill");
    const dot = r.duck("Dot");
    const old = (name: string, to: string, extra: object = {}) =>
      r.store.addRoomPost({
        projectId: r.pid,
        authorKind: "agent",
        authorId: quill.s.id,
        authorName: name,
        sessionId: quill.s.id,
        kind: "message",
        level: "agents",
        text: `@${to} do the thing`,
        toSessionId: dot.s.id,
        at: 1,
        ...extra,
      });
    return { r, quill, dot, old };
  }

  it("rewrites stored names without the suffix, and the leading @mention of the receiver", () => {
    const { r, old } = numbered();
    const row = old("Quill 2", "Dot 2");
    // Reset the one-time record the Room's constructor left (the rows above arrived after it ran).
    r.store.db.prepare("DELETE FROM host_migrations WHERE name='duck-names-no-digits'").run();
    expect(r.store.repairNumberedDuckNames()).toBeGreaterThan(0);
    const fixed = r.store.roomPostById(row.id)!;
    expect(fixed.authorName).toBe("Quill");
    expect(fixed.text).toBe("@Dot do the thing");
  });

  it("uses the Duck's current name when the stored one is an alias from a rename", () => {
    const { r, quill, old } = numbered();
    r.store.db.prepare("INSERT INTO duck_aliases (duck_id, alias) VALUES (?,?)").run(quill.d.id, "Quill 2");
    r.store.updateDuck(quill.d.id, { name: "Sage" });
    const row = old("Quill 2", "Dot");
    r.store.db.prepare("DELETE FROM host_migrations WHERE name='duck-names-no-digits'").run();
    r.store.repairNumberedDuckNames();
    expect(r.store.roomPostById(row.id)!.authorName).toBe("Sage");
  });

  it("is idempotent and leaves a real mention with a number alone", () => {
    const { r, old } = numbered();
    const row = old("Quill", "Dot", { text: "@Dot 5 files changed" });
    r.store.db.prepare("DELETE FROM host_migrations WHERE name='duck-names-no-digits'").run();
    r.store.repairNumberedDuckNames();
    expect(r.store.roomPostById(row.id)!.text).toBe("@Dot 5 files changed");
    expect(r.store.repairNumberedDuckNames()).toBe(0);
  });

  it("serves a plain name even for a Duck whose own name still ends in digits", () => {
    const r = rig();
    const quill = r.duck("Quill");
    const dot = r.duck("Dot");
    r.store.db.prepare("UPDATE ducks SET name='Dot 2' WHERE id=?").run(dot.d.id);
    r.store.db.prepare("UPDATE room_posts SET author_name='x'").run();
    const row = r.room.agentPost(quill.s, { kind: "message", level: "agents", text: "hi", toSessionId: dot.s.id })!;
    expect(r.room.toPosts(r.pid, [row])[0]!.toName).toBe("Dot");
  });
});
