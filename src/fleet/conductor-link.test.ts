import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConductorLink,
  CONDUCTOR_NOT_LINKED,
  parseLinkRequest,
  relayEnvEnabled,
  type MigrationProbe,
} from "./conductor-link.js";
import { ConductorObserver } from "./observers/conductor.js";
import { ConductorReplier } from "./session-reply.js";
import { LinkedConductorRoute, NoConductorRoute, loadAddons } from "../addons.js";
import type { ConductorRegistryAdapter } from "../adapters/conductor-registry.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "link-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const probe = (over: Partial<MigrationProbe> = {}): MigrationProbe => ({
  dbExists: () => false,
  hasSessions: () => false,
  referencesConductorChats: () => false,
  relayEnabled: () => false,
  ...over,
});

describe("migration", () => {
  const file = () => path.join(dir, "conductor-link.json");
  it("a fresh install (no database) is not linked, and the answer is written", () => {
    expect(ConductorLink.load(file(), probe()).linked).toBe(false);
    expect(JSON.parse(fs.readFileSync(file(), "utf8"))).toEqual({ linked: false });
  });
  it("an empty database alone is not linked", () => {
    expect(ConductorLink.load(file(), probe({ dbExists: () => true })).linked).toBe(false);
  });
  it("sessions in the database link it", () => {
    const link = ConductorLink.load(file(), probe({ dbExists: () => true, hasSessions: () => true }));
    expect(link.linked).toBe(true);
    expect(JSON.parse(fs.readFileSync(file(), "utf8")).linkedAt).toBeTypeOf("string");
  });
  it("reply targets naming a Conductor chat link it", () => {
    expect(
      ConductorLink.load(file(), probe({ dbExists: () => true, referencesConductorChats: () => true })).linked,
    ).toBe(true);
  });
  it("the relay switched on links it", () => {
    expect(ConductorLink.load(file(), probe({ relayEnabled: () => true })).linked).toBe(true);
    expect(relayEnvEnabled({ SQUEAK_ADDONS: "x, conductor-relay" })).toBe(true);
    expect(relayEnvEnabled({ SQUEAK_CONDUCTOR_RELAY: "ON" })).toBe(true);
    expect(relayEnvEnabled({})).toBe(false);
  });
  it("an existing file wins and is never re-decided", () => {
    fs.writeFileSync(file(), JSON.stringify({ linked: false }));
    expect(ConductorLink.load(file(), probe({ dbExists: () => true, hasSessions: () => true })).linked).toBe(false);
  });
  it("set persists, notifies once and survives a reload", () => {
    const link = ConductorLink.load(file(), probe());
    const seen: boolean[] = [];
    link.onChange((v) => seen.push(v));
    link.set(true);
    link.set(true);
    expect(seen).toEqual([true]);
    expect(ConductorLink.load(file(), probe()).linked).toBe(true);
  });
});

describe("link request", () => {
  it("is strict", () => {
    expect(parseLinkRequest({ linked: true })).toEqual({ ok: true, linked: true });
    for (const bad of [{}, { linked: "yes" }, { linked: true, x: 1 }, null, [], "x", { link: true }]) {
      expect(parseLinkRequest(bad).ok).toBe(false);
    }
  });
});

describe("not linked", () => {
  it("the observer reads nothing", () => {
    let reads = 0;
    const registry = {
      listFleetSessions: () => {
        reads += 1;
        return [];
      },
    } as unknown as ConductorRegistryAdapter;
    let on = false;
    const observer = new ConductorObserver(registry, { enabled: () => on });
    expect(observer.observe()).toEqual([]);
    expect(reads).toBe(0);
    on = true;
    observer.observe();
    expect(reads).toBe(1);
  });

  it("a reply is refused with the plain sentence before the database is touched", async () => {
    const adapter = { on: () => undefined } as never;
    const registry = {
      getSessionById: () => {
        throw new Error("touched");
      },
    } as unknown as ConductorRegistryAdapter;
    const replier = new ConductorReplier({ registry, claude: adapter, codex: adapter, linked: () => false });
    expect(await replier.send("s", "hi", () => undefined)).toEqual({ status: "refused", reason: CONDUCTOR_NOT_LINKED });
  });

  it("the relay route refuses and is not ready", async () => {
    const inner = Object.assign(new NoConductorRoute(), { isReady: () => true });
    let linked = false;
    const route = new LinkedConductorRoute(inner, () => linked, CONDUCTOR_NOT_LINKED);
    expect(route.isReady()).toBe(false);
    expect(await route.send({} as never)).toEqual({ ok: false, reason: CONDUCTOR_NOT_LINKED });
    linked = true;
    expect(route.isReady()).toBe(true);
  });

  it("the relay add-on is not activated even when its flag is set", async () => {
    const loaded = await loadAddons(
      { conductorDbPath: "/x", supportDir: "/x" },
      { SQUEAK_CONDUCTOR_RELAY: "on" },
      () => {
        throw new Error("looked");
      },
      () => false,
    );
    expect(loaded.names).toEqual([]);
  });
});
