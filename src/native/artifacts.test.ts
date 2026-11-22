/* eslint-disable @typescript-eslint/no-explicit-any -- JSON replies are read loosely in tests */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleMcpMessage } from "./agent-tools.js";
import {
  artifactKindFromPath,
  artifactWireId,
  Artifacts,
  mergeArtifacts,
  scanArtifactFolder,
  type ArtifactItem,
} from "./artifacts.js";
import { SessionHost } from "./host.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

describe("artifact kinds and scan", () => {
  it("classifies by extension", () => {
    expect(artifactKindFromPath("a.HTML")).toBe("page");
    expect(artifactKindFromPath("a.md")).toBe("page");
    expect(artifactKindFromPath("a.psd")).toBe("psd");
    expect(artifactKindFromPath("a.ai")).toBe("ai");
    expect(artifactKindFromPath("a.svg")).toBe("svg");
    expect(artifactKindFromPath("a.pdf")).toBe("pdf");
    expect(artifactKindFromPath("a.webp")).toBe("image");
    expect(artifactKindFromPath("a.ts")).toBe("other");
  });

  it("classifies slides, documents and media", () => {
    for (const e of ["pptx", "ppt", "key"]) expect(artifactKindFromPath(`a.${e}`)).toBe("slides");
    for (const e of ["docx", "doc", "pages", "rtf", "xlsx", "numbers", "csv"])
      expect(artifactKindFromPath(`a.${e}`)).toBe("doc");
    for (const e of ["mp4", "MOV"]) expect(artifactKindFromPath(`a.${e}`)).toBe("video");
    for (const e of ["m4a", "mp3"]) expect(artifactKindFromPath(`a.${e}`)).toBe("audio");
  });

  it("finds slides, documents and media in a scan, within the same caps", () => {
    const root = tmp("art-scan-media-");
    for (const f of ["deck.key", "d/talk.pptx", "r.docx", "m.mp4", "s.mp3", "notes.ts"]) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), "x");
    }
    const found = scanArtifactFolder({ root });
    expect(found.map((a) => `${a.name}:${a.kind}`).sort()).toEqual([
      "deck.key:slides",
      "m.mp4:video",
      "r.docx:doc",
      "s.mp3:audio",
      "talk.pptx:slides",
    ]);
    expect(scanArtifactFolder({ root }, { maxFiles: 2 })).toHaveLength(2);
  });

  it("finds design files, skips build dirs, dot dirs, source, depth and the count cap", () => {
    const root = tmp("art-scan-");
    for (const f of [
      "logo.psd",
      "x/mock.png",
      "node_modules/p/i.png",
      ".git/i.png",
      "dist/i.png",
      "src/a.ts",
      "a/b/c/d.svg",
    ]) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), "x");
    }
    const names = scanArtifactFolder({ root, duckId: "d1", branch: "b" })
      .map((a) => path.relative(root, a.path))
      .sort();
    expect(names).toEqual(["a/b/c/d.svg", "logo.psd", "x/mock.png"]);
    expect(
      scanArtifactFolder({ root }, { maxDepth: 1 })
        .map((a) => a.name)
        .sort(),
    ).toEqual(["logo.psd", "mock.png"]);
    expect(scanArtifactFolder({ root }, { maxFiles: 1 })).toHaveLength(1);
    expect(scanArtifactFolder({ root, duckId: "d1" })[0]!.duckId).toBe("d1");
  });

  it("merge: shown wins over found for one path, newest first", () => {
    const mk = (p: string, source: "shown" | "found", at: number, duckId?: string): ArtifactItem => ({
      path: p,
      name: path.basename(p),
      kind: "image",
      source,
      modifiedAt: at,
      size: 1,
      ...(duckId ? { duckId } : {}),
    });
    const out = mergeArtifacts(
      [mk("/a/x.png", "shown", 5, "d")],
      [mk("/a/x.png", "found", 9), mk("/a/y.png", "found", 7)],
    );
    expect(out.map((a) => [a.name, a.source, a.duckId])).toEqual([
      ["y.png", "found", undefined],
      ["x.png", "shown", "d"],
    ]);
  });
});

describe("shown rows", () => {
  it("keeps every show newest first, per pond, and survives reopening the database", () => {
    const dir = tmp("art-db-");
    const file = path.join(dir, "native.db");
    const a = new NativeStore(file);
    a.recordShownArtifact({ projectId: "p", path: "/x/1.html", duckId: "d", sessionId: "s", branch: "b", at: 1 });
    a.recordShownArtifact({ projectId: "p", path: "/x/2.html", sessionId: "s", at: 2 });
    a.recordShownArtifact({ projectId: "q", path: "/x/3.html", sessionId: "s", at: 3 });
    a.close();
    const b = new NativeStore(file);
    expect(b.listShownArtifacts("p").map((r) => [r.path, r.duckId, r.branch])).toEqual([
      ["/x/2.html", null, null],
      ["/x/1.html", "d", "b"],
    ]);
    b.close();
  });
});

