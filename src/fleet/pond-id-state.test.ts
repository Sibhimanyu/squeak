import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildDirectory, withFleetSessions, type DirSession } from "../flotilla/directory.js";
import { MainRepoFinder, matchPond } from "../remote/pond-match.js";
import { phonePondsOf } from "./native-phone.js";
import type { FleetMonitor } from "./fleet-monitor.js";
import { serializeState } from "./runtime.js";
import type { FleetSession } from "./types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "squeak-pondid-")));
  dirs.push(root);
  const main = path.join(root, "repos", "greenroom");
  const worktree = path.join(root, "elsewhere", "hong-kong");
  const admin = path.join(main, ".git", "worktrees", "hong-kong");
  fs.mkdirSync(admin, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(admin, "commondir"), "../..\n");
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${admin}\n`);
  return { root, main, worktree };
}

const fleet = (key: string, extra: Partial<FleetSession>): FleetSession =>
  ({
    key,
    agent: "claude",
    origin: "terminal",
    state: "idle",
    title: key,
    repoName: null,
    branch: null,
    cwd: null,
    detail: "",
    lastActivityAt: "2026-11-13T00:00:00.000Z",
    ...extra,
  }) as unknown as FleetSession;

describe("pondId on /state", () => {
  it("places native, worktree-outside-folder, nested and home-folder chats, and agrees with the directory and phone view", () => {
    const { main, worktree, root } = world();
    const repos = new MainRepoFinder();
    const directory = buildDirectory({
      projects: [{ id: "proj-g", name: "greenroom", rootPath: main }],
      workspaces: [{ id: "ws1", projectId: "proj-g", name: "hong-kong", state: "ready" }],
      records: [],
      prefs: () => undefined,
      order: { mode: "newest", ids: [] },
      sessions: [],
      repos,
    });
    const sessions = [
      fleet("squeak-native:1", { origin: "squeak", projectId: "proj-g", cwd: worktree }),
      fleet("terminal:wt", { cwd: worktree }),
      fleet("terminal:in", { cwd: path.join(main, "src") }),
      fleet("terminal:home", { cwd: root }),
    ];
    const ponds = phonePondsOf(directory);
    const pondIdOf = (s: FleetSession): string | null => matchPond(ponds, s, repos)?.id ?? null;
    const monitor = {
      snapshot: {
        generatedAt: "t",
        sessions: sessions.slice(2),
        active: sessions.slice(0, 2),
        attention: [],
        codexUsage: null,
      },
    } as unknown as FleetMonitor;
    const state = serializeState(monitor, null, null, null, undefined, undefined, null, pondIdOf) as {
      active: Array<{ key: string; pondId?: string }>;
      others: Array<{ key: string; pondId?: string }>;
    };
    const byKey = new Map([...state.active, ...state.others].map((s) => [s.key, s.pondId]));
    expect(byKey.get("squeak-native:1")).toBe("proj-g");
    expect(byKey.get("terminal:wt")).toBe("proj-g");
    expect(byKey.get("terminal:in")).toBe("proj-g");
    expect(byKey.has("terminal:home")).toBe(true);
    expect(byKey.get("terminal:home")).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain('"pondId":null');

    // The directory places the same chats the same way.
    const dirSessions: DirSession[] = sessions.map((s) => ({
      key: s.key,
      native: s.origin === "squeak",
      projectId: s.projectId ?? null,
      cwd: s.cwd,
    }));
    const placed = withFleetSessions(directory, dirSessions, repos);
    for (const s of sessions) expect(placed.threads[s.key] ?? undefined).toBe(byKey.get(s.key));
  });
});
