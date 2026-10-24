import { describe, expect, it } from "vitest";

import { backgroundTasks } from "./background-work.js";

const NOW = Date.parse("2026-10-24T10:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const use = (id: string, name: string, input: Record<string, unknown>, minutesAgo: number) => ({
  type: "assistant",
  timestamp: at(minutesAgo),
  message: { id: `m-${id}`, content: [{ type: "tool_use", id, name, input }] },
});
const result = (id: string, minutesAgo: number, isError = false) => ({
  type: "user",
  timestamp: at(minutesAgo),
  message: {
    content: [{ type: "tool_result", tool_use_id: id, content: "ok", ...(isError ? { is_error: true } : {}) }],
  },
});
const notification = (id: string, status: string, summary: string, minutesAgo: number) => ({
  type: "user",
  timestamp: at(minutesAgo),
  message: {
    content: `<system-reminder>\n[SYSTEM NOTIFICATION]\n<task-notification>\n<task-id>x</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>\n</system-reminder>`,
  },
});

describe("backgroundTasks", () => {
  it("lists subagents and background shells, running until their result or notification", () => {
    const tasks = backgroundTasks(
      [
        use("a1", "Agent", { description: "Explore the relay", prompt: "secret prompt" }, 6),
        use("a2", "Agent", { description: "Research gaps", run_in_background: true }, 5),
        result("a2", 5),
        use("b1", "Bash", { command: "npm test", run_in_background: true, description: "Run the suite" }, 4),
        result("b1", 4),
        use("b2", "Bash", { command: "ls" }, 4),
      ],
      NOW,
    );
    expect(tasks).toEqual([
      expect.objectContaining({
        id: "a1",
        kind: "agent",
        label: "Explore the relay",
        status: "running",
        background: false,
      }),
      expect.objectContaining({ id: "a2", kind: "agent", label: "Research gaps", status: "running", background: true }),
      expect.objectContaining({ id: "b1", kind: "shell", label: "Run the suite", status: "running", background: true }),
    ]);
    expect(JSON.stringify(tasks)).not.toContain("secret prompt");
  });

  it("ends them by result and notification, and drops finished ones after ten minutes", () => {
    const tasks = backgroundTasks(
      [
        use("a1", "Agent", { description: "Old work" }, 40),
        result("a1", 30),
        use("a2", "Agent", { description: "Failed work" }, 9),
        result("a2", 8, true),
        use("b1", "Bash", { command: "make", run_in_background: true }, 6),
        notification("b1", "completed", 'Background command "make" completed (exit code 0)', 2),
        use("b2", "Bash", { command: "sleep 99", run_in_background: true }, 6),
        notification("b2", "killed", "Killed", 1),
      ],
      NOW,
    );
    expect(tasks.map((task) => [task.id, task.status, task.summary])).toEqual([
      ["a2", "failed", undefined],
      ["b1", "done", 'Background command "make" completed (exit code 0)'],
      ["b2", "stopped", "Killed"],
    ]);
  });

  it("keeps an async subagent running past its launch result, until its notification", () => {
    const launched = {
      ...result("a1", 5),
      toolUseResult: { isAsync: true, status: "async_launched", agentId: "abc", description: "Audit" },
    };
    const running = backgroundTasks([use("a1", "Agent", { description: "Audit" }, 5), launched], NOW);
    expect(running).toEqual([expect.objectContaining({ id: "a1", status: "running", background: true })]);
    const ended = backgroundTasks(
      [
        use("a1", "Agent", { description: "Audit" }, 5),
        launched,
        notification("a1", "completed", 'Agent "Audit" finished', 1),
      ],
      NOW,
    );
    expect(ended).toEqual([expect.objectContaining({ id: "a1", status: "done", summary: 'Agent "Audit" finished' })]);
  });

  it("ignores a worker's own sidechain and a run with no end from a day ago", () => {
    const tasks = backgroundTasks(
      [
        { ...use("s1", "Agent", { description: "Inside a worker" }, 1), isSidechain: true },
        use("b1", "Bash", { command: "serve", run_in_background: true }, 25 * 60),
      ],
      NOW,
    );
    expect(tasks).toEqual([]);
  });
});
