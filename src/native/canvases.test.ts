/* eslint-disable @typescript-eslint/no-explicit-any -- JSON replies are read loosely in tests */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CANVAS_LINE, buildThreadContext } from "./thread-context.js";
import { TOOLS } from "./agent-tools.js";
import { Artifacts, artifactKindFromPath, scanArtifactFolder } from "./artifacts.js";
import {
  addArtboard,
  applyCanvasOp,
  artboardPath,
  CanvasError,
  CanvasWatcher,
  createCanvas,
  deleteArtboard,
  duplicateArtboard,
  isCanvasDir,
  listCanvasesIn,
  packCanvasBundle,
  readCanvas,
  reorderArtboards,
  resolveCanvasDir,
  saveArtboardHtml,
  slugify,
  updateArtboard,
  validateCanvas,
} from "./canvases.js";
import { SessionHost } from "./host.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import type { Runner, RunnerHooks, SessionRow } from "./types.js";
import { WorkspaceManager } from "./workspaces.js";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

describe("canvas format", () => {
  it("slugifies titles to folder-safe names", () => {
    expect(slugify("Q3 Launch Deck!")).toBe("q3-launch-deck");
    expect(slugify("  ../../etc  ")).toBe("etc");
    expect(slugify("日本語")).toBe("canvas");
    expect(slugify("Café")).toBe("cafe");
  });

  it("validates canvas.json and drops unknown fields", () => {
    const ok = validateCanvas({
      version: 1,
      title: " T ",
      kind: "deck",
      extra: 1,
      artboards: [{ id: "a", name: "A", width: 1920, height: 1080, background: "#fff", junk: 1 }],
    });
    expect(ok).toEqual({
      version: 1,
      title: "T",
      kind: "deck",
      artboards: [{ id: "a", name: "A", width: 1920, height: 1080, background: "#fff" }],
    });
    expect(() => validateCanvas(null)).toThrow(CanvasError);
    expect(() => validateCanvas({ version: 2, title: "x", artboards: [] })).toThrow(/version/);
    expect(() =>
      validateCanvas({ version: 1, title: "x", artboards: [{ id: "../x", name: "n", width: 100, height: 100 }] }),
    ).toThrow(/bad id/);
    expect(() =>
      validateCanvas({ version: 1, title: "x", artboards: [{ id: "a", name: "n", width: 5, height: 100 }] }),
    ).toThrow(/width/);
    const dup = { id: "a", name: "n", width: 100, height: 100 };
    expect(() => validateCanvas({ version: 1, title: "x", artboards: [dup, dup] })).toThrow(/Duplicate/);
    expect(validateCanvas({ version: 1, title: "x", kind: "weird", artboards: [] }).kind).toBe("blank");
  });
});

