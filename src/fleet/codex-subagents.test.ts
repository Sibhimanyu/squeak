import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CodexSubagentReader } from "./codex-subagents.js";
import { CodexRolloutObserver } from "./observers/codex-rollout.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const PARENT = "01a18166-2cdf-74b1-86e6-6ef822f65b06";
const NOW = Date.parse("2026-10-29T06:00:00Z");

function line(timestamp: string, type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp, type, payload });
}

function setup(): { root: string; parent: string; child: (id: string, name: string, lines: string[]) => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-subagents-"));
  roots.push(root);
  const dir = path.join(root, "sessions", "2026", "10", "29");
  fs.mkdirSync(dir, { recursive: true });
  const parent = path.join(dir, `rollout-2026-10-29T05-00-00-${PARENT}.jsonl`);
  fs.writeFileSync(
    parent,
    `${line("2026-10-29T05:00:00Z", "session_meta", { id: PARENT, session_id: PARENT, cwd: "/w", originator: "codex_sdk_ts", source: "exec" })}\n`,
  );
  const child = (id: string, name: string, lines: string[]): string => {
    const file = path.join(dir, `rollout-2026-10-29T05-30-00-${id}.jsonl`);
    const meta = line("2026-10-29T05:30:00Z", "session_meta", {
      id,
      session_id: PARENT,
      parent_thread_id: PARENT,
      timestamp: "2026-10-29T05:30:00.000Z",
      source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_path: `/root/${name}` } } },
    });
    fs.writeFileSync(file, `${[meta, ...lines].join("\n")}\n`);
    fs.utimesSync(file, NOW / 1000 - 60, NOW / 1000 - 60);
    return file;
  };
  return { root, parent, child };
}

describe("a Codex chat's subagents", () => {
  it("lists each child rollout by its parent, running or done, named from its task", () => {
    const { parent, child } = setup();
    child("01a1862e-aaaa-7000-8000-000000000001", "popover_redesign", [
      line("2026-10-29T05:30:01Z", "event_msg", { type: "task_started" }),
    ]);
    child("01a1862e-aaaa-7000-8000-000000000002", "web_copy", [
      line("2026-10-29T05:30:01Z", "event_msg", { type: "task_started" }),
      line("2026-10-29T05:58:00Z", "event_msg", { type: "task_complete", last_agent_message: "Released it.\n\nDone." }),
    ]);
    const tasks = new CodexSubagentReader().tasks(parent, NOW);
    expect(tasks.map((t) => [t.label, t.status, t.kind, t.background])).toEqual([
      ["Popover redesign", "running", "agent", true],
      ["Web copy", "done", "agent", true],
    ]);
    expect(tasks[1]?.summary).toBe("Released it. Done.");
    expect(tasks[0]?.agentId).toBe("01a1862e-aaaa-7000-8000-000000000001");
  });

  it("drops a task that finished long ago and marks a day-old silent one stopped", () => {
    const { parent, child } = setup();
    child("01a1862e-aaaa-7000-8000-000000000003", "old_one", [
      line("2026-10-29T04:00:00Z", "event_msg", { type: "task_started" }),
      line("2026-10-29T04:10:00Z", "event_msg", { type: "task_complete", last_agent_message: "ok" }),
    ]);
    child("01a1862e-aaaa-7000-8000-000000000004", "aborted", [
      line("2026-10-29T05:50:00Z", "event_msg", { type: "task_started" }),
      line("2026-10-29T05:55:00Z", "event_msg", { type: "turn_aborted" }),
    ]);
    const tasks = new CodexSubagentReader().tasks(parent, NOW);
    expect(tasks.map((t) => [t.label, t.status])).toEqual([["Aborted", "stopped"]]);
    const later = new CodexSubagentReader().tasks(parent, NOW + 3 * 24 * 60 * 60_000);
    expect(later).toEqual([]);
  });

  it("reads a child's own steps, and refuses an id it did not find", () => {
    const { parent, child } = setup();
    const id = "01a1862e-aaaa-7000-8000-000000000005";
    child(id, "tab_animation", [
      line("2026-10-29T05:30:01Z", "event_msg", { type: "task_started" }),
      line("2026-10-29T05:30:02Z", "response_item", {
        type: "custom_tool_call",
        name: "exec",
        input: 'await tools.exec_command({cmd:"npm test"})',
      }),
    ]);
    const reader = new CodexSubagentReader();
    const read = reader.read(parent, id, NOW);
    expect(read?.label).toBe("Tab animation");
    expect(read?.steps.map((s) => s.text)).toEqual(["Run npm test"]);
    expect(reader.read(parent, "01a1862e-zzzz-7000-8000-000000000009", NOW)).toBeNull();
    expect(reader.read(parent, "../../etc/passwd", NOW)).toBeNull();
  });

  it("keeps a child's rollout off the radar as a chat of its own", () => {
    const { root, parent, child } = setup();
    child("01a1862e-aaaa-7000-8000-000000000006", "hidden_one", [
      line("2026-10-29T05:30:01Z", "event_msg", { type: "task_started" }),
    ]);
    const observed = new CodexRolloutObserver({
      codexHome: root,
      activeWithinMs: 10 * 365 * 24 * 60 * 60_000,
    }).observe();
    void parent;
    const keys = (Array.isArray(observed) ? observed : []).map((s: { sourceId: string }) => s.sourceId);
    expect(keys).toContain(PARENT);
    expect(keys).not.toContain("01a1862e-aaaa-7000-8000-000000000006");
  });
});
