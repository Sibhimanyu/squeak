/* eslint-disable @typescript-eslint/no-explicit-any -- JSON replies are read loosely in tests */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionHost } from "./host.js";
import { Room, RoomError } from "./room.js";
import {
  checkAttachments,
  cleanFileName,
  imageSize,
  ROOM_FILE_MAX_BYTES,
  ROOM_IMAGE_MAX_BYTES,
  stripAttachmentLines,
} from "./room-attachments.js";
import { RoomTasks } from "./room-tasks.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";

/** A Duck's briefing without its how-to-work tail, so these tests read the Task text itself. */
const unbrief = (t: string): string => t.replace(/\n\nHow to work this task:(\n- [^\n]*)+/, "");

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("pixels")]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jfif")]);
const b64 = (b: Buffer | string): string => Buffer.from(b).toString("base64");
const img = (b = PNG) => ({ name: "shot.png", data: b64(b) });
const doc = (name = "notes.pdf", body = "hello") => ({ name, data: b64(body) });

function rig() {
  const store = new NativeStore(":memory:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attach-"));
  const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
  const room = new Room({ store, ownerName: () => "Sam", attachmentsDir: path.join(dir, "store") });
  const sent: Array<{ id: string; text: string }> = [];
  const started: string[] = [];
  const duckDir = dir;
  const chat = (title: string) =>
    store.createSession({ cwd: duckDir, agent: "claude", model: "m", permissionMode: "default", title });
  const checks: string[] = [];
  const jobs = new RoomTasks({
    store,
    room,
    settings: () => ({ askBeforeStarting: true, maxWorkingDucks: 4 }), // these tests tap Go
    send: async (id, text) => void sent.push({ id, text: unbrief(text) }),
    newThread: async (_p, text, title, attach) => {
      started.push(unbrief(text) + (attach?.(duckDir) ?? ""));
      return chat(title);
    },
    call: async (i) => {
      checks.push(i.prompt);
      return '{"job":false,"text":""}';
    },
  });
  return { store, room, jobs, project, pid: project.id, sent, started, chat, duckDir, checks, dir };
}

describe("checking attachments", () => {
  it("tells images from files by their bytes, never the name or mime", () => {
    const out = checkAttachments([
      { name: "innocent.txt", data: b64(PNG), mime: "text/plain" },
      { name: "x.png", data: b64("not an image") },
      img(JPG),
    ]);
    expect(out.map((o) => [o.kind, o.name, o.mime])).toEqual([
      ["image", "image-1.png", "image/png"],
      ["file", "x.png", "application/octet-stream"],
      ["image", "image-2.jpg", "image/jpeg"],
    ]);
  });

  it("refuses bad shapes, empty data, too many, too large and over the total", () => {
    expect(() => checkAttachments("x")).toThrow(/list/);
    expect(() => checkAttachments([1])).toThrow(/object/);
    expect(() => checkAttachments([{ name: "a", data: "!!!" }])).toThrow(/base64/);
    expect(() => checkAttachments([{ name: "a", data: "" }])).toThrow(/base64/);
    expect(() => checkAttachments([{ name: "a", data: b64("x"), path: "/etc" }])).toThrow(/unknown key/);
    expect(() => checkAttachments(Array.from({ length: 5 }, () => img()))).toThrow(/4 images/);
    expect(() => checkAttachments(Array.from({ length: 5 }, () => doc()))).toThrow(/4 files/);
    expect(() => checkAttachments([img(Buffer.concat([PNG, Buffer.alloc(ROOM_IMAGE_MAX_BYTES)]))])).toThrow(
      /over 2 MB/,
    );
    expect(() => checkAttachments([doc("big.bin", "x".repeat(ROOM_FILE_MAX_BYTES + 1))])).toThrow(/over 5 MB/);
    const big = Buffer.alloc(ROOM_FILE_MAX_BYTES, 1);
    expect(() => checkAttachments(Array.from({ length: 4 }, () => ({ name: "b", data: b64(big) })))).toThrow(/16 MB/);
  });

  it("reads a picture's pixel size from its header, so a surface can lay it out before it loads", () => {
    const png = Buffer.alloc(33);
    PNG.copy(png, 0, 0, 8);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "latin1");
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(480, 20);
    expect(imageSize(png)).toEqual({ width: 640, height: 480 });
    // SOI, an APP0 segment, then SOF0 (480 x 640)
    const jpg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0,
      0, 0, 0, 0,
    ]);
    expect(imageSize(jpg)).toEqual({ width: 640, height: 480 });
    expect(imageSize(JPG)).toBeNull();
    expect(checkAttachments([{ name: "a", data: b64(png) }])[0]).toMatchObject({ width: 640, height: 480 });
  });

  it("cleans file names", () => {
    expect(cleanFileName("../../etc/passwd")).toBe("passwd");
    expect(cleanFileName("..\\x\\.hidden")).toBe("hidden");
    expect(cleanFileName("a\nb\u0000c.txt")).toBe("abc.txt");
    expect(cleanFileName("")).toBe("file");
    expect(cleanFileName("x".repeat(200) + ".pdf").length).toBe(80);
  });

  it("strips only the lines an attachment adds", () => {
    expect(
      stripAttachmentLines("fix it\n\n@⟦image-1.png⟧(.context%2Fa%2Fimage-1.png)\nAttached file: .context/a/n.pdf"),
    ).toBe("fix it");
    expect(stripAttachmentLines("see @⟦x⟧(y) inline")).toBe("see @⟦x⟧(y) inline");
  });
});