describe("canvas files", () => {
  it("creates each kind at its size with a starter artboard", () => {
    const root = tmp("canvas-kinds-");
    const sizes = {
      deck: [1920, 1080],
      poster: [1080, 1350],
      logo: [1024, 1024],
      social: [1080, 1080],
      blank: [1080, 1080],
    };
    for (const [kind, [w, h]] of Object.entries(sizes)) {
      const made = createCanvas(root, `My ${kind}`, kind);
      expect(made.canvas.kind).toBe(kind);
      expect(made.canvas.artboards).toHaveLength(1);
      expect([made.canvas.artboards[0]!.width, made.canvas.artboards[0]!.height]).toEqual([w, h]);
      const html = fs.readFileSync(made.artboards[0]!.file, "utf8");
      expect(html).toContain(`width: ${w}px; height: ${h}px`);
      expect(isCanvasDir(made.path)).toBe(true);
    }
    expect(createCanvas(root, "Deck", "deck").artboards[0]!.id).toBe("title");
  });

  it("escapes the title in the starter and numbers a taken slug", () => {
    const root = tmp("canvas-slug-");
    const a = createCanvas(root, "<script>x</script>", "deck");
    expect(fs.readFileSync(a.artboards[0]!.file, "utf8")).not.toContain("<script>");
    const b = createCanvas(root, "Same", "poster");
    const c = createCanvas(root, "Same", "poster");
    expect(path.basename(b.path)).toBe("same.canvas");
    expect(path.basename(c.path)).toBe("same-2.canvas");
    expect(createCanvas(root, "x", "nonsense").canvas.kind).toBe("blank");
    expect(() => createCanvas(root, "  ", "deck")).toThrow(/title/);
  });

  it("adds, updates, reorders and deletes artboards", () => {
    const root = tmp("canvas-edit-");
    const { path: dir } = createCanvas(root, "Deck", "deck");
    const s2 = addArtboard(dir, { name: "Slide Two", html: "<p>2</p>" });
    expect(s2).toMatchObject({ id: "slide-two", width: 1920, height: 1080 });
    const s3 = addArtboard(dir, { name: "Slide Two", width: 800, height: 600, html: "<p>3</p>" });
    expect(s3.id).toBe("slide-two-2");
    expect(s3.width).toBe(800);
    // The next one inherits the last artboard's size.
    expect(addArtboard(dir, { name: "four", html: "x" })).toMatchObject({ width: 800, height: 600 });
    updateArtboard(dir, "slide-two", { html: "<p>new</p>", name: "Renamed", width: 1000 });
    const detail = readCanvas(dir);
    expect(detail.artboards.find((a) => a.id === "slide-two")).toMatchObject({
      name: "Renamed",
      width: 1000,
      height: 1080,
    });
    expect(fs.readFileSync(artboardPath(dir, "slide-two"), "utf8")).toBe("<p>new</p>");
    expect(reorderArtboards(dir, ["four", "title", "title", "nope"]).map((a) => a.id)).toEqual([
      "four",
      "title",
      "slide-two",
      "slide-two-2",
    ]);
    deleteArtboard(dir, "four");
    expect(readCanvas(dir).canvas.artboards.map((a) => a.id)).not.toContain("four");
    expect(fs.existsSync(artboardPath(dir, "four"))).toBe(false);
    expect(() => updateArtboard(dir, "ghost", { name: "x" })).toThrow(/No artboard/);
    expect(() => deleteArtboard(dir, "ghost")).toThrow(/No artboard/);
    expect(() => addArtboard(dir, { name: "big", width: 99999, html: "x" })).toThrow(/width/);
    expect(() => addArtboard(dir, { name: "huge", html: "x".repeat(1024 * 1024 + 1) })).toThrow(/1 MB/);
  });

  it("keeps every artboard path inside the canvas folder", () => {
    const root = tmp("canvas-safe-");
    const { path: dir } = createCanvas(root, "Safe", "blank");
    for (const bad of ["../x", "a/b", "..", "/etc/passwd", "A", "", "a.b"]) {
      expect(() => artboardPath(dir, bad)).toThrow(CanvasError);
      expect(() => updateArtboard(dir, bad, { html: "x" })).toThrow(CanvasError);
    }
    expect(fs.readdirSync(root)).toEqual(["canvases"]);
  });

  it("lists a folder's canvases newest first and skips broken ones", () => {
    const root = tmp("canvas-list-");
    const old = createCanvas(root, "Old", "blank");
    const fresh = createCanvas(root, "Fresh", "deck");
    fs.utimesSync(path.join(old.path, "canvas.json"), 1000, 1000);
    fs.utimesSync(path.join(old.path, "artboards", "artboard-1.html"), 1000, 1000);
    fs.mkdirSync(path.join(root, "canvases", "broken.canvas"));
    fs.mkdirSync(path.join(root, "canvases", "plain-folder"));
    const list = listCanvasesIn(root, { duckId: "d", branch: "b" });
    expect(list.map((c) => c.title)).toEqual(["Fresh", "Old"]);
    expect(list[0]).toMatchObject({ kind: "deck", artboards: 1, duckId: "d", branch: "b", slug: "fresh" });
    expect(list[0]!.path).toBe(fresh.path);
    expect(listCanvasesIn(tmp("canvas-none-"))).toEqual([]);
  });

  it("reports the newest asset change so viewers redraw when a picture changes", () => {
    const root = tmp("canvas-assets-");
    const { path: dir } = createCanvas(root, "Pics", "blank");
    expect(readCanvas(dir).assetsModifiedAt).toBe(0);
    fs.writeFileSync(path.join(dir, "assets", "a.png"), "x");
    fs.utimesSync(path.join(dir, "assets", "a.png"), 5000, 5000);
    expect(readCanvas(dir).assetsModifiedAt).toBe(5_000_000);
  });

  it("resolves a canvas only inside the allowed roots, by real path", () => {
    const root = tmp("canvas-resolve-");
    const outside = tmp("canvas-outside-");
    const mine = createCanvas(root, "Mine", "blank");
    const theirs = createCanvas(outside, "Theirs", "blank");
    expect(resolveCanvasDir(mine.path, [root])).toBe(fs.realpathSync(mine.path));
    expect(() => resolveCanvasDir(theirs.path, [root])).toThrow(/outside/);
    expect(() => resolveCanvasDir("canvases/mine.canvas", [root])).toThrow(/full path/);
    expect(() => resolveCanvasDir(path.join(root, "canvases", "nope.canvas"), [root])).toThrow(/No such/);
    expect(() => resolveCanvasDir(path.join(root, "canvases"), [root])).toThrow(/not a canvas/);
    fs.symlinkSync(theirs.path, path.join(root, "canvases", "link.canvas"));
    expect(() => resolveCanvasDir(path.join(root, "canvases", "link.canvas"), [root])).toThrow(/outside/);
  });
});