describe("Artifacts service", () => {
  it("lists shown + found, drops files that vanished, caches the scan 30 s", () => {
    const store = new NativeStore(":memory:");
    const root = tmp("art-svc-");
    const project = store.createProject({ name: "app", rootPath: root, defaultBranch: "main", kind: "folder" });
    fs.writeFileSync(path.join(root, "page.html"), "<p>");
    fs.writeFileSync(path.join(root, "pic.png"), "x");
    store.recordShownArtifact({ projectId: project.id, path: path.join(root, "page.html"), sessionId: "s", at: 1 });
    store.recordShownArtifact({ projectId: project.id, path: path.join(root, "gone.html"), sessionId: "s", at: 2 });
    let t = 1000;
    let scans = 0;
    const svc = new Artifacts({ store, now: () => t, scan: (f) => (scans++, scanArtifactFolder(f)) });
    const first = svc.list(project.id).artifacts;
    expect(first.map((a) => [a.name, a.source]).sort()).toEqual([
      ["page.html", "shown"],
      ["pic.png", "found"],
    ]);
    svc.list(project.id);
    expect(scans).toBe(1);
    t += 31_000;
    fs.unlinkSync(path.join(root, "pic.png"));
    expect(svc.list(project.id).artifacts.map((a) => a.name)).toEqual(["page.html"]);
    expect(scans).toBe(2);
  });
});

describe("show records and the route", () => {
  it("records a show call and serves it, token-gated with no CORS header", async () => {
    const dir = tmp("art-srv-");
    const store = new NativeStore(":memory:");
    const host = new SessionHost({ store } as any);
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
    open.push(async () => {
      await srv.stop();
      await host.stop();
    });
    const root = tmp("art-pond-");
    const project = store.createProject({ name: "app", rootPath: root, defaultBranch: "main", kind: "folder" });
    const s = store.createSession({ cwd: root, agent: "claude", model: "m", permissionMode: "default", title: "A" });
    fs.writeFileSync(path.join(root, "out.html"), "<h1>x</h1>");
    const res = await handleMcpMessage((srv as any).tools, s.id, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "show", arguments: { path: "out.html" } },
    });
    expect((res as any).result.isError).toBeFalsy();
    expect(store.listShownArtifacts(project.id)).toHaveLength(1);

    const url = `http://127.0.0.1:${port}/native/projects/${project.id}/artifacts`;
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    expect((await fetch(url)).status).toBe(401);
    const ok = await fetch(url, { headers: { "x-squeak-token": token } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    const body = (await ok.json()) as any;
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]).toMatchObject({ name: "out.html", kind: "page", source: "shown" });
    expect(
      (await fetch(`http://127.0.0.1:${port}/native/projects/nope/artifacts`, { headers: { "x-squeak-token": token } }))
        .status,
    ).toBe(404);
  });
});

describe("what a remote member may be handed", () => {
  it("outputs only: no source kinds, nothing from a private chat or duck, never a path", () => {
    const store = new NativeStore(":memory:");
    const root = tmp("art-share-");
    const outside = tmp("art-outside-");
    const project = store.createProject({ name: "app", rootPath: root, defaultBranch: "main", kind: "folder" });
    const write = (dir: string, name: string) => {
      fs.writeFileSync(path.join(dir, name), "x");
      return path.join(dir, name);
    };
    const pub = write(root, "deck.pdf");
    const code = write(root, "main.ts");
    const secret = write(root, "secret.pdf");
    const duckPdf = write(root, "duck.pdf");
    const found = write(root, "found.png");
    const elsewhere = write(outside, "shown.png");
    fs.symlinkSync(path.join(outside, "shown.png"), path.join(root, "link.png"));
    const duck = store.createDuck({ projectId: project.id, name: "Mallard", currentSessionId: "sess-private" });
    const rec = (p: string, sessionId: string, duckId?: string) =>
      store.recordShownArtifact({ projectId: project.id, path: p, sessionId, duckId: duckId ?? null, at: 5 });
    rec(pub, "sess-public");
    rec(code, "sess-public");
    rec(secret, "sess-private");
    rec(duckPdf, "sess-public", duck.id);
    rec(elsewhere, "sess-public");
    const svc = new Artifacts({ store });
    const got = svc.shareable(project.id, new Set(["sess-private"]));
    const names = got.map((a) => a.name).sort();
    // a found symlink is never listed (the scan skips it); a shown file outside every pond folder is never shared
    expect(names).toEqual(["deck.pdf", "found.png"]);
    expect(got.every((a) => a.id === artifactWireId(a.path) && /^[a-f0-9]{16}$/.test(a.id))).toBe(true);
    expect(got.find((a) => a.name === "found.png")!.path).toBe(path.resolve(found));
    // with nothing private, the shown pdf of a private chat and duck come back, source code still does not
    const open = svc.shareable(project.id, new Set()).map((a) => a.name);
    expect(open).toContain("secret.pdf");
    expect(open).toContain("duck.pdf");
    expect(open).not.toContain("main.ts");
  });
});
