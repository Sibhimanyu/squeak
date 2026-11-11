import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConductorLink,
  CONDUCTOR_NOT_LINKED,
  CONDUCTOR_WORKSPACE_NOT_PICKED,
  parseLinkRequest,
  parseWorkspaceRequest,
  relayEnvEnabled,
  type MigrationProbe,
} from "./conductor-link.js";
import { ConductorObserver } from "./observers/conductor.js";
import { ConductorReplier } from "./session-reply.js";
import { LinkedConductorRoute, NoConductorRoute, loadAddons } from "../addons.js";
import type { ConductorRegistryAdapter, FleetRegistrySessionRef } from "../adapters/conductor-registry.js";
import { mergeObservations } from "./merge.js";
import { isActiveSession } from "./active.js";
import { serializeState } from "./runtime.js";
import type { FleetMonitor } from "./fleet-monitor.js";
import type { ObservedSession } from "./types.js";

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

describe("picked workspaces", () => {
  const file = () => path.join(dir, "conductor-link.json");
  const row = (id: string, workspaceId: string): FleetRegistrySessionRef =>
    ({
      id,
      workspaceId,
      status: "working",
      agentType: "claude",
      title: id,
      claudeSessionId: `agent-${id}`,
      updatedAt: "2026-11-11T10:00:00.000Z",
      lastUserMessageAt: "2026-11-11T10:00:00.000Z",
      directoryName: "dir",
      branch: "b",
      repositoryName: "repo",
      workspacePath: `/ws/${workspaceId}`,
      isHidden: false,
      pendingQuestion: "Which one?",
    }) as unknown as FleetRegistrySessionRef;

  it("starts empty with no migration, keeps picks across restarts and across unlinking", () => {
    const link = ConductorLink.load(file(), probe({ dbExists: () => true, hasSessions: () => true }));
    expect(link.linked).toBe(true);
    expect(link.workspaces).toEqual([]);
    expect(link.isPicked("w1")).toBe(false);
    let changes = 0;
    link.onChange(() => (changes += 1));
    link.setPicked("w1", true);
    link.setPicked("w1", true);
    expect(changes).toBe(1);
    link.set(false);
    expect(ConductorLink.load(file(), probe()).workspaces).toEqual(["w1"]);
    link.setPicked("w1", false);
    expect(ConductorLink.load(file(), probe()).isPicked("w1")).toBe(false);
  });

  it("reads an old file without the field as none", () => {
    fs.writeFileSync(file(), JSON.stringify({ linked: true }));
    expect(ConductorLink.load(file(), probe()).workspaces).toEqual([]);
  });

  it("parses { id, picked } strictly", () => {
    expect(parseWorkspaceRequest({ id: "w1", picked: true })).toEqual({ ok: true, id: "w1", picked: true });
    for (const bad of [
      null,
      [],
      {},
      { id: "w1" },
      { id: "", picked: true },
      { id: 1, picked: true },
      { id: "w", picked: "y" },
      { id: "w", picked: true, x: 1 },
    ]) {
      expect(parseWorkspaceRequest(bad).ok).toBe(false);
    }
  });

  it("the observer returns unpicked chats retired and closed, picked ones as they are", () => {
    const registry = {
      listFleetSessions: () => [row("a", "w1"), row("b", "w2")],
    } as unknown as ConductorRegistryAdapter;
    const out = new ConductorObserver(registry, { workspaces: () => ["w1"] }).observe();
    const [a, b] = out;
    expect(a).toMatchObject({ retired: false, closed: false, state: "awaiting_input" });
    expect(b).toMatchObject({ retired: true, closed: true, state: "working", detail: null });
    expect(new ConductorObserver(registry, { workspaces: () => [] }).observe().every((s) => s.retired)).toBe(true);
  });

  it("an unpicked chat's transcript is not rediscovered as an anonymous session", () => {
    const registry = { listFleetSessions: () => [row("b", "w2")] } as unknown as ConductorRegistryAdapter;
    const conductor = new ConductorObserver(registry, { workspaces: () => [] }).observe();
    const transcript: ObservedSession = {
      key: "claude-transcript:agent-b",
      source: "claude-transcript",
      agent: "claude",
      origin: "sdk",
      sourceId: "agent-b",
      agentSessionId: "agent-b",
      conductorSessionId: null,
      cwd: "/ws/w2",
      repoName: null,
      branch: null,
      title: null,
      state: "working",
      detail: null,
      lastActivityAt: "2026-11-11T10:00:00.000Z",
      transcriptPath: "/t.jsonl",
      contextPercent: null,
      retired: false,
      baseRef: null,
      costUsd: null,
    };
    const merged = mergeObservations([...conductor, transcript]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.retired).toBe(true);
    expect(isActiveSession(merged[0] as never, Date.parse("2026-11-11T10:01:00.000Z"))).toBe(false);
  });

  it("a reply to an unpicked workspace is refused with the fixed sentence", async () => {
    const adapter = { on: () => undefined } as never;
    const registry = {
      getSessionById: () => ({ id: "b", workspaceId: "w2", status: "idle" }),
    } as unknown as ConductorRegistryAdapter;
    const replier = new ConductorReplier({
      registry,
      claude: adapter,
      codex: adapter,
      workspacePicked: (id) => id === "w1",
    });
    expect(await replier.send("b", "hi", () => undefined)).toEqual({
      status: "refused",
      reason: CONDUCTOR_WORKSPACE_NOT_PICKED,
    });
  });

  it("/state carries the picked ids", () => {
    const monitor = {
      snapshot: { generatedAt: "2026-11-11T10:00:00.000Z", sessions: [], active: [], attention: [], codexUsage: null },
    } as unknown as FleetMonitor;
    const state = serializeState(monitor, null, null, null, true, ["w1"]) as { conductorWorkspaces?: string[] };
    expect(state.conductorWorkspaces).toEqual(["w1"]);
  });
});