describe("a room message with attachments", () => {
  it("is stored with the post, listed on the page and kept for a picture alone", () => {
    const r = rig();
    const post = r.room.personPost(r.pid, "look at this", "room", [img(), doc()]);
    const page = r.room.page(r.pid, {}).posts;
    expect(page[0]!.attachments).toMatchObject([
      { kind: "image", name: "image-1.png", mime: "image/png", size: PNG.length },
      { kind: "file", name: "notes.pdf", mime: "application/pdf", size: 5 },
    ]);
    expect(page[0]!.attachments![0]!.url).toBe(
      `/native/projects/${r.pid}/room/attachments/${page[0]!.attachments![0]!.id}`,
    );
    const alone = r.room.personPost(r.pid, "", "room", [img()]);
    expect(alone.text).toBe("");
    expect(post.id).not.toBe(alone.id);
    expect(() => r.room.personPost(r.pid, "", "room", [])).toThrow(RoomError);
    expect(() => r.room.personPost(r.pid, "hi", "room", [{ name: "a", data: "!" }])).toThrow(RoomError);
    // nothing was posted by the refused ones
    expect(r.room.page(r.pid, {}).posts).toHaveLength(2);
  });

  it("is refused for anyone but a person's message", () => {
    const r = rig();
    expect(() =>
      r.room.post({
        projectId: r.pid,
        author: { kind: "agent", id: "a", name: "A" },
        kind: "working",
        text: "x",
        attachments: [img()],
      }),
    ).toThrow(/Only a person/);
  });

  it("the job check hears the count, never the bytes", async () => {
    const r = rig();
    r.jobs.attach(r.room as any);
    r.room.personPost(r.pid, "please fix the spacing in the layout builder", "room", [img(), img(JPG), doc()]);
    await r.jobs.idle();
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]).toContain("(+2 images, 1 file)");
    expect(r.checks[0]).not.toContain(b64(PNG));
  });
});

describe("attachments travel into a duck's turn", () => {
  const lines = (text: string) => text.split("\n").filter((l) => l.startsWith("@⟦") || l.startsWith("Attached file:"));

  it("go: written under the duck's folder, named like a chat's, and the job still follows its turn", async () => {
    const r = rig();
    const s = r.chat("Layout builder");
    const post = r.room.personPost(r.pid, "fix the layout builder spacing", "room", [img(), doc("spec.pdf")]);
    const job = r.jobs.fromMessage(r.pid, post.id);
    await r.jobs.act(r.pid, job.id, { action: "go" });
    const sent = r.sent[0]!;
    expect(sent.id).toBe(s.id);
    expect(sent.text.startsWith("fix the layout builder spacing\n\n@⟦image-1.png⟧(")).toBe(true);
    const [token, file] = lines(sent.text);
    const imageRel = decodeURIComponent(/\((.*)\)/.exec(token!)![1]!);
    expect(imageRel).toMatch(/^\.context\/attachments\/[0-9a-f]{8}\/image-1\.png$/);
    expect(fs.readFileSync(path.join(r.duckDir, imageRel))).toEqual(PNG);
    expect(file).toMatch(/^Attached file: \.context\/attachments\/[0-9a-f]{8}\/spec\.pdf$/);
    expect(fs.readFileSync(path.join(r.duckDir, file!.slice("Attached file: ".length)), "utf8")).toBe("hello");
    // the job binds to the turn whose prompt carries the lines
    const log = (await import("./timeline-log.js")).TimelineLog;
    new log(r.store.db).append(s.id, {
      type: "turn.started",
      turnId: "u1",
      promptMessageId: "m",
      text: sent.text,
      at: new Date().toISOString(),
    } as any);
    expect(r.jobs.reconcileJob(r.pid, r.jobs.get(job.id)!.job).state).toBe("working");
  });

  it("allow: a claim granted sends the attachments too", async () => {
    const r = rig();
    const a = r.chat("Layout builder");
    const post = r.room.personPost(r.pid, "fix the layout builder spacing", "room", [img(JPG)]);
    const job = r.jobs.fromMessage(r.pid, post.id);
    r.jobs.claim(a, r.pid, job.id, "5 min");
    await r.jobs.act(r.pid, job.id, { action: "allow" });
    expect(r.sent).toHaveLength(1);
    expect(lines(r.sent[0]!.text)).toHaveLength(1);
    expect(r.sent[0]!.text).toContain("image-1.jpg");
  });

  it("new duck: the first message of the new thread carries them", async () => {
    const r = rig();
    const post = r.room.personPost(r.pid, "add a dark mode toggle to settings", "room", [img()]);
    const job = r.jobs.fromMessage(r.pid, post.id);
    await r.jobs.act(r.pid, job.id, { action: "new" });
    expect(r.started).toHaveLength(1);
    expect(lines(r.started[0]!)).toHaveLength(1);
    expect(r.started[0]).toMatch(/^add a dark mode toggle to settings\n\n@⟦image-1\.png⟧/);
  });

  it("a picture-only message still makes a job with words, and nothing is sent without attachments", async () => {
    const r = rig();
    r.chat("Layout builder");
    const job = r.jobs.fromMessage(r.pid, r.room.personPost(r.pid, "", "room", [img()]).id);
    expect(job.text).toBe("See the attached images.");
    const plain = r.jobs.fromMessage(r.pid, r.room.personPost(r.pid, "fix the layout builder spacing").id);
    await r.jobs.act(r.pid, plain.id, { action: "go" });
    expect(r.sent[0]!.text).toBe("fix the layout builder spacing");
  });

  it("refuses to write through a symlinked .context", async () => {
    const r = rig();
    r.chat("Layout builder");
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "elsewhere-"));
    fs.symlinkSync(elsewhere, path.join(r.duckDir, ".context"));
    const job = r.jobs.fromMessage(
      r.pid,
      r.room.personPost(r.pid, "fix the layout builder spacing", "room", [img()]).id,
    );
    await expect(r.jobs.act(r.pid, job.id, { action: "go" })).rejects.toThrow(/isn't safe/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(r.sent).toEqual([]);
  });
});

