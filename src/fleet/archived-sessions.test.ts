import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ArchivedSessions } from "./archived-sessions.js";
import { isActiveSession } from "./active.js";
import { serializeState } from "./runtime.js";
import { readArchiveRequest, setThreadArchived } from "./thread-archive.js";
import type { FleetMonitor } from "./fleet-monitor.js";
import type { FleetSession } from "./types.js";
import { withConductorHost } from "./host-fixtures.js";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arch-")), "archived-sessions.json");
}

function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    key: "claude:one",
    source: "claude-transcript",
    agent: "claude",
    origin: "terminal",
    sourceId: "one",
    agentSessionId: "one",
    conductorSessionId: null,
    cwd: null,
    repoName: "squeak",
    branch: null,
    title: "A thread",
    state: "finished",
    detail: null,
    lastActivityAt: new Date(NOW - 60_000).toISOString(),
    transcriptPath: null,
    contextPercent: null,
    retired: false,
    baseRef: null,
    costUsd: null,
    pid: null,
    alive: false,
    git: null,
    stateSource: "transcript",
    ...withConductorHost(overrides),
  };
}

describe("ArchivedSessions", () => {
  it("archives, keeps the first time, unarchives, and survives a restart", () => {
    const file = tmpFile();
    let now = NOW;
    const store = new ArchivedSessions({ file, now: () => now });
    expect(store.archive("claude:one")).toBe(true);
    now += 5_000;
    store.archive("claude:one");
    expect(store.get("claude:one")?.archivedAt).toBe(new Date(NOW).toISOString());
    expect(new ArchivedSessions({ file }).list()).toEqual([
      { key: "claude:one", archivedAt: new Date(NOW).toISOString() },
    ]);
    store.unarchive("claude:one");
    expect(new ArchivedSessions({ file }).list()).toEqual([]);
  });

  it("refuses a malformed key and ignores a bad file", () => {
    const file = tmpFile();
    fs.writeFileSync(file, "not json");
    const store = new ArchivedSessions({ file });
    expect(store.archive("has space")).toBe(false);
    expect(store.archive("")).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("marks sessions retired with archivedAt, and never a Squeak chat", () => {
    const store = new ArchivedSessions({ file: tmpFile(), now: () => NOW });
    store.archive("claude:one");
    store.archive("squeak-native:n1");
    const [a, b, c] = store.apply([
      session(),
      session({ key: "claude:two" }),
      session({ key: "squeak-native:n1", origin: "squeak" }),
    ]);
    expect(a).toMatchObject({ retired: true, archivedAt: new Date(NOW).toISOString() });
    expect(b?.retired).toBe(false);
    expect(c?.archivedAt).toBeUndefined();
  });

  it("an archived thread leaves the active set, the only place attention and pushes come from", () => {
    const store = new ArchivedSessions({ file: tmpFile(), now: () => NOW });
    store.archive("claude:one");
    const blocked = session({ state: "awaiting_approval" });
    expect(isActiveSession(blocked, NOW)).toBe(true);
    const [archived] = store.apply([blocked]);
    expect(isActiveSession(archived!, NOW)).toBe(false);
  });
});

describe("/state archived list", () => {
  it("lists archived threads newest archived first, apart from active and others", () => {
    const older = session({ key: "claude:a", retired: true, archivedAt: "2026-11-12T10:00:00.000Z" });
    const newer = session({ key: "claude:b", retired: true, archivedAt: "2026-11-13T10:00:00.000Z" });
    const live = session({ key: "claude:c" });
    const monitor = {
      snapshot: {
        generatedAt: new Date(NOW).toISOString(),
        sessions: [older, live, newer],
        active: [live],
        attention: [],
        codexUsage: null,
      },
    } as unknown as FleetMonitor;
    const state = serializeState(monitor) as {
      active: Array<{ key: string }>;
      others: Array<{ key: string }>;
      archived: Array<{ key: string; archived: boolean; archivedAt: string }>;
    };
    expect(state.archived.map((s) => s.key)).toEqual(["claude:b", "claude:a"]);
    expect(state.archived[0]).toMatchObject({ archived: true, archivedAt: "2026-11-13T10:00:00.000Z" });
    expect(state.active.map((s) => s.key)).toEqual(["claude:c"]);
    expect(state.others).toEqual([]);
    expect(state.active[0]).not.toHaveProperty("archived");
  });
});

describe("setThreadArchived", () => {
  const make = (sessions: FleetSession[], native?: (id: string, archived: boolean) => Promise<void>) => {
    const archived = new ArchivedSessions({ file: tmpFile(), now: () => NOW });
    const refresh = vi.fn();
    return { archived, refresh, deps: { archived, sessions: () => sessions, refresh, nativeArchive: native ?? null } };
  };

  it("hides a fleet thread in Squeak only and refreshes", async () => {
    const m = make([session()]);
    expect(await setThreadArchived(m.deps, "claude:one", true)).toEqual({ ok: true });
    expect(m.archived.get("claude:one")).toBeDefined();
    expect(m.refresh).toHaveBeenCalled();
    expect(await setThreadArchived(m.deps, "claude:one", false)).toEqual({ ok: true });
    expect(m.archived.get("claude:one")).toBeUndefined();
  });

  it("refuses a working or waiting thread, an unknown one and a bad key", async () => {
    const m = make([session({ state: "working" }), session({ key: "claude:w", state: "awaiting_input" })]);
    expect(await setThreadArchived(m.deps, "claude:one", true)).toMatchObject({ ok: false });
    expect(await setThreadArchived(m.deps, "claude:w", true)).toMatchObject({ ok: false });
    expect(await setThreadArchived(m.deps, "claude:nope", true)).toMatchObject({ ok: false });
    expect(await setThreadArchived(m.deps, "bad key", true)).toMatchObject({ ok: false });
    expect(m.archived.list()).toEqual([]);
  });

  it("sends a Squeak chat to the session host, not the file", async () => {
    const calls: Array<[string, boolean]> = [];
    const m = make([session({ key: "squeak-native:n1", origin: "squeak", sourceId: "n1" })], async (id, a) => {
      calls.push([id, a]);
    });
    expect(await setThreadArchived(m.deps, "squeak-native:n1", true)).toEqual({ ok: true });
    expect(calls).toEqual([["n1", true]]);
    expect(m.archived.list()).toEqual([]);
    const down = make([session({ key: "squeak-native:n1", origin: "squeak", sourceId: "n1" })], async () => {
      throw new Error("Stop the chat before archiving it.");
    });
    expect(await setThreadArchived(down.deps, "squeak-native:n1", true)).toEqual({
      ok: false,
      reason: "Stop the chat before archiving it.",
    });
  });

  it("reads exactly { archived: boolean }", () => {
    expect(readArchiveRequest({ archived: true })).toEqual({ archived: true });
    expect(readArchiveRequest({ archived: "yes" })).toBeNull();
    expect(readArchiveRequest({ archived: true, x: 1 })).toBeNull();
    expect(readArchiveRequest(null)).toBeNull();
    expect(readArchiveRequest([])).toBeNull();
  });
});
