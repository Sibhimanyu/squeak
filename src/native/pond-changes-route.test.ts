/* eslint-disable @typescript-eslint/no-explicit-any -- JSON replies are read loosely in tests */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionHost } from "./host.js";
import { PondChangesReader } from "./pond-changes.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

const git = (cwd: string, ...a: string[]): string =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...a], {
    cwd,
    encoding: "utf8",
  });

function rig(kind: "git" | "folder" = "git", maxFiles?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pond-changes-"));
  const root = path.join(dir, "root");
  fs.mkdirSync(root);
  if (kind === "git") {
    git(root, "init", "-b", "main");
    fs.writeFileSync(path.join(root, "a.txt"), "one\ntwo\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "init");
  }
  const store = new NativeStore(":memory:");
  const host = new SessionHost({ store });
  const tokenPath = path.join(dir, "hook-token");
  const srv = new NativeServer({
    host,
    store,
    workspaces: new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws"), gitUser: "t" }),
    tokenPath,
    port: 0,
    routines: false,
    ...(maxFiles ? { pondChanges: (room) => new PondChangesReader({ store, room, maxFiles }) } : {}),
  });
  open.push(async () => {
    await srv.stop();
    await host.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const project = store.createProject({ name: "app", rootPath: root, defaultBranch: "main", kind });
  let listening: Promise<number> | undefined;
  const call = async (url: string, headers: Record<string, string> = {}) => {
    const port = await (listening ??= srv.start());
    return fetch(`http://127.0.0.1:${port}${url}`, { headers });
  };
  const get = async (url: string) => {
    await (listening ??= srv.start());
    return call(url, { "x-squeak-token": fs.readFileSync(tokenPath, "utf8").trim() });
  };
  /** A Duck on its own Stream: a real worktree on branch `branch`, one chat in it. */
  const duckOnStream = (name: string, branch: string) => {
    const wt = path.join(dir, "ws", name);
    git(root, "worktree", "add", "-b", branch, wt, "main");
    const ws = store.createWorkspace({ projectId: project.id, name, path: wt, branch });
    const s = store.createSession({
      cwd: wt,
      agent: "claude",
      model: "m",
      permissionMode: "default",
      title: name,
      workspaceId: ws.id,
    });
    const duck = store.duckForSession(s.id, project.id)!;
    store.updateDuck(duck.id, { name });
    return { duck, wt, ws };
  };
  return { root, project, get, call, duckOnStream, git, tokenPath };
}

describe("GET /native/projects/:id/changes", () => {
  it("groups each Duck's changes by Stream and lists Main's uncommitted work", async () => {
    const r = rig();
    const pip = r.duckOnStream("Pip", "sq/pip");
    const moss = r.duckOnStream("Moss", "sq/moss");
    // Pip: one committed edit and one new, unstaged file. Moss: nothing yet.
    fs.writeFileSync(path.join(pip.wt, "a.txt"), "one\ntwo\nthree\n");
    git(pip.wt, "commit", "-am", "pip edit");
    fs.writeFileSync(path.join(pip.wt, "new.txt"), "x\ny\n");
    // Main: an uncommitted edit.
    fs.writeFileSync(path.join(r.root, "a.txt"), "ONE\ntwo\n");

    const res = await r.get(`/native/projects/${r.project.id}/changes`);
    expect(res.status).toBe(200);
    const body: any = await res.json();

    expect(body.projectId).toBe(r.project.id);
    expect(body.main.branch).toBe("main");
    expect(body.main.files).toMatchObject([{ path: "a.txt", status: "M", added: 1, removed: 1 }]);

    const byName = Object.fromEntries(body.ducks.map((d: any) => [d.duckName, d]));
    expect(Object.keys(byName).sort()).toEqual(["Moss", "Pip"]);
    expect(byName.Pip).toMatchObject({
      duckId: pip.duck.id,
      branch: "sq/pip",
      workspaceId: pip.ws.id,
      truncated: false,
      totals: { added: 3, removed: 0, files: 2 },
    });
    expect(byName.Pip.files).toMatchObject([
      { path: "a.txt", status: "M", added: 1, removed: 0 },
      { path: "new.txt", status: "A", added: 2, removed: 0, untracked: true },
    ]);
    expect(byName.Moss).toMatchObject({ duckId: moss.duck.id, branch: "sq/moss", files: [] });
    expect(body.ducksTruncated).toBe(false);
  });

  it("sees a change as soon as the index moves", async () => {
    const r = rig();
    const pip = r.duckOnStream("Pip", "sq/pip");
    const url = `/native/projects/${r.project.id}/changes`;
    expect(((await (await r.get(url)).json()) as any).ducks[0].files).toEqual([]);
    fs.writeFileSync(path.join(pip.wt, "late.txt"), "z\n");
    r.git(pip.wt, "add", "late.txt"); // staging moves the index file, which drops the remembered answer
    const after: any = await (await r.get(url)).json();
    expect(after.ducks[0].files).toMatchObject([{ path: "late.txt", added: 1 }]);
  });

  it("caps the files per Duck and says so", async () => {
    const r = rig("git", 3);
    const pip = r.duckOnStream("Pip", "sq/pip");
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(pip.wt, `f${i}.txt`), "x\n");
    const body: any = await (await r.get(`/native/projects/${r.project.id}/changes`)).json();
    expect(body.ducks[0].files).toHaveLength(3);
    expect(body.ducks[0].truncated).toBe(true);
    expect(body.ducks[0].totals.files).toBe(5);
  });

  it("is token-gated, has no CORS header and refuses writes", async () => {
    const r = rig();
    const url = `/native/projects/${r.project.id}/changes`;
    expect((await r.call(url)).status).toBe(401);
    expect((await r.call(url, { "x-squeak-token": "wrong" })).status).toBe(401);
    const ok = await r.get(url);
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    const port = new URL(ok.url).port;
    const post = await fetch(`http://127.0.0.1:${port}${url}`, {
      method: "POST",
      headers: { "x-squeak-token": fs.readFileSync(r.tokenPath, "utf8").trim() },
    });
    expect(post.status).not.toBe(200);
  });

  it("404s for an unknown Pond and answers a plain-folder Pond with no Main and no Ducks in Streams", async () => {
    const r = rig("folder");
    expect((await r.get("/native/projects/nope/changes")).status).toBe(404);
    const body: any = await (await r.get(`/native/projects/${r.project.id}/changes`)).json();
    expect(body).toEqual({ projectId: r.project.id, ducks: [], ducksTruncated: false });
  });
});
