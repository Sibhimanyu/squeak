import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AddonHost } from "../../src/addon-host.js";
import type { AddonConfig, AddonContext, AddonManifest } from "../../src/addons.js";
import { logger } from "../../src/utils/logger.js";
import addon, { conductorDbPathFor } from "./index.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-addon-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const manifest: AddonManifest = JSON.parse(
  fs.readFileSync(new URL("./addon.json", import.meta.url), "utf8"),
) as AddonManifest;

/** The add-on activated against a host over a temp support dir; Conductor's database does not exist. */
async function setup() {
  const host = new AddonHost(dir);
  const config = {
    supportDir: dir,
    dbPath: path.join(dir, "state.db"),
    workspacesRoot: path.join(dir, "ws"),
    defaultFallbackModel: "m",
    defaultPermissionMode: "default",
    claudeBin: "/nope/claude",
    codexBin: "/nope/codex",
    handsAppPath: null,
    activeWindowMs: 60_000,
    nativeDbPath: path.join(dir, "native.db"),
  } as AddonConfig;
  const env = { CONDUCTOR_DB_PATH: path.join(dir, "conductor", "conductor.db") };
  const context = {
    id: "conductor",
    supportDir: dir,
    config,
    env,
    logger,
    snapshot: () => ({ sessions: [], active: [], attention: [], generatedAt: "", codexUsage: null }),
    refresh: () => undefined,
    isEnabled: () => host.isEnabled("conductor"),
    setEnabled: (enabled: boolean) => host.setEnabled("conductor", enabled),
    services: { provide: () => undefined, get: () => undefined },
  } as unknown as AddonContext;
  const handle = await addon.activate(context);
  host.register(manifest, handle);
  return { host, handle };
}

const route = (handle: Awaited<ReturnType<typeof setup>>["handle"], method: string, p: string) =>
  handle.routes!.find((candidate) => candidate.method === method && candidate.path === p)!;

describe("the Conductor add-on", () => {
  it("is distributed and inert until enabled: no observer rows, no replier, no state beyond its own fields", async () => {
    expect(manifest.distributed).toBe(true);
    const { host } = await setup();
    expect(host.isEnabled("conductor")).toBe(false);
    expect(host.observers()[0]?.observe()).toEqual([]);
    expect(host.repliers()).toHaveLength(0);
    expect(host.newChat()).toBeNull();
    expect(host.stateFields()).toMatchObject({ addons: [], conductorLinked: false, conductorWorkspaces: [] });
    expect(fs.existsSync(path.join(dir, "conductor", "conductor.db"))).toBe(false);
  });

  it("ignores an old conductor-link.json: a Mac that was linked starts with Conductor off", async () => {
    fs.writeFileSync(path.join(dir, "conductor-link.json"), JSON.stringify({ linked: true, workspaces: ["w1"] }));
    const { host } = await setup();
    expect(host.isEnabled("conductor")).toBe(false);
    expect(host.stateFields()).toMatchObject({ conductorWorkspaces: [] });
    expect(fs.existsSync(path.join(dir, "conductor-link.json"))).toBe(true);
  });

  it("keeps GET/POST /control/conductor/link working: linked:true is enabling the add-on", async () => {
    const { host, handle } = await setup();
    const read = (await route(handle, "GET", "/control/conductor/link").handle({}, {})) as {
      body: { linked: boolean };
    };
    expect(read.body).toMatchObject({ linked: false, available: false });
    const posted = await route(handle, "POST", "/control/conductor/link").handle({ linked: true }, {});
    expect(posted).toEqual({ status: 200, body: { ok: true, linked: true } });
    expect(host.isEnabled("conductor")).toBe(true);
    expect(host.repliers()).toHaveLength(1);
    expect(host.repliers()[0]?.ownsTarget("0a401f51-6093-442e-8437-9ca80979fb78")).toBe(true);
    expect(host.repliers()[0]?.ownsTarget("claude-transcript:x")).toBe(false);
    expect(await route(handle, "POST", "/control/conductor/link").handle({ linked: "yes" }, {})).toMatchObject({
      status: 400,
    });
    await route(handle, "POST", "/control/conductor/link").handle({ linked: false }, {});
    expect(host.isEnabled("conductor")).toBe(false);
  });

  it("stores workspace picks in its own file, starting empty", async () => {
    const { handle } = await setup();
    const view = await route(handle, "POST", "/control/conductor/workspaces").handle({ id: "w9", picked: true }, {});
    expect(view.status).toBe(200);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "conductor", "workspaces.json"), "utf8"))).toEqual({
      workspaces: ["w9"],
    });
    expect(await route(handle, "POST", "/control/conductor/workspaces").handle({ id: "w9" }, {})).toMatchObject({
      status: 400,
    });
  });

  it("runs its start-up maintenance with Conductor off, touching nothing when there is no Conductor", async () => {
    const { handle } = await setup();
    await expect(Promise.resolve(handle.maintenance?.())).resolves.toBeUndefined();
  });

  it("finds Conductor's database where CONDUCTOR_DB_PATH or the default says", () => {
    expect(conductorDbPathFor({ CONDUCTOR_DB_PATH: "/x/y.db" })).toBe("/x/y.db");
    expect(conductorDbPathFor({})).toBe(
      path.join(os.homedir(), "Library/Application Support/com.conductor.app/conductor.db"),
    );
    expect(conductorDbPathFor({ CONDUCTOR_DB_PATH: "~/c.db" })).toBe(path.join(os.homedir(), "c.db"));
  });
});
