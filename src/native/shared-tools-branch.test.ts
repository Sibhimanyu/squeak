import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatStarter } from "./chat-starter.js";
import { SessionHost } from "./host.js";
import { Placement } from "./placement.js";
import { Room } from "./room.js";
import { NativeServer } from "./server.js";
import { createSharedTools } from "./shared-tools.js";
import { NativeStore } from "./store.js";
import type { Runner, RunnerHooks, SessionRow } from "./types.js";
import { WorkspaceManager } from "./workspaces.js";
import { WorkspaceSources } from "./workspace-sources.js";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const before = process.env.SQUEAK_DUCKS_OWN_BRANCH;
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (stops.length) await stops.pop()!();
  if (before === undefined) delete process.env.SQUEAK_DUCKS_OWN_BRANCH;
  else process.env.SQUEAK_DUCKS_OWN_BRANCH = before;
});

/**
 * Regression: a Duck in a Git Pond's Main was told "Placement is unavailable here" by branch_off and join_branch all
 * session (greenroom, 2026-11-23), so it could not edit at all. The host wires the server the way main.ts does when
 * Flotilla is on: one Placement and one ChatStarter, and the agent tools from createSharedTools.
 */
describe("branch_off through the host's real wiring (as main.ts builds it)", () => {
  it("a Duck in Main gets its own branch; never 'Placement is unavailable here'", async () => {
    process.env.SQUEAK_DUCKS_OWN_BRANCH = "on";
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shared-branch-")));
    const repo = path.join(dir, "app");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "T");
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "first");
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
    const workspaces = new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") });
    const room = new Room({ store, deliver: (id, text) => host.send(id, text, { room: true }) });
    const sources = new WorkspaceSources({ store, workspaces });
    const placement = new Placement({ store, workspaces, sources });
    const starter = new ChatStarter({ store, host, workspaces, placement, room });
    const shared = createSharedTools({
      store,
      workspaces,
      send: (id, text) => host.send(id, text),
      create: (spec) => starter.create(spec),
      sources,
      placement,
      post: (id, kind, payload) => host.post(id, kind, payload),
    });
    const tokenPath = path.join(dir, "hook-token");
    const server = new NativeServer({
      host,
      store,
      workspaces,
      ...shared,
      placement,
      starter,
      room,
      tokenPath,
      port: 0,
      routines: false,
    });
    await server.start();
    stops.push(async () => {
      await server.stop();
      await host.stop();
    });
    const pond = workspaces.addProject(repo);
    const first = await host.create({
      cwd: pond.rootPath,
      agent: "claude",
      model: "m",
      permissionMode: "default",
      workspaceId: null,
      text: "go",
    });
    store.duckForSession(first.id, pond.id);
    const endpoint = server.mcpEndpoint(first.id)!;
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "branch_off", arguments: { name: "Login form" } },
      }),
    });
    const out = ((await res.json()) as { result: { content: { text: string }[]; isError?: boolean } }).result;
    expect(out.content[0]!.text).not.toMatch(/Placement is unavailable/);
    expect(out.isError).toBeUndefined();
    expect(store.listWorkspaces(pond.id)).toHaveLength(1);
  });
});
