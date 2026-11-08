import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import { ClaudeCodeAdapter } from "./claude-code.js";

function createFakeChild(): ChildProcessWithoutNullStreams {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin: new PassThrough(),
    kill: vi.fn(),
  }) as unknown as ChildProcessWithoutNullStreams;
}

function writeJsonLine(child: ChildProcessWithoutNullStreams, payload: Record<string, unknown>): void {
  (child.stdout as PassThrough).write(`${JSON.stringify(payload)}\n`);
}

afterEach(() => {
  spawnMock.mockReset();
  vi.restoreAllMocks();
});

describe("ClaudeCodeAdapter", () => {
  it("starts a new session with --session-id and emits assistant text notifications", async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);

    const adapter = new ClaudeCodeAdapter("/tmp/claude");
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    adapter.on("notification", (notification) => notifications.push(notification));

    await adapter.resumeThread({
      threadId: "thread-1",
      allowMissingRollout: true,
    });

    const startPromise = adapter.startTurn({
      threadId: "thread-1",
      cwd: "/tmp/workspace",
      model: "opus-1m",
      input: "hello",
    });

    child.emit("spawn");
    const { turnId } = await startPromise;

    expect(spawnMock).toHaveBeenCalledWith(
      "/tmp/claude",
      expect.arrayContaining(["--session-id", "thread-1"]),
      expect.objectContaining({
        cwd: "/tmp/workspace",
      }),
    );

    writeJsonLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "text",
          text: "",
        },
      },
    });
    writeJsonLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: "hello",
        },
      },
    });
    writeJsonLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_stop",
        index: 0,
      },
    });
    writeJsonLine(child, {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "hello",
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(notifications).toContainEqual({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turn: {
          id: turnId,
        },
      },
    });
    expect(
      notifications.some(
        (notification) => notification.method === "item/agentMessage/delta" && notification.params.delta === "hello",
      ),
    ).toBe(true);
    expect(
      notifications.some(
        (notification) =>
          notification.method === "item/completed" &&
          (notification.params.item as { type?: string; text?: string }).type === "agentMessage" &&
          (notification.params.item as { type?: string; text?: string }).text === "hello",
      ),
    ).toBe(true);
    expect(
      notifications.some(
        (notification) =>
          notification.method === "turn/completed" &&
          (notification.params.turn as { status?: string }).status === "completed",
      ),
    ).toBe(true);
  });

  it("translates Claude tool use into bridge activity notifications", async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);

    const adapter = new ClaudeCodeAdapter("/tmp/claude");
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    adapter.on("notification", (notification) => notifications.push(notification));

    const startPromise = adapter.startTurn({
      threadId: "thread-2",
      cwd: "/tmp/workspace",
      model: "opus-1m",
      input: "run tests",
    });

    child.emit("spawn");
    await startPromise;

    writeJsonLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "tool-1",
          name: "Bash",
          input: {},
        },
      },
    });
    writeJsonLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: '{"command":"npm test"}',
        },
      },
    });
    writeJsonLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_stop",
        index: 1,
      },
    });
    writeJsonLine(child, {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "ok",
          },
        ],
      },
    });
    writeJsonLine(child, {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(
      notifications.some(
        (notification) =>
          notification.method === "item/started" &&
          (notification.params.item as { type?: string; command?: string }).type === "commandExecution" &&
          (notification.params.item as { type?: string; command?: string }).command === "npm test",
      ),
    ).toBe(true);
    expect(
      notifications.some(
        (notification) =>
          notification.method === "item/completed" &&
          (notification.params.item as { type?: string; command?: string }).type === "commandExecution" &&
          (notification.params.item as { type?: string; command?: string }).command === "npm test",
      ),
    ).toBe(true);
  });

  it("kills the active child process on interrupt", async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);

    const adapter = new ClaudeCodeAdapter("/tmp/claude");
    const startPromise = adapter.startTurn({
      threadId: "thread-3",
      cwd: "/tmp/workspace",
      model: "opus-1m",
      input: "interrupt me",
    });

    child.emit("spawn");
    const { turnId } = await startPromise;

    await adapter.interruptTurn({
      threadId: "thread-3",
      turnId,
    });

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("emits one item per text block so a tool-split turn does not repeat itself", async () => {
    const child = createFakeChild();
    spawnMock.mockReturnValue(child);

    const adapter = new ClaudeCodeAdapter("/tmp/claude");
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    adapter.on("notification", (notification) => notifications.push(notification));

    const startPromise = adapter.startTurn({
      threadId: "thread-4",
      cwd: "/tmp/workspace",
      model: "opus-1m",
      input: "check the plist",
    });

    child.emit("spawn");
    await startPromise;

    // First text block.
    writeJsonLine(child, {
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    });
    writeJsonLine(child, {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "already running" } },
    });
    writeJsonLine(child, { type: "stream_event", event: { type: "content_block_stop", index: 0 } });

    // A tool call splits the turn.
    writeJsonLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tool-9", name: "Bash", input: {} },
      },
    });
    writeJsonLine(child, {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
      },
    });
    writeJsonLine(child, { type: "stream_event", event: { type: "content_block_stop", index: 1 } });

    // Second text block.
    writeJsonLine(child, {
      type: "stream_event",
      event: { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    });
    writeJsonLine(child, {
      type: "stream_event",
      event: { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "and healthy" } },
    });
    writeJsonLine(child, { type: "stream_event", event: { type: "content_block_stop", index: 2 } });

    writeJsonLine(child, { type: "result", subtype: "success", is_error: false, result: "already runningand healthy" });

    await new Promise((resolve) => setImmediate(resolve));

    const messages = notifications
      .filter(
        (notification) =>
          notification.method === "item/completed" &&
          (notification.params.item as { type?: string }).type === "agentMessage",
      )
      .map((notification) => (notification.params.item as { text?: string }).text);

    // Each block stands alone. Emitting the turn-wide accumulator here made the
    // second item "already runningand healthy", which Conductor mirrored as a
    // duplicate row restating the first block.
    expect(messages).toEqual(["already running", "and healthy"]);
  });

  describe("a stream cut short by a large line", () => {
    const thread = "6549cb21-b0bb-45ab-ab94-24f299fdbe51";
    const transcript = (entries: Record<string, unknown>[]) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-projects-"));
      fs.mkdirSync(path.join(dir, "-ws"));
      fs.writeFileSync(
        path.join(dir, "-ws", `${thread}.jsonl`),
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );
      return dir;
    };
    const run = async (projectsDir: string) => {
      const child = createFakeChild();
      spawnMock.mockReturnValue(child);
      const adapter = new ClaudeCodeAdapter("/tmp/claude", { projectsDir });
      const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
      adapter.on("notification", (notification) => notifications.push(notification));
      const start = adapter.startTurn({ threadId: thread, cwd: "/ws", model: null, input: "look at this" });
      child.emit("spawn");
      await start;
      // What arrived: a tool result carrying an image, cut off mid-line; then a clean exit and no `result`.
      (child.stdout as PassThrough).write(
        '{"type":"user","message":{"content":[{"type":"tool_result","content":[{"type":"image","source":{"data":"/9j/4AAQ\n',
      );
      await new Promise((resolve) => setImmediate(resolve));
      child.emit("exit", 0, null);
      await new Promise((resolve) => setImmediate(resolve));
      return notifications;
    };
    const later = () => new Date(Date.now() + 5_000).toISOString();

    it("finishes the turn from the transcript when the agent ended it", async () => {
      const dir = transcript([
        {
          type: "assistant",
          timestamp: "2020-01-01T00:00:00.000Z",
          message: { content: [{ type: "text", text: "an older turn" }], stop_reason: "end_turn" },
        },
        {
          type: "assistant",
          timestamp: later(),
          message: { content: [{ type: "thinking", thinking: "" }], stop_reason: "end_turn" },
        },
        {
          type: "assistant",
          timestamp: later(),
          message: { content: [{ type: "text", text: "Here's the Work section." }], stop_reason: "end_turn" },
        },
      ]);
      const notifications = await run(dir);
      const texts = notifications
        .filter((n) => n.method === "item/completed")
        .map((n) => (n.params.item as { text?: string }).text);
      expect(texts).toEqual(["Here's the Work section."]);
      const done = notifications.find((n) => n.method === "turn/completed");
      expect(done?.params.turn).toMatchObject({ status: "completed", error: null });
    });

    it("still fails when the transcript shows no finished turn", async () => {
      const dir = transcript([
        {
          type: "assistant",
          timestamp: later(),
          message: { content: [{ type: "tool_use", name: "Read" }], stop_reason: "tool_use" },
        },
      ]);
      const done = (await run(dir)).find((n) => n.method === "turn/completed");
      expect(done?.params.turn).toMatchObject({ status: "failed" });
    });
  });
});
