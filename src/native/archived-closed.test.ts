/* eslint-disable @typescript-eslint/no-explicit-any -- JSON replies are read loosely in tests */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SessionHost } from "./host.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!();
});

/** A store with one pond; the host is started by the test so the migration runs on its own start. */
function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archived-closed-"));
  const root = path.join(dir, "root");
  fs.mkdirSync(root);
  const store = new NativeStore(":memory:");
  const host = new SessionHost({ store });
  const project = store.createProject({ name: "app", rootPath: root, defaultBranch: "main", kind: "folder" });
  const tokenPath = path.join(dir, "hook-token");
  const server = new NativeServer({
    host,
    store,
    workspaces: new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") }),
    tokenPath,
    port: 0,
    routines: false,
  });
  let port = 0;
  open.push(async () => {
    await server.stop();
    await host.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = async (method: string, url: string, body?: unknown) => {
    port ||= await server.start();
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: { "x-squeak-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json()) as any };
  };
  const chat = (title: string) =>
    store.createSession({ cwd: root, agent: "claude", model: "m", permissionMode: "default", title });
  return { store, host, project, call, chat };
}

describe("archived chats become Closed Ducks at host start", () => {
  it("an archived chat comes back as a named Closed Duck in its pond, with its history, and runs once", async () => {
    const h = rig();
    const s = h.chat("Old work");
    h.store.appendMessage(s.id, "user", "user", { text: "hello" });
    h.store.setArchivedAt(s.id, new Date().toISOString());
    h.host.start();

    expect(h.store.getSession(s.id)?.archivedAt).toBeNull();
    const duck = h.store.duckBySession(s.id)!;
    expect(duck).toMatchObject({ state: "closed", projectId: h.project.id });
    expect(duck.name).toBeNull(); // Closed: the name went back to the pool
    expect(h.store.messagesAfter(s.id).length).toBeGreaterThan(0);

    const list = await h.call("GET", `/native/projects/${h.project.id}/ducks`);
    const listed = list.json.ducks.find((d: any) => d.id === duck.id);
    expect(listed).toMatchObject({ open: false });

    // Idempotent: a person reopens it, a restart does not close it again.
    await h.call("POST", `/native/ducks/${duck.id}/state`, { open: true });
    h.host.start();
    expect(h.store.duckRow(duck.id)?.state).toBe("open");
    expect(h.store.duckBySession(s.id)?.id).toBe(duck.id);
  });

  it("an existing Duck's archived current chat is unarchived and set Closed, keeping its name as the last name", () => {
    const h = rig();
    const s = h.chat("Named");
    const duck = h.store.duckForSession(s.id, h.project.id)!;
    h.store.updateDuck(duck.id, { name: "Pip" });
    h.store.setArchivedAt(s.id, new Date().toISOString());
    h.host.start();
    expect(h.store.getSession(s.id)?.archivedAt).toBeNull();
    expect(h.store.duckRow(duck.id)).toMatchObject({ name: null, lastName: "Pip", state: "closed" });
  });

  it("a Duck's older chat stays in its history; a chat Delete Duck archived stays gone", async () => {
    const h = rig();
    const older = h.chat("older");
    const current = h.chat("current");
    const duck = h.store.duckForSession(older.id, h.project.id)!;
    h.store.attachSessionToDuck(duck.id, current.id);
    h.store.setArchivedAt(older.id, new Date().toISOString());

    const gone = h.chat("deleted");
    const goneDuck = h.store.duckForSession(gone.id, h.project.id)!;
    expect((await h.call("DELETE", `/native/ducks/${goneDuck.id}`)).status).toBe(200);

    h.host.start();
    expect(h.store.getSession(older.id)?.archivedAt).toBeTruthy();
    expect(h.store.getSession(gone.id)?.archivedAt).toBeTruthy();
    expect(h.store.duckBySession(gone.id)).toBeNull();
  });
});

describe("the archive routes are Closed", () => {
  it("POST archive closes the Duck without archiving; unarchive reopens it", async () => {
    const h = rig();
    const s = h.chat("Chat");
    const off = await h.call("POST", `/native/sessions/${s.id}/archive`, {});
    expect(off.json).toMatchObject({ ok: true, archived: false, open: false });
    expect(h.store.getSession(s.id)?.archivedAt).toBeNull();
    expect(h.store.duckOf(s.id).state).toBe("closed");
    const on = await h.call("POST", `/native/sessions/${s.id}/unarchive`, {});
    expect(on.json).toMatchObject({ open: true });
  });
});
