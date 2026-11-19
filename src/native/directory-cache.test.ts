import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SessionHost } from "./host.js";
import { NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";

function make(records: () => Promise<unknown[]>): NativeServer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "directory-cache-"));
  const store = new NativeStore(":memory:");
  const host = new SessionHost({
    store,
    runnerFactory: () => ({ canSteer: false, send: async () => {}, close: async () => {} }) as never,
  });
  const workspaces = new WorkspaceManager({ store, root: path.join(dir, "ws") } as never);
  return new NativeServer({
    host,
    store,
    workspaces,
    tokenPath: path.join(dir, "token"),
    port: 0,
    routines: false,
    supportDir: dir,
    flotilla: { handle: async () => false, records: records as never },
  });
}

describe("directory cache", () => {
  it("serves the last snapshot at once while a slow rebuild runs, and builds once at a time", async () => {
    let calls = 0;
    let slow = false;
    const server = make(async () => {
      calls += 1;
      if (slow) await new Promise((r) => setTimeout(r, 400));
      return [];
    });
    await server.directory();
    expect(calls).toBe(1);
    await new Promise((r) => setTimeout(r, 800)); // past the TTL
    slow = true;
    const t0 = Date.now();
    await server.directory();
    await server.directory();
    expect(Date.now() - t0).toBeLessThan(100);
    expect(calls).toBe(2); // one background rebuild, not two
    await new Promise((r) => setTimeout(r, 500));
    const t1 = Date.now();
    await server.directory();
    expect(Date.now() - t1).toBeLessThan(100);
  });

  it("a write makes the next ask wait for a fresh build", async () => {
    let calls = 0;
    const server = make(async () => {
      calls += 1;
      return [];
    });
    await server.directory();
    await server.directory();
    expect(calls).toBe(1);
    server.invalidateDirectory();
    await server.directory();
    expect(calls).toBe(2);
  });
});
