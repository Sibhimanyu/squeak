// "Remove from Squeak" on a project whose Pond is shared (issue #142): the host asks PondEnding to end the Pond first (cloud
// first, resumable) instead of refusing; without the person's `endPond` it still refuses with the sentence that says so, and a
// failed end leaves the project where it was.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SessionHost } from "./host.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import type { Runner } from "./types.js";
import { WorkspaceManager } from "./workspaces.js";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (stops.length) await stops.pop()!();
});

async function start(endPond: () => Promise<void>) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "remove-shared-")));
  const store = new NativeStore(":memory:");
  const host = new SessionHost({
    store,
    runnerFactory: (): Runner => ({
      canSteer: false,
      send: async () => {},
      steer: async () => false,
      interrupt: async () => {},
      setPermissionMode: async () => {},
      close: async () => {},
    }),
  });
  const events: string[] = [];
  const tokenPath = path.join(dir, "token");
  const server = new NativeServer({
    host,
    store,
    workspaces: new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") }),
    tokenPath,
    port: 0,
    routines: false,
    flotilla: {
      handle: async () => false,
      projectRemovalBlock: () =>
        "It is shared with 2 people. Removing Alpha from Squeak deletes the Pond for everyone.",
      endProjectPond: async () => {
        events.push("end");
        await endPond();
      },
      projectRemoved: () => void events.push("removed"),
    },
  });
  const port = await server.start();
  stops.push(async () => {
    await server.stop();
    await host.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const token = fs.readFileSync(tokenPath, "utf8").trim();
  const call = async (method: string, url: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { "x-squeak-token": token } });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const project = store.createProject({ name: "Alpha", rootPath: dir, defaultBranch: "main" });
  return { call, store, project, events };
}

describe("Remove from Squeak on a shared Pond", () => {
  it("refuses with the sentence until the person says to delete the Pond, then ends it before removing the project", async () => {
    const h = await start(async () => {});
    const refused = await h.call("DELETE", `/native/projects/${h.project.id}`);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/deletes the Pond for everyone/);
    expect(h.store.getProject(h.project.id)).toBeTruthy();
    expect(h.events).toEqual([]);

    const done = await h.call("DELETE", `/native/projects/${h.project.id}?endPond=1`);
    expect(done.status).toBe(200);
    expect(h.events).toEqual(["end", "removed"]);
    expect(h.store.getProject(h.project.id)).toBeFalsy();
  });

  it("a Pond that cannot be ended leaves the project in place, with the sentence, so Try again works", async () => {
    const { FlotillaError } = await import("../flotilla/types.js");
    let fail = true;
    const h = await start(async () => {
      if (fail) throw new FlotillaError("Squeak couldn't end the Pond in the cloud. Try again.", 503);
    });
    const failed = await h.call("DELETE", `/native/projects/${h.project.id}?endPond=1`);
    expect(failed.status).toBe(503);
    expect(failed.json.error).toMatch(/couldn't end the Pond in the cloud/);
    expect(h.store.getProject(h.project.id)).toBeTruthy();
    expect(h.events).toEqual(["end"]);

    fail = false;
    expect((await h.call("DELETE", `/native/projects/${h.project.id}?endPond=1`)).status).toBe(200);
    expect(h.store.getProject(h.project.id)).toBeFalsy();
  });
});
