/* eslint-disable @typescript-eslint/no-explicit-any -- the host's JSON answers are untyped */
// The first-minutes journey (docs/spec.md, People and remote, Proof): a new Pond, a Duck started and sent at once, an invitation,
// and putting the Pond on GitHub, with no step landing anywhere but where it was asked. The host side is real: the session host,
// its HTTP routes, a real folder and real git, a fake GitHub (the one door the tests replace). The cloud side is the relay double.
//
// Not covered (needs the Mac app, which no test here opens): that the sheets and buttons for these steps are where a newcomer
// looks (macos/Tests/.../FirstPondJourneyTests.swift holds the words and the menu decision).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Every git launch can stall on this Mac (endpoint security), so a test that runs git gets room.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

import type { GitHubAdapter, RepoVisibility } from "../native/git-pond.js";
import { SessionHost } from "../native/host.js";
import { NativeServer } from "../native/server.js";
import { NativeStore } from "../native/store.js";
import type { Runner, RunnerHooks, SessionRow } from "../native/types.js";
import { WorkspaceManager } from "../native/workspaces.js";
import { RelayWorld, type RelayMac } from "./relay-world.test-fixture.js";

process.env.SQUEAK_POND_OWN_THREADS = "on";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/** A fake GitHub: "creating" a repo makes a bare one in a temp folder and pushes there. */
function fakeGitHub() {
  const created: Array<{ name: string; visibility: RepoVisibility; remote: string; dir: string }> = [];
  const adapter: GitHubAdapter = {
    status: async () => ({ ok: true, login: "owner" }),
    visibility: async () => "unknown",
    createAndPush: async ({ name, visibility, dir }) => {
      const remote = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fake-gh-")), `${name}.git`);
      execFileSync("git", ["init", "--bare", "-q", remote]);
      git(dir, "remote", "add", "origin", remote);
      git(dir, "push", "-q", "origin", "main");
      created.push({ name, visibility, remote, dir });
      return { url: `https://github.com/owner/${name}` };
    },
  };
  return { adapter, created };
}

const sibhi = { userId: "u-sibhi", email: "sibhi@example.com", name: "Sibhi" };
const asha = { userId: "u-asha", email: "asha@example.com", name: "Asha" };