describe("canvas hand edits and structure", () => {
  it("saves one artboard's HTML without touching canvas.json, and refuses what is not an artboard", () => {
    const root = tmp("canvas-save-");
    const { path: dir } = createCanvas(root, "Deck", "deck");
    const before = fs.readFileSync(path.join(dir, "canvas.json"), "utf8");
    const at = saveArtboardHtml(dir, "title", "<p data-sq-id='a'>hi</p>");
    expect(at).toBeGreaterThan(0);
    expect(fs.readFileSync(artboardPath(dir, "title"), "utf8")).toBe("<p data-sq-id='a'>hi</p>");
    expect(fs.readFileSync(path.join(dir, "canvas.json"), "utf8")).toBe(before);
    expect(fs.readdirSync(path.join(dir, "artboards")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(() => saveArtboardHtml(dir, "ghost", "x")).toThrow(/No artboard/);
    expect(() => saveArtboardHtml(dir, "../x", "x")).toThrow(CanvasError);
    expect(() => saveArtboardHtml(dir, "title", 5)).toThrow(/html/);
    expect(() => saveArtboardHtml(dir, "title", "x".repeat(1024 * 1024 + 1))).toThrow(/1 MB/);
  });

  it("duplicates an artboard right after itself with its HTML", () => {
    const root = tmp("canvas-dup-");
    const { path: dir } = createCanvas(root, "Deck", "deck");
    saveArtboardHtml(dir, "title", "<p>one</p>");
    const copy = duplicateArtboard(dir, "title");
    expect(copy).toMatchObject({ id: "title-copy", name: "Title copy", width: 1920 });
    expect(fs.readFileSync(artboardPath(dir, copy.id), "utf8")).toBe("<p>one</p>");
    expect(readCanvas(dir).canvas.artboards.map((a) => a.id)).toEqual(["title", "title-copy"]);
    expect(() => duplicateArtboard(dir, "ghost")).toThrow(/No artboard/);
  });

  it("applies list operations: add, rename, duplicate, reorder, resize, delete", () => {
    const root = tmp("canvas-op-");
    const { path: dir } = createCanvas(root, "Poster", "poster");
    let d = applyCanvasOp(dir, { op: "add", name: "Wide", width: 1600, height: 900 });
    expect(d.canvas.artboards.map((a) => [a.id, a.width, a.height])).toEqual([
      ["poster", 1080, 1350],
      ["wide", 1600, 900],
    ]);
    // A new artboard is a blank page of its own size.
    expect(fs.readFileSync(artboardPath(dir, "wide"), "utf8")).toContain("width: 1600px");
    d = applyCanvasOp(dir, { op: "add" });
    expect(d.canvas.artboards[2]).toMatchObject({ name: "Artboard 3", width: 1600 });
    d = applyCanvasOp(dir, { op: "rename", id: "wide", name: "Banner" });
    expect(d.canvas.artboards[1]!.name).toBe("Banner");
    d = applyCanvasOp(dir, { op: "resize", id: "wide", width: 1200, height: 628 });
    expect(d.canvas.artboards[1]).toMatchObject({ width: 1200, height: 628 });
    d = applyCanvasOp(dir, { op: "duplicate", id: "poster" });
    expect(d.canvas.artboards.map((a) => a.id)).toEqual(["poster", "poster-copy", "wide", "artboard-3"]);
    d = applyCanvasOp(dir, { op: "reorder", order: ["wide", "poster"] });
    expect(d.canvas.artboards.map((a) => a.id)).toEqual(["wide", "poster", "poster-copy", "artboard-3"]);
    d = applyCanvasOp(dir, { op: "delete", id: "poster-copy" });
    expect(d.canvas.artboards.map((a) => a.id)).toEqual(["wide", "poster", "artboard-3"]);
    expect(() => applyCanvasOp(dir, { op: "explode" })).toThrow(/Unknown/);
    expect(() => applyCanvasOp(dir, { op: "reorder", order: "x" })).toThrow(/order/);
    expect(() => applyCanvasOp(dir, { op: "rename", id: "ghost", name: "x" })).toThrow(/No artboard/);
    expect(() => applyCanvasOp(dir, { op: "resize", id: "wide", width: 1, height: 1 })).toThrow(/width/);
  });

  it("packs a canvas into one bundle: artboards and images, never links, dot files or past the cap", () => {
    const root = tmp("canvas-bundle-");
    const { path: dir } = createCanvas(root, "Deck", "deck");
    saveArtboardHtml(dir, "title", "<img src='../assets/a.png'>");
    fs.writeFileSync(path.join(dir, "assets", "a.png"), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(dir, "assets", ".secret"), "no");
    const outside = tmp("canvas-bundle-out-");
    fs.writeFileSync(path.join(outside, "x.png"), "private");
    fs.symlinkSync(path.join(outside, "x.png"), path.join(dir, "assets", "link.png"));
    const bundle = JSON.parse(packCanvasBundle(dir).toString("utf8"));
    expect(bundle).toMatchObject({ format: "squeak-canvas-bundle", version: 1 });
    expect(bundle.canvas.artboards[0].id).toBe("title");
    expect(bundle.artboards.title).toContain("a.png");
    expect(Object.keys(bundle.assets)).toEqual(["a.png"]);
    expect(Buffer.from(bundle.assets["a.png"], "base64")).toEqual(Buffer.from([1, 2, 3]));
    expect(() => packCanvasBundle(dir, 20)).toThrow(/too large/);
  });
});

describe("canvases a remote member may be handed", () => {
  it("shares a canvas folder as an output, never one a private chat showed or outside the pond", () => {
    const store = new NativeStore(":memory:");
    const root = tmp("canvas-share-");
    const project = store.createProject({ name: "app", rootPath: root, defaultBranch: "main", kind: "folder" });
    const made = createCanvas(root, "Launch", "deck");
    const svc = new Artifacts({ store });
    const got = svc.shareable(project.id, new Set());
    expect(got.map((a) => `${a.name}:${a.kind}`)).toEqual(["launch.canvas:canvas"]);
    expect(got[0]!.path).toBe(path.resolve(made.path));
    expect(got[0]!.id).toMatch(/^[a-f0-9]{16}$/);
    // shown from outside the pond folders: not handed over
    const stray = createCanvas(tmp("canvas-share-out-"), "Stray", "blank");
    store.recordShownArtifact({ projectId: project.id, path: stray.path, sessionId: "s", duckId: null, at: 9 });
    expect(svc.shareable(project.id, new Set()).map((a) => a.name)).toEqual(["launch.canvas"]);
  });
});

describe("canvas watcher", () => {
  const waitFor = async (ok: () => boolean, ms = 4000): Promise<void> => {
    const end = Date.now() + ms;
    while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  };

  it("emits one debounced changed for a burst, ignores temp files, and closes with the last listener", async () => {
    const root = tmp("canvas-watch-");
    const { path: dir } = createCanvas(root, "W", "blank");
    const w = new CanvasWatcher(80);
    let n = 0;
    const stop = w.subscribe(dir, () => n++);
    const stop2 = w.subscribe(dir, () => undefined);
    expect(w.watched()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 300));
    n = 0;
    fs.writeFileSync(path.join(dir, "artboards", "x.html.1.tmp"), "x");
    await new Promise((r) => setTimeout(r, 300));
    expect(n).toBe(0);
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, "artboards", "artboard-1.html"), `v${i}`);
    await waitFor(() => n > 0);
    await new Promise((r) => setTimeout(r, 300));
    expect(n).toBe(1);
    stop();
    expect(w.watched()).toHaveLength(1);
    stop2();
    stop2();
    expect(w.watched()).toEqual([]);
    w.close();
  });
});