describe("the room routes", () => {
  async function server() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attach-srv-"));
    const store = new NativeStore(":memory:");
    const host = new SessionHost({ store } as any);
    const tokenPath = path.join(dir, "hook-token");
    const srv = new NativeServer({
      host,
      store,
      workspaces: new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") }),
      tokenPath,
      supportDir: dir,
      port: 0,
      heartbeatMs: 40,
    });
    const port = await srv.start();
    open.push(async () => {
      await srv.stop();
      await host.stop();
    });
    const project = store.createProject({ name: "app", rootPath: dir, defaultBranch: "main", kind: "folder" });
    store.saveProjectSettings({ ...store.getProjectSettings(project.id), askBeforeStarting: true }); // these tests tap Go
    const other = store.createProject({ name: "other", rootPath: dir + "-o", defaultBranch: "main", kind: "folder" });
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    const call = (method: string, url: string, body?: unknown, tok: string | null = token) =>
      fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: {
          ...(tok ? { "x-squeak-token": tok } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { call, pid: project.id, other: other.id };
  }

  it("takes attachments on a post and serves them behind the token, per pond, files as downloads", async () => {
    const s = await server();
    const res = await s.call("POST", `/native/projects/${s.pid}/room`, {
      text: "see",
      attachments: [img(), doc("a b.pdf")],
    });
    expect(res.status).toBe(201);
    const { post } = (await res.json()) as any;
    expect(post.attachments).toHaveLength(2);
    const page = (await (await s.call("GET", `/native/projects/${s.pid}/room`)).json()) as any;
    expect(page.posts[0].attachments.map((a: any) => a.name)).toEqual(["image-1.png", "a b.pdf"]);

    const image = await s.call("GET", post.attachments[0].url);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);
    const file = await s.call("GET", post.attachments[1].url);
    expect(file.headers.get("content-disposition")).toContain("attachment");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");

    expect((await s.call("GET", post.attachments[0].url, undefined, null)).status).toBe(401);
    expect((await s.call("GET", post.attachments[0].url, undefined, "wrong")).status).toBe(401);
    expect((await s.call("GET", post.attachments[0].url.replace(s.pid, s.other))).status).toBe(404);
    expect((await s.call("GET", `/native/projects/${s.pid}/room/attachments/nope`)).status).toBe(404);
  });

  it("answers 400 for a bad attachment or an empty post, and a picture alone is fine", async () => {
    const s = await server();
    const url = `/native/projects/${s.pid}/room`;
    expect((await s.call("POST", url, { text: "x", attachments: [{ name: "a", data: "!!" }] })).status).toBe(400);
    expect(
      (await s.call("POST", url, { text: "x", attachments: [{ name: "a", data: b64("x"), path: "/" }] })).status,
    ).toBe(400);
    expect((await s.call("POST", url, { text: "" })).status).toBe(400);
    expect((await s.call("POST", url, { attachments: [img()] })).status).toBe(201);
    expect((await s.call("POST", url, { text: "x", attachments: Array.from({ length: 5 }, () => img()) })).status).toBe(
      400,
    );
  });

  it("the stream carries the post's attachments", async () => {
    const s = await server();
    const stream = await s.call("GET", `/native/projects/${s.pid}/room/stream`);
    const reader = stream.body!.getReader();
    await reader.read();
    await s.call("POST", `/native/projects/${s.pid}/room`, { text: "see", attachments: [img()] });
    let text = "";
    const dec = new TextDecoder();
    while (!text.includes("event: post")) text += dec.decode((await reader.read()).value);
    while (!/data: .*\n\n/.test(text.slice(text.indexOf("event: post"))))
      text += dec.decode((await reader.read()).value);
    await reader.cancel();
    expect(text).toContain('"attachments":[{"id"');
  });
});