describe("a new Pond's first minutes", () => {
  let world: RelayWorld;
  let owner: RelayMac;
  let invitee: RelayMac;
  let stop: () => Promise<void>;
  let call: (method: string, url: string, body?: unknown) => Promise<{ status: number; json: Record<string, any> }>;
  let store: NativeStore;
  const tmp: string[] = [];
  const gh = fakeGitHub();
  /** What each runner (one per Duck) was told, by the Duck's working folder: where a message actually landed. */
  const told = new Map<string, string[]>();
  /** The hooks of the Duck working in each folder: the test says when it is done. */
  const running = new Map<string, RunnerHooks>();
  const folders = { site: "", other: "" };
  const ids = { site: "", other: "" };
  let pondId = "";

  beforeAll(async () => {
    world = await RelayWorld.start();
    owner = await world.mac(sibhi);
    world.owner.id = owner.service.me.id;
    invitee = await world.mac(asha);
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "first-minutes-")));
    tmp.push(dir);
    store = new NativeStore(":memory:");
    const host = new SessionHost({
      store,
      runnerFactory: (session: SessionRow, hooks: RunnerHooks): Runner => ({
        canSteer: false,
        send: async (text) => {
          told.set(session.cwd, [...(told.get(session.cwd) ?? []), text]);
          running.set(session.cwd, hooks);
          hooks.onStatus("working");
        },
        steer: async () => false,
        interrupt: async () => {},
        setPermissionMode: async () => {},
        close: async () => {},
      }),
    });
    const workspaces = new WorkspaceManager({ store, workspacesRoot: path.join(dir, "ws") });
    const tokenPath = path.join(dir, "hook-token");
    const server = new NativeServer({
      host,
      store,
      workspaces,
      tokenPath,
      port: 0,
      routines: false,
      github: gh.adapter,
    });
    const port = await server.start();
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    stop = async () => {
      await server.stop();
      await host.stop();
    };
    call = async (method, url, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${url}`, {
        method,
        headers: { "x-squeak-token": token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null };
    };
    // Two folders, so a step that lands in the wrong Pond is visible: the one the person works in and one beside it.
    for (const name of ["site", "other"] as const) {
      folders[name] = path.join(dir, name);
      fs.mkdirSync(folders[name]);
      fs.writeFileSync(path.join(folders[name], "notes.txt"), `${name}\n`);
      ids[name] = workspaces.addProject(folders[name]).id;
    }
  });
  afterAll(async () => {
    await stop?.();
    world?.stop();
    for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  });

  it("a new Pond is a plain folder Pond on this Mac, not in the cloud, nothing shared", async () => {
    expect(store.getProject(ids.site)).toMatchObject({ kind: "folder", rootPath: folders.site });
    expect(await owner.service.list()).toEqual([]);
    expect(world.requests).toEqual(expect.not.arrayContaining([expect.objectContaining({ route: "/ponds" })]));
  });

  it("a Duck started with its first message sends it at once, in that Pond's folder and nowhere else", async () => {
    const made = await call("POST", "/native/sessions", {
      agent: "claude",
      model: "claude-sonnet-4-5",
      projectId: ids.site,
      text: "Add a about page",
    });
    expect(made.status).toBe(201);
    const row = store.getSession(made.json.session.id)!;
    expect(row.cwd).toBe(folders.site);
    expect(told.get(folders.site)).toEqual(["Add a about page"]);
    expect(told.has(folders.other)).toBe(false);
    expect(store.listSessions().filter((s) => s.cwd === folders.other)).toEqual([]);
  });

  it("the invitation is for that Pond, at the role chosen, and nothing else is invited or shared", async () => {
    const pond = await owner.service.createPond({ name: "site", projectId: ids.site });
    pondId = pond.id;
    const sent = await owner.service.inviteEmails(pondId, [asha.email], "viewer");
    expect(sent.results[0]).toMatchObject({ ok: true });
    const waiting = await invitee.service.invitations(true);
    expect(waiting).toEqual([
      expect.objectContaining({ pondId, pondName: "site", inviter: "Sibhi", role: "viewer", state: "pending" }),
    ]);
    // The other folder is not a Pond of the cloud, and the Duck in this one is not shared by being invited to.
    expect((await owner.service.list()).map((p) => p.id)).toEqual([pondId]);
    expect(await owner.service.threads(pondId)).toEqual([]);
    expect(world.sent.map((m) => m.to)).toEqual([asha.email]);
  });

  it("putting it on GitHub makes one private repository of that folder, and leaves the Duck and the invitation alone", async () => {
    // While the Duck is still working the host says so and changes nothing (no repository, no .git).
    const early = await call("POST", `/native/projects/${ids.site}/git-pond`, {});
    expect(early.status).toBe(409);
    expect(early.json.error).toMatch(/still working/);
    expect(gh.created).toEqual([]);
    expect(fs.existsSync(path.join(folders.site, ".git"))).toBe(false);
    running.get(folders.site)!.onStatus("idle");
    const r = await call("POST", `/native/projects/${ids.site}/git-pond`, {});
    expect(r.status).toBe(200);
    expect(r.json.project).toMatchObject({ id: ids.site, kind: "git", defaultBranch: "main" });
    expect(gh.created).toMatchObject([{ name: "site", visibility: "private", dir: folders.site }]);
    expect(execFileSync("git", ["-C", gh.created[0]!.remote, "rev-parse", "main"], { encoding: "utf8" }).trim()).toBe(
      git(folders.site, "rev-parse", "HEAD"),
    );
    // Nothing happened to the folder beside it.
    expect(store.getProject(ids.other)).toMatchObject({ kind: "folder" });
    expect(fs.existsSync(path.join(folders.other, ".git"))).toBe(false);
    // The Duck still works where it was started, and the invitation is as it was.
    expect(store.listSessions().filter((s) => s.cwd === folders.site)).toHaveLength(1);
    expect(store.listSessions().every((s) => s.cwd === folders.site)).toBe(true);
    expect((await invitee.service.invitations(true)).map((i) => [i.pondId, i.state])).toEqual([[pondId, "pending"]]);
    expect((await owner.service.people(pondId)).invites.map((i) => [i.email, i.state])).toEqual([
      [asha.email, "pending"],
    ]);
  });
});