describe("canvases as artifacts", () => {
  it("lists a canvas folder as one artifact of kind canvas", () => {
    const root = tmp("canvas-art-");
    createCanvas(root, "Deck", "deck");
    fs.writeFileSync(path.join(root, "pic.png"), "x");
    const found = scanArtifactFolder({ root });
    expect(found.map((a) => `${a.name}:${a.kind}`).sort()).toEqual(["deck.canvas:canvas", "pic.png:image"]);
    expect(artifactKindFromPath("/x/deck.canvas")).toBe("canvas");
  });
});

describe("canvas thread note", () => {
  it("is in the thread context and states the format", () => {
    expect(CANVAS_LINE).toMatch(/self-contained/);
    expect(CANVAS_LINE).toMatch(/1920x1080/);
    expect(CANVAS_LINE).toMatch(/canvas_add_artboard/);
    expect(buildThreadContext({ title: "t", agent: "claude" } as any)).toContain(CANVAS_LINE);
  });
});

// ------------------------------------------------------------------------------------------------ over HTTP

interface Harness {
  base: string;
  token: string;
  store: NativeStore;
  dir: string;
  server: NativeServer;
}

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

async function start(): Promise<Harness> {
  const dir = tmp("canvas-http-");
  const store = new NativeStore(":memory:");
  const host = new SessionHost({
    store,
    runnerFactory: (_s: SessionRow, h: RunnerHooks): Runner => ({
      canSteer: false,
      send: async () => h.onStatus("working"),
      steer: async () => false,
      interrupt: async () => {},
      setPermissionMode: async () => {},
      close: async () => {},
    }),
  });
  const tokenPath = path.join(dir, "hook-token");
  const server = new NativeServer({
    host,
    store,
    workspaces: new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") }),
    tokenPath,
    port: 0,
    heartbeatMs: 50,
  });
  const port = await server.start();
  open.push(async () => {
    await server.stop();
    await host.stop();
  });
  return { base: `http://127.0.0.1:${port}`, token: fs.readFileSync(tokenPath, "utf8").trim(), store, dir, server };
}

async function call(h: Harness, method: string, url: string, body?: unknown, token: string | null = h.token) {
  const res = await fetch(h.base + url, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { "x-squeak-token": token } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

const pond = (h: Harness) => {
  const root = tmp("canvas-pond-");
  return {
    root,
    project: h.store.createProject({ name: "app", rootPath: root, defaultBranch: "main", kind: "folder" }),
  };
};

const mcp = async (h: Harness, sessionId: string, name: string, args: Record<string, unknown>) => {
  const ep = h.server.mcpEndpoint(sessionId)!;
  const res = await fetch(ep.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ep.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return ((await res.json()) as any).result as { content: { text: string }[]; isError?: boolean };
};

describe("canvas routes", () => {
  it("creates, lists and reads a canvas; gated by the token with no CORS header", async () => {
    const h = await start();
    const { project } = pond(h);
    const url = `/native/projects/${project.id}/canvases`;
    expect((await call(h, "GET", url, undefined, null)).status).toBe(401);
    expect((await call(h, "GET", url)).json.canvases).toEqual([]);
    const made = await call(h, "POST", url, { title: "Launch", kind: "poster" });
    expect(made.status).toBe(201);
    expect(made.json.canvas).toMatchObject({ title: "Launch", kind: "poster", artboards: 1 });
    expect(made.headers.get("access-control-allow-origin")).toBeNull();
    const list = (await call(h, "GET", url)).json.canvases;
    expect(list).toHaveLength(1);
    const detail = await call(h, "GET", `/native/canvases?path=${encodeURIComponent(list[0].path)}`);
    expect(detail.status).toBe(200);
    expect(detail.json.canvas.artboards[0]).toMatchObject({ width: 1080, height: 1350 });
    expect(detail.json.artboards[0].file).toContain("artboards");
    expect((await call(h, "POST", url, { kind: "deck" })).status).toBe(400);
    expect((await call(h, "POST", url, { title: "x", kind: "wrong" })).status).toBe(400);
    expect((await call(h, "GET", "/native/projects/nope/canvases")).status).toBe(404);
  });

  it("refuses a canvas outside every pond and a missing path", async () => {
    const h = await start();
    pond(h);
    const stray = createCanvas(tmp("canvas-stray-"), "Stray", "blank");
    expect((await call(h, "GET", `/native/canvases?path=${encodeURIComponent(stray.path)}`)).status).toBe(404);
    expect((await call(h, "GET", "/native/canvases")).status).toBe(400);
  });

  it("saves an artboard by PUT and applies list operations by POST; token-gated, no CORS, inside ponds only", async () => {
    const h = await start();
    const { project } = pond(h);
    const made = await call(h, "POST", `/native/projects/${project.id}/canvases`, { title: "Edit", kind: "deck" });
    const dir = made.json.canvas.path as string;
    const q = (extra = "") => `?path=${encodeURIComponent(dir)}${extra}`;
    const put = `/native/canvases/artboard${q("&id=title")}`;
    expect((await call(h, "PUT", put, { html: "<p>x</p>" }, null)).status).toBe(401);
    const saved = await call(h, "PUT", put, { html: "<p>by hand</p>" });
    expect(saved.status).toBe(200);
    expect(saved.json.modifiedAt).toBeGreaterThan(0);
    expect(saved.headers.get("access-control-allow-origin")).toBeNull();
    expect(fs.readFileSync(path.join(dir, "artboards", "title.html"), "utf8")).toBe("<p>by hand</p>");
    expect((await call(h, "PUT", `/native/canvases/artboard${q("&id=ghost")}`, { html: "x" })).status).toBe(400);
    expect((await call(h, "PUT", `/native/canvases/artboard${q("&id=..%2Fx")}`, { html: "x" })).status).toBe(400);
    expect((await call(h, "PUT", put, { html: "x".repeat(1024 * 1024 + 1) })).status).toBe(400);
    const stray = createCanvas(tmp("canvas-stray-"), "Stray", "blank");
    expect(
      (
        await call(h, "PUT", `/native/canvases/artboard?path=${encodeURIComponent(stray.path)}&id=artboard-1`, {
          html: "x",
        })
      ).status,
    ).toBe(404);
    const added = await call(h, "POST", `/native/canvases/manage${q()}`, { op: "add", name: "Two" });
    expect(added.status).toBe(200);
    expect(added.json.canvas.artboards.map((a: any) => a.id)).toEqual(["title", "two"]);
    expect((await call(h, "POST", `/native/canvases/manage${q()}`, { op: "nope" })).status).toBe(400);
    expect((await call(h, "POST", `/native/canvases/manage${q()}`, { op: "add" }, null)).status).toBe(401);
  });

  it("streams hello, then changed when an artboard is written", async () => {
    const h = await start();
    const { project } = pond(h);
    const made = await call(h, "POST", `/native/projects/${project.id}/canvases`, { title: "Live", kind: "deck" });
    const dir = made.json.canvas.path as string;
    const events: string[] = [];
    const req = http.get(
      `${h.base}/native/canvases/stream?path=${encodeURIComponent(dir)}`,
      { headers: { "x-squeak-token": h.token } },
      (res) => {
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          for (const m of c.matchAll(/^event: (\w+)/gm)) events.push(m[1]!);
        });
      },
    );
    open.push(async () => void req.destroy());
    const waitFor = async (ok: () => boolean) => {
      const end = Date.now() + 4000;
      while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    };
    await waitFor(() => events.includes("hello"));
    await new Promise((r) => setTimeout(r, 300));
    updateArtboard(dir, "title", { html: "<p>changed</p>" });
    await waitFor(() => events.includes("changed"));
    expect(events).toContain("changed");
    expect((await call(h, "GET", "/native/canvases/stream", undefined, null)).status).toBe(401);
  });
});

describe("canvas tools", () => {
  it("lists the four tools", () => {
    for (const n of ["canvas_create", "canvas_add_artboard", "canvas_update_artboard", "canvas_open"]) {
      expect(TOOLS.find((t) => t.name === n)).toBeTruthy();
    }
  });

  it("creates, adds, updates and opens a canvas in the chat's folder", async () => {
    const h = await start();
    const cwd = tmp("canvas-chat-");
    const s = h.store.createSession({ cwd, agent: "claude", model: "sonnet", permissionMode: "default", title: "A" });
    const created = await mcp(h, s.id, "canvas_create", { title: "Pitch", kind: "deck" });
    expect(created.isError).toBeFalsy();
    const dir = path.join(fs.realpathSync(cwd), "canvases", "pitch.canvas");
    expect(created.content[0]!.text).toContain("pitch.canvas");
    expect(isCanvasDir(dir)).toBe(true);
    const added = await mcp(h, s.id, "canvas_add_artboard", {
      canvas: "pitch",
      name: "Agenda",
      html: "<h1>Agenda</h1>",
    });
    expect(added.content[0]!.text).toMatch(/agenda \(1920x1080\)/);
    const upd = await mcp(h, s.id, "canvas_update_artboard", {
      canvas: "pitch.canvas",
      id: "agenda",
      html: "<h1>2</h1>",
      width: 1280,
      height: 720,
    });
    expect(upd.content[0]!.text).toMatch(/1280x720/);
    expect(fs.readFileSync(artboardPath(dir, "agenda"), "utf8")).toBe("<h1>2</h1>");
    const opened = await mcp(h, s.id, "canvas_open", { canvas: dir });
    expect(opened.isError).toBeFalsy();
    const ev = h.store.messagesAfter(s.id).find((m) => m.kind === "squeak/show");
    expect((ev!.payload as any).relative).toBe(path.join("canvases", "pitch.canvas"));
    expect((ev!.payload as any).title).toBe("Pitch");
  });

  it("refuses bad input and canvases outside the chat's folder", async () => {
    const h = await start();
    const cwd = tmp("canvas-chat2-");
    const s = h.store.createSession({ cwd, agent: "claude", model: "sonnet", permissionMode: "default", title: "A" });
    const other = createCanvas(tmp("canvas-other-"), "Other", "blank");
    expect((await mcp(h, s.id, "canvas_create", {})).isError).toBe(true);
    expect((await mcp(h, s.id, "canvas_add_artboard", { name: "x", html: "x" })).isError).toBe(true);
    expect((await mcp(h, s.id, "canvas_add_artboard", { canvas: "ghost", name: "x", html: "x" })).isError).toBe(true);
    expect((await mcp(h, s.id, "canvas_open", { canvas: other.path })).content[0]!.text).toMatch(/outside/);
    expect(
      (await mcp(h, s.id, "canvas_update_artboard", { canvas: other.path, id: "artboard-1", html: "x" })).isError,
    ).toBe(true);
    expect((await mcp(h, s.id, "canvas_open", { canvas: "../../etc/x.canvas" })).isError).toBe(true);
  });
});
